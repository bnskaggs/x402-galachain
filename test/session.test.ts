import { describe, expect, it } from "vitest";
import {
  bearerToken,
  issueSessionToken,
  payerFromExactPayload,
  verifySessionToken,
} from "../src/session.js";
import type { ExactGalaChainPayload } from "../src/types.js";
import { payer, signedPayload } from "./helpers.js";

const secret = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 bytes
const now = 1_800_000_000;

describe("session tokens", () => {
  it("round-trips claims", () => {
    const token = issueSessionToken({ payer, product: "wallet-history", iat: now, exp: now + 86_400, tx: "abc" }, secret);
    const result = verifySessionToken(token, { secret, product: "wallet-history", now: now + 10 });
    expect(result).toEqual({
      ok: true,
      claims: { v: 1, payer, product: "wallet-history", iat: now, exp: now + 86_400, tx: "abc" },
    });
  });

  it("rejects a tampered token", () => {
    const token = issueSessionToken({ payer, product: "wallet-history", iat: now, exp: now + 60 }, secret);
    const [body, mac] = token.split(".");
    const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);
    expect(verifySessionToken(`${flipped}.${mac}`, { secret, now })).toMatchObject({ ok: false, reason: "bad-signature" });
    // Tamper mid-MAC; the final base64url char only carries two significant
    // bits, so flipping it can decode to the same bytes.
    const macFlipped = mac.slice(0, 10) + (mac[10] === "A" ? "B" : "A") + mac.slice(11);
    expect(verifySessionToken(`${body}.${macFlipped}`, { secret, now })).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with another secret", () => {
    const token = issueSessionToken({ payer, product: "p", iat: now, exp: now + 60 }, secret);
    expect(verifySessionToken(token, { secret: secret.slice(1) + "z", now })).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("expires exactly at exp", () => {
    const token = issueSessionToken({ payer, product: "p", iat: now, exp: now + 60 }, secret);
    expect(verifySessionToken(token, { secret, now: now + 59 }).ok).toBe(true);
    expect(verifySessionToken(token, { secret, now: now + 60 })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a token for another product when product is pinned", () => {
    const token = issueSessionToken({ payer, product: "pool-econ", iat: now, exp: now + 60 }, secret);
    expect(verifySessionToken(token, { secret, product: "wallet-history", now })).toMatchObject({ ok: false, reason: "wrong-product" });
    expect(verifySessionToken(token, { secret, now }).ok).toBe(true);
  });

  it("flags malformed input without throwing", () => {
    expect(verifySessionToken("", { secret, now })).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifySessionToken("a.b.c", { secret, now })).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifySessionToken("justone", { secret, now })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses short secrets and bad claims at issue time", () => {
    expect(() => issueSessionToken({ payer, product: "p", exp: now + 60, iat: now }, "short")).toThrow(/32 bytes/);
    expect(() => issueSessionToken({ payer, product: "p", exp: now, iat: now }, secret)).toThrow(/exp/);
    expect(() => issueSessionToken({ payer: "", product: "p", exp: now + 1, iat: now }, secret)).toThrow(/payer/);
  });
});

describe("payerFromExactPayload", () => {
  it("prefers dto.from and falls back to the signer public key", async () => {
    const payload = (await signedPayload()).payload as ExactGalaChainPayload;
    expect(payerFromExactPayload(payload)).toBe(payer);
    const { from: _from, ...dtoWithoutFrom } = payload.dto;
    expect(payerFromExactPayload({ ...payload, dto: dtoWithoutFrom })).toBe(payer);
    expect(payload.signerPublicKey).toBeTruthy();
  });

  it("throws when neither is present", () => {
    expect(() => payerFromExactPayload({ dto: { to: "eth|x" } } as unknown as ExactGalaChainPayload)).toThrow(/signerPublicKey/);
  });
});

describe("bearerToken", () => {
  it("parses the Authorization header leniently on case and whitespace", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer   abc.def  ")).toBe("abc.def");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});
