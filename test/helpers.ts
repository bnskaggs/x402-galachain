import { signatures } from "@gala-chain/api";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactGalaChainClientScheme } from "../src/client.js";
import { GALA_ASSET_ID, GALACHAIN_NETWORK } from "../src/constants.js";
import { GalaChainGateway } from "../src/gateway.js";
import type { ExactGalaChainPayload } from "../src/types.js";
import { galaChainAddressFromPrivateKey } from "../src/utils.js";

export interface Scripted {
  status: number;
  body: unknown;
}

/** A GalaChainGateway whose HTTP layer is scripted per method; records calls. */
export function mockGateway(script: Record<string, Scripted | Scripted[]>) {
  const calls: { method: string; body: unknown }[] = [];
  const queues = new Map<string, Scripted[]>();
  for (const [method, value] of Object.entries(script)) {
    queues.set(method, Array.isArray(value) ? [...value] : [value]);
  }
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = url.split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = queues.get(method);
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!next) return new Response(JSON.stringify({ message: `unscripted ${method}` }), { status: 404 });
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { gateway: new GalaChainGateway({ fetchFn }), calls };
}

export const ok = (data: unknown = {}, status = 200): Scripted => ({ status, body: { Data: data, Status: 1 } });
export const gcError = (status: number, ErrorKey: string, Message: string, transactionId?: string): Scripted => ({
  status,
  body: { error: { ErrorCode: status, ErrorKey, Message, Status: 0 }, message: Message, transactionId },
});

export const payerKey = signatures.genKeyPair();
export const payer = galaChainAddressFromPrivateKey(payerKey.privateKey);
export const seller = `eth|${signatures.getEthAddress(signatures.genKeyPair().publicKey)}`;
export const attacker = `eth|${signatures.getEthAddress(signatures.genKeyPair().publicKey)}`;

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: GALACHAIN_NETWORK,
    amount: "100000000", // 1 GALA
    asset: GALA_ASSET_ID,
    payTo: seller,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "transfer-token", decimals: 8, name: "GALA" },
    ...overrides,
  };
}

/** A fully signed, valid payload for `reqs`, built by the real client scheme. */
export async function signedPayload(reqs: PaymentRequirements = requirements()): Promise<PaymentPayload> {
  const client = new ExactGalaChainClientScheme(payerKey.privateKey);
  const result = await client.createPaymentPayload(2, reqs);
  return {
    x402Version: 2,
    resource: { url: "http://localhost/quote", description: "test", mimeType: "application/json" },
    accepted: reqs,
    payload: result.payload,
  };
}

export function dtoOf(payload: PaymentPayload) {
  return (payload.payload as ExactGalaChainPayload).dto;
}
