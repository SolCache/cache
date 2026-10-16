// Shared client for the Cache onchain program: PDAs, instruction encoders, account decoders.
// Used by the browser app, the Cloudflare Worker keeper and the CI setup script.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { Buffer } from "buffer";

const buf = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b));

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;
/** Seed for the dedicated wrapped-SOL account a SOL-funded vault draws from. */
export const CACHE_SOL_SEED = "cache-sol-v1";
export const MULTIPLIERS = [1, 2, 5, 10, 20, 50, 100] as const;
export const MAX_PICKS = 5;
export const MIN_WEEKLY_CAP_USD = 1;
export const MAX_WEEKLY_CAP_USD = 100_000;
export const MIN_WEEKLY_CAP_SOL = 0.01;
export const MAX_WEEKLY_CAP_SOL = 1_000;

/** xStocks offered in v1. Mints from Backed's Solana deployments; the CI setup script
 *  re-checks each one on mainnet (exists, Token-2022) before adding it to the allowlist. */
export const STOCKS: { symbol: string; name: string; mint: string }[] = [
  { symbol: "TSLAx", name: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB" },
  { symbol: "NVDAx", name: "NVIDIA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
  { symbol: "AAPLx", name: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
  { symbol: "SPYx", name: "S&P 500 ETF", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { symbol: "GOOGLx", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN" },
  { symbol: "MSFTx", name: "Microsoft", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
  { symbol: "QQQx", name: "Nasdaq 100 ETF", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ" },
];
export const stockByMint = (mint: string) => STOCKS.find((s) => s.mint === mint);

const DISC = {
  init_config: [23, 235, 115, 232, 168, 96, 1, 231],
  update_config: [29, 158, 252, 191, 10, 83, 219, 99],
  initialize_vault: [48, 191, 163, 44, 71, 129, 63, 164],
  update_vault: [67, 229, 185, 188, 226, 11, 210, 60],
  close_vault: [141, 103, 17, 126, 72, 75, 29, 29],
  begin_sweep: [147, 244, 224, 21, 162, 70, 107, 89],
  end_sweep: [242, 219, 250, 26, 62, 219, 162, 50],
};
const ACCOUNT_DISC = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Vault: [211, 8, 232, 43, 2, 152, 117, 119],
};

// ---------------------------------------------------------------- PDAs

export const configPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], programId)[0];

export const vaultPda = (programId: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), owner.toBytes()], programId)[0];

export const programDataPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];

export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

/** Associated-token "create idempotent" instruction (no-op if the account exists). */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: buf(new Uint8Array([1])),
  });
}

/** SPL Token `Approve` (instruction 4): lets `delegate` move up to `amount` base units. */
export function approveIx(account: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint) {
  const data = new Uint8Array(9);
  data[0] = 4;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: buf(data),
  });
}

/** SPL Token `Revoke` (instruction 5). */
export function revokeIx(account: PublicKey, owner: PublicKey) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: buf(new Uint8Array([5])),
  });
}

// ---------------------------------------------------------------- borsh helpers

class Writer {
  private parts: number[] = [];
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return this.bytes(b); }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return this.bytes(b); }
  pubkey(k: PublicKey) { return this.bytes(k.toBytes()); }
  pubkeys(ks: PublicKey[]) { this.u32(ks.length); ks.forEach((k) => this.pubkey(k)); return this; }
  done() { return new Uint8Array(this.parts); }
}

class Reader {
  private o = 0;
  private dv: DataView;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  skip(n: number) { this.o += n; return this; }
  u8() { return this.b[this.o++]; }
  bool() { return this.u8() === 1; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
  pubkey() { const k = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  pubkeys() { const n = this.u32(); return Array.from({ length: n }, () => this.pubkey()); }
}

const toUsdcUnits = (usd: number) => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
export const fromUsdcUnits = (units: bigint) => Number(units) / 10 ** USDC_DECIMALS;
export { toUsdcUnits };

// ---------------------------------------------------------------- instructions

export function initConfigIx(p: {
  programId: PublicKey; admin: PublicKey; keeper: PublicKey; allowedMints: PublicKey[];
  swapProgram?: PublicKey; usdcMint?: PublicKey;
}) {
  const data = new Writer().bytes(DISC.init_config)
    .pubkey(p.keeper).pubkey(p.swapProgram ?? JUPITER_PROGRAM_ID).pubkey(p.usdcMint ?? USDC_MINT)
    .pubkeys(p.allowedMints).done();
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: true },
      { pubkey: p.admin, isSigner: true, isWritable: true },
      { pubkey: p.programId, isSigner: false, isWritable: false },
      { pubkey: programDataPda(p.programId), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: buf(data),
  });
}

