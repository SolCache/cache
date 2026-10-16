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
  cacheSolAccount, fundingInfo, fromUnits, toUnits,
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
  SELL_SLIPPAGE_BPS?: string;
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
      solPriceUsd: (await prices(env, [SOL]).catch(() => ({} as Record<string, number>)))[SOL] ?? null,
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
    return json({ result, state: await walletState(env, wallet, false) });
  }

  // Sell every xStock the wallet holds for USDC. Preview returns quotes; build returns unsigned swap
  // transactions for the user to sign in their own wallet (Cache never touches these funds).
  if (p === "/api/sell" && req.method === "POST") {
    const { wallet, build, mints } = (await req.json()) as { wallet: string; build?: boolean; mints?: string[] };
    const owner = new PublicKey(wallet);
    const atas = STOCKS.map((s) => ata(owner, new PublicKey(s.mint), TOKEN_2022));
    const accs = await getAccounts(env, atas);
    const held = STOCKS.map((s, i) => ({ s, amount: accs[i] ? decodeTokenAccount(accs[i]!.data).amount : 0n }))
      .filter((h) => h.amount > 0n && (!mints?.length || mints.includes(h.s.mint)));
    const sellSlippage = env.SELL_SLIPPAGE_BPS ?? "300";
    const legs: any[] = [];
    for (const { s, amount } of held) {
      try {
        const quote = await jup(env, `/swap/v1/quote?inputMint=${s.mint}&outputMint=${USDC_MINT.toBase58()}&amount=${amount}&slippageBps=${sellSlippage}&restrictIntermediateTokens=true`);
        if (!quote?.outAmount) throw new Error("No route");
        const leg: any = { mint: s.mint, symbol: s.symbol, amount: amount.toString(), usdcOut: Number(quote.outAmount) / 1e6 };
        if (build) {
          const swap = await jup(env, "/swap/v1/swap", {
            quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: false, dynamicComputeUnitLimit: true,
            // Thin xStock pools move between quoting and signing; let Jupiter size slippage from a simulation, up to the cap.
            dynamicSlippage: true,
            prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300000, priorityLevel: "high" } },
          });
          if (!swap?.swapTransaction) throw new Error(swap?.error ?? "Jupiter didn't return a transaction");
          leg.tx = swap.swapTransaction;
        }
        legs.push(leg);
      } catch (e: any) {
        legs.push({ mint: s.mint, symbol: s.symbol, amount: amount.toString(), error: e?.message ?? String(e) });
      }
    }
    return json({ legs, totalUsdc: legs.reduce((a, l) => a + (l.usdcOut ?? 0), 0) });
  }

  if (p === "/api/health") {
    const keeper = keeperKeypair(env).publicKey;
    const bal = await rpc(env, "getBalance", [keeper.toBase58(), { commitment: "confirmed" }]);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    const logs = await env.DB.prepare("SELECT ts, wallet, level, message FROM logs ORDER BY id DESC LIMIT 20").all<{ ts: number; wallet: string; level: string; message: string }>();
    // Public endpoint: never expose which wallets use Cache. Addresses are shortened to first4…last4.
    const mask = (s: string) => s.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, (a) => `${a.slice(0, 4)}…${a.slice(-4)}`);
    const safe = (logs.results ?? []).map((l) => ({ ts: l.ts, level: l.level, wallet: l.wallet ? mask(l.wallet) : null, message: mask(String(l.message ?? "")).slice(0, 300) }));
    return json({ keeper: keeper.toBase58(), keeperSol: bal.value / 1e9, users: users?.n ?? 0, logs: safe });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- state

