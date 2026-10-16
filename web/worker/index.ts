// Cache backend: one Cloudflare Worker that serves the site, the API, the trade indexer
// (polling Helius) and the keeper that sweeps round-ups into xStocks.
import {
  AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import {
  ata, beginSweepIx, configPda, createAtaIdempotentIx, decodeConfig, decodeTokenAccount, decodeVault, endSweepIx,
  fromUsdcUnits, roundUpUsd, stockByMint, toUsdcUnits, STOCKS, USDC_MINT, USDT_MINT, vaultPda, WSOL_MINT,
} from "../src/shared/cache";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROGRAM_ID: string;
  HELIUS_API_KEY: string;
  KEEPER_SECRET_KEY: string;
  JUPITER_API_KEY?: string;
  MIN_SWEEP_USD?: string;
  SLIPPAGE_BPS?: string;
}

const STABLES = new Set([USDC_MINT.toBase58(), USDT_MINT.toBase58()]);
const SOL = WSOL_MINT.toBase58();
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- HTTP

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404) return res;
      const page = await env.ASSETS.fetch(new Request(new URL("/404.html", url), req));
      return new Response(page.body, { status: 404, headers: page.headers });
    }
    try {
      return await route(req, url, env, ctx);
    } catch (e: any) {
      console.error(e);
      return json({ error: e?.message ?? String(e) }, 500);
    }
  },

  // Every 15 minutes: pull new trades for every user; once a day (12:00 UTC run) sweep.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const users = await env.DB.prepare("SELECT wallet FROM users").all<{ wallet: string }>();
    const d = new Date(event.scheduledTime);
    const sweepRun = d.getUTCHours() === 12 && d.getUTCMinutes() < 15;
    for (const u of users.results ?? []) {
      try {
        await syncTrades(env, u.wallet);
        if (sweepRun) await sweepWallet(env, u.wallet);
      } catch (e: any) {
        await log(env, u.wallet, "error", `scheduled: ${e?.message ?? e}`);
      }
    }
  },
};

