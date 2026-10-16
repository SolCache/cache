import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  approveIx, ata, closeVaultIx, createAtaIdempotentIx, initializeVaultIx, MAX_PICKS, MULTIPLIERS, revokeIx,
  STOCKS, stockByMint, toUsdcUnits, TOKEN_PROGRAM_ID, updateVaultIx, USDC_MINT, vaultPda,
} from "./shared/cache";

// ---------------------------------------------------------------- types & state

type Stock = { symbol: string; name: string; mint: string };
type Config = { programId: string; keeper: string; config: null | { paused: boolean; keeper: string; allowedMints: string[] }; keeperMatches: boolean; stocks: Stock[]; minSweepUsd: number };
type State = {
  registered: boolean; pendingUsd: number;
  vault: null | { picks: string[]; weeklyCapUsd: number; multiplier: number; paused: boolean; spentThisWeekUsd: number; periodStart: number; totalSweptUsd: number; sweepCount: number };
  usdc: null | { balanceUsd: number; approvedToCache: boolean; allowanceUsd: number; delegate: string | null };
  trades: any[]; sweeps: any[];
};

const CAP_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const ALLOWANCE_WEEKS = [1, 4, 12];

let cfg: Config;
let provider: any = null;
let owner: PublicKey | null = null;
let state: State | null = null;
let editing = false;
let busy = false;
const form = { picks: [] as string[], cap: 25, mult: 1, weeks: 4 };

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const main = $("#main");
const money = (n: number, d = 2) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (k: string) => k.slice(0, 4) + "…" + k.slice(-4);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
const programId = () => new PublicKey(cfg.programId);

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

async function send(ixs: TransactionInstruction[], label: string) {
  if (!provider || !owner) throw new Error("Connect a wallet first");
  const { value: bh } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  toast(`${label}: approve it in your wallet…`);
  let sig: string;
  if (provider.signAndSendTransaction) {
    const r = await provider.signAndSendTransaction(tx);
    sig = typeof r === "string" ? r : r.signature;
  } else {
    const signed: VersionedTransaction = await provider.signTransaction(tx);
    sig = await rpc("sendTransaction", [btoa(String.fromCharCode(...signed.serialize())), { encoding: "base64" }]);
  }
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

async function saveSettings() {
  if (!owner) return;
  if (!form.picks.length) throw new Error("Pick at least one stock");
  const progs = await tokenProgramsFor(form.picks);
  const destAtas = form.picks.map((m, i) => ata(owner!, new PublicKey(m), progs[i]));
  const existing = await accounts([ata(owner, USDC_MINT), ...destAtas]);
  const ataIxs: TransactionInstruction[] = [];
  if (!existing[0]) ataIxs.push(createAtaIdempotentIx(owner, owner, USDC_MINT, TOKEN_PROGRAM_ID));
  form.picks.forEach((m, i) => { if (!existing[i + 1]) ataIxs.push(createAtaIdempotentIx(owner!, owner!, new PublicKey(m), progs[i])); });

  const picks = form.picks.map((m) => new PublicKey(m));
  const vaultIx = state?.vault
    ? updateVaultIx({ programId: programId(), owner, picks, weeklyCapUsd: form.cap, multiplier: form.mult, paused: state.vault.paused })
    : initializeVaultIx({ programId: programId(), owner, picks, weeklyCapUsd: form.cap, multiplier: form.mult });
  const approve = approveIx(ata(owner, USDC_MINT), vaultPda(programId(), owner), owner, toUsdcUnits(form.cap * form.weeks));

  // Keep each transaction under Solana's size limit: many new stock accounts go in their own transaction first.
  if (ataIxs.length > 3) {
    await send(ataIxs, "Creating your stock accounts");
    await send([vaultIx, approve], state?.vault ? "Saving settings" : "Starting Cache");
  } else {
    await send([...ataIxs, vaultIx, approve], state?.vault ? "Saving settings" : "Starting Cache");
  }
  await api("/api/register", { wallet: owner.toBase58() });
  editing = false;
  await refresh();
}

async function setPaused(paused: boolean) {
  if (!owner || !state?.vault) return;
  const v = state.vault;
  await send([updateVaultIx({ programId: programId(), owner, picks: v.picks.map((m) => new PublicKey(m)), weeklyCapUsd: v.weeklyCapUsd, multiplier: v.multiplier, paused })], paused ? "Pausing" : "Resuming");
  await refresh();
}

async function topUp() {
  if (!owner || !state?.vault) return;
  const amount = state.vault.weeklyCapUsd * form.weeks;
  await send([approveIx(ata(owner, USDC_MINT), vaultPda(programId(), owner), owner, toUsdcUnits(amount))], "Updating approval");
  await refresh();
}

async function stopCache() {
  if (!owner) return;
  await send([revokeIx(ata(owner, USDC_MINT), owner), closeVaultIx({ programId: programId(), owner })], "Stopping Cache");
  await refresh();
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
    toast(failed.length ? `Swept ${ok} of ${res.swept.length}. ${esc(failed[0].error)}` : `Swept into ${ok} stock${ok === 1 ? "" : "s"}.`, failed.length > 0);
  }
  render();
}

