import {
  GALA_TOKEN_CLASS,
  GALACHAIN_GATEWAY_URL,
  TRANSFER_TOKEN_FEE_CODE,
} from "./constants.js";
import type {
  GalaChainBalance,
  GalaChainDryRunResult,
  GalaChainResponse,
  GalaChainTransferTokenDto,
  GatewayResult,
} from "./types.js";

export interface GalaChainGatewayOptions {
  url?: string;
  fetchFn?: typeof fetch;
}

export class GalaChainGateway {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: GalaChainGatewayOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get url(): string {
    return this.options.url ?? GALACHAIN_GATEWAY_URL;
  }

  async dryRunTransfer(
    dto: GalaChainTransferTokenDto,
    callerPublicKey: string,
  ): Promise<GatewayResult<GalaChainDryRunResult>> {
    const { signature: _signature, ...unsignedDto } = dto;
    return this.post<GalaChainDryRunResult>("DryRun", {
      method: "TransferToken",
      callerPublicKey,
      dto: unsignedDto,
    });
  }

  async transferToken(dto: GalaChainTransferTokenDto): Promise<GatewayResult> {
    return this.post("TransferToken", dto);
  }

  async fetchBalances(owner: string): Promise<GatewayResult<GalaChainBalance[]>> {
    return this.post<GalaChainBalance[]>("FetchBalances", {
      owner,
      ...GALA_TOKEN_CLASS,
    });
  }

  async fetchProposedTransferFee(user: string): Promise<GatewayResult<unknown>> {
    return this.post("FetchProposedFee", {
      feeCode: TRANSFER_TOKEN_FEE_CODE,
      user,
    });
  }

  async post<T = unknown>(method: string, body: unknown): Promise<GatewayResult<T>> {
    const res = await this.fetchFn(`${this.url}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: GalaChainResponse<T>;
    try {
      parsed = JSON.parse(text) as GalaChainResponse<T>;
    } catch {
      parsed = {
        error: {
          ErrorKey: "invalid_galachain_gateway_response",
          Message: text,
        },
        Status: 0,
      };
    }
    return { status: res.status, body: parsed };
  }
}

export function galaChainMessage(result: GatewayResult): string {
  return result.body.error?.Message ?? result.body.message ?? "";
}

export function galaChainErrorKey(result: GatewayResult): string | undefined {
  return result.body.error?.ErrorKey;
}

export function isSuccess(result: GatewayResult): boolean {
  return result.status >= 200 && result.status < 300 && result.body.Status === 1;
}

/**
 * A DryRun that ran reports outer `Status: 1` regardless of how the simulated
 * call went; the simulated call's outcome is `Data.response`. Measured on
 * mainnet 2026-09-29: an unfunded payer got HTTP 200, outer Status 1, inner
 * `PAYMENT_REQUIRED`, and a write set for the attempted writes.
 */
export function isDryRunSuccess(result: GatewayResult<GalaChainDryRunResult>): boolean {
  return isSuccess(result) && result.body.Data?.response?.Status === 1;
}

export function dryRunErrorKey(result: GatewayResult<GalaChainDryRunResult>): string | undefined {
  return result.body.Data?.response?.ErrorKey ?? galaChainErrorKey(result);
}

export function extractOriginalTransactionId(message: string): string | undefined {
  const match = message.match(/transaction\s+([0-9a-f]{64})/i);
  return match?.[1];
}