async function route(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname;

  if (p === "/api/config" && req.method === "GET") {
    const keeper = keeperKeypair(env).publicKey.toBase58();
    let config: any = null;
    try {
      const acc = await getAccount(env, configPda(new PublicKey(env.PROGRAM_ID)));
      if (acc) {
        const c = decodeConfig(acc.data);
        config = {
          paused: c.paused, keeper: c.keeper.toBase58(),
          allowedMints: c.allowedMints.map((m) => m.toBase58()),
        };
      }
    } catch {}
    const allowed = new Set(config?.allowedMints ?? []);
    return json({
      programId: env.PROGRAM_ID, keeper, config,
      keeperMatches: config ? config.keeper === keeper : false,
      stocks: STOCKS.filter((s) => allowed.has(s.mint)),
      minSweepUsd: minSweep(env),
    });
  }

  if (p === "/api/rpc" && req.method === "POST") {
    const body: any = await req.json();
    const allowed = new Set([
      "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts", "getBalance", "sendTransaction",
      "getSignatureStatuses", "simulateTransaction", "getMinimumBalanceForRentExemption", "getTokenAccountBalance",
    ]);
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.every((c) => allowed.has(c?.method))) return json({ error: "RPC method not allowed" }, 400);
    const r = await fetch(rpcUrl(env), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }

  if (p === "/api/register" && req.method === "POST") {
    const { wallet } = (await req.json()) as { wallet: string };
    const owner = new PublicKey(wallet);
    const vault = await getAccount(env, vaultPda(new PublicKey(env.PROGRAM_ID), owner));
    if (!vault) return json({ error: "No Cache vault found for this wallet yet. Finish setup first." }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO users (wallet, created_at) VALUES (?, ?)").bind(wallet, now()).run();
    // Start watching from the most recent swap so history before signup isn't rounded up.
    ctx.waitUntil(syncTrades(env, wallet, { baselineOnly: true }).catch(() => {}));
    return json({ ok: true });
  }

  if (p === "/api/state" && req.method === "GET") {
    const wallet = url.searchParams.get("wallet");
    if (!wallet) return json({ error: "wallet is required" }, 400);
    const user = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first<any>();
    if (user && now() - user.last_sync > 60) await syncTrades(env, wallet).catch((e) => log(env, wallet, "error", `sync: ${e.message}`));
    return json(await walletState(env, wallet));
  }

  if (p === "/api/sweep" && req.method === "POST") {
    const { wallet } = (await req.json()) as { wallet: string };
    const user = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first<any>();
    if (!user) return json({ error: "This wallet isn't registered with Cache yet." }, 400);
    if (now() - user.last_sweep_request < 60) return json({ error: "Please wait a minute between sweeps." }, 429);
    await env.DB.prepare("UPDATE users SET last_sweep_request = ? WHERE wallet = ?").bind(now(), wallet).run();
    await syncTrades(env, wallet);
    const result = await sweepWallet(env, wallet);
    return json({ result, state: await walletState(env, wallet) });
  }

  if (p === "/api/health") {
    const keeper = keeperKeypair(env).publicKey;
    const bal = await rpc(env, "getBalance", [keeper.toBase58(), { commitment: "confirmed" }]);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    const logs = await env.DB.prepare("SELECT ts, wallet, level, message FROM logs ORDER BY id DESC LIMIT 20").all();
    return json({ keeper: keeper.toBase58(), keeperSol: bal.value / 1e9, users: users?.n ?? 0, logs: logs.results });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- state

async function walletState(env: Env, wallet: string) {
  const programId = new PublicKey(env.PROGRAM_ID);
  const owner = new PublicKey(wallet);
  const [vaultAcc, usdcAcc] = await getAccounts(env, [vaultPda(programId, owner), ata(owner, USDC_MINT)]);
  const vault = vaultAcc ? decodeVault(vaultAcc.data) : null;
  const usdc = usdcAcc ? decodeTokenAccount(usdcAcc.data) : null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first<any>();
  const trades = await env.DB.prepare("SELECT * FROM trades WHERE wallet = ? ORDER BY ts DESC LIMIT 50").bind(wallet).all();
  const sweeps = await env.DB.prepare("SELECT * FROM sweeps WHERE wallet = ? ORDER BY ts DESC LIMIT 25").bind(wallet).all();
  const pending = user ? await pendingUsd(env, wallet) : 0;
  const vaultKey = vaultPda(programId, owner);
  return {
    registered: !!user,
    pendingUsd: pending,
    vault: vault && {
      picks: vault.picks.map((m) => m.toBase58()),
      weeklyCapUsd: fromUsdcUnits(vault.weeklyCap),
      multiplier: vault.multiplier,
      paused: vault.paused,
      spentThisWeekUsd: now() >= vault.periodStart + 7 * 86400 ? 0 : fromUsdcUnits(vault.spentInPeriod),
      periodStart: vault.periodStart,
      totalSweptUsd: fromUsdcUnits(vault.totalSwept),
      sweepCount: Number(vault.sweepCount),
    },
    usdc: usdc && {
      balanceUsd: fromUsdcUnits(usdc.amount),
      approvedToCache: !!usdc.delegate && usdc.delegate.equals(vaultKey),
      allowanceUsd: usdc.delegate && usdc.delegate.equals(vaultKey) ? fromUsdcUnits(usdc.delegatedAmount) : 0,
      delegate: usdc.delegate?.toBase58() ?? null,
    },
    trades: trades.results,
    sweeps: sweeps.results,
  };
}

/** Re-checks sweeps that were sent but not yet confirmed; a dropped transaction stops counting against pending. */
async function reconcileSent(env: Env, wallet: string) {
  const sent = await env.DB.prepare("SELECT id, sig, ts FROM sweeps WHERE wallet = ? AND status = 'sent' AND sig IS NOT NULL").bind(wallet).all<{ id: number; sig: string; ts: number }>();
  const rows = sent.results ?? [];
  if (!rows.length) return;
  const r = await rpc(env, "getSignatureStatuses", [rows.map((s) => s.sig), { searchTransactionHistory: true }]);
  for (let i = 0; i < rows.length; i++) {
    const s = r.value?.[i];
    if (s?.err) await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = 'Transaction failed onchain' WHERE id = ?").bind(rows[i].id).run();
    else if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") await env.DB.prepare("UPDATE sweeps SET status = 'confirmed' WHERE id = ?").bind(rows[i].id).run();
    else if (!s && now() - rows[i].ts > 180) await env.DB.prepare("UPDATE sweeps SET status = 'expired', error = 'Transaction did not land; it will be retried' WHERE id = ?").bind(rows[i].id).run();
  }
}

async function pendingUsd(env: Env, wallet: string) {
  await reconcileSent(env, wallet);
  const t = await env.DB.prepare("SELECT COALESCE(SUM(roundup_usd), 0) AS s FROM trades WHERE wallet = ?").bind(wallet).first<{ s: number }>();
  const s = await env.DB.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS s FROM sweeps WHERE wallet = ? AND status IN ('sent','confirmed')").bind(wallet).first<{ s: number }>();
  return Math.max(0, Math.round(((t?.s ?? 0) - (s?.s ?? 0)) * 100) / 100);
}

// ---------------------------------------------------------------- indexer

type HeliusTx = {
  signature: string; timestamp: number; type: string; source: string; description: string; fee: number; feePayer: string;
  transactionError: any;
  accountData: { account: string; nativeBalanceChange: number; tokenBalanceChanges: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[] }[];
};

/** Pulls the wallet's recent swaps from Helius and records a round-up for each new one. */
async function syncTrades(env: Env, wallet: string, opts: { baselineOnly?: boolean } = {}) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first<any>();
  if (!user) return;
  const params = new URLSearchParams({ "api-key": env.HELIUS_API_KEY, type: "SWAP", limit: "50" });
  const r = await fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?${params}`);
  if (!r.ok) throw new Error(`Helius ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const txs = (await r.json()) as HeliusTx[];
  await env.DB.prepare("UPDATE users SET last_sync = ?, last_sig = COALESCE(?, last_sig) WHERE wallet = ?")
    .bind(now(), txs[0]?.signature ?? null, wallet).run();
  if (opts.baselineOnly) return;

  const fresh = txs.filter((t) => !t.transactionError && t.timestamp >= user.created_at && t.feePayer === wallet);
  if (!fresh.length) return;
  const known = await env.DB.prepare(`SELECT sig FROM trades WHERE sig IN (${fresh.map(() => "?").join(",")})`)
    .bind(...fresh.map((t) => t.signature)).all<{ sig: string }>();
  const seen = new Set((known.results ?? []).map((k) => k.sig));
  const todo = fresh.filter((t) => !seen.has(t.signature));
  if (!todo.length) return;

  const vaultAcc = await getAccount(env, vaultPda(new PublicKey(env.PROGRAM_ID), new PublicKey(wallet)));
  if (!vaultAcc) return;
  const vault = decodeVault(vaultAcc.data);
  if (vault.paused) return;

  for (const tx of todo) {
    const value = await tradeValueUsd(env, tx, wallet);
    if (value == null || value < 0.5) continue;
    const roundup = roundUpUsd(value, vault.multiplier);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO trades (sig, wallet, ts, source, description, value_usd, roundup_usd, multiplier) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(tx.signature, wallet, tx.timestamp, tx.source, (tx.description || "").slice(0, 200), value, roundup, vault.multiplier).run();
  }
}

/** USD value of a swap from the wallet's own balance changes: stablecoin leg first, then SOL, then a price lookup. */
async function tradeValueUsd(env: Env, tx: HeliusTx, wallet: string): Promise<number | null> {
  const changes = new Map<string, number>();
  for (const a of tx.accountData ?? []) {
    if (a.account === wallet && a.nativeBalanceChange) {
      const lamports = a.nativeBalanceChange + (tx.feePayer === wallet ? tx.fee : 0);
      changes.set(SOL, (changes.get(SOL) ?? 0) + lamports / 1e9);
    }
    for (const t of a.tokenBalanceChanges ?? []) {
      if (t.userAccount !== wallet) continue;
      const v = Number(t.rawTokenAmount.tokenAmount) / 10 ** t.rawTokenAmount.decimals;
      changes.set(t.mint, (changes.get(t.mint) ?? 0) + v);
    }
  }
  // Ignore SOL dust (rent for new token accounts etc.).
  if (Math.abs(changes.get(SOL) ?? 0) < 0.002) changes.delete(SOL);
  for (const [m, v] of changes) if (Math.abs(v) < 1e-9) changes.delete(m);
  if (!changes.size) return null;

  for (const [m, v] of changes) if (STABLES.has(m)) return Math.abs(v);
  const sol = changes.get(SOL);
  if (sol) return Math.abs(sol) * ((await prices(env, [SOL]))[SOL] ?? 0) || null;

  const out = [...changes].filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])[0] ?? [...changes][0];
  const px = (await prices(env, [out[0]]))[out[0]];
  return px ? Math.abs(out[1]) * px : null;
}

