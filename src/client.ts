import { randomUUID } from "node:crypto";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { DEFAULT_MAX_TIMEOUT_SECONDS } from "./constants.js";
import type { ExactGalaChainPayload, GalaChainTransferTokenDto } from "./types.js";
import {
  assetIdToTokenInstance,
  atomicToGalaQuantity,
  galaChainAddressFromPrivateKey,
  publicKeyFromPrivateKey,
  signDto,
} from "./utils.js";

export interface ExactGalaChainClientOptions {
  uniqueKeyPrefix?: string;
}

export class ExactGalaChainClientScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly address: string;
  private readonly publicKey: string;
  private readonly uniqueKeyPrefix: string;

  constructor(
    private readonly privateKey: string,
    options: ExactGalaChainClientOptions = {},
  ) {
    this.publicKey = publicKeyFromPrivateKey(privateKey);
    this.address = galaChainAddressFromPrivateKey(privateKey);
    this.uniqueKeyPrefix = options.uniqueKeyPrefix ?? "x402";
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const maxTimeoutSeconds =
      typeof paymentRequirements.maxTimeoutSeconds === "number"
        ? paymentRequirements.maxTimeoutSeconds
        : DEFAULT_MAX_TIMEOUT_SECONDS;

    const unsignedDto: GalaChainTransferTokenDto = {
      to: paymentRequirements.payTo,
      tokenInstance: assetIdToTokenInstance(paymentRequirements.asset),
      quantity: atomicToGalaQuantity(paymentRequirements.amount),
      uniqueKey: `${this.uniqueKeyPrefix}-${randomUUID()}`,
      dtoExpiresAt: Date.now() + maxTimeoutSeconds * 1000,
    };

    const payload: ExactGalaChainPayload = {
      dto: signDto(unsignedDto, this.privateKey),
      signerPublicKey: this.publicKey,
    };

    return {
      x402Version,
      payload,
    };
  }
}

