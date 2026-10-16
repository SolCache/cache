// Converts the DEPLOYER_PRIVATE_KEY secret (base58, as exported from Phantom) into a
// Solana CLI keypair file. Prints only the public key.
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const secret = (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
if (!secret) throw new Error("DEPLOYER_PRIVATE_KEY secret is missing. Add it in GitHub → Settings → Secrets and variables → Actions.");
let bytes: Uint8Array;
if (secret.startsWith("[")) bytes = Uint8Array.from(JSON.parse(secret));
else bytes = bs58.decode(secret);
const kp = Keypair.fromSecretKey(bytes);
const out = process.argv[2] ?? `${process.env.HOME}/.config/solana/id.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log(kp.publicKey.toBase58());
