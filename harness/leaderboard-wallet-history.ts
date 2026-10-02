import { appendFileSync, mkdirSync } from "node:fs";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  ExactGalaChainClientScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
} from "../src/index.js";
import { privateKey } from "./keys.js";

// Paid-tier spec steps 2-3: buy a wallet-history session as a wallet that has
// GalaSwap history. Point X402_PROBE_ENV at the env file holding that key.
// Costs 5 GALA + 1 GALA fee if the payer has history; nothing if not.

const BASE = (process.env.LEADERBOARD_URL ?? "https://swap-leaderboard.gala.com").replace(/\/$/, "");
const PAY_TO = process.env.X402_PAY_TO ?? "eth|5410685578383FBa214beA0522123B492a66f059";
const OTHER = "eth|867ED02aE41dE46A15a6b0831AFE0e319A9703c5";
const gateway = new GalaChainGateway();
const key = privateKey("BUYER");
const payer = galaChainAddressFromPrivateKey(key);

type Check = { id: string; ok: boolean; detail: unknown };
const checks: Check[] = [];
function check(id: string, ok: boolean, detail: unknown) {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail)}`);
}

async function gala(owner: string): Promise<number> {
  const res = await gateway.fetchBalances(owner);
  const row = (res.body.Data ?? []).find(b => b.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

async function get(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const client = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(key));
client.setSpendControls({ allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }] });
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`base ${BASE}  payer ${payer}  payTo ${PAY_TO}`);
const start = { payer: await gala(payer), payTo: await gala(PAY_TO) };
console.log(`balances before ${JSON.stringify(start)}`);

const res = await paidFetch(`${BASE}/api/v1/paid/session/wallet-history`, { method: "POST" });
const body = (await res.json().catch(() => ({}))) as Record<string, any>;
const header = res.headers.get("PAYMENT-RESPONSE");
const settlement = header ? decodePaymentResponseHeader(header) : undefined;

if (res.status === 404) {
  await new Promise(r => setTimeout(r, 5_000));
  console.log(`no history for payer; refused before settle; payer delta ${(await gala(payer)) - start.payer}`);
  process.exit(0);
}

check("wallet-history session paid", res.status === 200 && !!body.token && settlement?.success === true && body.payer === payer, {
  status: res.status,
  tx: settlement?.transaction,
  payer: body.payer,
  expiresAt: body.expiresAt,
  error: body.error,
});
if (!body.token) process.exit(1);

const own = await get("/api/v1/paid/wallet-history", body.token);
const rows: any[] = own.body.rows ?? [];
const ownOnly = rows.every(r => String(r.address).toLowerCase() === payer.toLowerCase());
check("own rows only", own.status === 200 && rows.length > 0 && ownOnly, {
  status: own.status,
  rows: rows.length,
  first: rows[0]?.day,
  last: rows.at(-1)?.day,
});

const spoof = await get(`/api/v1/paid/wallet-history?address=${encodeURIComponent(OTHER)}`, body.token);
const spoofRows: any[] = spoof.body.rows ?? [];
check("address param ignored", spoof.status === 200 && spoofRows.length === rows.length && spoof.body.meta?.ignoredAddress === OTHER, {
  status: spoof.status,
  rows: spoofRows.length,
  ignoredAddress: spoof.body.meta?.ignoredAddress,
});

const wrong = await get("/api/v1/paid/pool-econ?window=30d", body.token);
check("token refused on pool-econ", wrong.status === 401 && wrong.body.detail?.reason === "wrong-product", {
  status: wrong.status,
  reason: wrong.body.detail?.reason,
});

await new Promise(r => setTimeout(r, 5_000));
const end = { payer: await gala(payer), payTo: await gala(PAY_TO) };
const delta = { payer: +(end.payer - start.payer).toFixed(8), payTo: +(end.payTo - start.payTo).toFixed(8) };
check("balances", delta.payer === -6 && delta.payTo === 5, delta);

const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
mkdirSync("runs", { recursive: true });
appendFileSync(
  "runs/leaderboard-acceptance.jsonl",
  JSON.stringify({ at: new Date().toISOString(), kind: "wallet-history", base: BASE, payer, payTo: PAY_TO, start, end, delta, tx: settlement?.transaction, checks }) + "\n",
);
if (failed) process.exitCode = 1;
