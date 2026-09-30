import { describe, expect, it } from "vitest";
import { ExactGalaChainFacilitatorScheme } from "../src/facilitator.js";
import { GALACHAIN_NETWORK } from "../src/constants.js";
import { signDto } from "../src/utils.js";
import { signatures } from "@gala-chain/api";
import {
  attacker,
  dryRunConflict,
  dryRunFail,
  dryRunOk,
  dtoOf,
  gcError,
  mockGateway,
  ok,
  payer,
  payerKey,
  requirements,
  signedPayload,
} from "./helpers.js";

/** Re-sign a payload's dto with changed fields: the signature stays valid, only the content differs. */
function resign(p: Awaited<ReturnType<typeof signedPayload>>, changes: Record<string, unknown>) {
  const { signature: _s, ...unsigned } = dtoOf(p);
  return signDto({ ...unsigned, ...changes }, payerKey.privateKey);
}

const TX = "d03eb7dfbe4148ec47409693f4902a406217625a03b7ae8b8abf4f7cba26036d";

function facilitatorWith(script: Parameters<typeof mockGateway>[0]) {
  const { gateway, calls } = mockGateway(script);
  return { facilitator: new ExactGalaChainFacilitatorScheme(gateway), calls };
}

describe("verify: happy path", () => {
  it("accepts a valid payload and names the payer", async () => {
    const { facilitator, calls } = facilitatorWith({ DryRun: dryRunOk() });
    const result = await facilitator.verify(await signedPayload(), requirements());
    expect(result).toEqual({ isValid: true, payer });
    expect(calls.map(c => c.method)).toEqual(["DryRun"]);
    const dry = calls[0].body as { method: string; dto: { signature?: string } };
    expect(dry.method).toBe("TransferToken");
    expect(dry.dto.signature).toBeUndefined();
  });
});

describe("verify: envelope rules", () => {
  it("rejects a non-v2 payload", async () => {
    const { facilitator } = facilitatorWith({});
    const p = { ...(await signedPayload()), x402Version: 1 };
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_x402_version");
  });

  it("rejects a network mismatch", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    const r = await facilitator.verify(p, requirements({ network: "eip155:84532" }));
    expect(r.invalidReason).toBe("network_mismatch");
  });

  it("rejects a payload with no dto, no signer key, or no signature", async () => {
    const { facilitator } = facilitatorWith({});
    const base = await signedPayload();
    const noDto = { ...base, payload: { signerPublicKey: "04ab" } };
    const noKey = { ...base, payload: { dto: dtoOf(base) } };
    const { signature: _s, ...unsigned } = dtoOf(base);
    const noSig = { ...base, payload: { dto: unsigned, signerPublicKey: (base.payload as { signerPublicKey: string }).signerPublicKey } };
    expect((await facilitator.verify(noDto, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_missing_dto");
    expect((await facilitator.verify(noKey, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_missing_signer_public_key");
    expect((await facilitator.verify(noSig, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_missing_signature");
  });
});

describe("verify: the signed fields cannot be tampered with", () => {
  it("rejects a signature that no longer matches the dto", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    dtoOf(p).uniqueKey = "x402-tampered";
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_signature");
  });

  it("rejects a relayer-swapped pay-to (the signature covers `to`)", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    dtoOf(p).to = attacker;
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_signature");
  });

  it("rejects a validly signed payment to the wrong recipient", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload(requirements({ payTo: attacker }));
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_pay_to_mismatch");
  });

  it("rejects `from` set to someone other than the signer", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    // Re-sign with a foreign `from` so the signature itself is valid.
    (p.payload as { dto: unknown }).dto = resign(p, { from: attacker });
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_from_mismatch");
  });
});

describe("verify: asset and amount", () => {
  it("rejects the wrong token class", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    (p.payload as { dto: unknown }).dto = resign(p, { tokenInstance: { ...dtoOf(p).tokenInstance, collection: "GUSDC" } });
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_asset_mismatch");
  });

  it("rejects an amount that does not match exactly", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload(requirements({ amount: "200000000" }));
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_amount_mismatch");
  });

  it("rejects a zero quantity even when the requirements ask for zero (chain validator accepts 0)", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload(requirements({ amount: "0" }));
    expect((await facilitator.verify(p, requirements({ amount: "0" }))).invalidReason).toBe("invalid_exact_galachain_quantity");
  });
});

describe("verify: expiry window", () => {
  it("rejects a dto with no expiry", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    const { signature: _s, dtoExpiresAt: _e, ...rest } = dtoOf(p);
    (p.payload as { dto: unknown }).dto = signDto(rest, payerKey.privateKey);
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_missing_expiry");
  });

  it("rejects an already-expired dto", async () => {
    const { facilitator } = facilitatorWith({});
    const p = await signedPayload();
    (p.payload as { dto: unknown }).dto = resign(p, { dtoExpiresAt: Date.now() - 1 });
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_expired");
  });

  it("rejects a window longer than the requirements allow (the long-fuse case)", async () => {
    const { facilitator } = facilitatorWith({});
    const tenYears = 10 * 365 * 24 * 3600;
    const p = await signedPayload(requirements({ maxTimeoutSeconds: tenYears }));
    expect((await facilitator.verify(p, requirements({ maxTimeoutSeconds: 300 }))).invalidReason).toBe(
      "invalid_exact_galachain_expiry_mismatch",
    );
  });
});