async function walletState(env: Env, wallet: string, reconcile = true) {
  const programId = new PublicKey(env.PROGRAM_ID);
  const owner = new PublicKey(wallet);
  const vaultKey = vaultPda(programId, owner);
  const solAccKey = await cacheSolAccount(owner);
  const [vaultAcc, usdcAcc, solAcc, ownerAcc] = await getAccounts(env, [vaultKey, ata(owner, USDC_MINT), solAccKey, owner]);
  const vault = vaultAcc ? decodeVault(vaultAcc.data) : null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first<any>();
  const trades = await env.DB.prepare("SELECT * FROM trades WHERE wallet = ? ORDER BY ts DESC LIMIT 50").bind(wallet).all();
  const sweeps = await env.DB.prepare("SELECT * FROM sweeps WHERE wallet = ? ORDER BY ts DESC LIMIT 25").bind(wallet).all();
  const pending = user ? await pendingUsd(env, wallet, reconcile) : 0;

  const tokenState = (acc: Acc | null, decimals: number) => {
    if (!acc) return null;
    const t = decodeTokenAccount(acc.data);
    const approved = !!t.delegate && t.delegate.equals(vaultKey);
    return { balance: fromUnits(t.amount, decimals), approved, allowance: approved ? fromUnits(t.delegatedAmount, decimals) : 0 };
  };
  const fi = vault ? fundingInfo(vault.fundingMint) : null;
  const solPrice = fi?.kind === "SOL" ? (await prices(env, [SOL]).catch(() => ({} as Record<string, number>)))[SOL] ?? null : null;
  return {
    registered: !!user,
    pendingUsd: pending,
    solPriceUsd: solPrice,
    vault: vault && fi && {
      funding: fi.kind,
      fundingAccount: vault.fundingAccount.toBase58(),
      picks: vault.picks.map((m) => m.toBase58()),
      weeklyCap: fromUnits(vault.weeklyCap, fi.decimals),
      multiplier: vault.multiplier,
      paused: vault.paused,
      spentThisWeek: now() >= vault.periodStart + 7 * 86400 ? 0 : fromUnits(vault.spentInPeriod, fi.decimals),
      periodStart: vault.periodStart,
      totalSwept: fromUnits(vault.totalSwept, fi.decimals),
      sweepCount: Number(vault.sweepCount),
    },
    usdc: tokenState(usdcAcc, 6),
    cacheSol: solAcc ? { ...tokenState(solAcc, 9)!, account: solAccKey.toBase58() } : null,
    walletSol: (ownerAcc?.lamports ?? 0) / 1e9,
    trades: trades.results,
    sweeps: sweeps.results,
  };
}

/** Re-checks sweeps that were sent but not yet confirmed. A transaction the network dropped stops counting against pending. */
async function reconcileSent(env: Env, wallet: string) {
  const sent = await env.DB.prepare("SELECT id, sig, ts, lvbh FROM sweeps WHERE wallet = ? AND status = 'sent' AND sig IS NOT NULL").bind(wallet).all<{ id: number; sig: string; ts: number; lvbh: number | null }>();
  const rows = sent.results ?? [];
  if (!rows.length) return;
  const [r, height] = await Promise.all([
    rpc(env, "getSignatureStatuses", [rows.map((s) => s.sig), { searchTransactionHistory: true }]),
    rpc(env, "getBlockHeight", [{ commitment: "confirmed" }]),
  ]);
  for (let i = 0; i < rows.length; i++) {
    const s = r.value?.[i];
    if (s?.err) await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = 'Transaction failed onchain' WHERE id = ?").bind(rows[i].id).run();
    else if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") await env.DB.prepare("UPDATE sweeps SET status = 'confirmed' WHERE id = ?").bind(rows[i].id).run();
    else if (!s && (((rows[i].lvbh ?? 0) > 0 && height > (rows[i].lvbh ?? 0)) || now() - rows[i].ts > 180)) {
      await env.DB.prepare("UPDATE sweeps SET status = 'expired', error = 'Dropped by the network before it landed. Nothing moved; these round-ups go into the next sweep.' WHERE id = ?").bind(rows[i].id).run();
    }
  }
}

