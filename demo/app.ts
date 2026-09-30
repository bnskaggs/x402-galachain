import { HTTPFacilitatorClient } from "@x402/core/http";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import express from "express";
import { ExactGalaChainServerScheme, GALACHAIN_NETWORK } from "x402-galachain";

const payTo = process.env.SELLER_ADDRESS;
if (!payTo) throw new Error("SELLER_ADDRESS is required");

const facilitatorUrl =
  process.env.FACILITATOR_URL ?? "https://x402-galachain-facilitator-ten.vercel.app";

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitator).register(
  GALACHAIN_NETWORK,
  new ExactGalaChainServerScheme(),
);

const app = express();
app.disable("x-powered-by");
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
  ),
);

app.get("/quote", (_req, res) => {
  res.json({ quote: "GALA moved on GalaChain.", servedAt: new Date().toISOString() });
});

export default app;
