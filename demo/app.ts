import { decodePaymentRequiredHeader, HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { decodePaymentResponseHeader, x402Client, x402HTTPClient } from "@x402/fetch";
import express from "express";
import {
  ExactGalaChainClientScheme,
  ExactGalaChainServerScheme,
  GALA_ASSET_ID,
  GalaChainGateway,
  GALACHAIN_NETWORK,
  galaChainAddressFromPrivateKey,
  galaQuantityToAtomic,
  isSuccess,
  type ExactGalaChainPayload,
} from "x402-galachain";
import {
  firstRequirement,
  landingPage,
  paymentRequiredBody,
  paywallPage,
  summarizeRequirements,
} from "./landing.js";

const payTo = process.env.SELLER_ADDRESS;
if (!payTo) throw new Error("SELLER_ADDRESS is required");

const facilitatorUrl =
  process.env.FACILITATOR_URL ?? "https://x402-galachain-facilitator-ten.vercel.app";
const demoBuyerKey = process.env.DEMO_BUYER_KEY;
const minimumDemoBalanceAtomic = galaQuantityToAtomic("2.01");

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitator).register(
  GALACHAIN_NETWORK,
  new ExactGalaChainServerScheme(),
);

const app = express();
app.disable("x-powered-by");

type DemoStep = {
  title: string;
  summary: string;
  ms?: number;
  details?: Record<string, unknown>;
};

const rateLimits = new Map<string, number[]>();
let demoPaymentInFlight = false;

app.get("/", (_req, res) => {
  res.type("html").send(
    landingPage({
      demoBuyerEnabled: Boolean(demoBuyerKey),
      facilitatorUrl,
      payTo,
    }),
  );
});

app.use((_, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    const paymentRequiredHeader = res.getHeader("PAYMENT-REQUIRED");
    if (
      res.statusCode === 402 &&
      body &&
      typeof body === "object" &&
      Object.keys(body).length === 0 &&
      typeof paymentRequiredHeader === "string"
    ) {
      try {
        return originalJson(paymentRequiredBody(decodePaymentRequiredHeader(paymentRequiredHeader)));
      } catch {
        return originalJson({
          message: "Payment required, but the PAYMENT-REQUIRED header could not be decoded.",
        });
      }
    }
    return originalJson(body);
  }) as typeof res.json;
  next();
});

