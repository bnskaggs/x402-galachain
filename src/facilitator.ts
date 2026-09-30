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
  extractOriginalTransactionId,
  galaChainErrorKey,
  galaChainMessage,
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

function toGalaNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { c?: unknown }).c) &&
    typeof (value as { e?: unknown }).e === "number"
  ) {
    const { c, e, s = 1 } = value as { c: number[]; e: number; s?: number };
    return Number(`${s < 0 ? "-" : ""}${c.join("")}`) * 10 ** (e - String(c[0]).length + 1);
  }
  return Number.NaN;
}

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

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    if (payload.x402Version !== 2) return invalid("invalid_exact_galachain_x402_version");
    if (payload.accepted?.scheme !== "exact" || requirements.scheme !== "exact") {
      return invalid("unsupported_scheme");
    }
    if (payload.accepted.network !== requirements.network || requirements.network !== GALACHAIN_NETWORK) {
      return invalid("network_mismatch");
    }

    const exactPayload = payload.payload as Partial<ExactGalaChainPayload>;
    const dto = exactPayload.dto;
    const signerPublicKey = exactPayload.signerPublicKey;
    if (!dto || typeof dto !== "object") return invalid("invalid_exact_galachain_payload_missing_dto");
    if (!signerPublicKey || typeof signerPublicKey !== "string") {
      return invalid("invalid_exact_galachain_payload_missing_signer_public_key");
    }
    if (!dto.signature) return invalid("invalid_exact_galachain_payload_missing_signature");

    const payer = galaChainAddressFromPublicKey(signerPublicKey);
    if (!signatures.isValid(dto.signature, unsignedDto(dto), signerPublicKey)) {
      return invalid("invalid_exact_galachain_payload_signature", payer);
    }

    if (dto.from && !sameAddress(dto.from, payer)) {
      return invalid("invalid_exact_galachain_from_mismatch", payer);
    }
    if (!dto.uniqueKey) return invalid("invalid_exact_galachain_missing_unique_key", payer);
    if (!sameAddress(dto.to, requirements.payTo)) {
      return invalid("invalid_exact_galachain_pay_to_mismatch", payer);
    }
    if (tokenInstanceToAssetId(dto.tokenInstance) !== requirements.asset || requirements.asset !== GALA_ASSET_ID) {
      return invalid("invalid_exact_galachain_asset_mismatch", payer);
    }
    if (dto.tokenInstance.instance !== GALA_TOKEN_INSTANCE.instance) {
      return invalid("invalid_exact_galachain_asset_instance_mismatch", payer);
    }

    let atomicAmount: string;
    try {
      atomicAmount = galaQuantityToAtomic(dto.quantity);
    } catch {
      return invalid("invalid_exact_galachain_quantity", payer);
    }
    if (atomicAmount !== requirements.amount) {
      return invalid("invalid_exact_galachain_amount_mismatch", payer);
    }

    if (typeof dto.dtoExpiresAt !== "number" || !Number.isFinite(dto.dtoExpiresAt)) {
      return invalid("invalid_exact_galachain_missing_expiry", payer);
    }
    const now = Date.now();
    if (dto.dtoExpiresAt <= now + 1_000) {
      return invalid("invalid_exact_galachain_expired", payer);
    }
    if (typeof requirements.maxTimeoutSeconds !== "number" || !Number.isFinite(requirements.maxTimeoutSeconds)) {
      return invalid("invalid_exact_galachain_requirements_timeout", payer);
    }
    if (dto.dtoExpiresAt > now + requirements.maxTimeoutSeconds * 1000 + 5_000) {
      return invalid("invalid_exact_galachain_expiry_mismatch", payer);
    }

    if (paymentFlow(requirements) === "authorization") {
      const dryRun = await this.gateway.dryRunTransfer(dto, signerPublicKey);
      if (!isSuccess(dryRun)) {
        const key = galaChainErrorKey(dryRun);
        if (key === "PAYMENT_REQUIRED") return invalid("insufficient_funds", payer);
        return invalid(`invalid_exact_galachain_dry_run_failed:${key ?? dryRun.status}`, payer);
      }
    }

    return { isValid: true, payer };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const valid = await this.verify(payload, requirements, context);
    if (!valid.isValid) {
      return {
        success: false,
        errorReason: valid.invalidReason ?? "verification_failed",
        payer: valid.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    const dto = (payload.payload as ExactGalaChainPayload).dto;
    const result = await this.gateway.transferToken(dto);
    if (isSuccess(result)) {
      let transaction = result.body.transactionId ?? "";
      if (!transaction) {
        // The public gateway currently omits the tx id on a successful submit.
        // Re-presenting the same signed DTO is idempotent on GalaChain: it
        // returns a conflict that names the original transaction and burns no
        // second fee. That gives x402 callers a useful SettlementResponse.
        const duplicate = await this.gateway.transferToken(dto);
        transaction =
          extractOriginalTransactionId(galaChainMessage(duplicate)) ??
          duplicate.body.transactionId ??
          "";
      }
      return {
        success: true,
        payer: valid.payer,
        transaction,
        network: requirements.network,
      };
    }

    const key = galaChainErrorKey(result);
    const message = galaChainMessage(result);
    if (result.status === 409 || key === "UNIQUE_TRANSACTION_CONFLICT") {
      return {
        success: false,
        errorReason: "invalid_exact_galachain_duplicate",
        payer: valid.payer,
        transaction: extractOriginalTransactionId(message) ?? result.body.transactionId ?? "",
        network: requirements.network,
      };
    }

    if (result.status === 402 || key === "PAYMENT_REQUIRED") {
      return {
        success: false,
        errorReason: "insufficient_funds",
        payer: valid.payer,
        transaction: result.body.transactionId ?? "",
        network: requirements.network,
      };
    }

    return {
      success: false,
      errorReason: key ?? "unexpected_settle_error",
      payer: valid.payer,
      transaction: result.body.transactionId ?? "",
      network: requirements.network,
    };
  }
}