async function prices(env: Env, mints: string[]): Promise<Record<string, number>> {
  const r = await jup(env, `/price/v3?ids=${mints.join(",")}`);
  const out: Record<string, number> = {};
  for (const m of mints) if (r?.[m]?.usdPrice) out[m] = Number(r[m].usdPrice);
  return out;
}

// ---------------------------------------------------------------- keeper

/** Sweeps the wallet's pending round-ups into its picks, within every onchain limit. */
async function sweepWallet(env: Env, wallet: string) {
  const programId = new PublicKey(env.PROGRAM_ID);
  const owner = new PublicKey(wallet);
  const keeper = keeperKeypair(env);
  const [vaultAcc, usdcAcc] = await getAccounts(env, [vaultPda(programId, owner), ata(owner, USDC_MINT)]);
  if (!vaultAcc) return skip(env, wallet, "No vault");
  const vault = decodeVault(vaultAcc.data);
  if (vault.paused) return skip(env, wallet, "Round-ups are paused");
  if (!usdcAcc) return skip(env, wallet, "No USDC account");
  const usdc = decodeTokenAccount(usdcAcc.data);
  const vaultKey = vaultPda(programId, owner);
  if (!usdc.delegate || !usdc.delegate.equals(vaultKey)) return skip(env, wallet, "USDC approval for Cache is missing; re-approve in the app");

  const pending = await pendingUsd(env, wallet);
  const capLeft = now() >= vault.periodStart + 7 * 86400 ? fromUsdcUnits(vault.weeklyCap) : fromUsdcUnits(vault.weeklyCap - vault.spentInPeriod);
  const amountUsd = Math.floor(Math.min(pending, capLeft, fromUsdcUnits(usdc.delegatedAmount), fromUsdcUnits(usdc.amount)) * 100) / 100;
  if (amountUsd < minSweep(env)) {
    return skip(env, wallet, `Nothing to sweep yet ($${amountUsd.toFixed(2)} available; pending $${pending.toFixed(2)}, cap left $${capLeft.toFixed(2)}, USDC $${fromUsdcUnits(usdc.amount).toFixed(2)}, allowance $${fromUsdcUnits(usdc.delegatedAmount).toFixed(2)})`);
  }

  // Split across picks; tiny amounts go to one pick, rotating each sweep.
  const picks = vault.picks;
  const perPick = amountUsd / picks.length;
  const legs = perPick >= 0.5
    ? picks.map((m, i) => ({ mint: m, usd: i === picks.length - 1 ? Math.round((amountUsd - Math.floor(perPick * 100) / 100 * (picks.length - 1)) * 100) / 100 : Math.floor(perPick * 100) / 100 }))
    : [{ mint: picks[Number(vault.sweepCount % BigInt(picks.length))], usd: amountUsd }];

  const results: any[] = [];
  for (const leg of legs) {
    results.push(await sweepLeg(env, keeper, programId, owner, leg.mint, leg.usd));
  }
  return { swept: results };
}