app.post("/pay-demo", async (req, res) => {
  if (!demoBuyerKey) {
    res.status(503).json({ error: "DEMO_BUYER_KEY is not configured yet." });
    return;
  }

  const rateLimit = checkRateLimit(req.ip ?? req.socket.remoteAddress ?? "unknown");
  if (!rateLimit.ok) {
    res.status(429).json({ error: `Demo rate limit hit. Try again in ${rateLimit.retryAfterSeconds}s.` });
    return;
  }

  if (demoPaymentInFlight) {
    res.status(409).json({ error: "A demo payment is already in flight. Try again in a few seconds." });
    return;
  }

  demoPaymentInFlight = true;
  try {
    const steps: DemoStep[] = [];
    const clientScheme = new ExactGalaChainClientScheme(demoBuyerKey);
    const payer = galaChainAddressFromPrivateKey(demoBuyerKey);

    await requireDemoBalance(payer);

    const client = new x402Client().register(GALACHAIN_NETWORK, clientScheme);
    client.setSpendControls({
      allowedAssets: [{ network: GALACHAIN_NETWORK, asset: GALA_ASSET_ID }],
    });
    const httpClient = new x402HTTPClient(client);
    const quoteUrl = `${baseUrl(req)}/quote`;

    const unpaidStart = Date.now();
    const unpaid = await fetch(quoteUrl, {
      headers: { accept: "application/json" },
    });
    const unpaidBody = await unpaid.text();
    const unpaidMs = Date.now() - unpaidStart;
    const paymentRequiredHeader = unpaid.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new Error(`Expected PAYMENT-REQUIRED from /quote, got HTTP ${unpaid.status}`);
    }
    const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
    const requirement = firstRequirement(paymentRequired);
    steps.push({
      title: "1. Unpaid request",
      summary: `GET /quote returned HTTP ${unpaid.status} in ${unpaidMs}ms.`,
      ms: unpaidMs,
      details: {
        body: tryJson(unpaidBody),
        accepts: requirement ? [summarizeRequirements(requirement)] : paymentRequired.accepts,
      },
    });

    const paymentStart = Date.now();
    const paymentRequiredResponse = httpClient.getPaymentRequiredResponse(name => unpaid.headers.get(name));
    const paymentPayload = await client.createPaymentPayload(paymentRequiredResponse);
    const paymentMs = Date.now() - paymentStart;
    steps.push({
      title: "2. Client signs",
      summary: `The demo buyer signed a GalaChain TransferToken payload in ${paymentMs}ms.`,
      ms: paymentMs,
      details: {
        payer,
        payload: redactPaymentPayload(paymentPayload),
      },
    });

    steps.push({
      title: "3. Seller verifies and settles",
      summary:
        "On the retry, the seller asks the hosted facilitator to dry-run the signed payload, then submit TransferToken.",
      details: {
        facilitator: facilitatorUrl,
        note: "This is server-to-server; the returned transaction id is the observable proof.",
      },
    });

    const paidStart = Date.now();
    const paid = await fetch(quoteUrl, {
      headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
    });
    const paidBody = await paid.text();
    const paidMs = Date.now() - paidStart;
    const paymentResponseHeader = paid.headers.get("PAYMENT-RESPONSE");
    const paymentResponse = paymentResponseHeader
      ? decodePaymentResponseHeader(paymentResponseHeader)
      : null;

    steps.push({
      title: "4. Paid response",
      summary: `Retry returned HTTP ${paid.status} in ${paidMs}ms.`,
      ms: paidMs,
      details: {
        body: tryJson(paidBody),
        paymentResponse,
      },
    });

    res.json({
      ok: paid.ok,
      tx: paymentResponse?.transaction ?? "",
      payer,
      totalMs: unpaidMs + paymentMs + paidMs,
      steps,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    demoPaymentInFlight = false;
  }
});

app.use(
  paymentMiddleware(
    {
      "GET /quote": {
        accepts: {
          scheme: "exact",
          price: "1 GALA",
          network: GALACHAIN_NETWORK,
          payTo,
        },
        description: "One quote, paid in GALA on GalaChain",
        mimeType: "application/json",
      },
    },
    resourceServer,
    undefined,
    {
      generateHtml(paymentRequired: PaymentRequired) {
        return paywallPage(paymentRequired);
      },
    },
  ),
);

app.get("/quote", (_req, res) => {
  res.json({ quote: "GALA moved on GalaChain.", servedAt: new Date().toISOString() });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 4022);
  app.listen(port, () => {
    console.log(`x402 GalaChain demo listening on http://localhost:${port}`);
  });
}

export default app;

function baseUrl(req: express.Request): string {
  const protocol = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("host");
  if (!host) throw new Error("Missing Host header");
  return `${protocol}://${host}`;
}

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const hits = (rateLimits.get(ip) ?? []).filter(ts => now - ts < windowMs);
  if (hits.length >= 3) {
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((windowMs - (now - hits[0])) / 1000),
    };
  }
  hits.push(now);
  rateLimits.set(ip, hits);
  return { ok: true };
}

async function requireDemoBalance(owner: string): Promise<void> {
  const gateway = new GalaChainGateway();
  const result = await gateway.fetchBalances(owner);
  if (!isSuccess(result)) {
    throw new Error("Could not read demo buyer balance from GalaChain.");
  }

  const balance = result.body.Data?.find(
    item =>
      item.collection === "GALA" &&
      item.category === "Unit" &&
      item.type === "none" &&
      item.additionalKey === "none",
  );
  const balanceAtomic = BigInt(galaQuantityToAtomic(String(balance?.quantity ?? "0")));
  if (balanceAtomic < BigInt(minimumDemoBalanceAtomic)) {
    throw new Error("Demo buyer is not funded. It needs at least 2.01 GALA for one click.");
  }
}

function redactPaymentPayload(paymentPayload: unknown): Record<string, unknown> {
  const payload = paymentPayload as {
    payload?: ExactGalaChainPayload;
    accepted?: unknown;
    x402Version?: number;
  };
  const dto = payload.payload?.dto;
  return {
    x402Version: payload.x402Version,
    accepted: payload.accepted,
    dto: dto
      ? {
          to: dto.to,
          tokenInstance: dto.tokenInstance,
          quantity: dto.quantity,
          uniqueKey: dto.uniqueKey,
          dtoExpiresAt: dto.dtoExpiresAt,
          signature: "[redacted]",
        }
      : null,
    signerPublicKey: payload.payload?.signerPublicKey ? "[redacted]" : undefined,
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
