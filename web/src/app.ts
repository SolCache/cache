import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  addToCacheSolIxs, withdrawFromCacheSolIxs, approveIx, ata, cacheSolAccount, closeTokenAccountIx, closeVaultIx, computeUnitLimitIx, createAtaIdempotentIx,
  loadedAccountsDataSizeLimitIx,
  createCacheSolAccountIxs, initializeVaultIx, MAX_PICKS, MULTIPLIERS, revokeIx, SOL_DECIMALS, STOCKS, stockByMint,
  toUnits, TOKEN_PROGRAM_ID, updateVaultIx, USDC_DECIMALS, USDC_MINT, vaultPda,
} from "./shared/cache";

// ---------------------------------------------------------------- types & state

type Funding = "USDC" | "SOL";
type Stock = { symbol: string; name: string; mint: string };
type Config = {
  programId: string; keeper: string; config: null | { paused: boolean; keeper: string; allowedMints: string[] };
  keeperMatches: boolean; stocks: Stock[]; minSweepUsd: number; solPriceUsd: number | null;
};
type TokenState = { balance: number; approved: boolean; allowance: number };
type State = {
  registered: boolean; pendingUsd: number; solPriceUsd: number | null;
  vault: null | {
    funding: Funding; fundingAccount: string; picks: string[]; weeklyCap: number; multiplier: number; paused: boolean;
    spentThisWeek: number; periodStart: number; totalSwept: number; sweepCount: number;
  };
  usdc: TokenState | null;
  cacheSol: (TokenState & { account: string }) | null;
  walletSol: number;
  trades: any[]; sweeps: any[];
};

const USDC_CAP_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const SOL_CAP_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000];
const ALLOWANCE_WEEKS = [1, 4, 12];
const SOL_RESERVE = 0.03; // kept in the wallet for fees and account deposits

let cfg: Config;
let provider: any = null;
let owner: PublicKey | null = null;
let state: State | null = null;
let editing = false;
let busy = false;
const form = { funding: "USDC" as Funding, picks: [] as string[], capUsd: 25, capSol: 0.25, mult: 1, weeks: 4 };

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const main = $("#main");
const money = (n: number, d = 2) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sol = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 })} SOL`;
const amountIn = (f: Funding, n: number) => (f === "SOL" ? sol(n) : money(n));
const short = (k: string) => k.slice(0, 4) + "…" + k.slice(-4);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
const programId = () => new PublicKey(cfg.programId);
const capFor = (f: Funding) => (f === "SOL" ? form.capSol : form.capUsd);
const decimalsFor = (f: Funding) => (f === "SOL" ? SOL_DECIMALS : USDC_DECIMALS);

// ---------------------------------------------------------------- network

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

async function rpc(method: string, params: unknown[]) {
  const j = await api("/api/rpc", { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(j.error.message ?? "RPC error");
  return j.result;
}

async function accounts(keys: PublicKey[]) {
  const r = await rpc("getMultipleAccounts", [keys.map((k) => k.toBase58()), { encoding: "base64", commitment: "confirmed" }]);
  return r.value.map((v: any) => (v ? { owner: v.owner as string, data: Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) } : null));
}

// ---------------------------------------------------------------- wallets

const WALLETS = [
  { name: "Phantom", get: () => (window as any).phantom?.solana, url: "https://phantom.com" },
  { name: "Solflare", get: () => (window as any).solflare, url: "https://solflare.com" },
  { name: "Backpack", get: () => (window as any).backpack, url: "https://backpack.app" },
];

async function connect(name: string) {
  const w = WALLETS.find((x) => x.name === name)!;
  const p = w.get();
  if (!p) { window.open(w.url, "_blank"); return; }
  await p.connect();
  provider = p;
  owner = new PublicKey(p.publicKey.toString());
  try { localStorage.setItem("cache:wallet", name); } catch {}
  p.on?.("accountChanged", () => location.reload());
  await refresh();
}

async function disconnect() {
  try { await provider?.disconnect?.(); } catch {}
  try { localStorage.removeItem("cache:wallet"); } catch {}
  provider = null; owner = null; state = null;
  render();
}

const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

type SimResult = { err: unknown; logs?: string[] | null; unitsConsumed?: number; loadedAccountsDataSize?: number };

/** Simulate an unsigned transaction (Phantom's guidance: sigVerify off, before asking the wallet to sign). */
async function simulate(tx: VersionedTransaction): Promise<SimResult> {
  const r = await rpc("simulateTransaction", [b64(tx.serialize()), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  return r.value as SimResult;
}

function simError(label: string, sim: SimResult) {
  const logs = (sim.logs ?? []).join("\n");
  const msg = /insufficient (funds|lamports)/i.test(logs) ? "not enough balance to cover it"
    : (logs.match(/Error Message: ([^.\n]+)/)?.[1] ?? (typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err)));
  return new Error(`${label} would fail: ${msg}. Nothing was sent.`);
}

const MAX_UNITS = 1_400_000;
const MAX_LOADED_BYTES = 64 * 1024 * 1024;

async function send(ixs: TransactionInstruction[], label: string) {
  if (!provider || !owner) throw new Error("Connect a wallet first");
  const payer = owner;
  const { value: bh } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const build = (list: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: list }).compileToV0Message());

  // 1. Measure: simulate with the maximum compute budget.
  toast(`${label}: preparing…`);
  const probe = await simulate(build([computeUnitLimitIx(MAX_UNITS), ...ixs]));
  if (probe.err) throw simError(label, probe);

  // 2. Set explicit limits from the measurement, with headroom for the wallet's own safety checks.
  const used = probe.unitsConsumed ?? 200_000;
  const units = Math.min(MAX_UNITS, Math.max(Math.ceil(used * 1.3), used + 40_000));
  const loaded = probe.loadedAccountsDataSize;
  const bytes = Math.min(MAX_LOADED_BYTES, loaded ? Math.max(Math.ceil(loaded * 1.5), loaded + 2 * 1024 * 1024) : 8 * 1024 * 1024);
  let tx = build([computeUnitLimitIx(units), loadedAccountsDataSizeLimitIx(bytes), ...ixs]);

  // 3. Simulate the exact transaction the wallet will see.
  let check = await simulate(tx);
  if (check.err) {
    tx = build([computeUnitLimitIx(units), ...ixs]);
    check = await simulate(tx);
    if (check.err) throw simError(label, check);
  }

  // 4. The wallet only signs; we send through our own RPC with preflight on.
  toast(`${label}: approve it in your wallet…`);
  const signed: VersionedTransaction = await provider.signTransaction(tx);
  const sig: string = await rpc("sendTransaction", [b64(signed.serialize()), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]);
  toast(`${label}: confirming…`);
  for (let i = 0; i < 40; i++) {
    const r = await rpc("getSignatureStatuses", [[sig]]);
    const s = r.value?.[0];
    if (s?.err) throw new Error(`${label} failed onchain. <a href="${solscan(sig)}" target="_blank" rel="noopener">View on Solscan</a>`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      toast(`${label} confirmed. <a href="${solscan(sig)}" target="_blank" rel="noopener">View on Solscan</a>`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label} is taking long to confirm. <a href="${solscan(sig)}" target="_blank" rel="noopener">Check Solscan</a>`);
}

