import { createHmac, timingSafeEqual } from "node:crypto";
import type { ExactGalaChainPayload } from "./types.js";
import { galaChainAddressFromPublicKey } from "./utils.js";

/**
 * Stateless session tokens for sellers that price access as "pay once, read
 * for a while" instead of per call. GalaChain burns 1 GALA from the payer on
 * every transaction regardless of the amount moved, so a 0.1 GALA read costs
 * the payer 1.1 GALA when billed per call; a session key paid once amortises
 * that burn across the window.
 *
 * Tokens are `base64url(JSON claims) + "." + base64url(HMAC-SHA256)`. Any
 * replica holding the secret can verify; there is no store and no revocation
 * (the TTL is the revocation). The secret is a seller-side HMAC key, never a
 * chain key; if it leaks, the paid tier is readable for free and nothing else.
 */
export interface SessionClaims {
  v: 1;
  /** GalaChain address the payment came from, e.g. `eth|ABCD…` (case preserved). */
  payer: string;
  /** Seller-defined product id, e.g. `wallet-history`. */
  product: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
  /** Settlement transaction id, when the seller knows it at issue time. */
  tx?: string;
}

export type SessionVerification =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "wrong-product" };

export const MIN_SESSION_SECRET_BYTES = 32;

function assertSecret(secret: string): Buffer {
  const key = Buffer.from(secret, "utf8");
  if (key.length < MIN_SESSION_SECRET_BYTES) {
    throw new Error(`Session secret must be at least ${MIN_SESSION_SECRET_BYTES} bytes`);
  }
  return key;
}

function sign(body: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

export function issueSessionToken(
  claims: Omit<SessionClaims, "v" | "iat"> & { iat?: number },
  secret: string,
): string {
  const key = assertSecret(secret);
  if (!claims.payer) throw new Error("Session payer is required");
  if (!claims.product) throw new Error("Session product is required");
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.exp) || claims.exp <= iat) {
    throw new Error("Session exp must be an integer after iat");
  }
  const full: SessionClaims = {
    v: 1,
    payer: claims.payer,
    product: claims.product,
    iat,
    exp: claims.exp,
    ...(claims.tx ? { tx: claims.tx } : {}),
  };
  const body = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${body}.${sign(body, key).toString("base64url")}`;
}

export function verifySessionToken(
  token: string,
  options: { secret: string; product?: string; now?: number },
): SessionVerification {
  const key = assertSecret(options.secret);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, mac] = parts;

  const expected = sign(body, key);
  let provided: Buffer;
  try {
    provided = Buffer.from(mac, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims?.v !== 1 ||
    typeof claims.payer !== "string" ||
    typeof claims.product !== "string" ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (now >= claims.exp) return { ok: false, reason: "expired" };
  if (options.product !== undefined && claims.product !== options.product) {
    return { ok: false, reason: "wrong-product" };
  }
  return { ok: true, claims };
}

/**
 * The payer behind a GalaChain `exact` payment: `dto.from` when the wallet set
 * it, otherwise the address derived from the signer's public key. This is the
 * address a seller binds a session to, and for payer-scoped products the only
 * address the session may read.
 */
export function payerFromExactPayload(payload: ExactGalaChainPayload): string {
  if (payload.dto?.from) return payload.dto.from;
  if (!payload.signerPublicKey) {
    throw new Error("Payment payload has neither dto.from nor signerPublicKey");
  }
  return galaChainAddressFromPublicKey(payload.signerPublicKey);
}

/** `Authorization: Bearer <token>` → token, or null when absent or malformed. */
export function bearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}