async function pendingUsd(env: Env, wallet: string, reconcile = true) {
  if (reconcile) await reconcileSent(env, wallet);
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

const QUOTE_SYMBOLS: Record<string, string> = { [SOL]: "SOL", [USDC_MINT.toBase58()]: "USDC", [USDT_MINT.toBase58()]: "USDT" };

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
  const known = await env.DB.prepare(`SELECT sig, description FROM trades WHERE sig IN (${fresh.map(() => "?").join(",")})`)
    .bind(...fresh.map((t) => t.signature)).all<{ sig: string; description: string }>();
  const knownDesc = new Map((known.results ?? []).map((k) => [k.sig, k.description ?? ""]));
  const todo = fresh.filter((t) => !knownDesc.has(t.signature));
  const relabel = fresh.filter((t) => knownDesc.has(t.signature) && !/^\$|→/.test(knownDesc.get(t.signature)!));
  if (!todo.length && !relabel.length) return;

  let multiplier = 1;
  if (todo.length) {
    const vaultAcc = await getAccount(env, vaultPda(new PublicKey(env.PROGRAM_ID), new PublicKey(wallet)));
    if (!vaultAcc) return;
    const vault = decodeVault(vaultAcc.data);
    if (vault.paused) return;
    multiplier = vault.multiplier;
  }

  // One symbol lookup and one price lookup for the whole batch keeps Cloudflare's per-request call budget low.
  const parsed = [...todo, ...relabel].map((tx) => ({ tx, changes: walletChanges(tx, wallet) }));
  const symbolMints = new Set<string>();
  const priceMints = new Set<string>();
  for (const { tx, changes } of parsed) {
    for (const m of changes.keys()) if (!QUOTE_SYMBOLS[m]) symbolMints.add(m);
    if (todo.includes(tx)) { const pm = priceMintFor(changes); if (pm) priceMints.add(pm); }
  }
  const [syms, pxs] = await Promise.all([symbols(env, [...symbolMints]), priceMints.size ? prices(env, [...priceMints]) : Promise.resolve({} as Record<string, number>)]);

  for (const { tx, changes } of parsed) {
    if (todo.includes(tx) && [...changes.keys()].some((m) => stockByMint(m))) continue;
    const label = tradeLabel(changes, syms);
    if (!todo.includes(tx)) {
      await env.DB.prepare("UPDATE trades SET description = ? WHERE sig = ?").bind(label, tx.signature).run();
      continue;
    }
    const value = tradeValue(changes, pxs);
    if (value == null || value < 0.5) continue;
    const roundup = roundUpUsd(value, multiplier);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO trades (sig, wallet, ts, source, description, value_usd, roundup_usd, multiplier) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(tx.signature, wallet, tx.timestamp, tx.source, label, value, roundup, multiplier).run();
  }
}

/** Net token changes for the wallet in one transaction (SOL fee and rent dust removed). */
function walletChanges(tx: HeliusTx, wallet: string) {
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
  if (Math.abs(changes.get(SOL) ?? 0) < 0.002) changes.delete(SOL);
  for (const [m, v] of changes) if (Math.abs(v) < 1e-9) changes.delete(m);
  return changes;
}

/** Which mint needs a USD price to value this trade (none when a stablecoin leg exists). */
function priceMintFor(changes: Map<string, number>) {
  if ([...changes.keys()].some((m) => STABLES.has(m))) return null;
  if (changes.has(SOL)) return SOL;
  const out = [...changes].filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])[0] ?? [...changes][0];
  return out?.[0] ?? null;
}

/** USD value: stablecoin leg first, then SOL, then the token sold. */
function tradeValue(changes: Map<string, number>, pxs: Record<string, number>): number | null {
  if (!changes.size) return null;
  for (const [m, v] of changes) if (STABLES.has(m)) return Math.abs(v);
  const pm = priceMintFor(changes);
  if (!pm || !pxs[pm]) return null;
  return Math.abs(changes.get(pm)!) * pxs[pm];
}

/** "$BONK Buy", "$WIF Sell", "$JUP → $WIF" or "SOL → USDC". */
function tradeLabel(changes: Map<string, number>, syms: Record<string, string>) {
  const sym = (m: string) => QUOTE_SYMBOLS[m] ?? syms[m] ?? m.slice(0, 4) + "…";
  const tokens = [...changes].filter(([m]) => !QUOTE_SYMBOLS[m]);
  if (tokens.length === 1) return `$${sym(tokens[0][0])} ${tokens[0][1] > 0 ? "Buy" : "Sell"}`;
  const sorted = [...(tokens.length >= 2 ? tokens : changes)].sort((a, b) => a[1] - b[1]);
  if (sorted.length < 2) return "Swap";
  const [sold, bought] = [sorted[0][0], sorted[sorted.length - 1][0]];
  const fmt = (m: string) => (QUOTE_SYMBOLS[m] ? sym(m) : `$${sym(m)}`);
  return `${fmt(sold)} → ${fmt(bought)}`;
}