// ---------------------------------------------------------------- actions

async function tokenProgramsFor(mints: string[]) {
  const accs = await accounts(mints.map((m) => new PublicKey(m)));
  return accs.map((a: any, i: number) => {
    if (!a) throw new Error(`Stock mint ${mints[i]} not found`);
    return new PublicKey(a.owner);
  });
}

/** SOL the user will move into the Cache SOL account at setup (also the approval). */
const solSetAside = () => Math.round(form.capSol * form.weeks * 1e4) / 1e4;
const solShortfall = () => Math.max(0, solSetAside() + SOL_RESERVE - (state?.walletSol ?? 0));

async function saveSettings() {
  if (!owner) return;
  if (!form.picks.length) throw new Error("Pick at least one stock");
  const picks = form.picks.map((m) => new PublicKey(m));
  const progs = await tokenProgramsFor(form.picks);
  const destAtas = form.picks.map((m, i) => ata(owner!, new PublicKey(m), progs[i]));
  const existing = await accounts(destAtas);
  const ataIxs: TransactionInstruction[] = [];
  form.picks.forEach((m, i) => { if (!existing[i]) ataIxs.push(createAtaIdempotentIx(owner!, owner!, new PublicKey(m), progs[i])); });
  const vault = vaultPda(programId(), owner);

  // Editing an existing vault: settings only (switching between USDC and SOL means Stop and set up again).
  if (state?.vault) {
    const f = state.vault.funding;
    const ixs = [...ataIxs, updateVaultIx({ programId: programId(), owner, picks, weeklyCap: toUnits(capFor(f), decimalsFor(f)), multiplier: form.mult, paused: state.vault.paused })];
    if (f === "USDC") ixs.push(approveIx(ata(owner, USDC_MINT), vault, owner, toUnits(form.capUsd * form.weeks, USDC_DECIMALS)));
    await send(ixs, "Saving settings");
    editing = false;
    return refresh();
  }

  let fundingIxs: TransactionInstruction[];
  let fundingAccount: PublicKey;
  if (form.funding === "USDC") {
    fundingAccount = ata(owner, USDC_MINT);
    fundingIxs = [createAtaIdempotentIx(owner, owner, USDC_MINT, TOKEN_PROGRAM_ID)];
    fundingIxs.push(approveIx(fundingAccount, vault, owner, toUnits(form.capUsd * form.weeks, USDC_DECIMALS)));
  } else {
    if (solShortfall() > 0) throw new Error(`You need about ${sol(solShortfall())} more SOL in this wallet, or a smaller limit.`);
    fundingAccount = await cacheSolAccount(owner);
    const lamports = toUnits(solSetAside(), SOL_DECIMALS);
    const [existingSol] = await accounts([fundingAccount]);
    const rent = await rpc("getMinimumBalanceForRentExemption", [165]);
    fundingIxs = existingSol ? await addToCacheSolIxs(owner, lamports) : await createCacheSolAccountIxs(owner, lamports, rent);
    fundingIxs.push(approveIx(fundingAccount, vault, owner, lamports));
  }
  const init = initializeVaultIx({ programId: programId(), owner, fundingAccount, picks, weeklyCap: toUnits(capFor(form.funding), decimalsFor(form.funding)), multiplier: form.mult });
  // The approval must come after the funding account exists; the vault instruction checks the account too.
  const approve = fundingIxs.pop()!;
  const mainIxs = [...fundingIxs, init, approve];

  // Keep each transaction under Solana's size limit: several new stock accounts go in their own transaction first.
  if (ataIxs.length > 2) {
    await send(ataIxs, "Creating your stock accounts");
    await send(mainIxs, "Starting Cache");
  } else {
    await send([...ataIxs, ...mainIxs], "Starting Cache");
  }
  await api("/api/register", { wallet: owner.toBase58() });
  editing = false;
  await refresh();
}

