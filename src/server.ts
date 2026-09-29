import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import {
  ASSET_TRANSFER_METHOD,
  GALA_ASSET_ID,
  GALA_DECIMALS,
  GALACHAIN_NETWORK,
} from "./constants.js";
import { galaQuantityToAtomic } from "./utils.js";

function parseGalaAmount(value: string): string {
  const trimmed = value.trim();
  const galaMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*GALA$/i);
  if (galaMatch) return galaQuantityToAtomic(galaMatch[1]);
  if (/^\d+(\.\d+)?$/.test(trimmed)) return galaQuantityToAtomic(trimmed);
  throw new Error(`Unsupported GalaChain price: ${value}. Use "1 GALA" or a bare GALA amount.`);
}

export class ExactGalaChainServerScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = ASSET_TRANSFER_METHOD;
  // Only `authorization` (verify -> resource -> settle) has been exercised on
  // mainnet. `upfront` would work mechanically but is undeclared until tested.
  readonly paymentFlows = {
    [ASSET_TRANSFER_METHOD]: {
      supported: ["authorization"],
      default: "authorization",
    },
  } as const satisfies Record<string, PaymentFlowConfig>;

  getAssetDecimals(asset: string, network: Network): number | undefined {
    if (network === GALACHAIN_NETWORK && asset === GALA_ASSET_ID) {
      return GALA_DECIMALS;
    }
    return undefined;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (network !== GALACHAIN_NETWORK) {
      throw new Error(`Unsupported GalaChain network: ${network}`);
    }

    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) throw new Error("Asset must be specified for GalaChain AssetAmount");
      if (price.asset !== GALA_ASSET_ID) throw new Error(`Unsupported GalaChain asset: ${price.asset}`);
      return {
        amount: price.amount,
        asset: price.asset,
        extra: { ...(price.extra ?? {}) },
      };
    }

    return {
      amount: parseGalaAmount(String(price)),
      asset: GALA_ASSET_ID,
      extra: {},
    };
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    void supportedKind;
    void facilitatorExtensions;
    return {
      ...paymentRequirements,
      extra: {
        ...(paymentRequirements.extra ?? {}),
        assetTransferMethod: ASSET_TRANSFER_METHOD,
        decimals: GALA_DECIMALS,
        name: "GALA",
      },
    };
  }
}

