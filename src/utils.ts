import { signatures } from "@gala-chain/api";
import {
  GALA_ASSET_ID,
  GALA_DECIMALS,
  GALA_TOKEN_INSTANCE,
} from "./constants.js";
import type { GalaChainTokenInstance } from "./types.js";

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/^0x/, "");
}

export function publicKeyFromPrivateKey(privateKey: string): string {
  return signatures.getPublicKey(normalizePrivateKey(privateKey));
}

export function galaChainAddressFromPublicKey(publicKey: string): string {
  return `eth|${signatures.getEthAddress(publicKey)}`;
}

export function galaChainAddressFromPrivateKey(privateKey: string): string {
  return galaChainAddressFromPublicKey(publicKeyFromPrivateKey(privateKey));
}

export function signDto<T extends object>(dto: T, privateKey: string): T & { signature: string } {
  return {
    ...dto,
    signature: signatures.getSignature(dto, normalizePrivateKey(privateKey)),
  };
}

export function assetIdToTokenInstance(asset: string): GalaChainTokenInstance {
  if (asset !== GALA_ASSET_ID) {
    throw new Error(`Unsupported GalaChain asset: ${asset}`);
  }
  return GALA_TOKEN_INSTANCE;
}

export function tokenInstanceToAssetId(token: {
  collection: string;
  category: string;
  type: string;
  additionalKey: string;
}): string {
  return `${token.collection}|${token.category}|${token.type}|${token.additionalKey}`;
}

export function atomicToGalaQuantity(amount: string): string {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`GALA amount must be an integer atomic string: ${amount}`);
  }
  const atomic = BigInt(amount);
  const scale = 10n ** BigInt(GALA_DECIMALS);
  const whole = atomic / scale;
  const fraction = atomic % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(GALA_DECIMALS, "0").replace(/0+$/, "")}`;
}

export function galaQuantityToAtomic(quantity: string | number): string {
  const raw = String(quantity);
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid GALA quantity: ${raw}`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > GALA_DECIMALS) {
    throw new Error(`GALA quantity has more than ${GALA_DECIMALS} decimals: ${raw}`);
  }
  const padded = fraction.padEnd(GALA_DECIMALS, "0");
  return (BigInt(whole) * 10n ** BigInt(GALA_DECIMALS) + BigInt(padded || "0")).toString();
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