async function setPaused(paused: boolean) {
  if (!owner || !state?.vault) return;
  const v = state.vault;
  await send([updateVaultIx({ programId: programId(), owner, picks: v.picks.map((m) => new PublicKey(m)), weeklyCap: toUnits(v.weeklyCap, decimalsFor(v.funding)), multiplier: v.multiplier, paused })], paused ? "Pausing" : "Resuming");
  await refresh();
}

async function topUp() {
  if (!owner || !state?.vault) return;
  const v = state.vault;
  const vault = vaultPda(programId(), owner);
  if (v.funding === "USDC") {
    await send([approveIx(ata(owner, USDC_MINT), vault, owner, toUnits(v.weeklyCap * form.weeks, USDC_DECIMALS))], "Updating approval");
  } else {
    const add = Math.round(v.weeklyCap * form.weeks * 1e4) / 1e4;
    if (add + SOL_RESERVE > state.walletSol) throw new Error(`Adding ${sol(add)} needs more SOL in your wallet.`);
    const account = await cacheSolAccount(owner);
    const total = (state.cacheSol?.balance ?? 0) + add;
    await send([...(await addToCacheSolIxs(owner, toUnits(add, SOL_DECIMALS))), approveIx(account, vault, owner, toUnits(total, SOL_DECIMALS))], `Adding ${sol(add)}`);
  }
  await refresh();
}

async function withdrawSol() {
  if (!owner || !state?.vault || !state.cacheSol || !withdrawPct) return;
  const balance = toUnits(state.cacheSol.balance, SOL_DECIMALS);
  const amount = withdrawPct === 100 ? balance : (balance * BigInt(withdrawPct)) / 100n;
  if (amount <= 0n) throw new Error("Your Cache SOL account is empty.");
  const rent = await rpc("getMinimumBalanceForRentExemption", [165]);
  const account = await cacheSolAccount(owner);
  const ixs = await withdrawFromCacheSolIxs(owner, amount, rent);
  // Keep the approval in line with what's left.
  ixs.push(approveIx(account, vaultPda(programId(), owner), owner, balance - amount));
  await send(ixs, `Unwrapping ${sol(Number(amount) / 1e9)} to your wallet`);
  withdrawPct = null;
  await refresh();
}

async function stopCache() {
  if (!owner || !state?.vault) return;
  const ixs: TransactionInstruction[] = [];
  if (state.vault.funding === "USDC") {
    ixs.push(revokeIx(ata(owner, USDC_MINT), owner));
  } else {
    const account = await cacheSolAccount(owner);
    ixs.push(revokeIx(account, owner), closeTokenAccountIx(account, owner, owner));
  }
  ixs.push(closeVaultIx({ programId: programId(), owner }));
  await send(ixs, state.vault.funding === "SOL" ? "Stopping Cache and returning your SOL" : "Stopping Cache");
  await refresh();
}

const SWAP_ERRORS: Record<string, string> = {
  "0x1771": "Price moved more than the slippage limit",
  "0x1": "Not enough funds for the swap",
};
function swapError(e: any) {
  const msg = String(e?.message ?? e);
  const code = msg.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]?.toLowerCase();
  if (code && SWAP_ERRORS[code]) return SWAP_ERRORS[code];
  if (/blockhash/i.test(msg)) return "Took too long to sign; retry";
  if (/rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet";
  return msg.replace(/^sendTransaction: /, "").slice(0, 120);
}

async function previewConvert(mints?: string[]) {
  if (!owner) return;
  const r = await api<{ legs: SellLeg[]; totalUsdc: number }>("/api/sell", { wallet: owner.toBase58(), mints });
  if (!r.legs.length) { toast("You don't hold any xStocks yet."); convert = null; return; }
  convert = r;
}

