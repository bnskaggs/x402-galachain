/**
 * One paid mainnet call through the HTTP facilitator.
 * Cost: 0.01 GALA principal + the 1 GALA TransferToken fee.
 * Prints addresses and timings. Never prints keys.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ExactGalaChainClientScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
  type ExactGalaChainPayload,
} from "../src/index.js";
import { createApp } from "../service/app.js";
import { privateKey } from "./keys.js";

const AMOUNT_ATOMIC = "1000000"; // 0.01 GALA
const gateway = new GalaChainGateway();
const buyerKey = privateKey("BUYER");
const buyer = galaChainAddressFromPrivateKey(buyerKey);
const seller = galaChainAddressFromPrivateKey(privateKey("SELLER"));

async function galaQty(owner: string): Promise<number | null> {
  const res = await gateway.fetchBalances(owner);
  if (res.status !== 200 || res.body.Status !== 1) return null;
  const row = (res.body.Data ?? []).find(balance => balance.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

const buyerBefore = await galaQty(buyer);
const sellerBefore = await galaQty(seller);
if (buyerBefore === null || buyerBefore < 1.02) {
  console.log(`abort: buyer balance ${buyerBefore} is under 1.02 GALA`);
  process.exit(1);
}

const app = createApp({ allowedPayTo: [seller], allowOpenRelay: false });
const server: Server = await new Promise(resolve => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const url = `http://127.0.0.1:${port}`;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: GALACHAIN_NETWORK,
  amount: AMOUNT_ATOMIC,
  asset: GALA_ASSET_ID,
  payTo: seller,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "transfer-token", decimals: 8, name: "GALA" },
};
const client = new ExactGalaChainClientScheme(buyerKey);
const created = await client.createPaymentPayload(2, requirements);
const payload: PaymentPayload = {
  x402Version: 2,
  resource: { url: "http://localhost/quote", description: "http-proof", mimeType: "application/json" },
  accepted: requirements,
  payload: created.payload,
};
const uniqueKey = (created.payload as ExactGalaChainPayload).dto.uniqueKey;

async function post(route: "verify" | "settle") {
  const started = Date.now();
  const res = await fetch(`${url}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const body = await res.json();
  return { status: res.status, ms: Date.now() - started, body };
}

try {
  const verified = await post("verify");
  const settled = await post("settle");
  const buyerAfter = await galaQty(buyer);
  const sellerAfter = await galaQty(seller);
  const record = {
    at: new Date().toISOString(),
    uniqueKey,
    verify: verified,
    settle: settled,
    buyerBefore,
    buyerAfter,
    sellerBefore,
    sellerAfter,
  };
  mkdirSync("runs", { recursive: true });
  appendFileSync("runs/http-proof-2026-09-30.jsonl", JSON.stringify(record) + "\n");
  console.log(JSON.stringify(record));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
