import { appendFileSync, mkdirSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  ExactGalaChainClientScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
} from "../src/index.js";
import { privateKey } from "./keys.js";

// Paid-tier acceptance against the live GalaSwap leaderboard
// (galaswap-leaderboard/docs/paid-tier-spec.md, Part C4). Spends real GALA
// from the probe BUYER wallet: one 10 GALA pool-econ session plus the 1 GALA
// fee. The wallet-history purchase is expected to be refused before settle
// because the probe wallet has no GalaSwap history.

const BASE = (process.env.LEADERBOARD_URL ?? "https://swap-leaderboard.gala.com").replace(/\/$/, "");
const PAY_TO = process.env.X402_PAY_TO ?? "eth|5410685578383FBa214beA0522123B492a66f059";
const gateway = new GalaChainGateway();
const buyerKey = privateKey("BUYER");
const buyer = galaChainAddressFromPrivateKey(buyerKey);

type Check = { id: string; ok: boolean; detail: unknown };
const checks: Check[] = [];
function check(id: string, ok: boolean, detail: unknown) {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function gala(owner: string): Promise<number> {
  const res = await gateway.fetchBalances(owner);
  const row = (res.body.Data ?? []).find(b => b.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

async function balances() {
  const [b, p] = await Promise.all([gala(buyer), gala(PAY_TO)]);
  return { buyer: b, payTo: p };
}

function paidFetch() {
  const client = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(buyerKey));
  client.setSpendControls({ allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }] });
  return wrapFetchWithPayment(fetch, client);
}

async function unpaid(path: string, expectAtomic: string) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  const header = res.headers.get("PAYMENT-REQUIRED");
  const req = header ? decodePaymentRequiredHeader(header).accepts[0] : undefined;
  check(`unpaid ${path}`, res.status === 402 && req?.amount === expectAtomic && req?.network === GALACHAIN_NETWORK && req?.payTo === PAY_TO, {
    status: res.status,
    amount: req?.amount,
    network: req?.network,
    payTo: req?.payTo,
  });
}

async function get(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as Record<string, any> };
}

async function main() {
  console.log(`base ${BASE}  buyer ${buyer}  payTo ${PAY_TO}`);
  const start = await balances();
  console.log(`balances before ${JSON.stringify(start)}`);
  if (start.buyer < 12) throw new Error(`buyer has ${start.buyer} GALA; need at least 12`);

  await unpaid("/api/v1/paid/session/wallet-history", "500000000");
  await unpaid("/api/v1/paid/session/pool-econ", "1000000000");

  // No history for this payer: handler returns 404, settlement is cancelled.
  const wh = await paidFetch()(`${BASE}/api/v1/paid/session/wallet-history`, { method: "POST" });
  const whBody = await wh.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 5_000));
  const afterWh = await balances();
  check("wallet-history refused without charge", wh.status === 404 && afterWh.buyer === start.buyer && !wh.headers.get("PAYMENT-RESPONSE"), {
    status: wh.status,
    body: whBody,
    buyerDelta: afterWh.buyer - start.buyer,
  });

  const pe = await paidFetch()(`${BASE}/api/v1/paid/session/pool-econ`, { method: "POST" });
  const peBody = (await pe.json().catch(() => ({}))) as Record<string, any>;
  const prHeader = pe.headers.get("PAYMENT-RESPONSE");
  const settlement = prHeader ? decodePaymentResponseHeader(prHeader) : undefined;
  const token: string | undefined = peBody.token;
  check("pool-econ session paid", pe.status === 200 && !!token && settlement?.success === true && peBody.payer === buyer, {
    status: pe.status,
    tx: settlement?.transaction,
    payer: peBody.payer,
    expiresAt: peBody.expiresAt,
  });
  if (!token) throw new Error("no token; stopping before data checks");

  const d30 = await get("/api/v1/paid/pool-econ?window=30d", token);
  const pools: any[] = d30.body.pools ?? [];
  const ratioRule = pools.every(p => (p.coveredFeesUsd === 0 ? p.asFeeRatio === null && !!p.ratioUnavailableReason : p.asFeeRatio !== null));
  check("pool-econ 30d data", d30.status === 200 && pools.length > 0 && ratioRule && pools.every(p => p.window === "30d"), {
    status: d30.status,
    pools: pools.length,
    nullRatios: pools.filter(p => p.asFeeRatio === null).length,
    asOf: d30.body.asOf,
  });

  const d90 = await get("/api/v1/paid/pool-econ?window=90d", token);
  check("pool-econ 90d data", d90.status === 200 && (d90.body.pools ?? []).length > 0, { status: d90.status, pools: (d90.body.pools ?? []).length });

  const d7 = await get("/api/v1/paid/pool-econ?window=7d", token);
  check("pool-econ 7d withheld", d7.status === 400, { status: d7.status, error: d7.body.error });

  const wrong = await get("/api/v1/paid/wallet-history", token);
  check("token refused on other product", wrong.status === 401 && wrong.body.detail?.reason === "wrong-product", { status: wrong.status, reason: wrong.body.detail?.reason });

  const [body, mac] = token.split(".");
  const tampered = `${body}.${mac.slice(0, 10)}${mac[10] === "A" ? "B" : "A"}${mac.slice(11)}`;
  const bad = await get("/api/v1/paid/pool-econ?window=30d", tampered);
  check("tampered token refused", bad.status === 401 && bad.body.detail?.reason === "bad-signature", { status: bad.status, reason: bad.body.detail?.reason });

  const none = await get("/api/v1/paid/pool-econ?window=30d");
  check("missing token refused", none.status === 401, { status: none.status });

  const free = await get("/api/v1/leaderboard?window=7d&limit=1");
  check("free leaderboard untouched", free.status === 200, { status: free.status });

  await new Promise(r => setTimeout(r, 5_000));
  const end = await balances();
  const delta = { buyer: end.buyer - start.buyer, payTo: end.payTo - start.payTo };
  check("balances", delta.buyer === -11 && delta.payTo === 10, delta);

  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  mkdirSync("runs", { recursive: true });
  appendFileSync(
    "runs/leaderboard-acceptance.jsonl",
    JSON.stringify({ at: new Date().toISOString(), base: BASE, buyer, payTo: PAY_TO, start, end, delta, tx: settlement?.transaction, checks }) + "\n",
  );
  if (failed) process.exitCode = 1;
}

await main();