/** Builds fresh swaps at confirm time, signs them together, and sends each one independently. */
async function confirmConvert() {
  if (!owner || !provider || !convert) return;
  const wanted = convert.legs.filter((l) => l.status !== "converted").map((l) => l.mint);
  const r = await api<{ legs: SellLeg[] }>("/api/sell", { wallet: owner.toBase58(), build: true, mints: wanted });
  const results = new Map<string, SellLeg>(convert.legs.map((l) => [l.mint, { ...l }]));
  for (const l of r.legs) results.set(l.mint, { ...results.get(l.mint), ...l, status: l.tx ? "pending" : "failed", error: l.tx ? undefined : l.error });
  const built = r.legs.filter((l) => l.tx);
  // Simulate each swap before asking for signatures; drop any that would fail.
  const sims = await Promise.all(built.map((l) => simulate(VersionedTransaction.deserialize(Uint8Array.from(atob(l.tx!), (c) => c.charCodeAt(0)))).catch(() => null)));
  const legs = built.filter((l, i) => {
    const sim = sims[i];
    if (sim && sim.err) { results.set(l.mint, { ...results.get(l.mint)!, status: "failed", error: simError("Swap", sim).message.replace(/^Swap would fail: /, "") }); return false; }
    return true;
  });
  if (legs.length) {
    const txs = legs.map((l) => VersionedTransaction.deserialize(Uint8Array.from(atob(l.tx!), (c) => c.charCodeAt(0))));
    toast(`Approve ${txs.length} swap${txs.length === 1 ? "" : "s"} in your wallet…`);
    const signed: VersionedTransaction[] = provider.signAllTransactions ? await provider.signAllTransactions(txs) : await Promise.all(txs.map((t) => provider.signTransaction(t)));
    const sent: { mint: string; sig: string }[] = [];
    await Promise.all(signed.map(async (t, i) => {
      try {
        const sig = await rpc("sendTransaction", [b64(t.serialize()), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]);
        sent.push({ mint: legs[i].mint, sig });
      } catch (e) {
        results.set(legs[i].mint, { ...results.get(legs[i].mint)!, status: "failed", error: swapError(e) });
      }
    }));
    toast("Converting to USDC: confirming…");
    for (let i = 0; i < 25 && sent.some((x) => results.get(x.mint)!.status === "pending"); i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const st = (await rpc("getSignatureStatuses", [sent.map((x) => x.sig)])).value ?? [];
      sent.forEach((x, j) => {
        const s = st[j];
        if (s?.err) results.set(x.mint, { ...results.get(x.mint)!, status: "failed", error: swapError(JSON.stringify(s.err)) });
        else if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) results.set(x.mint, { ...results.get(x.mint)!, status: "converted", tx: x.sig });
      });
    }
    sent.forEach((x) => { if (results.get(x.mint)!.status === "pending") results.set(x.mint, { ...results.get(x.mint)!, status: "failed", error: "Didn't land in time; retry" }); });
  }
  const all = [...results.values()];
  convert = { legs: all, totalUsdc: all.reduce((a, l) => a + (l.usdcOut ?? 0), 0), done: true };
  const ok = all.filter((l) => l.status === "converted").length;
  const failed = all.filter((l) => l.status === "failed").length;
  toast(failed ? `Converted ${ok} of ${all.length}. Use “Retry failed” for the rest.` : `All ${ok} converted to USDC.`, failed > 0);
  if (owner && state?.vault) await loadHoldings(state.vault.picks).catch(() => {});
  if (!failed) setTimeout(() => { convert = null; render(); }, 6000);
}

async function sweepNow() {
  if (!owner) return;
  toast("Sweeping your round-ups… this can take up to a minute.");
  const r = await api("/api/sweep", { wallet: owner.toBase58() });
  state = r.state;
  const res = r.result;
  if (res?.skipped) toast(esc(res.skipped));
  else if (res?.swept) {
    const ok = res.swept.filter((s: any) => s.status === "confirmed").length;
    const failed = res.swept.filter((s: any) => s.status === "failed");
    const pending = res.swept.filter((s: any) => s.status === "sent").length;
    toast(failed.length ? `Swept ${ok} of ${res.swept.length}. ${esc(failed[0].error)}` : pending ? `Sent ${res.swept.length} swap${res.swept.length === 1 ? "" : "s"}; confirming…` : `Swept into ${ok} stock${ok === 1 ? "" : "s"}.`, failed.length > 0);
  }
  render();
  for (let i = 0; i < 12 && state?.sweeps.some((w: any) => w.status === "sent" || w.status === "building"); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    state = await api<State>(`/api/state?wallet=${owner.toBase58()}`);
    render();
  }
  if (owner && state?.vault) await loadHoldings(state.vault.picks).catch(() => {});
  render();
}

// ---------------------------------------------------------------- data

let holdings: { symbol: string; amount: number }[] = [];
type SellLeg = { mint: string; symbol: string; amount: string; usdcOut?: number; tx?: string; error?: string; status?: "converted" | "failed" | "pending" };
let withdrawPct: number | null = null;
let convert: null | { legs: SellLeg[]; totalUsdc: number; done?: boolean } = null;

async function refresh() {
  if (!owner) return render();
  state = await api<State>(`/api/state?wallet=${owner.toBase58()}`);
  if (state.vault && !state.registered) {
    await api("/api/register", { wallet: owner.toBase58() }).catch(() => {});
    state = await api<State>(`/api/state?wallet=${owner.toBase58()}`);
  }
  if (state.vault) {
    form.funding = state.vault.funding;
    form.picks = [...state.vault.picks];
    if (state.vault.funding === "SOL") form.capSol = state.vault.weeklyCap; else form.capUsd = state.vault.weeklyCap;
    form.mult = state.vault.multiplier;
    await loadHoldings(state.vault.picks).catch(() => (holdings = []));
  }
  render();
}

