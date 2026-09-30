import { signatures } from "@gala-chain/api";
import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  ASSET_TRANSFER_METHOD,
  GALA_ASSET_ID,
  GALA_TOKEN_INSTANCE,
  GALACHAIN_CAIP_FAMILY,
  GALACHAIN_NETWORK,
} from "./constants.js";
import {
  GalaChainGateway,
  dryRunErrorKey,
  dryRunMessage,
  extractOriginalTransactionId,
  galaChainErrorKey,
  galaChainMessage,
  isDryRunSuccess,
  isSuccess,
} from "./gateway.js";
import type { ExactGalaChainPayload, GalaChainTransferTokenDto } from "./types.js";
import {
  galaChainAddressFromPublicKey,
  galaQuantityToAtomic,
  sameAddress,
  tokenInstanceToAssetId,
} from "./utils.js";

function invalid(invalidReason: string, payer = ""): VerifyResponse {
  return { isValid: false, invalidReason, payer };
}

function unsignedDto(dto: GalaChainTransferTokenDto): Omit<GalaChainTransferTokenDto, "signature"> {
  const { signature: _signature, ...rest } = dto;
  return rest;
}

function paymentFlow(requirements: PaymentRequirements): string {
  const flow = requirements.extra?.paymentFlow;
  return typeof flow === "string" ? flow : "authorization";
}

type StaticCheck =
  | { ok: true; payer: string; publicKeyHex: string; dto: GalaChainTransferTokenDto }
  | { ok: false; response: VerifyResponse };