// ---------------------------------------------------------------- data

let holdings: { symbol: string; amount: number }[] = [];

async function refresh() {
  if (!owner) return render();
  state = await api<State>(`/api/state?wallet=${owner.toBase58()}`);
  if (state.vault && !state.registered) {
    await api("/api/register", { wallet: owner.toBase58() }).catch(() => {});
    state = await api<State>(`/api/state?wallet=${owner.toBase58()}`);
  }
  if (state.vault) {
    form.picks = [...state.vault.picks];
    form.cap = state.vault.weeklyCapUsd;
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
    <p class="muted">The program is deployed but its configuration hasn't been initialized. Run the “Initialize config” workflow, then reload.</p>
    <p class="dim mono">Program ${esc(cfg.programId)}</p></section>`;
}

function connectView() {
  const list = WALLETS.map((w) => `<button class="wallet" data-act="connect" data-name="${w.name}">${w.name}<span>${w.get() ? "Detected" : "Install"}</span></button>`).join("");
  return `<section class="card center"><span class="tile" style="width:96px"></span>
    <h2>Connect your wallet</h2>
    <p class="muted" style="max-width:34em">Cache follows this address for swaps and sends the xStocks it buys back here. Your funds never leave your wallet until a sweep.</p>
    <div class="wallets">${list}</div>
    <p class="note warn" style="max-width:34em;text-align:left">This is a mainnet test of unaudited software. Use a wallet with only a small amount of USDC. xStocks aren't available to US persons.</p>
  </section>`;
}

function setupView() {
  const isEdit = !!state?.vault;
  const stocks = cfg.stocks.length ? cfg.stocks : STOCKS;
  const capIdx = Math.max(0, CAP_STEPS.indexOf(form.cap) === -1 ? CAP_STEPS.findIndex((c) => c >= form.cap) : CAP_STEPS.indexOf(form.cap));
  const allowance = form.cap * form.weeks;
  return `<section class="card stack">
    <div><span class="pixel" style="color:var(--teal)">${isEdit ? "Edit settings" : "Set up Cache"}</span>
    <h2 style="margin-top:6px">${isEdit ? "Change how Cache works for you" : "Three choices, one signature"}</h2></div>

    <div class="field"><div class="field-top"><span class="flabel">Pick your stocks</span><span class="dim">${form.picks.length}/${MAX_PICKS}</span></div>
      <div class="picker">${stocks.map((s) => `<button class="stock" data-act="pick" data-mint="${s.mint}" aria-pressed="${form.picks.includes(s.mint)}"><span class="tk">${esc(s.symbol)}</span><span class="nm">${esc(s.name)}</span></button>`).join("")}</div></div>

    <div class="grid2">
      <div class="field"><div class="field-top"><label for="cap">Weekly limit</label><span class="big grad-text mono" id="capOut">${money(form.cap, 0)}</span></div>
        <input type="range" id="cap" min="0" max="${CAP_STEPS.length - 1}" step="1" value="${capIdx}">
        <div class="field-top dim" style="font-size:12px"><span>$5</span><span>$100,000</span></div></div>
      <div class="field"><span class="flabel" id="multLbl">Round-up multiplier</span>
        <div class="seg" role="group" aria-labelledby="multLbl">${MULTIPLIERS.map((m) => `<button data-act="mult" data-m="${m}" aria-pressed="${form.mult === m}">${m}x</button>`).join("")}</div></div>
    </div>

    <div class="field"><span class="flabel" id="wkLbl">USDC approval</span>
      <div class="seg" role="group" aria-labelledby="wkLbl" style="max-width:420px">${ALLOWANCE_WEEKS.map((w) => `<button data-act="weeks" data-w="${w}" aria-pressed="${form.weeks === w}">${w} wk${w > 1 ? "s" : ""}</button>`).join("")}</div>
      <p class="dim" style="font-size:13px">Cache can spend up to <b class="mono" style="color:var(--fg)">${money(allowance, 0)}</b> of your USDC in total before you top up, and never more than your weekly limit in any week.</p></div>

    <div class="summary">
      <div><span>Stocks</span><b>${form.picks.map((m) => esc(stockByMint(m)?.symbol ?? short(m))).join(", ") || "None yet"}</b></div>
      <div><span>Round-ups</span><b>To the next dollar × ${form.mult}</b></div>
      <div><span>Weekly limit</span><b>${money(form.cap, 0)} USDC</b></div>
      <div><span>Approval</span><b>${money(allowance, 0)} USDC to Cache's vault</b></div>
      <div><span>Sweeps</span><b>Daily at 12:00 UTC, or any time with “Sweep now”</b></div>
    </div>
    ${allowance > 1000 ? `<p class="note warn">That's a large approval for a test. You can pick a smaller limit or fewer weeks and top up later.</p>` : ""}
    <p class="dim" style="font-size:13px">First-time setup also opens a token account for each stock (about 0.002 SOL each, refundable if you close them).</p>
    <div class="row">
      ${isEdit ? `<button class="btn btn-ghost" data-act="cancel-edit">Cancel</button>` : ""}
      <button class="btn btn-primary" data-act="save" ${form.picks.length && !busy ? "" : "disabled"}>${isEdit ? "Save changes" : "Sign and start"}</button>
    </div>
  </section>`;
}

function dashboardView() {
  const s = state!, v = s.vault!, u = s.usdc;
  const spentPct = Math.min(100, (v.spentThisWeekUsd / v.weeklyCapUsd) * 100);
  const warn = !u ? "You don't have a USDC account yet. Add some USDC to this wallet." :
    !u.approvedToCache ? "Cache's USDC approval is missing (another app may have replaced it). Top up the approval to keep sweeps working." :
    u.allowanceUsd < Math.min(s.pendingUsd, v.weeklyCapUsd) ? "Your USDC approval is running low. Top it up below." :
    u.balanceUsd < cfg.minSweepUsd ? `Your USDC balance is below the ${money(cfg.minSweepUsd)} minimum sweep. Add USDC to keep investing.` : "";
  return `
  ${v.paused ? `<p class="note warn">Round-ups are paused. New trades aren't counted until you resume.</p>` : ""}
  ${warn ? `<p class="note warn">${warn}</p>` : ""}
  <section class="stats">
    <div class="stat"><span class="label">Pending round-ups</span><span class="value grad-text">${money(s.pendingUsd)}</span><span class="sub">Invested at the next sweep</span></div>
    <div class="stat"><span class="label">Invested so far</span><span class="value">${money(v.totalSweptUsd)}</span><span class="sub">${v.sweepCount} sweep${v.sweepCount === 1 ? "" : "s"}</span></div>
    <div class="stat"><span class="label">This week</span><span class="value">${money(v.spentThisWeekUsd)}</span><div class="bar-track"><i style="width:${spentPct}%"></i></div><span class="sub">of ${money(v.weeklyCapUsd, 0)} limit</span></div>
    <div class="stat"><span class="label">USDC</span><span class="value">${money(u?.balanceUsd ?? 0)}</span><span class="sub">Approval left ${money(u?.allowanceUsd ?? 0)}</span></div>
  </section>

  <section class="card stack">
    <div class="row" style="justify-content:space-between"><h3>Your stocks</h3><span class="dim" style="font-size:13px">Round-ups × ${v.multiplier}</span></div>
    <div class="holdings">${holdings.map((h) => `<div class="holding"><span class="tk">${esc(h.symbol)}</span><span class="amt">${h.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span><span class="dim" style="font-size:12px">tokens in your wallet</span></div>`).join("")}</div>
    <div class="row">
      <button class="btn btn-primary" data-act="sweep" ${busy || v.paused ? "disabled" : ""}>Sweep now</button>
      <button class="btn btn-ghost" data-act="${v.paused ? "resume" : "pause"}" ${busy ? "disabled" : ""}>${v.paused ? "Resume" : "Pause"}</button>
      <button class="btn btn-ghost" data-act="edit" ${busy ? "disabled" : ""}>Edit settings</button>
      <button class="btn btn-ghost" data-act="topup" ${busy ? "disabled" : ""}>Top up approval (${form.weeks} wk)</button>
      <button class="btn btn-danger" data-act="stop" ${busy ? "disabled" : ""}>Stop Cache</button>
    </div>
  </section>

  <section class="card stack">
    <h3>Round-ups</h3>
    <div class="table-wrap">${s.trades.length ? `<table><thead><tr><th>When</th><th>Trade</th><th>App</th><th style="text-align:right">Value</th><th style="text-align:right">Round-up</th></tr></thead><tbody>
      ${s.trades.map((t) => `<tr><td>${when(t.ts)}</td><td class="desc"><a href="${solscan(t.sig)}" target="_blank" rel="noopener">${esc(t.description || "Swap")}</a></td><td>${esc(t.source || "")}</td><td class="num">${money(t.value_usd)}</td><td class="num" style="color:var(--teal)">+${money(t.roundup_usd)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No round-ups yet. Make a swap from this wallet on any app; it shows up here within about 15 minutes, or right away when you reload this page.</div>`}</div>
  </section>

  <section class="card stack">
    <h3>Sweeps</h3>
    <div class="table-wrap">${s.sweeps.length ? `<table><thead><tr><th>When</th><th>Stock</th><th style="text-align:right">USDC</th><th>Status</th><th>Details</th></tr></thead><tbody>
      ${s.sweeps.map((w) => `<tr><td>${when(w.ts)}</td><td class="mono">${esc(stockByMint(w.mint)?.symbol ?? short(w.mint))}</td><td class="num">${money(w.amount_usd)}</td><td><span class="status ${esc(w.status)}">${esc(w.status)}</span></td><td class="desc">${w.sig ? `<a href="${solscan(w.sig)}" target="_blank" rel="noopener">Solscan</a> ` : ""}${esc(w.error || "")}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No sweeps yet. Once round-ups reach ${money(cfg.minSweepUsd)}, use “Sweep now” or wait for the daily sweep.</div>`}</div>
  </section>`;
}

const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function paintRanges() {
  const cap = $<HTMLInputElement>("#cap");
  if (cap) cap.style.setProperty("--p", (Number(cap.value) / (CAP_STEPS.length - 1)) * 100 + "%");
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
  if (act === "stop") {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to stop and revoke"; return; }
    return void run(stopCache);
  }
});

document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "cap") {
    form.cap = CAP_STEPS[Number(el.value)];
    $("#capOut").textContent = money(form.cap, 0);
    paintRanges();
  }
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