describe("verify: dry run", () => {
  it("rejects an unfunded payer even though the gateway wraps the failure in outer Status 1 (mainnet 2026-09-29)", async () => {
    const { facilitator } = facilitatorWith({
      DryRun: dryRunFail(402, "PAYMENT_REQUIRED", "Payment Requiured. payImmediatelyFromBalance: burnTokens ... Insufficient balance"),
    });
    expect((await facilitator.verify(await signedPayload(), requirements())).invalidReason).toBe("insufficient_funds");
  });

  it("surfaces other simulated failures with the inner ErrorKey", async () => {
    const { facilitator } = facilitatorWith({ DryRun: dryRunFail(400, "DTO_VALIDATION_FAILED", "nope") });
    expect((await facilitator.verify(await signedPayload(), requirements())).invalidReason).toBe(
      "invalid_exact_galachain_dry_run_failed:DTO_VALIDATION_FAILED",
    );
  });

  it("does not treat a returned write set as success", async () => {
    const { facilitator } = facilitatorWith({
      DryRun: ok({ reads: {}, writes: { "\u0000UNTX\u0000k\u0000": "{}" }, deletes: {}, response: { Status: 0, ErrorKey: "X" } }),
    });
    expect((await facilitator.verify(await signedPayload(), requirements())).isValid).toBe(false);
  });

  it("still handles an outer-level gateway error", async () => {
    const { facilitator } = facilitatorWith({ DryRun: gcError(400, "VALIDATION_FAILED", "The dto should have no signature") });
    expect((await facilitator.verify(await signedPayload(), requirements())).invalidReason).toBe(
      "invalid_exact_galachain_dry_run_failed:VALIDATION_FAILED",
    );
  });
});

describe("verify: signer envelope", () => {
  it("accepts a compressed signerPublicKey and derives the same payer", async () => {
    const { facilitator } = facilitatorWith({ DryRun: dryRunOk() });
    const p = await signedPayload();
    const compressed = signatures.normalizePublicKey(payerKey.publicKey).toString("hex");
    (p.payload as { signerPublicKey: string }).signerPublicKey = compressed;
    expect(await facilitator.verify(p, requirements())).toEqual({ isValid: true, payer });
  });

  it("returns a reason, not an exception, for a malformed signerPublicKey", async () => {
    const { facilitator } = facilitatorWith({ DryRun: dryRunOk() });
    const p = await signedPayload();
    (p.payload as { signerPublicKey: string }).signerPublicKey = "not-a-key";
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_signer_public_key");
  });

  it.each([
    ["multisig", { multisig: [] as string[] }],
    ["signerAddress (even the payer's own; the chain rejects it as redundant)", { signerAddress: payer }],
    ["in-DTO signerPublicKey (even the payer's own)", { signerPublicKey: payerKey.publicKey }],
    ["foreign signerAddress", { signerAddress: attacker }],
  ])("rejects a DTO carrying %s", async (_label, fields) => {
    const { facilitator } = facilitatorWith({ DryRun: dryRunOk() });
    const p = await signedPayload();
    (p.payload as { dto: unknown }).dto = resign(p, fields as Record<string, unknown>);
    expect((await facilitator.verify(p, requirements())).invalidReason).toBe("invalid_exact_galachain_payload_envelope");
  });
});

