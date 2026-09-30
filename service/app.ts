import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import express, { type ErrorRequestHandler, type Request } from "express";
import {
  ExactGalaChainFacilitatorScheme,
  GALACHAIN_NETWORK,
  GalaChainGateway,
  sameAddress,
} from "../src/index.js";

export const BODY_LIMIT_BYTES = 16 * 1024;
export const RATE_LIMIT_PER_MINUTE = 30;
export const RATE_WINDOW_MS = 60_000;
export const PAY_TO_NOT_ALLOWED = "invalid_exact_galachain_pay_to_not_allowed";

export interface ServiceOptions {
  gateway?: GalaChainGateway;
  /** Explicit list. When omitted, `ALLOWED_PAY_TO` is read from the environment. */
  allowedPayTo?: string[];
  /** Explicit open-relay switch. When omitted, `ALLOW_OPEN_RELAY=1` is read. */
  allowOpenRelay?: boolean;
  now?: () => number;
  rateLimit?: number;
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

interface RequestBody {
  paymentPayload?: PaymentPayload;
  paymentRequirements?: PaymentRequirements;
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (header) return header.split(",")[0]?.trim() || "unknown";
  return req.ip || req.socket.remoteAddress || "unknown";
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * Keyless facilitator HTTP shell.
 *
 * Missing allowlist fails closed: `/verify` and `/settle` reject every payTo
 * and do not call the gateway. Open relay requires `ALLOW_OPEN_RELAY=1`.
 * The in-memory rate limit is per process; on Vercel that means per instance.
 */
export function createApp(options: ServiceOptions = {}) {
  const allowOpenRelay = options.allowOpenRelay ?? process.env.ALLOW_OPEN_RELAY === "1";
  const allowed = options.allowedPayTo ?? parseAllowlist(process.env.ALLOWED_PAY_TO);
  const limit = options.rateLimit ?? RATE_LIMIT_PER_MINUTE;
  const now = options.now ?? Date.now;
  const gateway =
    options.gateway ??
    new GalaChainGateway(process.env.GALACHAIN_GATEWAY_URL ? { url: process.env.GALACHAIN_GATEWAY_URL } : {});
  const facilitator = new x402Facilitator().register(
    GALACHAIN_NETWORK,
    new ExactGalaChainFacilitatorScheme(gateway),
  );

  const hits = new Map<string, number[]>();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));

  const onBodyError: ErrorRequestHandler = (err, _req, res, next) => {
    const status = typeof err === "object" && err && "status" in err ? Number(err.status) : 0;
    const type = typeof err === "object" && err && "type" in err ? String(err.type) : "";
    if (status === 413 || type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    next(err);
  };
  app.use(onBodyError);

  function limited(ip: string): boolean {
    const windowStart = now() - RATE_WINDOW_MS;
    const recent = (hits.get(ip) ?? []).filter(at => at > windowStart);
    if (recent.length >= limit) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(now());
    hits.set(ip, recent);
    return false;
  }

  function payToAllowed(payTo: unknown): boolean {
    if (allowOpenRelay) return true;
    if (typeof payTo !== "string") return false;
    return allowed.some(entry => sameAddress(entry, payTo));
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      network: GALACHAIN_NETWORK,
      allowlistCount: allowed.length,
      openRelay: allowOpenRelay,
    });
  });

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  async function handle(route: "verify" | "settle", req: Request, res: express.Response): Promise<void> {
    const started = now();
    if (limited(clientIp(req))) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const body = req.body as RequestBody;
    const payload = body?.paymentPayload;
    const requirements = body?.paymentRequirements;
    if (!payload || !requirements || typeof requirements !== "object") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const payTo = requirements.payTo;
    const amountAtomic = requirements.amount;
    if (!payToAllowed(payTo)) {
      const rejected =
        route === "verify"
          ? { isValid: false, invalidReason: PAY_TO_NOT_ALLOWED, payer: "" }
          : { success: false, errorReason: PAY_TO_NOT_ALLOWED, transaction: "" };
      log({
        route,
        payTo: typeof payTo === "string" ? payTo : "",
        amountAtomic: typeof amountAtomic === "string" ? amountAtomic : "",
        result: "rejected",
        errorReason: PAY_TO_NOT_ALLOWED,
        txId: "",
        latencyMs: now() - started,
      });
      res.json(rejected);
      return;
    }

    try {
      if (route === "verify") {
        const result = await facilitator.verify(payload, requirements);
        log({
          route,
          payTo,
          amountAtomic,
          result: result.isValid ? "valid" : "invalid",
          errorReason: result.invalidReason ?? "",
          txId: "",
          latencyMs: now() - started,
        });
        res.json(result);
        return;
      }
      const result = await facilitator.settle(payload, requirements);
      log({
        route,
        payTo,
        amountAtomic,
        result: result.success ? "settled" : "failed",
        errorReason: result.errorReason ?? "",
        txId: result.transaction ?? "",
        latencyMs: now() - started,
      });
      res.json(result);
    } catch (err) {
      const errorReason = route === "verify" ? "unexpected_verify_error" : "unexpected_settle_error";
      log({
        route,
        payTo,
        amountAtomic,
        result: "error",
        errorReason,
        txId: "",
        latencyMs: now() - started,
        message: err instanceof Error ? err.message : "unknown",
      });
      res.json(
        route === "verify"
          ? { isValid: false, invalidReason: errorReason, payer: "" }
          : { success: false, errorReason, transaction: "" },
      );
    }
  }

  app.post("/verify", (req, res) => {
    void handle("verify", req, res);
  });
  app.post("/settle", (req, res) => {
    void handle("settle", req, res);
  });

  return app;
}