async function loadHoldings(picks: string[]) {
  const mints = await accounts(picks.map((m) => new PublicKey(m)));
  const atas = picks.map((m, i) => ata(owner!, new PublicKey(m), new PublicKey(mints[i]?.owner ?? TOKEN_PROGRAM_ID)));
  const accs = await accounts(atas);
  holdings = picks.map((m, i) => {
    const decimals = mints[i]?.data[44] ?? 0;
    const a = accs[i];
    const raw = a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
    return { symbol: stockByMint(m)?.symbol ?? short(m), amount: Number(raw) / 10 ** decimals };
  });
}

// ---------------------------------------------------------------- render

function render() {
  renderWallet();
  if (!cfg.config) { main.innerHTML = notReady(); return; }
  if (!owner) { main.innerHTML = connectView(); return; }
  if (!state) { main.innerHTML = `<section class="card center"><p class="muted">Loading your Cache…</p></section>`; return; }
  main.innerHTML = !state.vault || editing ? setupView() : dashboardView();
  paintRanges();
}

function renderWallet() {
  $("#walletSlot").innerHTML = owner
    ? `<div class="row"><span class="chip"><span class="dot"></span>${short(owner.toBase58())}</span><button class="btn btn-ghost btn-sm" data-act="disconnect">Disconnect</button></div>`
    : "";
}

function notReady() {
  return `<section class="card center"><span class="tile" style="width:84px"></span><h2>Cache isn't set up on mainnet yet</h2>
    <p class="muted">The program is deployed but its configuration hasn't been initialized.</p>
    <p class="dim mono">Program ${esc(cfg.programId)}</p></section>`;
}

function connectView() {
  const list = WALLETS.map((w) => `<button class="wallet" data-act="connect" data-name="${w.name}">${w.name}<span>${w.get() ? "Detected" : "Install"}</span></button>`).join("");
  return `<section class="card center"><span class="tile" style="width:96px"></span>
    <h2>Connect your wallet</h2>
    <p class="muted" style="max-width:34em">Cache follows this address for swaps and sends the xStocks it buys back here. Your funds stay in your wallet until a sweep.</p>
    <div class="wallets">${list}</div>
  </section>`;
}

function setupView() {
  const isEdit = !!state?.vault;
  const f = isEdit ? state!.vault!.funding : form.funding;
  const stocks = cfg.stocks.length ? cfg.stocks : STOCKS;
  const steps = f === "SOL" ? SOL_CAP_STEPS : USDC_CAP_STEPS;
  const cap = capFor(f);
  const capIdx = Math.max(0, steps.indexOf(cap) === -1 ? steps.findIndex((c) => c >= cap) : steps.indexOf(cap));
  const usdHint = f === "SOL" && cfg.solPriceUsd ? ` <span class="dim" style="font-size:13px">≈ ${money(cap * cfg.solPriceUsd, 0)}</span>` : "";
  const total = cap * form.weeks;
  const shortfall = f === "SOL" && !isEdit ? solShortfall() : 0;
  return `<section class="card stack">
    <div><span class="pixel" style="color:var(--accent)">${isEdit ? "Edit settings" : "Set up Cache"}</span>
    <h2 style="margin-top:6px">${isEdit ? "Change how Cache works for you" : "A few choices, one signature"}</h2></div>

    <div class="field"><span class="flabel" id="fundLbl">Invest round-ups from</span>
      ${isEdit
        ? `<p class="dim" style="font-size:13.5px">Paying with <b style="color:var(--fg)">${f}</b>. To switch, stop Cache and set it up again.</p>`
        : `<div class="seg" role="group" aria-labelledby="fundLbl" style="max-width:320px">${(["USDC", "SOL"] as Funding[]).map((x) => `<button data-act="funding" data-f="${x}" aria-pressed="${f === x}">${x}</button>`).join("")}</div>
           <p class="dim" style="font-size:13px">${f === "USDC"
             ? "Cache spends USDC from your wallet, up to the approval below."
             : "Cache moves the SOL below into a dedicated Cache SOL account in your wallet (shown as Wrapped SOL) and spends from that. Stopping returns it as normal SOL."}</p>`}</div>

    <div class="field"><div class="field-top"><span class="flabel">Pick your stocks</span><span class="dim">${form.picks.length}/${MAX_PICKS}</span></div>
      <div class="picker">${stocks.map((s) => `<button class="stock" data-act="pick" data-mint="${s.mint}" aria-pressed="${form.picks.includes(s.mint)}"><span class="tk">${esc(s.symbol)}</span><span class="nm">${esc(s.name)}</span></button>`).join("")}</div></div>

    <div class="grid2">
      <div class="field"><div class="field-top"><label for="cap">Weekly limit</label><span><span class="big grad-text mono" id="capOut">${amountIn(f, cap).replace(".00", "")}</span>${usdHint}</span></div>
        <input type="range" id="cap" data-funding="${f}" min="0" max="${steps.length - 1}" step="1" value="${capIdx}">
        <div class="field-top dim" style="font-size:12px"><span>${f === "SOL" ? "0.05 SOL" : "$5"}</span><span>${f === "SOL" ? "1,000 SOL" : "$100,000"}</span></div></div>
      <div class="field"><span class="flabel" id="multLbl">Round-up multiplier</span>
        <div class="seg" role="group" aria-labelledby="multLbl">${MULTIPLIERS.map((m) => `<button data-act="mult" data-m="${m}" aria-pressed="${form.mult === m}">${m}x</button>`).join("")}</div></div>
    </div>

    ${isEdit && f === "SOL" ? "" : `<div class="field"><span class="flabel" id="wkLbl">${f === "SOL" ? "SOL to set aside" : "USDC approval"}</span>
      <div class="seg" role="group" aria-labelledby="wkLbl" style="max-width:420px">${ALLOWANCE_WEEKS.map((w) => `<button data-act="weeks" data-w="${w}" aria-pressed="${form.weeks === w}">${w} wk${w > 1 ? "s" : ""}</button>`).join("")}</div>
      <p class="dim" style="font-size:13px">${f === "SOL"
        ? `Moves <b class="mono" style="color:var(--fg)">${sol(total)}</b> into your Cache SOL account. Cache never spends more than your weekly limit in a week.`
        : `Cache can spend up to <b class="mono" style="color:var(--fg)">${money(total, 0)}</b> of your USDC in total before you top up, and never more than your weekly limit in a week.`}</p></div>`}

    <div class="summary">
      <div><span>Pay with</span><b>${f}</b></div>
      <div><span>Stocks</span><b>${form.picks.map((m) => esc(stockByMint(m)?.symbol ?? short(m))).join(", ") || "None yet"}</b></div>
      <div><span>Round-ups</span><b>To the next dollar × ${form.mult}</b></div>
      <div><span>Weekly limit</span><b>${amountIn(f, cap)}</b></div>
      ${isEdit && f === "SOL" ? "" : `<div><span>${f === "SOL" ? "Set aside" : "Approval"}</span><b>${amountIn(f, total)}</b></div>`}
      <div><span>Sweeps</span><b>Daily at 12:00 UTC, or any time with “Sweep now”</b></div>
    </div>
    ${shortfall > 0 ? `<p class="note warn">Your wallet has ${sol(state?.walletSol ?? 0)}. Setting aside ${sol(total)} needs about ${sol(shortfall)} more, or pick a smaller limit or fewer weeks.</p>` : ""}
    ${!isEdit ? `<p class="dim" style="font-size:13px">First-time setup also opens a token account for each stock (about 0.002 SOL each, refundable if you close them).</p>` : ""}
    <div class="row">
      ${isEdit ? `<button class="btn btn-ghost" data-act="cancel-edit">Cancel</button>` : ""}
      <button class="btn btn-primary" data-act="save" ${form.picks.length && !busy && shortfall === 0 ? "" : "disabled"}>${isEdit ? "Save changes" : "Sign and start"}</button>
    </div>
  </section>`;
}

