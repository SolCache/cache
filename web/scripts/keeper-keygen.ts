// Generates the keeper keypair. The secret goes straight to stdout for `wrangler secret put`
// (never logged); the public key is written to deploy/keeper-pubkey.txt.
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { writeFileSync, mkdirSync } from "node:fs";

const kp = Keypair.generate();
mkdirSync("../deploy", { recursive: true });
writeFileSync("../deploy/keeper-pubkey.txt", kp.publicKey.toBase58() + "\n");
process.stdout.write(bs58.encode(kp.secretKey));
