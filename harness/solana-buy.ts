import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { secret } from "./keys.js";

// Buy a leaderboard pool-econ session with GALA on Solana, settled by
// Coinbase's hosted facilitator. Spends 10 GALA (SPL) from
// SOLANA_BUYER_PRIVATE_KEY (base58, as Phantom exports it) in ~/.x402-probe/.env.
// LEADERBOARD_URL defaults to production; point it at http://localhost:3000
// for a pre-deploy run.

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GALA_MINT = "eEUiUs4JWYZrp72djAGF1A8PhpR6rHphGeGN7GbVLp6";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const BASE = (process.env.LEADERBOARD_URL ?? "https://swap-leaderboard.gala.com").replace(/\/$/, "");
const SKIP_DATA = process.env.SKIP_DATA === "1";

async function galaBalance(owner: string): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: GALA_MINT }, { encoding: "jsonParsed" }],
    }),
  });
  const body = (await res.json()) as any;
  return (body.result?.value ?? []).reduce(
    (sum: number, acct: any) => sum + Number(acct.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
    0,
  );
}

const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret("SOLANA_BUYER_PRIVATE_KEY")));
const client = new x402Client().register(SOLANA_MAINNET, new ExactSvmScheme(signer, { rpcUrl: RPC }));
client.setSpendControls({ allowedAssets: [{ network: SOLANA_MAINNET, asset: GALA_MINT }] });
const paidFetch = wrapFetchWithPayment(fetch, client);

const unpaid = await fetch(`${BASE}/api/v1/paid/session/pool-econ`, { method: "POST" });
const required = unpaid.headers.get("PAYMENT-REQUIRED");
const offers = required ? decodePaymentRequiredHeader(required).accepts : [];
const offered = offers.find(o => o.network === SOLANA_MAINNET);
console.log(`base ${BASE}  buyer ${signer.address}`);
console.log(`402 status=${unpaid.status} networks=${offers.map(o => o.network).join(",")}`);
console.log(`solana option ${JSON.stringify(offered ?? null)}`);
if (!offered) throw new Error("no Solana option in the 402; is the rail switched on?");
if (offered.asset !== GALA_MINT || offered.amount !== "1000000000") throw new Error("unexpected Solana price/asset");

const payTo: string = offered.payTo;
const before = { buyer: await galaBalance(signer.address), payTo: await galaBalance(payTo) };
console.log(`GALA before ${JSON.stringify(before)}`);
if (before.buyer < 10) throw new Error(`buyer holds ${before.buyer} GALA on Solana; needs 10`);

const res = await paidFetch(`${BASE}/api/v1/paid/session/pool-econ`, { method: "POST" });
const session = (await res.json().catch(() => ({}))) as Record<string, any>;
const header = res.headers.get("PAYMENT-RESPONSE");
const settlement = header ? decodePaymentResponseHeader(header) : undefined;
console.log(`session status=${res.status} tx=${settlement?.transaction ?? "-"} payer=${session.payer ?? "-"} error=${session.error ?? "-"}`);
const rejected = res.status === 402 ? res.headers.get("PAYMENT-REQUIRED") : null;
if (rejected) console.log(`rejected: ${decodePaymentRequiredHeader(rejected).error ?? "(no reason given)"}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.env.X402_PURCHASES_DIR ?? join(homedir(), "x402-purchases"), `${stamp}-solana`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "pool-econ-session.json"), JSON.stringify({ status: res.status, settlement, ...session }, null, 2));

if (session.token && !SKIP_DATA) {
  const data = await fetch(`${BASE}/api/v1/paid/pool-econ?window=30d`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const body = (await data.json().catch(() => ({}))) as Record<string, any>;
  writeFileSync(join(outDir, "pool-econ-window-30d.json"), JSON.stringify(body, null, 2));
  console.log(`data status=${data.status} pools=${(body.pools ?? []).length}`);
}

await new Promise(r => setTimeout(r, 8_000));
const after = { buyer: await galaBalance(signer.address), payTo: await galaBalance(payTo) };
console.log(`GALA after ${JSON.stringify(after)} delta buyer=${+(after.buyer - before.buyer).toFixed(8)} payTo=${+(after.payTo - before.payTo).toFixed(8)}`);
console.log(`saved ${outDir}`);
