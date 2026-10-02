import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  ExactGalaChainClientScheme,
  GALA_ASSET_ID,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
} from "../src/index.js";
import { privateKey } from "./keys.js";

// Buy leaderboard paid sessions and keep everything the buyer receives.
// Usage: tsx harness/leaderboard-buy.ts wallet-history pool-econ
// Output (tokens are bearer secrets, so outside every repo):
//   $X402_PURCHASES_DIR or ~/x402-purchases/<timestamp>/

const BASE = (process.env.LEADERBOARD_URL ?? "https://swap-leaderboard.gala.com").replace(/\/$/, "");
const PRODUCTS: Record<string, string[]> = {
  "wallet-history": ["/api/v1/paid/wallet-history"],
  "pool-econ": ["/api/v1/paid/pool-econ?window=30d", "/api/v1/paid/pool-econ?window=90d"],
};

const wanted = process.argv.slice(2);
if (wanted.length === 0 || wanted.some(p => !PRODUCTS[p])) {
  throw new Error(`usage: leaderboard-buy.ts <${Object.keys(PRODUCTS).join("|")}>...`);
}

const key = privateKey("BUYER");
const client = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(key));
client.setSpendControls({ allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }] });
const paidFetch = wrapFetchWithPayment(fetch, client);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.env.X402_PURCHASES_DIR ?? join(homedir(), "x402-purchases"), stamp);
mkdirSync(outDir, { recursive: true });
console.log(`payer ${galaChainAddressFromPrivateKey(key)}  out ${outDir}`);

for (const product of wanted) {
  const res = await paidFetch(`${BASE}/api/v1/paid/session/${product}`, { method: "POST" });
  const session = (await res.json().catch(() => ({}))) as Record<string, any>;
  const header = res.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : undefined;
  writeFileSync(join(outDir, `${product}-session.json`), JSON.stringify({ status: res.status, settlement, ...session }, null, 2));
  console.log(`${product} session ${res.status} tx=${settlement?.transaction ?? "-"} expires=${session.expiresAt ?? "-"}`);
  if (!session.token) continue;

  for (const path of PRODUCTS[product]) {
    const data = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
    const body = await data.json().catch(() => ({}));
    const name = path.split("/").pop()!.replace(/[?=]/g, "-");
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(body, null, 2));
    console.log(`  ${path} ${data.status} -> ${name}.json`);
  }
}
