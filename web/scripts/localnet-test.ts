// End-to-end test of the Cache program on a local validator (free, no mainnet).
// The SPL Token program stands in for Jupiter: inside each sweep the keeper sends the funding
// token away and pays the user mock stock tokens, exactly the balance changes a real swap makes.
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import {
  approveIx, ata, beginSweepIx, cacheSolAccount, closeTokenAccountIx, closeVaultIx, configPda, createAtaIdempotentIx,
  createCacheSolAccountIxs, addToCacheSolIxs, withdrawFromCacheSolIxs, decodeConfig, decodeTokenAccount, decodeVault, endSweepIx, initConfigIx,
  initializeVaultIx, revokeIx, TOKEN_PROGRAM_ID, updateVaultIx, USDC_MINT, vaultPda, WSOL_MINT,
} from "../src/shared/cache";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const programId = new PublicKey(process.env.TEST_PROGRAM_ID!);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/tmp/localnet/deployer.json", "utf8"))));
const keeper = Keypair.generate();
const user = Keypair.generate();      // USDC-funded vault
const solUser = Keypair.generate();   // SOL-funded vault
const sink = Keypair.generate();
const mallory = Keypair.generate();
const stockMint = Keypair.generate();
const U = (usd: number) => BigInt(Math.round(usd * 1e6));
const S = (sol: number) => BigInt(Math.round(sol * 1e9));

let passed = 0, failed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const bad = (name: string, why: string) => { failed++; console.log(`  ✗ ${name}: ${why}`); };

// ---------------------------------------------------------------- SPL helpers (no extra deps)
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const mintToIx = (mint: PublicKey, dest: PublicKey, auth: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID, data: Buffer.concat([Buffer.from([7]), u64(amount)]),
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: false }],
});
const transferIx = (src: PublicKey, dst: PublicKey, owner: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID, data: Buffer.concat([Buffer.from([3]), u64(amount)]),
  keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
});
const initMintIx = (mint: PublicKey, auth: PublicKey) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID, data: Buffer.concat([Buffer.from([20, 6]), auth.toBuffer(), Buffer.from([0])]),
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
});

async function build(ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx;
}

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = await build(ixs, signers);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Expects the transaction to fail with the given Anchor error name. */
async function expectError(name: string, ixs: TransactionInstruction[], signers: Keypair[], errorName: string) {
  const tx = await build(ixs, signers);
  const sim = await conn.simulateTransaction(tx);
  const logs = (sim.value.logs ?? []).join("\n");
  if (!sim.value.err) return bad(name, "transaction succeeded but should have failed");
  if (!logs.includes(errorName)) return bad(name, `failed for a different reason:\n${logs.split("\n").slice(-6).join("\n")}`);
  ok(`${name} → rejected (${errorName})`);
}

async function balance(acc: PublicKey) {
  const info = await conn.getAccountInfo(acc);
  return info ? decodeTokenAccount(info.data).amount : 0n;
}
const vaultOf = async (owner: PublicKey) => decodeVault((await conn.getAccountInfo(vaultPda(programId, owner)))!.data);

/** A sweep where the token program plays the swap: the keeper sends `out` of the funding token to a sink and pays `stockIn` stock. */
function sweepIxs(o: {
  owner: Keypair; userSource: PublicKey; fundingMint: PublicKey; amount: bigint; minOut: bigint;
  out?: bigint; stockIn?: bigint; noEnd?: boolean; extra?: TransactionInstruction; dest?: PublicKey; asKeeper?: Keypair;
}) {
  const k = o.asKeeper ?? keeper;
  const dest = o.dest ?? ata(o.owner.publicKey, stockMint.publicKey);
  const keeperSource = ata(k.publicKey, o.fundingMint);
  const sinkAcc = ata(sink.publicKey, o.fundingMint);
  const ixs = [beginSweepIx({ programId, owner: o.owner.publicKey, keeper: k.publicKey, userSource: o.userSource, keeperSource, dest, amount: o.amount, minOut: o.minOut })];
  if (o.extra) ixs.push(o.extra);
  const out = o.out ?? o.amount;
  if (out > 0n) ixs.push(transferIx(keeperSource, sinkAcc, k.publicKey, out));
  const stockIn = o.stockIn ?? 2_000n;
  if (stockIn > 0n) ixs.push(transferIx(ata(keeper.publicKey, stockMint.publicKey), dest, keeper.publicKey, stockIn));
  if (!o.noEnd) ixs.push(endSweepIx({ programId, owner: o.owner.publicKey, keeper: k.publicKey, keeperSource, dest, userSource: o.userSource }));
  return ixs;
}