describe("verify: consumed uniqueKey", () => {
  it("maps a DryRun conflict (DryRun enforces uniqueKey) to invalid_exact_galachain_duplicate", async () => {
    const { facilitator } = facilitatorWith({ DryRun: dryRunConflict("x", TX) });
    expect((await facilitator.verify(await signedPayload(), requirements())).invalidReason).toBe(
      "invalid_exact_galachain_duplicate",
    );
  });
});

describe("settle", () => {
  it("submits without a prior dry run, and looks the tx id up with an unsigned DryRun when the gateway omits it", async () => {
    const { facilitator, calls } = facilitatorWith({
      TransferToken: ok({}, 201), // gateway success without transactionId
      DryRun: dryRunConflict("x", TX),
    });
    const r = await facilitator.settle(await signedPayload(), requirements());
    expect(r).toEqual({ success: true, payer, transaction: TX, network: GALACHAIN_NETWORK });
    expect(calls.map(c => c.method)).toEqual(["TransferToken", "DryRun"]);
    expect((calls[1].body as { dto: { signature?: string } }).dto.signature).toBeUndefined();
  });

  it("uses the gateway tx id directly when present, with a single call", async () => {
    const { facilitator, calls } = facilitatorWith({
      TransferToken: { status: 201, body: { Data: {}, Status: 1, transactionId: TX } },
    });
    const r = await facilitator.settle(await signedPayload(), requirements());
    expect(r.success).toBe(true);
    expect(r.transaction).toBe(TX);
    expect(calls.map(c => c.method)).toEqual(["TransferToken"]);
  });

  it("returns success with an empty tx id if the lookup does not conflict", async () => {
    const { facilitator } = facilitatorWith({ TransferToken: ok({}, 201), DryRun: dryRunOk() });
    const r = await facilitator.settle(await signedPayload(), requirements());
    expect(r.success).toBe(true);
    expect(r.transaction).toBe("");
  });

  it("reports a replayed payload as failure naming the original tx (exact spec: consumed primitive = failure)", async () => {
    const { facilitator, calls } = facilitatorWith({
      TransferToken: gcError(409, "UNIQUE_TRANSACTION_CONFLICT", `Unique transaction key x is already saved for transaction ${TX}`),
    });
    const r = await facilitator.settle(await signedPayload(), requirements());
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("invalid_exact_galachain_duplicate");
    expect(r.transaction).toBe(TX);
    expect(calls.map(c => c.method)).toEqual(["TransferToken"]);
  });

  it("maps a fee shortfall at settle time to insufficient_funds", async () => {
    const { facilitator } = facilitatorWith({ TransferToken: gcError(402, "PAYMENT_REQUIRED", "Insufficient balance") });
    const r = await facilitator.settle(await signedPayload(), requirements());
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("insufficient_funds");
  });

  it("refuses to settle what the static rules reject, without touching the gateway", async () => {
    const { facilitator, calls } = facilitatorWith({ TransferToken: ok({}, 201) });
    const p = await signedPayload(requirements({ payTo: attacker }));
    const r = await facilitator.settle(p, requirements());
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("invalid_exact_galachain_pay_to_mismatch");
    expect(calls).toHaveLength(0);
  });
});
