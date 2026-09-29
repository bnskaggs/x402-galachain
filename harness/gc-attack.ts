import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import {
  ExactGalaChainClientScheme,
  ExactGalaChainFacilitatorScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
  type ExactGalaChainPayload,
} from "../src/index.js";
import { guarded, type SignedEntry } from "./guard.js";
import { privateKey, type Role } from "./keys.js";
import { withRetry } from "./retry.js";

const PORT = 4121;
const URL = `http://localhost:${PORT}`;
const gateway = new GalaChainGateway();
const facilitator = new ExactGalaChainFacilitatorScheme(gateway);
const PRICE = 1_000_000n; // 0.01 GALA, 8 decimals
const TEN_YEARS = 10 * 365 * 24 * 3600;
const MITIGATED = process.argv.includes("--mitigated");

function addr(role: Role): string {
  return galaChainAddressFromPrivateKey(privateKey(role));
}

function requirements(amount: bigint, payTo = addr("SELLER"), maxTimeoutSeconds = 300): PaymentRequirements {
  return {
    scheme: "exact",
    network: GALACHAIN_NETWORK,
    amount: amount.toString(),
    asset: GALA_ASSET_ID,
    payTo,
    maxTimeoutSeconds,
    extra: { assetTransferMethod: "transfer-token", decimals: 8, name: "GALA" },
  };
}

function paymentRequired(reqs: PaymentRequirements, error = "Payment required"): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url: `${URL}/quote`, description: "One quote, paid in GALA", mimeType: "application/json" },
    accepts: [reqs],
  };
}

function send402(res: express.Response, reqs: PaymentRequirements, error?: string) {
  res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired(reqs, error))).json({});
}

function readPayment(req: express.Request): PaymentPayload | undefined {
  const header = req.header("PAYMENT-SIGNATURE");
  return header ? decodePaymentSignatureHeader(header) : undefined;
}

async function settle(payload: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResponse> {
  return facilitator.settle(payload, reqs);
}

async function balance(owner: string): Promise<number> {
  const res = await gateway.fetchBalances(owner);
  const row = (res.body.Data ?? []).find(b => b.collection === "GALA");
  return row ? Number(row.quantity) : 0;
}

async function snapshot() {
  const [buyer, seller, attacker] = await Promise.all([
    balance(addr("BUYER")),
    balance(addr("SELLER")),
    balance(addr("ATTACKER")),
  ]);
  return { buyer, seller, attacker };
}

function diff(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  return {
    buyer: after.buyer - before.buyer,
    seller: after.seller - before.seller,
    attacker: after.attacker - before.attacker,
  };
}

function listen(app: express.Express) {
  return new Promise<Server>(resolve => {
    const server = app.listen(PORT, () => resolve(server));
  });
}

async function close(server: Server) {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function makeBuyer() {
  const client = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(privateKey("BUYER")));
  client.setSpendControls({ allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }] });
  const ledger: SignedEntry[] = [];
  const refusals: string[] = [];
  const decide = guarded({
    payTo: { [URL]: [addr("SELLER")] },
    maxTimeoutSeconds: 300,
    budgetAtomic: 3n * PRICE,
  });
  if (MITIGATED) {
    client.onBeforePaymentCreation(async ctx => {
      const r = ctx.selectedRequirements;
      const decision = decide(
        {
          origin: URL,
          path: "/quote",
          payTo: r.payTo,
          amountAtomic: BigInt(r.amount),
          maxTimeoutSeconds: typeof r.maxTimeoutSeconds === "number" ? r.maxTimeoutSeconds : 300,
        },
        ledger,
      );
      if (!decision.pay) {
        refusals.push(decision.reason);
        return { abort: true, reason: decision.reason };
      }
    });
  }
  client.onAfterPaymentCreation(async ctx => {
    const payload = ctx.paymentPayload.payload as ExactGalaChainPayload;
    ledger.push({
      origin: URL,
      to: payload.dto.to,
      amountAtomic: BigInt(ctx.selectedRequirements.amount),
      uniqueKey: payload.dto.uniqueKey,
      dtoExpiresAt: payload.dto.dtoExpiresAt,
      delivered: false,
    });
  });
  return { fetch: wrapFetchWithPayment(fetch, client), ledger, refusals };
}

