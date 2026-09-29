import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { x402Facilitator } from "@x402/core/facilitator";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";
import {
  ExactGalaChainClientScheme,
  ExactGalaChainFacilitatorScheme,
  ExactGalaChainServerScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
  type ExactGalaChainPayload,
} from "../src/index.js";
import { privateKey, type Role } from "./keys.js";

const PORT = Number(process.env.GC_SELLER_PORT ?? 4121);
const SELLER_URL = process.env.GC_SELLER_URL ?? `http://localhost:${PORT}`;
const gateway = new GalaChainGateway();

function gcAddress(role: Role): string {
  return galaChainAddressFromPrivateKey(privateKey(role));
}

async function galaBalance(owner: string): Promise<number> {
  const res = await gateway.fetchBalances(owner);
  const row = (res.body.Data ?? []).find(balance => balance.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

async function snapshot() {
  const [buyer, seller] = await Promise.all([galaBalance(gcAddress("BUYER")), galaBalance(gcAddress("SELLER"))]);
  return { buyer, seller };
}

function delta(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  return {
    buyer: after.buyer - before.buyer,
    seller: after.seller - before.seller,
  };
}

export async function startGalaChainSeller(opts: { port?: number; price?: string } = {}) {
  const port = opts.port ?? PORT;
  const app = express();
  const facilitator = new x402Facilitator().register(
    GALACHAIN_NETWORK,
    new ExactGalaChainFacilitatorScheme(gateway),
  );

  const resourceServer = new x402ResourceServer({
    verify: facilitator.verify.bind(facilitator),
    settle: facilitator.settle.bind(facilitator),
    getSupported: async () => facilitator.getSupported(),
  } as ConstructorParameters<typeof x402ResourceServer>[0]).register(
    GALACHAIN_NETWORK,
    new ExactGalaChainServerScheme(),
  );

  app.use(
    paymentMiddleware(
      {
        "GET /quote": {
          accepts: {
            scheme: "exact",
            price: opts.price ?? "1 GALA",
            network: GALACHAIN_NETWORK,
            payTo: gcAddress("SELLER"),
          },
          description: "One quote, paid in GALA on GalaChain",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.get("/quote", (_req, res) => {
    res.json({ quote: "GALA moved on GalaChain.", servedAt: new Date().toISOString() });
  });

  return new Promise<{ server: Server; url: string }>(resolve => {
    const server = app.listen(port, () => resolve({ server, url: `http://localhost:${port}` }));
  });
}

function createClient({ allowGala }: { allowGala: boolean }) {
  const client = new x402Client().register(
    GALACHAIN_NETWORK,
    new ExactGalaChainClientScheme(privateKey("BUYER")),
  );
  if (allowGala) {
    client.setSpendControls({
      allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }],
    });
  }
  const signed: string[] = [];
  client.onAfterPaymentCreation(async ctx => {
    const payload = ctx.paymentPayload.payload as ExactGalaChainPayload;
    signed.push(payload.dto.uniqueKey);
  });
  return { client, signed };
}

async function attempt(label: string, allowGala: boolean) {
  const { client, signed } = createClient({ allowGala });
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const before = await snapshot();
  let status = 0;
  let body = "";
  let error = "";
  let tx = "";
  try {
    const res = await paidFetch(`${SELLER_URL}/quote`);
    status = res.status;
    body = await res.text();
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (header) tx = decodePaymentResponseHeader(header).transaction;
  } catch (err) {
    error = (err as Error).message;
  }
  await new Promise(resolve => setTimeout(resolve, 4_000));
  const after = await snapshot();
  return { label, allowGala, before, after, delta: delta(before, after), status, body, error, tx, signed };
}

async function main() {
  const seller = await startGalaChainSeller();
  try {
    console.log(`GalaChain seller: ${seller.url}/quote`);
    console.log(`buyer ${gcAddress("BUYER")}  seller ${gcAddress("SELLER")}`);

    const stock = await attempt("stock-defaults", false);
    console.log(`stock-defaults status=${stock.status} signed=${stock.signed.length} error=${stock.error}`);

    const allowed = await attempt("allowed-gala", true);
    console.log(
      `allowed-gala status=${allowed.status} signed=${allowed.signed.length} tx=${allowed.tx} delta=${JSON.stringify(allowed.delta)}`,
    );
    console.log(allowed.body || allowed.error);

    mkdirSync("runs", { recursive: true });
    appendFileSync(
      "runs/galachain-demo-2026-09-29.jsonl",
      JSON.stringify({ at: new Date().toISOString(), stock, allowed }) + "\n",
    );
  } finally {
    await new Promise<void>(resolve => seller.server.close(() => resolve()));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
