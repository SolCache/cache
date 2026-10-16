// Prepares a local test validator: a test deployer keypair and a fake USDC mint account at the
// real USDC address (so the app's hard-coded USDC mint works), with the test deployer as mint authority.
import { Keypair } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { TOKEN_PROGRAM_ID, USDC_MINT } from "../src/shared/cache";

const dir = "/tmp/localnet";
mkdirSync(dir, { recursive: true });
const auth = Keypair.generate();
writeFileSync(`${dir}/deployer.json`, JSON.stringify(Array.from(auth.secretKey)));

// SPL Mint layout (82 bytes): mintAuthority COption, supply u64, decimals u8, isInitialized bool, freezeAuthority COption
const data = new Uint8Array(82);
const dv = new DataView(data.buffer);
dv.setUint32(0, 1, true);
data.set(auth.publicKey.toBytes(), 4);
dv.setBigUint64(36, 0n, true);
data[44] = 6;
data[45] = 1;
dv.setUint32(46, 0, true);

writeFileSync(`${dir}/usdc.json`, JSON.stringify({
  pubkey: USDC_MINT.toBase58(),
  account: {
    lamports: 1_461_600,
    data: [Buffer.from(data).toString("base64"), "base64"],
    owner: TOKEN_PROGRAM_ID.toBase58(),
    executable: false,
    rentEpoch: 0,
    space: 82,
  },
}));
console.log(auth.publicKey.toBase58());