async function paidGet(buyer: ReturnType<typeof makeBuyer>, url = `${URL}/quote`) {
  const before = buyer.ledger.length;
  try {
    const res = await buyer.fetch(url);
    if (res.ok && buyer.ledger.length > before) buyer.ledger[buyer.ledger.length - 1].delivered = true;
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

async function hostile(kind: "A1" | "A1b" | "A2" | "A3a" | "A4" | "A7") {
  const app = express();
  const settles: SettleResponse[] = [];
  const held: { payload: PaymentPayload; reqs: PaymentRequirements }[] = [];
  let price = PRICE;
  app.get("/quote", async (req, res) => {
    const reqs = requirements(price, addr("SELLER"), kind === "A7" ? TEN_YEARS : 300);
    const payload = readPayment(req);
    if (!payload) return send402(res, reqs);
    if (kind === "A7") {
      held.push({ payload, reqs: payload.accepted });
      res.status(500).json({ error: "internal error" });
      return;
    }
    const s = await settle(payload, payload.accepted);
    settles.push(s);
    if (!s.success) return send402(res, reqs, `settle failed: ${s.errorReason}`);
    if (kind === "A1") return res.status(500).json({ error: "internal error" });
    if (kind === "A1b") return send402(res, reqs, "Payment failed. Please retry.");
    if (kind === "A2") {
      const paid = price;
      price *= 2n;
      return res.json({ paid: paid.toString(), quote: "Budgets are features." });
    }
    if (kind === "A3a") {
      res.json({ quote: "Budgets are features." });
      settles.push(await settle(payload, payload.accepted));
      return;
    }
    res.json({ status: "pending", message: "Result not ready. Poll again." });
  });
  const server = await listen(app);
  return {
    server,
    settles,
    held,
    async cashOut() {
      for (const h of held) settles.push(await settle(h.payload, h.reqs));
    },
  };
}

async function a3b(lockNonces = false) {
  const app = express();
  let handlerRuns = 0;
  const seen = new Set<string>();
  app.get("/quote", async (req, res) => {
    const reqs = requirements(PRICE);
    const payload = readPayment(req);
    if (!payload) return send402(res, reqs);
    if (lockNonces) {
      const uniqueKey = (payload.payload as { dto?: { uniqueKey?: string } }).dto?.uniqueKey;
      if (uniqueKey && seen.has(uniqueKey)) {
        res.status(409).json({ error: "authorization already used" });
        return;
      }
      if (uniqueKey) seen.add(uniqueKey);
    }
    const verify = await facilitator.verify(payload, payload.accepted);
    if (!verify.isValid) return send402(res, reqs, String(verify.invalidReason));
    handlerRuns++;
    await new Promise(resolve => setTimeout(resolve, 250));
    const s = await settle(payload, payload.accepted);
    if (!s.success) return send402(res, reqs, String(s.errorReason));
    res.json({ quote: "A signature is a promise with a deadline." });
  });
  const server = await listen(app);
  const rawClient = new x402Client().register(GALACHAIN_NETWORK, new ExactGalaChainClientScheme(privateKey("BUYER")));
  rawClient.setSpendControls({ allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }] });
  const first = await fetch(`${URL}/quote`);
  const pr = first.headers.get("PAYMENT-REQUIRED");
  if (!pr) throw new Error("A3b failed to obtain payment requirements");
  const http = new x402HTTPClient(rawClient);
  const paymentRequiredResponse = http.getPaymentRequiredResponse(name => first.headers.get(name));
  const paymentPayload = await rawClient.createPaymentPayload(paymentRequiredResponse);
  const headers = http.encodePaymentSignatureHeader(paymentPayload);
  const responses = await Promise.all([0, 1].map(() => fetch(`${URL}/quote`, { headers })));
  const statuses = responses.map(r => r.status);
  await Promise.all(responses.map(r => r.text()));
  await close(server);
  return { handlerRuns, statuses };
}

async function a5() {
  const app = express();
  const settles: SettleResponse[] = [];
  app.get("/quote", async (req, res) => {
    const reqs = requirements(PRICE, addr("ATTACKER"));
    const payload = readPayment(req);
    if (!payload) return send402(res, reqs);
    settles.push(await settle(payload, payload.accepted));
    res.json({ quote: "Measure twice, pay once." });
  });
  const server = await listen(app);
  return { server, settles };
}

async function run() {
  const attack = process.argv[2];
  const before = await snapshot();
  const buyer = makeBuyer();
  let extra: Record<string, unknown> = {};

  if (attack === "A1" || attack === "A1b" || attack === "A3a") {
    const h = await hostile(attack);
    const { result, attempts } = await withRetry(() => paidGet(buyer), 3);
    extra = { attempts, result, settles: h.settles };
    await close(h.server);
  } else if (attack === "A2") {
    const h = await hostile("A2");
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(await withRetry(() => paidGet(buyer), 3));
    extra = { tasks, settles: h.settles };
    await close(h.server);
  } else if (attack === "A3b") {
    extra = await a3b(MITIGATED);
  } else if (attack === "A4") {
    const h = await hostile("A4");
    const tasks = [];
    for (let i = 0; i < 10; i++) tasks.push(await withRetry(() => paidGet(buyer), 3));
    extra = { tasks, settles: h.settles };
    await close(h.server);
  } else if (attack === "A5") {
    const h = await a5();
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push(await withRetry(() => paidGet(buyer), 3));
    extra = { tasks, settles: h.settles };
    await close(h.server);
  } else if (attack === "A7") {
    const h = await hostile("A7");
    const { result, attempts } = await withRetry(() => paidGet(buyer), 3);
    const atTaskEnd = await snapshot();
    await h.cashOut();
    await new Promise(resolve => setTimeout(resolve, 4_000));
    extra = { attempts, result, atTaskEnd, deltaAtTaskEnd: diff(before, atTaskEnd), held: h.held.length, settles: h.settles };
    await close(h.server);
  } else {
    throw new Error("usage: npm run attack -- A1|A1b|A2|A3a|A3b|A4|A5|A7");
  }

  await new Promise(resolve => setTimeout(resolve, 4_000));
  const after = await snapshot();
  const record = {
    at: new Date().toISOString(),
    chain: "galachain",
    attack,
    variant: MITIGATED ? "mitigated" : "naive",
    before,
    after,
    delta: diff(before, after),
    signed: buyer.ledger.map(e => e.uniqueKey),
    delivered: buyer.ledger.filter(e => e.delivered).length,
    refusals: buyer.refusals,
    ...extra,
  };
  console.log(JSON.stringify(record, null, 2));
  mkdirSync("runs", { recursive: true });
  appendFileSync("runs/galachain-attacks-2026-09-29.jsonl", JSON.stringify(record) + "\n");
}

await run();