function dashboardView() {
  const s = state!, v = s.vault!, f = v.funding;
  const src = f === "SOL" ? s.cacheSol : s.usdc;
  const spentPct = Math.min(100, (v.spentThisWeek / v.weeklyCap) * 100);
  const price = f === "SOL" ? s.solPriceUsd ?? cfg.solPriceUsd ?? 0 : 1;
  const allowanceUsd = (src?.allowance ?? 0) * price;
  const warn = !src ? (f === "SOL" ? "Your Cache SOL account is missing. Stop Cache and set it up again." : "You don't have a USDC account yet. Add some USDC to this wallet.") :
    !src.approved ? `Cache's ${f} approval is missing (another app may have replaced it). Use “${f === "SOL" ? "Add SOL" : "Top up approval"}” to keep sweeps working.` :
    allowanceUsd < Math.min(s.pendingUsd, v.weeklyCap * price) ? `Your ${f === "SOL" ? "Cache SOL balance" : "USDC approval"} is running low. Top it up below.` :
    src.balance * price < cfg.minSweepUsd ? `Your ${f === "SOL" ? "Cache SOL" : "USDC"} balance is below the ${money(cfg.minSweepUsd)} minimum sweep.` : "";
  const sweptLabel = f === "SOL" ? `${sol(v.totalSwept)}${price ? ` <span class="dim" style="font-size:14px">≈ ${money(v.totalSwept * price)}</span>` : ""}` : money(v.totalSwept);
  return `
  ${v.paused ? `<p class="note warn">Round-ups are paused. New trades aren't counted until you resume.</p>` : ""}
  ${warn ? `<p class="note warn">${warn}</p>` : ""}
  <section class="stats">
    <div class="stat"><span class="label">Pending round-ups</span><span class="value grad-text">${money(s.pendingUsd)}</span><span class="sub">Invested at the next sweep</span></div>
    <div class="stat"><span class="label">Invested so far</span><span class="value">${sweptLabel}</span><span class="sub">${v.sweepCount} sweep${v.sweepCount === 1 ? "" : "s"}</span></div>
    <div class="stat"><span class="label">This week</span><span class="value">${amountIn(f, v.spentThisWeek)}</span><div class="bar-track"><i style="width:${spentPct}%"></i></div><span class="sub">of ${amountIn(f, v.weeklyCap)} limit</span></div>
    <div class="stat"><span class="label">${f === "SOL" ? "Cache SOL" : "USDC"}</span><span class="value">${amountIn(f, src?.balance ?? 0)}</span><span class="sub">Approval left ${amountIn(f, src?.allowance ?? 0)}${f === "SOL" ? ` · Wallet ${sol(s.walletSol)}` : ""}</span></div>
  </section>

  <section class="card stack">
    <div class="row" style="justify-content:space-between"><h3>Your stocks</h3><span class="dim" style="font-size:13px">Paid with ${f} · round-ups × ${v.multiplier}</span></div>
    <div class="holdings">${holdings.map((h) => `<div class="holding"><span class="tk">${esc(h.symbol)}</span><span class="amt">${h.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span><span class="dim" style="font-size:12px">tokens in your wallet</span></div>`).join("")}</div>
    <div class="row">
      <button class="btn btn-primary" data-act="sweep" ${busy || v.paused ? "disabled" : ""}>Sweep now</button>
      <button class="btn btn-ghost" data-act="${v.paused ? "resume" : "pause"}" ${busy ? "disabled" : ""}>${v.paused ? "Resume" : "Pause"}</button>
      <button class="btn btn-ghost" data-act="edit" ${busy ? "disabled" : ""}>Edit settings</button>
      <button class="btn btn-ghost" data-act="topup" ${busy ? "disabled" : ""}>${f === "SOL" ? `Add ${sol(Math.round(v.weeklyCap * form.weeks * 1e4) / 1e4)}` : `Top up approval (${form.weeks} wk)`}</button>
      ${f === "SOL" ? `<button class="btn btn-ghost" data-act="withdraw" ${busy || !(s.cacheSol?.balance) ? "disabled" : ""}>Withdraw SOL</button>` : ""}
      <button class="btn btn-ghost" data-act="convert" ${busy || !holdings.some((h) => h.amount > 0) ? "disabled" : ""}>Convert all to USDC</button>
      <button class="btn btn-danger" data-act="stop" ${busy ? "disabled" : ""}>Stop Cache</button>
    </div>
    ${withdrawPct !== null && f === "SOL" ? `<div class="field"><span class="flabel" id="wdLbl">Unwrap from your Cache SOL account (${sol(s.cacheSol?.balance ?? 0)})</span>
      <div class="seg" role="group" aria-labelledby="wdLbl" style="max-width:360px">${[25, 50, 100].map((p) => `<button data-act="withdraw-pct" data-p="${p}" aria-pressed="${withdrawPct === p}">${p === 100 ? "All" : p + "%"}</button>`).join("")}</div>
      <p class="dim" style="font-size:13px">Returns ${withdrawPct ? `<b class="mono" style="color:var(--fg)">${sol(((s.cacheSol?.balance ?? 0) * withdrawPct) / 100)}</b>` : "it"} to your normal SOL balance. Cache keeps running; sweeps use whatever is left, and you can add SOL again anytime.</p>
      <div class="row"><button class="btn btn-ghost" data-act="cancel-withdraw">Cancel</button><button class="btn btn-primary" data-act="confirm-withdraw" ${busy || !withdrawPct ? "disabled" : ""}>Unwrap to wallet</button></div></div>` : ""}
    ${convert ? `<div class="summary">
      ${convert.legs.map((l) => `<div><span>${esc(l.symbol)}</span><b>${
        l.status === "converted" ? `<a href="${solscan(l.tx!)}" target="_blank" rel="noopener" style="color:var(--good)">Converted ≈ ${money(l.usdcOut ?? 0)}</a>`
        : l.status === "failed" ? `<span style="color:var(--bad)">Failed: ${esc(l.error ?? "")}</span>`
        : l.status === "pending" ? `<span class="dim">Confirming…</span>`
        : l.error ? `<span class="dim">${esc(l.error)}</span>` : `≈ ${money(l.usdcOut ?? 0)}`}</b></div>`).join("")}
      ${convert.done ? "" : `<div><span>You'll receive about</span><b class="mono">${money(convert.totalUsdc)} USDC</b></div>`}
    </div>
    ${convert.done ? "" : `<p class="dim" style="font-size:13px">Sells every xStock in this wallet for USDC through Jupiter. Slippage adjusts to each pool, up to 3%. You sign the swaps in your wallet; Cache never holds these funds.</p>`}
    <div class="row">
      <button class="btn btn-ghost" data-act="cancel-convert">${convert.done ? "Close" : "Cancel"}</button>
      ${convert.done
        ? (convert.legs.some((l) => l.status === "failed") ? `<button class="btn btn-primary" data-act="confirm-convert" ${busy ? "disabled" : ""}>Retry failed (${convert.legs.filter((l) => l.status === "failed").length})</button>` : "")
        : `<button class="btn btn-primary" data-act="confirm-convert" ${busy ? "disabled" : ""}>Confirm and sign</button>`}
    </div>` : ""}
  </section>

  <section class="card stack">
    <h3>Round-ups</h3>
    <div class="table-wrap">${s.trades.length ? `<table><thead><tr><th>When</th><th>Trade</th><th>App</th><th style="text-align:right">Value</th><th style="text-align:right">Round-up</th></tr></thead><tbody>
      ${s.trades.map((t) => `<tr><td>${when(t.ts)}</td><td class="desc"><a href="${solscan(t.sig)}" target="_blank" rel="noopener">${esc(t.description || "Swap")}</a></td><td>${esc(t.source || "")}</td><td class="num">${money(t.value_usd)}</td><td class="num" style="color:var(--accent)">+${money(t.roundup_usd)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No round-ups yet. Make a swap from this wallet on any app; it shows up here within about 15 minutes, or right away when you reload this page.</div>`}</div>
  </section>

  <section class="card stack">
    <h3>Sweeps</h3>
    <div class="table-wrap">${s.sweeps.length ? `<table><thead><tr><th>When</th><th>Stock</th><th style="text-align:right">Value</th><th>Status</th><th>Details</th></tr></thead><tbody>
      ${s.sweeps.map((w) => `<tr><td>${when(w.ts)}</td><td class="mono">${esc(stockByMint(w.mint)?.symbol ?? short(w.mint))}</td><td class="num">${money(w.amount_usd)}</td><td><span class="status ${esc(w.status)}">${esc(STATUS_LABEL[w.status] ?? w.status)}</span></td><td class="desc">${w.sig ? `<a href="${solscan(w.sig)}" target="_blank" rel="noopener">Solscan</a> ` : ""}${esc(w.error || "")}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No sweeps yet. Once round-ups reach ${money(cfg.minSweepUsd)}, use “Sweep now” or wait for the daily sweep.</div>`}</div>
  </section>`;
}

const STATUS_LABEL: Record<string, string> = { building: "Preparing", sent: "Pending", confirmed: "Confirmed", failed: "Failed", expired: "Dropped" };
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function paintRanges() {
  const cap = $<HTMLInputElement>("#cap");
  if (cap) cap.style.setProperty("--p", (Number(cap.value) / (Number(cap.max) || 1)) * 100 + "%");
}

let toastTimer: number | undefined;
function toast(html: string, error = false) {
  const t = $("#toast");
  t.innerHTML = html;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 12000 : 7000);
}

// ---------------------------------------------------------------- events

async function run(fn: () => Promise<void>) {
  if (busy) return;
  busy = true; render();
  try { await fn(); }
  catch (e: any) { toast(e?.message ?? String(e), true); }
  finally { busy = false; render(); }
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "connect") return void run(() => connect(b.dataset.name!));
  if (act === "disconnect") return void disconnect();
  if (act === "funding") { form.funding = b.dataset.f as Funding; return render(); }
  if (act === "pick") {
    const m = b.dataset.mint!;
    const i = form.picks.indexOf(m);
    if (i > -1) form.picks.splice(i, 1);
    else if (form.picks.length < MAX_PICKS) form.picks.push(m);
    return render();
  }
  if (act === "mult") { form.mult = Number(b.dataset.m); return render(); }
  if (act === "weeks") { form.weeks = Number(b.dataset.w); return render(); }
  if (act === "save") return void run(saveSettings);
  if (act === "edit") { editing = true; return render(); }
  if (act === "cancel-edit") { editing = false; return void refresh(); }
  if (act === "pause") return void run(() => setPaused(true));
  if (act === "resume") return void run(() => setPaused(false));
  if (act === "topup") return void run(topUp);
  if (act === "sweep") return void run(sweepNow);
  if (act === "convert") return void run(() => previewConvert());
  if (act === "withdraw") { withdrawPct = 0; return render(); }
  if (act === "withdraw-pct") { withdrawPct = Number(b.dataset.p); return render(); }
  if (act === "cancel-withdraw") { withdrawPct = null; return render(); }
  if (act === "confirm-withdraw") return void run(withdrawSol);
  if (act === "cancel-convert") { convert = null; return render(); }
  if (act === "confirm-convert") return void run(confirmConvert);
  if (act === "stop") {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to stop and revoke"; return; }
    return void run(stopCache);
  }
});

// While dragging, update only the label; re-render the summary when the slider is released.
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id !== "cap") return;
  const f = el.dataset.funding as Funding;
  if (f === "SOL") form.capSol = SOL_CAP_STEPS[Number(el.value)];
  else form.capUsd = USDC_CAP_STEPS[Number(el.value)];
  $("#capOut").textContent = amountIn(f, capFor(f)).replace(".00", "");
  paintRanges();
});
document.addEventListener("change", (e) => {
  if ((e.target as HTMLElement).id === "cap") render();
});

// ---------------------------------------------------------------- boot

(async () => {
  try {
    cfg = await api<Config>("/api/config");
  } catch (e: any) {
    main.innerHTML = `<section class="card center"><h2>Cache is unavailable</h2><p class="muted">${esc(e.message)}</p></section>`;
    return;
  }
  render();
  let saved: string | null = null;
  try { saved = localStorage.getItem("cache:wallet"); } catch {}
  const w = WALLETS.find((x) => x.name === saved);
  if (w?.get()) {
    // Reconnect silently if the wallet already trusts this site.
    try { await w.get().connect({ onlyIfTrusted: true }); provider = w.get(); owner = new PublicKey(provider.publicKey.toString()); await refresh(); } catch {}
  }
})();
