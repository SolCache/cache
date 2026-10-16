// Initializes (or updates) the Cache program's onchain config after a deploy:
// keeper, Jupiter as the swap program, USDC, and the verified xStock allowlist.
// Also tops up the keeper with a little SOL for transaction fees if it's low.
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  configPda, decodeConfig, initConfigIx, JUPITER_PROGRAM_ID, STOCKS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, updateConfigIx,
} from "../src/shared/cache";

const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const conn = new Connection(rpcUrl, "confirmed");
const admin = Keypair.fromSecretKey(bs58.decode(process.env.DEPLOYER_PRIVATE_KEY!.trim()));
const programId = new PublicKey(readFileSync("../deploy/program-id.txt", "utf8").trim());
const keeper = new PublicKey(readFileSync("../deploy/keeper-pubkey.txt", "utf8").trim());
const topUpSol = Number(process.env.KEEPER_TOPUP_SOL ?? "0.03");

async function send(ixs: any[], label: string) {
  // Priority fee so the transaction lands when the network is busy; resend until confirmed or the blockhash expires.
  const priority = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 });
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: [limit, priority, ...ixs] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([admin]);
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
    console.log(`${label}: sent ${sig} (attempt ${attempt})`);
    while ((await conn.getBlockHeight("confirmed")) <= lastValidBlockHeight) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        console.log(`${label}: confirmed https://solscan.io/tx/${sig}`);
        return sig;
      }
      await conn.sendRawTransaction(raw, { maxRetries: 0, skipPreflight: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`${label}: blockhash expired without confirmation, retrying`);
  }
  throw new Error(`${label}: not confirmed after 3 attempts`);
}

async function main() {
  console.log(`Program ${programId.toBase58()}\nAdmin   ${admin.publicKey.toBase58()}\nKeeper  ${keeper.toBase58()}`);

  // Verify each xStock mint exists on mainnet and is a token mint.
  const mintInfos = await conn.getMultipleAccountsInfo(STOCKS.map((s) => new PublicKey(s.mint)));
  const allowed: PublicKey[] = [];
  STOCKS.forEach((s, i) => {
    const info = mintInfos[i];
    const okOwner = info && (info.owner.equals(TOKEN_2022_PROGRAM_ID) || info.owner.equals(TOKEN_PROGRAM_ID));
    if (okOwner && info!.data.length >= 82) {
      allowed.push(new PublicKey(s.mint));
      console.log(`  ✓ ${s.symbol.padEnd(7)} ${s.mint}  decimals=${info!.data[44]}  ${info!.owner.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token"}`);
    } else {
      console.log(`  ✗ ${s.symbol.padEnd(7)} ${s.mint}  not a token mint on mainnet; skipped`);
    }
  });
  if (!allowed.length) throw new Error("No xStock mints verified; refusing to configure an empty allowlist");

  const existing = await conn.getAccountInfo(configPda(programId));
  if (!existing) {
    await send([initConfigIx({ programId, admin: admin.publicKey, keeper, allowedMints: allowed })], "init_config");
  } else {
    const c = decodeConfig(existing.data);
    const sameKeeper = c.keeper.equals(keeper);
    const sameMints = c.allowedMints.length === allowed.length && c.allowedMints.every((m, i) => m.equals(allowed[i]));
    const sameSwap = c.swapProgram.equals(JUPITER_PROGRAM_ID);
    if (sameKeeper && sameMints && sameSwap) console.log("Config already up to date");
    else await send([updateConfigIx({
      programId, admin: admin.publicKey,
      keeper: sameKeeper ? undefined : keeper,
      swapProgram: sameSwap ? undefined : JUPITER_PROGRAM_ID,
      allowedMints: sameMints ? undefined : allowed,
    })], "update_config");
  }

  const bal = await conn.getBalance(keeper);
  console.log(`Keeper balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  // An explicit amount from the workflow always sends; otherwise only refill a nearly empty keeper.
  if (topUpSol > 0 && (process.env.KEEPER_TOPUP_SOL || bal < 0.01 * LAMPORTS_PER_SOL)) {
    await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: keeper, lamports: Math.round(topUpSol * LAMPORTS_PER_SOL) })], `Keeper top-up ${topUpSol} SOL`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
