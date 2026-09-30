/**
 * Pays the hosted seller once, then replays the same signed payload.
 * Cost of the first call: 1 GALA plus the 1 GALA transfer fee.
 * The replay must not move more GALA.
 *
 * Keys are read from ~/.x402-probe/.env. Nothing here prints a key.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactGalaChainClientScheme, GALA_ASSET_ID, GALACHAIN_NETWORK } from "x402-galachain";

const sellerUrl = (process.env.SELLER_URL ?? "https://x402-galachain-demo.vercel.app").replace(/\/$/, "");
const envPath = process.env.X402_PROBE_ENV ?? join(homedir(), ".x402-probe", ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split("=") as [string, string]),
);
const buyerKey = env.BUYER_PRIVATE_KEY;
if (!buyerKey) throw new Error(`BUYER_PRIVATE_KEY not set in ${envPath}`);

const client = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(buyerKey));
client.setSpendControls({
  allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }],
});

let signed: PaymentPayload | undefined;
client.onAfterPaymentCreation(async ctx => {
  signed = ctx.paymentPayload;
});

const paidFetch = wrapFetchWithPayment(fetch, client);
const quoteUrl = `${sellerUrl}/quote`;

const first = await paidFetch(quoteUrl);
const firstBody = await first.text();
const firstHeader = first.headers.get("PAYMENT-RESPONSE");
const firstTx = firstHeader ? decodePaymentResponseHeader(firstHeader).transaction : "";
console.log(JSON.stringify({ run: "pay", status: first.status, tx: firstTx, body: firstBody }));

if (!signed) throw new Error("client did not sign a payload");

const replay = await fetch(quoteUrl, {
  headers: {
    "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(signed),
    "X-PAYMENT": encodePaymentSignatureHeader(signed),
  },
});
const replayBody = await replay.text();
const replayHeader = replay.headers.get("PAYMENT-RESPONSE");
const requiredHeader = replay.headers.get("PAYMENT-REQUIRED");
let replayDecoded: unknown = null;
let paymentRequired: unknown = null;
if (replayHeader) {
  try {
    replayDecoded = decodePaymentResponseHeader(replayHeader);
  } catch {
    replayDecoded = null;
  }
}
if (requiredHeader) {
  try {
    paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  } catch {
    paymentRequired = null;
  }
}
console.log(
  JSON.stringify({
    run: "replay",
    status: replay.status,
    body: replayBody,
    paymentResponse: replayDecoded,
    paymentRequired,
    priorTx: firstTx,
  }),
);