/** Token symbols, cached in D1 so each mint is looked up once. */
async function symbols(env: Env, mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!mints.length) return out;
  const cached = await env.DB.prepare(`SELECT mint, symbol FROM tokens WHERE mint IN (${mints.map(() => "?").join(",")})`).bind(...mints).all<{ mint: string; symbol: string }>();
  for (const c of cached.results ?? []) out[c.mint] = c.symbol;
  const missing = mints.filter((m) => !out[m]);
  if (missing.length) {
    try {
      const found = (await jup(env, `/tokens/v2/search?query=${missing.join(",")}`)) as { id: string; symbol: string }[];
      for (const t of found ?? []) {
        if (!missing.includes(t.id) || !t.symbol) continue;
        out[t.id] = t.symbol.toUpperCase().slice(0, 16);
        await env.DB.prepare("INSERT OR REPLACE INTO tokens (mint, symbol) VALUES (?, ?)").bind(t.id, out[t.id]).run();
      }
    } catch {}
  }
  return out;
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
  const vaultKey = vaultPda(programId, owner);
  const [vaultAcc] = await getAccounts(env, [vaultKey]);
  if (!vaultAcc) return skip(env, wallet, "No vault");
  const vault = decodeVault(vaultAcc.data);
  if (vault.paused) return skip(env, wallet, "Round-ups are paused");
  const fi = fundingInfo(vault.fundingMint);
  const [sourceAcc] = await getAccounts(env, [vault.fundingAccount]);
  if (!sourceAcc) return skip(env, wallet, `Your ${fi.kind} funding account is missing; set it up again in the app`);
  const source = decodeTokenAccount(sourceAcc.data);
  if (!source.delegate || !source.delegate.equals(vaultKey)) return skip(env, wallet, `${fi.kind} approval for Cache is missing; re-approve in the app`);

  // Amounts below are in the funding token's base units; round-ups are dollars, converted at today's price.
  const price = fi.kind === "SOL" ? (await prices(env, [SOL]))[SOL] : 1;
  if (!price) return skip(env, wallet, "Couldn't get the SOL price; will retry");
  const pending = await pendingUsd(env, wallet);
  const pendingUnits = toUnits(pending / price, fi.decimals);
  const capLeft = now() >= vault.periodStart + 7 * 86400 ? vault.weeklyCap : vault.weeklyCap - vault.spentInPeriod;
  const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
  const amount = min(pendingUnits, capLeft, source.delegatedAmount, source.amount);
  const amountUsd = Math.floor(fromUnits(amount, fi.decimals) * price * 100) / 100;
  if (amountUsd < minSweep(env)) {
    const f = (u: bigint) => `${fromUnits(u, fi.decimals).toFixed(fi.kind === "SOL" ? 4 : 2)} ${fi.kind}`;
    return skip(env, wallet, `Nothing to sweep yet ($${amountUsd.toFixed(2)} available; pending $${pending.toFixed(2)}, limit left ${f(capLeft)}, balance ${f(source.amount)}, approval ${f(source.delegatedAmount)})`);
  }

  // Split across picks; small amounts go to one pick, rotating each sweep.
  const picks = vault.picks;
  const n = amountUsd / picks.length >= 0.5 ? picks.length : 1;
  const legs = Array.from({ length: n }, (_, i) => {
    const mint = n === 1 ? picks[Number(vault.sweepCount % BigInt(picks.length))] : picks[i];
    const units = i === n - 1 ? amount - (amount / BigInt(n)) * BigInt(n - 1) : amount / BigInt(n);
    return { mint, units, usd: Math.round(fromUnits(units, fi.decimals) * price * 100) / 100 };
  });

  const results: any[] = [];
  const ctx: SweepCtx = {
    blockhash: await rpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }]).then((r) => r.value),
    alts: new Map(), fundingMint: vault.fundingMint, userSource: vault.fundingAccount,
  };
  for (const leg of legs) results.push(await sweepLeg(env, keeper, programId, owner, leg.mint, leg.units, leg.usd, ctx, false));
  return { swept: results };
}

type SweepCtx = { blockhash: { blockhash: string; lastValidBlockHeight: number }; alts: Map<string, AddressLookupTableAccount>; fundingMint: PublicKey; userSource: PublicKey };

// xStocks are Token-2022 mints (verified onchain at setup), so no lookup is needed per sweep.
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN_CLASSIC = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const PROGRAM_ERRORS: Record<number, string> = {
  6015: "This sweep would exceed the weekly limit",
  6016: "The swap returned less than the minimum; nothing moved",
  6017: "The keeper would have kept part of the funds, so the program refused it; nothing moved",
  6005: "Cache is paused", 6006: "Round-ups are paused",
};
function explain(message: string) {
  const m = message.match(/custom program error: 0x([0-9a-f]+)/i);
  const code = m ? parseInt(m[1], 16) : null;
  return code && PROGRAM_ERRORS[code] ? `${PROGRAM_ERRORS[code]} (code 0x${m![1]})` : message;
}