// ---------------------------------------------------------------- the test
async function main() {
  console.log(`Program ${programId.toBase58()} on local validator\n`);
  for (const k of [admin, keeper, user, solUser, mallory]) {
    const sig = await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  const userUsdc = ata(user.publicKey, USDC_MINT);
  const keeperStock = ata(keeper.publicKey, stockMint.publicKey);
  const userStock = ata(user.publicKey, stockMint.publicKey);
  const solUserStock = ata(solUser.publicKey, stockMint.publicKey);

  // Setup: mock stock mint, token accounts, balances.
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: stockMint.publicKey, lamports: rent, space: 82, programId: TOKEN_PROGRAM_ID }),
    initMintIx(stockMint.publicKey, admin.publicKey),
    ...[user, keeper, sink, mallory].map((k) => createAtaIdempotentIx(admin.publicKey, k.publicKey, USDC_MINT, TOKEN_PROGRAM_ID)),
    ...[keeper, sink].map((k) => createAtaIdempotentIx(admin.publicKey, k.publicKey, WSOL_MINT, TOKEN_PROGRAM_ID)),
    createAtaIdempotentIx(admin.publicKey, keeper.publicKey, stockMint.publicKey, TOKEN_PROGRAM_ID),
    mintToIx(USDC_MINT, userUsdc, admin.publicKey, U(100)),
    mintToIx(stockMint.publicKey, keeperStock, admin.publicKey, 1_000_000n),
  ], [admin, stockMint]);
  ok("setup: mock stock, token accounts, 100 test USDC for the user");

  // Config (only the upgrade authority may do this).
  await expectError("init_config by a non-authority", [initConfigIx({ programId, admin: user.publicKey, keeper: keeper.publicKey, allowedMints: [stockMint.publicKey], swapProgram: TOKEN_PROGRAM_ID })], [user], "Unauthorized");
  await send([initConfigIx({ programId, admin: admin.publicKey, keeper: keeper.publicKey, allowedMints: [stockMint.publicKey], swapProgram: TOKEN_PROGRAM_ID })], [admin]);
  const cfg = decodeConfig((await conn.getAccountInfo(configPda(programId)))!.data);
  cfg.keeper.equals(keeper.publicKey) ? ok("init_config by the upgrade authority") : bad("init_config", "keeper mismatch");

  // ---------------- USDC-funded vault
  console.log("\n  USDC vault");
  const initUsdc = (cap: bigint, multiplier: number, picks = [stockMint.publicKey]) =>
    initializeVaultIx({ programId, owner: user.publicKey, fundingAccount: userUsdc, picks, weeklyCap: cap, multiplier });
  await expectError("vault with a 3x multiplier", [initUsdc(U(10), 3)], [user], "InvalidMultiplier");
  await expectError("vault with a $200,000 cap", [initUsdc(U(200_000), 1)], [user], "InvalidCap");
  await expectError("vault picking a non-allowlisted mint", [initUsdc(U(10), 1, [USDC_MINT])], [user], "MintNotAllowed");
  await expectError("vault funded from someone else's account", [initializeVaultIx({ programId, owner: user.publicKey, fundingAccount: ata(mallory.publicKey, USDC_MINT), picks: [stockMint.publicKey], weeklyCap: U(10), multiplier: 1 })], [user], "WrongSource");
  await send([
    createAtaIdempotentIx(user.publicKey, user.publicKey, stockMint.publicKey, TOKEN_PROGRAM_ID),
    initUsdc(U(10), 100),
    approveIx(userUsdc, vaultPda(programId, user.publicKey), user.publicKey, U(20)),
  ], [user]);
  const v0 = await vaultOf(user.publicKey);
  v0.weeklyCap === U(10) && v0.multiplier === 100 && v0.fundingMint.equals(USDC_MINT) && v0.fundingAccount.equals(userUsdc)
    ? ok("one-signature setup: USDC vault ($10/week, 100x) + $20 approval") : bad("setup", "vault fields wrong");

  const usdcSweep = (o: Partial<Parameters<typeof sweepIxs>[0]> & { amount: bigint; minOut: bigint }) =>
    sweepIxs({ owner: user, userSource: userUsdc, fundingMint: USDC_MINT, ...o });

  await send(usdcSweep({ amount: U(5), minOut: 1_000n }), [keeper]);
  let v = await vaultOf(user.publicKey);
  if (v.spentInPeriod === U(5) && v.totalSwept === U(5) && v.sweepCount === 1n && !v.sweepActive && (await balance(userStock)) === 2_000n && (await balance(userUsdc)) === U(95)) {
    ok("sweep $5: USDC left the user, stock arrived in the user's own account, counters updated");
  } else bad("sweep $5", `spent=${v.spentInPeriod} swept=${v.totalSwept} count=${v.sweepCount}`);

  // Route leaves dust: $2 pulled, only $1.70 used → $0.30 refunded inside the same transaction.
  await send(usdcSweep({ amount: U(2), minOut: 1_000n, out: U(1.7) }), [keeper]);
  v = await vaultOf(user.publicKey);
  const keeperLeft = await balance(ata(keeper.publicKey, USDC_MINT));
  v.spentInPeriod === U(6.7) && v.totalSwept === U(6.7) && keeperLeft === 0n && (await balance(userUsdc)) === U(93.3)
    ? ok("route leaves $0.30 unused → refunded to the user, only $1.70 counted against the cap")
    : bad("dust refund", `spent=${v.spentInPeriod} swept=${v.totalSwept} keeper=${keeperLeft} user=${await balance(userUsdc)}`);

  await expectError("sweep over the weekly cap ($6.70 + $4 > $10)", usdcSweep({ amount: U(4), minOut: 1_000n }), [keeper], "WeeklyCapExceeded");
  await expectError("user receives less than the minimum", usdcSweep({ amount: U(1), minOut: 5_000n }), [keeper], "SlippageExceeded");
  await expectError("begin_sweep without end_sweep", usdcSweep({ amount: U(1), minOut: 1_000n, noEnd: true }), [keeper], "MissingEndSweep");
  await expectError("foreign instruction inside a sweep", usdcSweep({ amount: U(1), minOut: 1_000n, extra: SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: sink.publicKey, lamports: 1 }) }), [keeper], "InvalidSandwich");
  await expectError("someone other than the keeper sweeps", usdcSweep({ amount: U(1), minOut: 1_000n, asKeeper: mallory, out: 0n, stockIn: 0n }), [mallory], "Unauthorized");
  await expectError("stock sent to an account the user doesn't own", usdcSweep({ amount: U(1), minOut: 1_000n, dest: keeperStock }), [keeper], "WrongDestination");
  await expectError("sweep pulling from a different account", sweepIxs({ owner: user, userSource: ata(mallory.publicKey, USDC_MINT), fundingMint: USDC_MINT, amount: U(1), minOut: 1_000n }), [keeper], "WrongSource");

  await send([updateVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCap: U(10), multiplier: 100, paused: true })], [user]);
  await expectError("sweep while paused", usdcSweep({ amount: U(1), minOut: 1_000n }), [keeper], "VaultPaused");
  await send([updateVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCap: U(10), multiplier: 100, paused: false })], [user]);
  await send(usdcSweep({ amount: U(3), minOut: 1_000n }), [keeper]);
  v = await vaultOf(user.publicKey);
  v.spentInPeriod === U(9.7) && v.sweepCount === 3n ? ok("pause blocks sweeps; after resume a $3 sweep fits under the cap ($9.70 of $10)") : bad("resume sweep", `spent=${v.spentInPeriod}`);

  const usdcAcc = decodeTokenAccount((await conn.getAccountInfo(userUsdc))!.data);
  usdcAcc.delegatedAmount === U(10) ? ok("approval decreases with each pull ($20 → $10 left)") : bad("allowance", `delegated=${usdcAcc.delegatedAmount}`);

  const before = await conn.getBalance(user.publicKey);
  await send([revokeIx(userUsdc, user.publicKey), closeVaultIx({ programId, owner: user.publicKey })], [user]);
  const gone = !(await conn.getAccountInfo(vaultPda(programId, user.publicKey)));
  const revoked = !decodeTokenAccount((await conn.getAccountInfo(userUsdc))!.data).delegate;
  gone && revoked && (await conn.getBalance(user.publicKey)) > before ? ok("stop: approval revoked, vault closed, rent refunded") : bad("stop", `gone=${gone} revoked=${revoked}`);
  await expectError("sweep after stopping", usdcSweep({ amount: U(1), minOut: 1_000n }), [keeper], "AccountNotInitialized");

  // ---------------- SOL-funded vault
  console.log("\n  SOL vault");
  const solAcc = await cacheSolAccount(solUser.publicKey);
  const tokenRent = await conn.getMinimumBalanceForRentExemption(165);
  await expectError("SOL vault with a 0.001 SOL cap", [
    ...(await createCacheSolAccountIxs(solUser.publicKey, S(1), tokenRent)),
    initializeVaultIx({ programId, owner: solUser.publicKey, fundingAccount: solAcc, picks: [stockMint.publicKey], weeklyCap: S(0.001), multiplier: 1 }),
  ], [solUser], "InvalidCap");
  await send([
    createAtaIdempotentIx(solUser.publicKey, solUser.publicKey, stockMint.publicKey, TOKEN_PROGRAM_ID),
    ...(await createCacheSolAccountIxs(solUser.publicKey, S(1), tokenRent)),
    initializeVaultIx({ programId, owner: solUser.publicKey, fundingAccount: solAcc, picks: [stockMint.publicKey], weeklyCap: S(0.5), multiplier: 2 }),
    approveIx(solAcc, vaultPda(programId, solUser.publicKey), solUser.publicKey, S(1)),
  ], [solUser]);
  const sv = await vaultOf(solUser.publicKey);
  sv.fundingMint.equals(WSOL_MINT) && sv.fundingAccount.equals(solAcc) && (await balance(solAcc)) === S(1)
    ? ok("one-signature setup: 1 SOL wrapped into the Cache SOL account, SOL vault (0.5 SOL/week) + approval") : bad("SOL setup", "vault fields wrong");

  const solSweep = (o: Partial<Parameters<typeof sweepIxs>[0]> & { amount: bigint; minOut: bigint }) =>
    sweepIxs({ owner: solUser, userSource: solAcc, fundingMint: WSOL_MINT, dest: solUserStock, ...o });
  await send(solSweep({ amount: S(0.2), minOut: 1_000n, out: S(0.19) }), [keeper]);
  const sv2 = await vaultOf(solUser.publicKey);
  sv2.spentInPeriod === S(0.19) && (await balance(solAcc)) === S(0.81) && (await balance(solUserStock)) === 2_000n
    ? ok("SOL sweep 0.2: 0.19 used, 0.01 refunded, stock delivered") : bad("SOL sweep", `spent=${sv2.spentInPeriod} acc=${await balance(solAcc)}`);
  await expectError("SOL sweep over the 0.5 SOL weekly cap", solSweep({ amount: S(0.4), minOut: 1_000n }), [keeper], "WeeklyCapExceeded");

  await send([...(await addToCacheSolIxs(solUser.publicKey, S(0.5))), approveIx(solAcc, vaultPda(programId, solUser.publicKey), solUser.publicKey, S(1.31))], [solUser]);
  (await balance(solAcc)) === S(1.31) ? ok("top up: 0.5 more SOL wrapped into the Cache SOL account") : bad("SOL top up", `${await balance(solAcc)}`);

  const lamportsBeforeWd = await conn.getBalance(solUser.publicKey);
  await send([...(await withdrawFromCacheSolIxs(solUser.publicKey, S(0.31), tokenRent)), approveIx(solAcc, vaultPda(programId, solUser.publicKey), solUser.publicKey, S(1))], [solUser]);
  const gainedWd = (await conn.getBalance(solUser.publicKey)) - lamportsBeforeWd;
  (await balance(solAcc)) === S(1) && gainedWd > Number(S(0.309))
    ? ok("withdraw: 0.31 SOL unwrapped back to normal SOL, Cache SOL account stays open") : bad("SOL withdraw", `acc=${await balance(solAcc)} gained=${gainedWd}`);
  await send(solSweep({ amount: S(0.1), minOut: 1_000n }), [keeper]);
  (await balance(solAcc)) === S(0.9) ? ok("sweeps keep working after a withdraw") : bad("sweep after withdraw", `${await balance(solAcc)}`);

  const solBefore = await conn.getBalance(solUser.publicKey);
  await send([revokeIx(solAcc, solUser.publicKey), closeTokenAccountIx(solAcc, solUser.publicKey, solUser.publicKey), closeVaultIx({ programId, owner: solUser.publicKey })], [solUser]);
  const solAfter = await conn.getBalance(solUser.publicKey);
  !(await conn.getAccountInfo(solAcc)) && solAfter - solBefore > Number(S(0.89))
    ? ok("stop: wrapped SOL returned as normal SOL, vault closed") : bad("SOL stop", `gained=${solAfter - solBefore}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
