// End-to-end test of the Cache program on a local validator (free, no mainnet).
// The SPL Token program stands in for Jupiter: inside each sweep the keeper sends the USDC
// away and pays the user mock stock tokens, exactly the balance changes a real swap makes.
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import {
  approveIx, ata, beginSweepIx, closeVaultIx, configPda, createAtaIdempotentIx, decodeConfig, decodeTokenAccount,
  decodeVault, endSweepIx, initConfigIx, initializeVaultIx, revokeIx, TOKEN_PROGRAM_ID, updateVaultIx, USDC_MINT, vaultPda,
} from "../src/shared/cache";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const programId = new PublicKey(process.env.TEST_PROGRAM_ID!);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/tmp/localnet/deployer.json", "utf8"))));
const keeper = Keypair.generate();
const user = Keypair.generate();
const sink = Keypair.generate();
const mallory = Keypair.generate();
const stockMint = Keypair.generate();
const U = (usd: number) => BigInt(Math.round(usd * 1e6));

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
async function vault() {
  return decodeVault((await conn.getAccountInfo(vaultPda(programId, user.publicKey)))!.data);
}

// ---------------------------------------------------------------- the test
async function main() {
  console.log(`Program ${programId.toBase58()} on local validator\n`);
  for (const k of [admin, keeper, user, mallory]) {
    const sig = await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  const userUsdc = ata(user.publicKey, USDC_MINT);
  const keeperUsdc = ata(keeper.publicKey, USDC_MINT);
  const sinkUsdc = ata(sink.publicKey, USDC_MINT);
  const keeperStock = ata(keeper.publicKey, stockMint.publicKey);
  const userStock = ata(user.publicKey, stockMint.publicKey);

  // Setup: mock stock mint, token accounts, balances.
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: stockMint.publicKey, lamports: rent, space: 82, programId: TOKEN_PROGRAM_ID }),
    initMintIx(stockMint.publicKey, admin.publicKey),
    createAtaIdempotentIx(admin.publicKey, user.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    createAtaIdempotentIx(admin.publicKey, keeper.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    createAtaIdempotentIx(admin.publicKey, sink.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    createAtaIdempotentIx(admin.publicKey, mallory.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
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

  // User setup: invalid settings rejected, then the one-signature setup.
  await expectError("vault with a 3x multiplier", [initializeVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCapUsd: 10, multiplier: 3 })], [user], "InvalidMultiplier");
  await expectError("vault with a $200,000 cap", [initializeVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCapUsd: 200_000, multiplier: 1 })], [user], "InvalidCap");
  await expectError("vault picking a non-allowlisted mint", [initializeVaultIx({ programId, owner: user.publicKey, picks: [USDC_MINT], weeklyCapUsd: 10, multiplier: 1 })], [user], "MintNotAllowed");
  await send([
    createAtaIdempotentIx(user.publicKey, user.publicKey, stockMint.publicKey, TOKEN_PROGRAM_ID),
    initializeVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCapUsd: 10, multiplier: 100 }),
    approveIx(userUsdc, vaultPda(programId, user.publicKey), user.publicKey, U(20)),
  ], [user]);
  const v0 = await vault();
  v0.weeklyCap === U(10) && v0.multiplier === 100 ? ok("one-signature setup: vault ($10/week, 100x) + $20 approval") : bad("setup", "vault fields wrong");

  const sweep = (amount: bigint, minOut: bigint, opts: { usdcOut?: bigint; stockIn?: bigint; noEnd?: boolean; extra?: TransactionInstruction; dest?: PublicKey; asKeeper?: Keypair } = {}) => {
    const k = opts.asKeeper ?? keeper;
    const dest = opts.dest ?? userStock;
    const ixs = [beginSweepIx({ programId, owner: user.publicKey, keeper: k.publicKey, dest, amount, minOut })];
    if (opts.extra) ixs.push(opts.extra);
    if ((opts.usdcOut ?? amount) > 0n) ixs.push(transferIx(ata(k.publicKey, USDC_MINT), sinkUsdc, k.publicKey, opts.usdcOut ?? amount));
    if ((opts.stockIn ?? 2_000n) > 0n) ixs.push(transferIx(keeperStock, dest, keeper.publicKey, opts.stockIn ?? 2_000n));
    if (!opts.noEnd) ixs.push(endSweepIx({ programId, owner: user.publicKey, keeper: k.publicKey, dest }));
    return ixs;
  };

  // Happy path.
  await send(sweep(U(5), 1_000n), [keeper]);
  let v = await vault();
  const userStockBal = await balance(userStock);
  if (v.spentInPeriod === U(5) && v.totalSwept === U(5) && v.sweepCount === 1n && !v.sweepActive && userStockBal === 2_000n && (await balance(userUsdc)) === U(95)) {
    ok("sweep $5: USDC left the user, stock arrived in the user's own account, counters updated");
  } else bad("sweep $5", `spent=${v.spentInPeriod} swept=${v.totalSwept} count=${v.sweepCount} stock=${userStockBal}`);

  // Safety rules.
  await expectError("sweep over the weekly cap ($5 + $6 > $10)", sweep(U(6), 1_000n), [keeper], "WeeklyCapExceeded");
  await expectError("keeper keeps the USDC", sweep(U(1), 1_000n, { usdcOut: 0n }), [keeper], "KeeperKeptFunds");
  await expectError("user receives less than the minimum", sweep(U(1), 5_000n), [keeper], "SlippageExceeded");
  await expectError("begin_sweep without end_sweep", sweep(U(1), 1_000n, { noEnd: true }), [keeper], "MissingEndSweep");
  await expectError("foreign instruction inside a sweep", sweep(U(1), 1_000n, { extra: SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: sink.publicKey, lamports: 1 }) }), [keeper], "InvalidSandwich");
  await expectError("someone other than the keeper sweeps", sweep(U(1), 1_000n, { asKeeper: mallory, usdcOut: 0n, stockIn: 0n }), [mallory], "Unauthorized");
  await expectError("stock sent to an account the user doesn't own", sweep(U(1), 1_000n, { dest: keeperStock }), [keeper], "WrongDestination");

  // Pause / resume.
  await send([updateVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCapUsd: 10, multiplier: 100, paused: true })], [user]);
  await expectError("sweep while paused", sweep(U(1), 1_000n), [keeper], "VaultPaused");
  await send([updateVaultIx({ programId, owner: user.publicKey, picks: [stockMint.publicKey], weeklyCapUsd: 10, multiplier: 100, paused: false })], [user]);
  await send(sweep(U(4), 1_000n), [keeper]);
  v = await vault();
  v.spentInPeriod === U(9) && v.sweepCount === 2n ? ok("pause blocks sweeps; after resume a $4 sweep fits under the cap ($9 of $10)") : bad("resume sweep", `spent=${v.spentInPeriod}`);

  // Approval runs out.
  const usdcAcc = decodeTokenAccount((await conn.getAccountInfo(userUsdc))!.data);
  usdcAcc.delegatedAmount === U(11) ? ok("approval decreases with each sweep ($20 → $11 left)") : bad("allowance", `delegated=${usdcAcc.delegatedAmount}`);

  // Stop: revoke + close in one transaction, rent refunded.
  const before = await conn.getBalance(user.publicKey);
  await send([revokeIx(userUsdc, user.publicKey), closeVaultIx({ programId, owner: user.publicKey })], [user]);
  const gone = !(await conn.getAccountInfo(vaultPda(programId, user.publicKey)));
  const after = await conn.getBalance(user.publicKey);
  const revoked = !decodeTokenAccount((await conn.getAccountInfo(userUsdc))!.data).delegate;
  gone && revoked && after > before ? ok("stop: approval revoked, vault closed, rent refunded") : bad("stop", `gone=${gone} revoked=${revoked}`);
  await expectError("sweep after stopping", sweep(U(1), 1_000n), [keeper], "AccountNotInitialized");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