export function updateConfigIx(p: {
  programId: PublicKey; admin: PublicKey; keeper?: PublicKey; swapProgram?: PublicKey;
  paused?: boolean; allowedMints?: PublicKey[];
}) {
  const w = new Writer().bytes(DISC.update_config);
  p.keeper ? w.u8(1).pubkey(p.keeper) : w.u8(0);
  p.swapProgram ? w.u8(1).pubkey(p.swapProgram) : w.u8(0);
  p.paused === undefined ? w.u8(0) : w.u8(1).bool(p.paused);
  p.allowedMints ? w.u8(1).pubkeys(p.allowedMints) : w.u8(0);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: true },
      { pubkey: p.admin, isSigner: true, isWritable: false },
    ],
    data: buf(w.done()),
  });
}

export function initializeVaultIx(p: {
  programId: PublicKey; owner: PublicKey; fundingAccount: PublicKey; picks: PublicKey[]; weeklyCap: bigint; multiplier: number;
}) {
  const data = new Writer().bytes(DISC.initialize_vault).pubkeys(p.picks).u64(p.weeklyCap).u16(p.multiplier).done();
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: false },
      { pubkey: vaultPda(p.programId, p.owner), isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: true },
      { pubkey: p.fundingAccount, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: buf(data),
  });
}

export function updateVaultIx(p: {
  programId: PublicKey; owner: PublicKey; picks: PublicKey[]; weeklyCap: bigint; multiplier: number; paused: boolean;
}) {
  const data = new Writer().bytes(DISC.update_vault).pubkeys(p.picks).u64(p.weeklyCap).u16(p.multiplier).bool(p.paused).done();
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: false },
      { pubkey: vaultPda(p.programId, p.owner), isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: false },
    ],
    data: buf(data),
  });
}

export function closeVaultIx(p: { programId: PublicKey; owner: PublicKey }) {
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: vaultPda(p.programId, p.owner), isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: true },
    ],
    data: buf(new Uint8Array(DISC.close_vault)),
  });
}

export function beginSweepIx(p: {
  programId: PublicKey; owner: PublicKey; keeper: PublicKey; userSource: PublicKey; keeperSource: PublicKey;
  dest: PublicKey; amount: bigint; minOut: bigint;
}) {
  const data = new Writer().bytes(DISC.begin_sweep).u64(p.amount).u64(p.minOut).done();
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: false },
      { pubkey: vaultPda(p.programId, p.owner), isSigner: false, isWritable: true },
      { pubkey: p.keeper, isSigner: true, isWritable: false },
      { pubkey: p.userSource, isSigner: false, isWritable: true },
      { pubkey: p.keeperSource, isSigner: false, isWritable: true },
      { pubkey: p.dest, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: buf(data),
  });
}

export function endSweepIx(p: {
  programId: PublicKey; owner: PublicKey; keeper: PublicKey; keeperSource: PublicKey; dest: PublicKey; userSource: PublicKey;
}) {
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: configPda(p.programId), isSigner: false, isWritable: false },
      { pubkey: vaultPda(p.programId, p.owner), isSigner: false, isWritable: true },
      { pubkey: p.keeper, isSigner: true, isWritable: false },
      { pubkey: p.keeperSource, isSigner: false, isWritable: true },
      { pubkey: p.dest, isSigner: false, isWritable: false },
      { pubkey: p.userSource, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: buf(new Uint8Array(DISC.end_sweep)),
  });
}

// ---------------------------------------------------------------- wrapped SOL (SOL-funded vaults)

/** Address of the user's dedicated Cache SOL account (a wrapped-SOL token account, not their ATA,
 *  so apps that close the standard wrapped-SOL account never touch it). */
export const cacheSolAccount = (owner: PublicKey) => PublicKey.createWithSeed(owner, CACHE_SOL_SEED, TOKEN_PROGRAM_ID);

/** Instructions that create the Cache SOL account holding `lamports` of wrapped SOL. */
export async function createCacheSolAccountIxs(owner: PublicKey, lamports: bigint, rentLamports: number) {
  const account = await cacheSolAccount(owner);
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner, newAccountPubkey: account, basePubkey: owner, seed: CACHE_SOL_SEED,
      lamports: rentLamports + Number(lamports), space: 165, programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: WSOL_MINT, isSigner: false, isWritable: false }],
      data: buf([18, ...owner.toBytes()]),
    }),
  ];
}

/** Unwraps `lamports` from the Cache SOL account back to the owner's normal SOL in one transaction:
 *  a temporary wrapped-SOL account receives the amount and is closed straight away. The Cache SOL
 *  account itself stays open, so the vault keeps working and can be topped up again. */