async function sweepLeg(env: Env, keeper: Keypair, programId: PublicKey, owner: PublicKey, mint: PublicKey, usd: number) {
  const wallet = owner.toBase58();
  const amount = toUsdcUnits(usd);
  const id = (await env.DB.prepare("INSERT INTO sweeps (wallet, ts, mint, amount_usd, status) VALUES (?,?,?,?, 'building') RETURNING id")
    .bind(wallet, now(), mint.toBase58(), usd).first<{ id: number }>())!.id;
  try {
    const mintAcc = await getAccount(env, mint);
    if (!mintAcc) throw new Error("Stock mint not found");
    const tokenProgram = new PublicKey(mintAcc.owner);
    const dest = ata(owner, mint, tokenProgram);

    const slippage = env.SLIPPAGE_BPS ?? "100";
    const quote = await jup(env, `/swap/v1/quote?inputMint=${USDC_MINT.toBase58()}&outputMint=${mint.toBase58()}&amount=${amount}&slippageBps=${slippage}&restrictIntermediateTokens=true&maxAccounts=48`);
    if (!quote?.outAmount) throw new Error(`No route for ${stockByMint(mint.toBase58())?.symbol ?? mint.toBase58()}: ${JSON.stringify(quote).slice(0, 200)}`);
    const ins = await jup(env, "/swap/v1/swap-instructions", {
      quoteResponse: quote,
      userPublicKey: keeper.publicKey.toBase58(),
      destinationTokenAccount: dest.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300000, priorityLevel: "high" } },
    });
    if (ins?.error) throw new Error(`Jupiter: ${ins.error}`);

    const minOut = BigInt(quote.otherAmountThreshold);
    const ixs: TransactionInstruction[] = [
      ...(ins.computeBudgetInstructions ?? []).map(toIx),
      createAtaIdempotentIx(keeper.publicKey, keeper.publicKey, USDC_MINT, new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
      createAtaIdempotentIx(keeper.publicKey, owner, mint, tokenProgram),
      ...(ins.setupInstructions ?? []).map(toIx),
      beginSweepIx({ programId, owner, keeper: keeper.publicKey, dest, amount, minOut }),
      toIx(ins.swapInstruction),
      endSweepIx({ programId, owner, keeper: keeper.publicKey, dest }),
      ...(ins.cleanupInstruction ? [toIx(ins.cleanupInstruction)] : []),
    ];
    const alts = await loadAlts(env, ins.addressLookupTableAddresses ?? []);
    const { value: bh } = await rpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    const msg = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([keeper]);
    const raw = btoa(String.fromCharCode(...tx.serialize()));
    const sig: string = await rpc(env, "sendTransaction", [raw, { encoding: "base64", skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" }]);
    await env.DB.prepare("UPDATE sweeps SET sig = ?, status = 'sent', expected_out = ? WHERE id = ?").bind(sig, quote.outAmount, id).run();

    const status = await confirm(env, sig, 45);
    if (status === "confirmed") {
      await env.DB.prepare("UPDATE sweeps SET status = 'confirmed' WHERE id = ?").bind(id).run();
    } else if (status === "failed") {
      await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = 'Transaction failed onchain' WHERE id = ?").bind(id).run();
    } // else stays 'sent'; the next state read re-checks it
    return { mint: mint.toBase58(), usd, sig, status };
  } catch (e: any) {
    const message = (e?.message ?? String(e)).slice(0, 500);
    await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = ? WHERE id = ?").bind(message, id).run();
    await log(env, wallet, "error", `sweep ${mint.toBase58()}: ${message}`);
    return { mint: mint.toBase58(), usd, status: "failed", error: message };
  }
}

async function confirm(env: Env, sig: string, seconds: number) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const r = await rpc(env, "getSignatureStatuses", [[sig]]);
    const s = r.value?.[0];
    if (s?.err) return "failed";
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return "confirmed";
    await new Promise((res) => setTimeout(res, 2000));
  }
  return "pending";
}

