import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GALACHAIN_NETWORK } from "../src/constants.js";
import { BODY_LIMIT_BYTES, createApp, PAY_TO_NOT_ALLOWED } from "../service/app.js";
import { attacker, dryRunOk, mockGateway, requirements, seller, signedPayload } from "./helpers.js";

let server: Server | undefined;

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  return new Promise(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>(resolve => current.close(() => resolve()));
});

describe("facilitator service", () => {
  it("rejects a payTo that is not on the allowlist without calling the gateway", async () => {
    const { gateway, calls } = mockGateway({ DryRun: dryRunOk() });
    const url = await listen(createApp({ gateway, allowedPayTo: [seller], allowOpenRelay: false }));
    const payload = await signedPayload(requirements({ payTo: attacker }));

    const res = await fetch(`${url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: payload.accepted }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ isValid: false, invalidReason: PAY_TO_NOT_ALLOWED });
    expect(calls).toHaveLength(0);
  });

  it("verifies an allowlisted payTo through the gateway", async () => {
    const { gateway, calls } = mockGateway({ DryRun: dryRunOk() });
    const url = await listen(createApp({ gateway, allowedPayTo: [seller], allowOpenRelay: false }));
    const payload = await signedPayload();

    const res = await fetch(`${url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements() }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ isValid: true });
    expect(calls.map(call => call.method)).toEqual(["DryRun"]);
  });

  it("fails closed when the allowlist is empty", async () => {
    const { gateway, calls } = mockGateway({ DryRun: dryRunOk() });
    const url = await listen(createApp({ gateway, allowedPayTo: [], allowOpenRelay: false }));
    const payload = await signedPayload();

    const res = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements() }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: false, errorReason: PAY_TO_NOT_ALLOWED, transaction: "" });
    expect(calls).toHaveLength(0);
  });

  it("returns 413 for an oversized body", async () => {
    const { gateway } = mockGateway({});
    const url = await listen(createApp({ gateway, allowedPayTo: [seller] }));
    const res = await fetch(`${url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(BODY_LIMIT_BYTES)}"}`,
    });
    expect(res.status).toBe(413);
  });

  it("advertises mainnet only, with no fee payer", async () => {
    const { gateway } = mockGateway({});
    const url = await listen(createApp({ gateway, allowedPayTo: [seller] }));
    const res = await fetch(`${url}/supported`);
    const body = (await res.json()) as {
      kinds: { network: string; extra?: Record<string, unknown> }[];
      signers: Record<string, string[]>;
    };

    expect(res.status).toBe(200);
    expect(body.kinds.length).toBeGreaterThan(0);
    expect(body.kinds.every(kind => kind.network === GALACHAIN_NETWORK)).toBe(true);
    expect(body.kinds.every(kind => !("feePayer" in (kind.extra ?? {})))).toBe(true);
    expect(Object.values(body.signers).every(signers => signers.length === 0)).toBe(true);

    const health = await fetch(`${url}/health`);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      network: GALACHAIN_NETWORK,
      allowlistCount: 1,
      openRelay: false,
    });
  });

  it("rate-limits verify and settle", async () => {
    const { gateway } = mockGateway({ DryRun: dryRunOk() });
    const url = await listen(createApp({ gateway, allowedPayTo: [seller], rateLimit: 2 }));
    const payload = await signedPayload();
    const post = () =>
      fetch(`${url}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements() }),
      });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });
});