export async function withdrawFromCacheSolIxs(owner: PublicKey, lamports: bigint, rentLamports: number) {
  const account = await cacheSolAccount(owner);
  const tmp = await PublicKey.createWithSeed(owner, "cache-sol-tmp", TOKEN_PROGRAM_ID);
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, lamports, true);
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner, newAccountPubkey: tmp, basePubkey: owner, seed: "cache-sol-tmp",
      lamports: rentLamports, space: 165, programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: tmp, isSigner: false, isWritable: true }, { pubkey: WSOL_MINT, isSigner: false, isWritable: false }],
      data: buf([18, ...owner.toBytes()]),
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: tmp, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: buf([3, ...amount]),
    }),
    closeTokenAccountIx(tmp, owner, owner),
  ];
}

/** Moves more SOL into the Cache SOL account and syncs its wrapped balance. */
export async function addToCacheSolIxs(owner: PublicKey, lamports: bigint) {
  const account = await cacheSolAccount(owner);
  return [SystemProgram.transfer({ fromPubkey: owner, toPubkey: account, lamports: Number(lamports) }), syncNativeIx(account)];
}

export const syncNativeIx = (account: PublicKey) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: buf([17]),
});

/** SPL Token CloseAccount (9): for wrapped SOL this returns all of it to `destination` as SOL. */
export const closeTokenAccountIx = (account: PublicKey, destination: PublicKey, owner: PublicKey) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID,
  keys: [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ],
  data: buf([9]),
});

// ---------------------------------------------------------------- accounts

const hasDisc = (data: Uint8Array, disc: number[]) => disc.every((b, i) => data[i] === b);

export type VaultState = {
  owner: PublicKey; fundingMint: PublicKey; fundingAccount: PublicKey; picks: PublicKey[]; weeklyCap: bigint; multiplier: number;
  paused: boolean; periodStart: number; spentInPeriod: bigint; totalSwept: bigint; sweepCount: bigint; sweepActive: boolean;
};

export function decodeVault(data: Uint8Array): VaultState {
  if (!hasDisc(data, ACCOUNT_DISC.Vault)) throw new Error("Not a Cache vault account");
  const r = new Reader(data).skip(8);
  const owner = r.pubkey();
  const fundingMint = r.pubkey();
  const fundingAccount = r.pubkey();
  const picks = r.pubkeys();
  const weeklyCap = r.u64();
  const multiplier = r.u16();
  const paused = r.bool();
  const periodStart = Number(r.i64());
  const spentInPeriod = r.u64();
  const totalSwept = r.u64();
  const sweepCount = r.u64();
  const sweepActive = r.bool();
  return { owner, fundingMint, fundingAccount, picks, weeklyCap, multiplier, paused, periodStart, spentInPeriod, totalSwept, sweepCount, sweepActive };
}

/** Decimals and label for a vault's funding token. */
export const fundingInfo = (mint: PublicKey) =>
  mint.equals(WSOL_MINT) ? { kind: "SOL" as const, decimals: SOL_DECIMALS } : { kind: "USDC" as const, decimals: USDC_DECIMALS };
export const toUnits = (amount: number, decimals: number) => BigInt(Math.round(amount * 10 ** decimals));
export const fromUnits = (units: bigint, decimals: number) => Number(units) / 10 ** decimals;

export type ConfigState = {
  admin: PublicKey; keeper: PublicKey; swapProgram: PublicKey; usdcMint: PublicKey; paused: boolean; allowedMints: PublicKey[];
};

export function decodeConfig(data: Uint8Array): ConfigState {
  if (!hasDisc(data, ACCOUNT_DISC.Config)) throw new Error("Not a Cache config account");
  const r = new Reader(data).skip(8);
  return {
    admin: r.pubkey(), keeper: r.pubkey(), swapProgram: r.pubkey(), usdcMint: r.pubkey(),
    paused: r.bool(), allowedMints: r.pubkeys(),
  };
}

/** SPL token account layout: mint(32) owner(32) amount(8) delegateOption(4) delegate(32) state(1) ... delegatedAmount at 121. */
export function decodeTokenAccount(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hasDelegate = dv.getUint32(72, true) === 1;
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: dv.getBigUint64(64, true),
    delegate: hasDelegate ? new PublicKey(data.subarray(76, 108)) : null,
    delegatedAmount: dv.getBigUint64(121, true),
  };
}

// ---------------------------------------------------------------- round-ups

/** Round a trade's USD value up to the next dollar; a trade that is already whole rounds up a full $1. */
export function roundUpUsd(valueUsd: number, multiplier: number) {
  const cents = Math.round(valueUsd * 100);
  let up = (100 - (cents % 100)) % 100;
  if (up === 0) up = 100;
  return (up * multiplier) / 100;
}