async function sweepLeg(env: Env, keeper: Keypair, programId: PublicKey, owner: PublicKey, mint: PublicKey, amount: bigint, usd: number, ctx: SweepCtx, directOnly: boolean) {
  const wallet = owner.toBase58();
  const keeperSource = ata(keeper.publicKey, ctx.fundingMint);
  const id = (await env.DB.prepare("INSERT INTO sweeps (wallet, ts, mint, amount_usd, status) VALUES (?,?,?,?, 'building') RETURNING id")
    .bind(wallet, now(), mint.toBase58(), usd).first<{ id: number }>())!.id;
  try {
    const tokenProgram = stockByMint(mint.toBase58()) ? TOKEN_2022 : new PublicKey((await getAccount(env, mint))?.owner ?? TOKEN_CLASSIC);
    const dest = ata(owner, mint, tokenProgram);

    const slippage = env.SLIPPAGE_BPS ?? "100";
    const quote = await jup(env, `/swap/v1/quote?inputMint=${ctx.fundingMint.toBase58()}&outputMint=${mint.toBase58()}&amount=${amount}&slippageBps=${slippage}&restrictIntermediateTokens=true&maxAccounts=48${directOnly ? "&onlyDirectRoutes=true" : ""}`);
    if (!quote?.outAmount) throw new Error(`No route for ${stockByMint(mint.toBase58())?.symbol ?? mint.toBase58()}`);
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
      createAtaIdempotentIx(keeper.publicKey, keeper.publicKey, ctx.fundingMint, TOKEN_CLASSIC),
      createAtaIdempotentIx(keeper.publicKey, owner, mint, tokenProgram),
      ...(ins.setupInstructions ?? []).map(toIx),
      beginSweepIx({ programId, owner, keeper: keeper.publicKey, userSource: ctx.userSource, keeperSource, dest, amount, minOut }),
      toIx(ins.swapInstruction),
      endSweepIx({ programId, owner, keeper: keeper.publicKey, keeperSource, dest, userSource: ctx.userSource }),
      ...(ins.cleanupInstruction ? [toIx(ins.cleanupInstruction)] : []),
    ];
    const missingAlts = (ins.addressLookupTableAddresses ?? []).filter((a: string) => !ctx.alts.has(a));
    for (const alt of await loadAlts(env, missingAlts)) ctx.alts.set(alt.key.toBase58(), alt);
    const alts = (ins.addressLookupTableAddresses ?? []).map((a: string) => ctx.alts.get(a)).filter(Boolean) as AddressLookupTableAccount[];
    const msg = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: ctx.blockhash.blockhash, instructions: ixs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([keeper]);
    const raw = btoa(String.fromCharCode(...tx.serialize()));
    const sig: string = await rpc(env, "sendTransaction", [raw, { encoding: "base64", skipPreflight: false, maxRetries: 5, preflightCommitment: "confirmed" }]);
    await env.DB.prepare("UPDATE sweeps SET sig = ?, status = 'sent', expected_out = ?, lvbh = ? WHERE id = ?")
      .bind(sig, quote.outAmount, ctx.blockhash.lastValidBlockHeight, id).run();

    // One quick check; anything still in flight is settled by the next status read (the app polls after a sweep).
    await new Promise((res) => setTimeout(res, 2500));
    const st = (await rpc(env, "getSignatureStatuses", [[sig]])).value?.[0];
    let status = "sent";
    if (st?.err) {
      status = "failed";
      await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = 'Transaction failed onchain' WHERE id = ?").bind(id).run();
    } else if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      status = "confirmed";
      await env.DB.prepare("UPDATE sweeps SET status = 'confirmed' WHERE id = ?").bind(id).run();
    }
    return { mint: mint.toBase58(), usd, sig, status };
  } catch (e: any) {
    const message = explain((e?.message ?? String(e)).slice(0, 500));
    await env.DB.prepare("UPDATE sweeps SET status = 'failed', error = ? WHERE id = ?").bind(message, id).run();
    await log(env, wallet, "error", `sweep ${mint.toBase58()}${directOnly ? " (direct route)" : ""}: ${message}`);
    return { mint: mint.toBase58(), usd, status: "failed", error: message };
  }
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

type Acc = { data: Uint8Array; owner: string; lamports: number };
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function getAccount(env: Env, key: PublicKey): Promise<Acc | null> {
  return (await getAccounts(env, [key]))[0];
}

async function getAccounts(env: Env, keys: PublicKey[]): Promise<(Acc | null)[]> {
  const r = await rpc(env, "getMultipleAccounts", [keys.map((k) => k.toBase58()), { encoding: "base64", commitment: "confirmed" }]);
  return r.value.map((v: any) => (v ? { data: b64(v.data[0]), owner: v.owner, lamports: v.lamports } : null));
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