async function skip(env: Env, wallet: string, reason: string) {
  await log(env, wallet, "info", reason);
  return { skipped: reason };
}

// ---------------------------------------------------------------- helpers

function keeperKeypair(env: Env) {
  if (!env.KEEPER_SECRET_KEY) throw new Error("KEEPER_SECRET_KEY is not set");
  return Keypair.fromSecretKey(bs58.decode(env.KEEPER_SECRET_KEY));
}

const minSweep = (env: Env) => Number(env.MIN_SWEEP_USD ?? "1");
const rpcUrl = (env: Env) => `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

async function rpc(env: Env, method: string, params: any[]) {
  const r = await fetch(rpcUrl(env), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

type Acc = { data: Uint8Array; owner: string };
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function getAccount(env: Env, key: PublicKey): Promise<Acc | null> {
  return (await getAccounts(env, [key]))[0];
}

async function getAccounts(env: Env, keys: PublicKey[]): Promise<(Acc | null)[]> {
  const r = await rpc(env, "getMultipleAccounts", [keys.map((k) => k.toBase58()), { encoding: "base64", commitment: "confirmed" }]);
  return r.value.map((v: any) => (v ? { data: b64(v.data[0]), owner: v.owner } : null));
}

async function loadAlts(env: Env, addresses: string[]) {
  if (!addresses.length) return [];
  const accs = await getAccounts(env, addresses.map((a) => new PublicKey(a)));
  return accs.flatMap((a, i) => a ? [new AddressLookupTableAccount({
    key: new PublicKey(addresses[i]),
    state: AddressLookupTableAccount.deserialize(a.data),
  })] : []);
}

function toIx(i: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }) {
  return new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(b64(i.data)),
  });
}

async function jup(env: Env, path: string, body?: unknown) {
  const base = env.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;
  const r = await fetch(base + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`Jupiter ${r.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function log(env: Env, wallet: string | null, level: string, message: string) {
  await env.DB.prepare("INSERT INTO logs (ts, wallet, level, message) VALUES (?,?,?,?)").bind(now(), wallet, level, message.slice(0, 1000)).run();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