export class ExactGalaChainFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = GALACHAIN_CAIP_FAMILY;

  constructor(private readonly gateway = new GalaChainGateway()) {}

  // No `feePayer`: the facilitator sponsors nothing, the payer funds the chain fee.
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return { assetTransferMethods: [ASSET_TRANSFER_METHOD] };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  /** Spec rules 1–9: everything that can be decided without the chain. */
  private checkStatic(payload: PaymentPayload, requirements: PaymentRequirements): StaticCheck {
    const fail = (reason: string, payer = ""): StaticCheck => ({ ok: false, response: invalid(reason, payer) });

    if (payload.x402Version !== 2) return fail("invalid_exact_galachain_x402_version");
    if (payload.accepted?.scheme !== "exact" || requirements.scheme !== "exact") return fail("unsupported_scheme");
    if (payload.accepted.network !== requirements.network || requirements.network !== GALACHAIN_NETWORK) {
      return fail("network_mismatch");
    }

    const exactPayload = payload.payload as Partial<ExactGalaChainPayload>;
    const dto = exactPayload.dto;
    const signerPublicKey = exactPayload.signerPublicKey;
    if (!dto || typeof dto !== "object") return fail("invalid_exact_galachain_payload_missing_dto");
    if (!signerPublicKey || typeof signerPublicKey !== "string") {
      return fail("invalid_exact_galachain_payload_missing_signer_public_key");
    }
    if (!dto.signature) return fail("invalid_exact_galachain_payload_missing_signature");

    // Accept compressed/uncompressed hex or base64; derive the alias from the uncompressed form.
    let publicKeyHex: string;
    try {
      publicKeyHex = signatures.getNonCompactHexPublicKey(signerPublicKey);
    } catch {
      return fail("invalid_exact_galachain_payload_signer_public_key");
    }
    const payer = galaChainAddressFromPublicKey(publicKeyHex);
    if (!signatures.isValid(dto.signature, unsignedDto(dto), publicKeyHex)) {
      return fail("invalid_exact_galachain_payload_signature", payer);
    }

    // Single recoverable signature only. The chain rejects signerPublicKey /
    // signerAddress as redundant when the key is recoverable, and multisig is
    // a different authentication mode (chaincode authenticate.ts).
    if (dto.multisig !== undefined || dto.signerAddress !== undefined || dto.signerPublicKey !== undefined) {
      return fail("invalid_exact_galachain_payload_envelope", payer);
    }
    if (dto.from && !sameAddress(dto.from, payer)) return fail("invalid_exact_galachain_from_mismatch", payer);
    if (!dto.uniqueKey) return fail("invalid_exact_galachain_missing_unique_key", payer);
    if (!sameAddress(dto.to, requirements.payTo)) return fail("invalid_exact_galachain_pay_to_mismatch", payer);
    if (tokenInstanceToAssetId(dto.tokenInstance) !== requirements.asset || requirements.asset !== GALA_ASSET_ID) {
      return fail("invalid_exact_galachain_asset_mismatch", payer);
    }
    if (dto.tokenInstance.instance !== GALA_TOKEN_INSTANCE.instance) {
      return fail("invalid_exact_galachain_asset_instance_mismatch", payer);
    }

    let atomicAmount: string;
    try {
      atomicAmount = galaQuantityToAtomic(dto.quantity);
    } catch {
      return fail("invalid_exact_galachain_quantity", payer);
    }
    // The chain's validator accepts a zero quantity; a zero payment is never an `exact` payment.
    if (BigInt(atomicAmount) === 0n) return fail("invalid_exact_galachain_quantity", payer);
    if (atomicAmount !== requirements.amount) return fail("invalid_exact_galachain_amount_mismatch", payer);

    if (typeof dto.dtoExpiresAt !== "number" || !Number.isFinite(dto.dtoExpiresAt)) {
      return fail("invalid_exact_galachain_missing_expiry", payer);
    }
    const now = Date.now();
    if (dto.dtoExpiresAt <= now + 1_000) return fail("invalid_exact_galachain_expired", payer);
    if (typeof requirements.maxTimeoutSeconds !== "number" || !Number.isFinite(requirements.maxTimeoutSeconds)) {
      return fail("invalid_exact_galachain_requirements_timeout", payer);
    }
    if (dto.dtoExpiresAt > now + requirements.maxTimeoutSeconds * 1000 + 5_000) {
      return fail("invalid_exact_galachain_expiry_mismatch", payer);
    }

    return { ok: true, payer, publicKeyHex, dto };
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const check = this.checkStatic(payload, requirements);
    if (!check.ok) return check.response;
    const { payer, publicKeyHex, dto } = check;

    // Rule 10. DryRun runs the full transaction wrapper minus authentication,
    // so it also enforces uniqueKey: a consumed key surfaces here as a conflict.
    if (paymentFlow(requirements) === "authorization") {
      const dryRun = await this.gateway.dryRunTransfer(dto, publicKeyHex);
      if (!isDryRunSuccess(dryRun)) {
        const key = dryRunErrorKey(dryRun);
        if (key === "PAYMENT_REQUIRED") return invalid("insufficient_funds", payer);
        if (key === "UNIQUE_TRANSACTION_CONFLICT") return invalid("invalid_exact_galachain_duplicate", payer);
        return invalid(`invalid_exact_galachain_dry_run_failed:${key ?? dryRun.status}`, payer);
      }
    }

    return { isValid: true, payer };
  }

  /**
   * The public gateway omits the transaction id on a successful submit. An
   * unsigned DryRun of the same DTO now hits the consumed uniqueKey and the
   * conflict message names the transaction that consumed it. Nothing signed
   * is re-sent and no Fabric proposal is made.
   */
  private async lookupTransactionId(dto: GalaChainTransferTokenDto, publicKeyHex: string): Promise<string> {
    const dryRun = await this.gateway.dryRunTransfer(dto, publicKeyHex);
    if (dryRunErrorKey(dryRun) !== "UNIQUE_TRANSACTION_CONFLICT") return "";
    return extractOriginalTransactionId(dryRunMessage(dryRun)) ?? "";
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const check = this.checkStatic(payload, requirements);
    if (!check.ok) {
      return {
        success: false,
        errorReason: check.response.invalidReason ?? "verification_failed",
        payer: check.response.payer,
        transaction: "",
        network: requirements.network,
      };
    }
    const { payer, publicKeyHex, dto } = check;
    const base = { payer, network: requirements.network };

    // Submission is itself the check for balance, fee and uniqueKey; a dry run
    // here would only add a round trip and could not change the outcome.
    const result = await this.gateway.transferToken(dto);
    if (isSuccess(result)) {
      const transaction = result.body.transactionId || (await this.lookupTransactionId(dto, publicKeyHex));
      return { success: true, transaction, ...base };
    }

    const key = galaChainErrorKey(result);
    if (result.status === 409 || key === "UNIQUE_TRANSACTION_CONFLICT") {
      return {
        success: false,
        errorReason: "invalid_exact_galachain_duplicate",
        transaction: extractOriginalTransactionId(galaChainMessage(result)) ?? result.body.transactionId ?? "",
        ...base,
      };
    }
    if (result.status === 402 || key === "PAYMENT_REQUIRED") {
      return { success: false, errorReason: "insufficient_funds", transaction: result.body.transactionId ?? "", ...base };
    }
    return {
      success: false,
      errorReason: key ?? "unexpected_settle_error",
      transaction: result.body.transactionId ?? "",
      ...base,
    };
  }
}
