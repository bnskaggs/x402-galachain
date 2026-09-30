/**
 * One paid mainnet call, timings only.
 * Prints addresses, balances, and millisecond timings. Never prints keys.
 *
 * Cost: 0.01 GALA principal + the TransferToken fee (1 GALA on the last read).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ExactGalaChainClientScheme,
  ExactGalaChainFacilitatorScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
  type ExactGalaChainPayload,
} from "../src/index.js";
import { privateKey } from "./keys.js";

const TESTNET_URL = "https://gateway-testnet.galachain.com/api/asset/token-contract";
const AMOUNT_ATOMIC = "1000000"; // 0.01 GALA

const mainnet = new GalaChainGateway();
const testnet = new GalaChainGateway({ url: TESTNET_URL });

async function galaQty(gateway: GalaChainGateway, owner: string): Promise<number | null> {
  const res = await gateway.fetchBalances(owner);
  if (res.status !== 200 || res.body.Status !== 1) return null;
  const row = (res.body.Data ?? []).find(balance => balance.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
}

const buyerKey = privateKey("BUYER");
const buyer = galaChainAddressFromPrivateKey(buyerKey);
const seller = galaChainAddressFromPrivateKey(privateKey("SELLER"));

const [buyerBefore, sellerBefore, testnetBuyer, fee] = await Promise.all([
  galaQty(mainnet, buyer),
  galaQty(mainnet, seller),
  galaQty(testnet, buyer),
  testnet.fetchProposedTransferFee(buyer),
]);

const read = await timed(() => mainnet.fetchBalances(buyer));

console.log(
  JSON.stringify({
    buyer,
    seller,
    buyerBefore,
    sellerBefore,
    testnetBuyer,
    testnetFeeStatus: fee.status,
    testnetFee: fee.body.Data ?? fee.body,
    balanceReadMs: read.ms,
  }),
);

if (buyerBefore === null || buyerBefore < 1.02) {
  console.log(`abort: buyer balance ${buyerBefore} is under 1.02 GALA`);
  process.exit(1);
}

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
  resource: { url: "http://localhost/quote", description: "timing", mimeType: "application/json" },
  accepted: requirements,
  payload: created.payload,
};
const uniqueKey = (created.payload as ExactGalaChainPayload).dto.uniqueKey;

const facilitator = new ExactGalaChainFacilitatorScheme(mainnet);
const verified = await timed(() => facilitator.verify(payload, requirements));
const settled = await timed(() => facilitator.settle(payload, requirements));

const [buyerAfter, sellerAfter] = await Promise.all([galaQty(mainnet, buyer), galaQty(mainnet, seller)]);

const record = {
  at: new Date().toISOString(),
  uniqueKey,
  verifyMs: verified.ms,
  verify: verified.value,
  settleMs: settled.ms,
  settle: { success: settled.value.success, transaction: settled.value.transaction, errorReason: settled.value.errorReason },
  buyerBefore,
  buyerAfter,
  sellerBefore,
  sellerAfter,
  balanceReadMs: read.ms,
  testnetBuyer,
};

mkdirSync("runs", { recursive: true });
appendFileSync("runs/timing-2026-09-30.jsonl", JSON.stringify(record) + "\n");
console.log(JSON.stringify(record));
