import { signatures } from "@gala-chain/api";
import { describe, expect, it } from "vitest";
import { ExactGalaChainClientScheme } from "../src/client.js";
import { GALA_ASSET_ID, GALACHAIN_NETWORK } from "../src/constants.js";
import { extractOriginalTransactionId } from "../src/gateway.js";
import { ExactGalaChainServerScheme } from "../src/server.js";
import type { ExactGalaChainPayload } from "../src/types.js";
import { atomicToGalaQuantity, galaQuantityToAtomic, tokenInstanceToAssetId } from "../src/utils.js";
import { payer, payerKey, requirements, seller } from "./helpers.js";

describe("server: parsePrice", () => {
  const server = new ExactGalaChainServerScheme();

  it("parses GALA-suffixed and bare decimal prices to 8-decimal atomic units", async () => {
    expect(await server.parsePrice("1 GALA", GALACHAIN_NETWORK)).toMatchObject({ amount: "100000000", asset: GALA_ASSET_ID });
    expect(await server.parsePrice("0.01 GALA", GALACHAIN_NETWORK)).toMatchObject({ amount: "1000000" });
    expect(await server.parsePrice("0.01", GALACHAIN_NETWORK)).toMatchObject({ amount: "1000000" });
    expect(await server.parsePrice(2, GALACHAIN_NETWORK)).toMatchObject({ amount: "200000000" });
  });

  it("passes an explicit GALA AssetAmount through and rejects other assets", async () => {
    expect(await server.parsePrice({ amount: "5", asset: GALA_ASSET_ID }, GALACHAIN_NETWORK)).toMatchObject({ amount: "5" });
    await expect(server.parsePrice({ amount: "5", asset: "GUSDC|Unit|none|none" }, GALACHAIN_NETWORK)).rejects.toThrow();
  });

  it("rejects dollar prices and foreign networks (GALA is not USD-pegged)", async () => {
    await expect(server.parsePrice("$0.10", GALACHAIN_NETWORK)).rejects.toThrow();
    await expect(server.parsePrice("1 GALA", "eip155:8453")).rejects.toThrow();
  });

  it("enhances requirements with the scheme's extra fields", async () => {
    const enhanced = await server.enhancePaymentRequirements(
      requirements({ extra: undefined }),
      { x402Version: 2, scheme: "exact", network: GALACHAIN_NETWORK },
      [],
    );
    expect(enhanced.extra).toMatchObject({ assetTransferMethod: "transfer-token", decimals: 8, name: "GALA" });
    expect(server.getAssetDecimals(GALA_ASSET_ID, GALACHAIN_NETWORK)).toBe(8);
  });

  it("declares only the flow that has been exercised", () => {
    expect(server.paymentFlows["transfer-token"].supported).toEqual(["authorization"]);
    expect(server.paymentFlows["transfer-token"].default).toBe("authorization");
  });
});

describe("client: createPaymentPayload", () => {
  it("builds a signed TransferTokenDto matching the requirements", async () => {
    const client = new ExactGalaChainClientScheme(payerKey.privateKey);
    const before = Date.now();
    const result = await client.createPaymentPayload(2, requirements());
    const { dto, signerPublicKey } = result.payload as ExactGalaChainPayload;

    expect(client.address).toBe(payer);
    expect(signerPublicKey).toBe(payerKey.publicKey);
    expect(dto.to).toBe(seller);
    expect(dto.quantity).toBe("1");
    expect(dto.tokenInstance).toMatchObject({ collection: "GALA", category: "Unit", type: "none", additionalKey: "none", instance: "0" });
    expect(dto.uniqueKey).toMatch(/^x402-[0-9a-f-]{36}$/);
    expect(dto.dtoExpiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(dto.dtoExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000 + 1_000);

    const { signature, ...unsigned } = dto;
    expect(signatures.isValid(signature!, unsigned, signerPublicKey)).toBe(true);
  });

  it("honours the seller's window uncapped (naive by design; the cap is a mitigation)", async () => {
    const client = new ExactGalaChainClientScheme(payerKey.privateKey);
    const tenYears = 10 * 365 * 24 * 3600;
    const result = await client.createPaymentPayload(2, requirements({ maxTimeoutSeconds: tenYears }));
    const { dto } = result.payload as ExactGalaChainPayload;
    expect(dto.dtoExpiresAt).toBeGreaterThan(Date.now() + (tenYears - 5) * 1000);
  });

  it("uses fresh uniqueKeys for every payload (no accidental self-replay)", async () => {
    const client = new ExactGalaChainClientScheme(payerKey.privateKey);
    const a = (await client.createPaymentPayload(2, requirements())).payload as ExactGalaChainPayload;
    const b = (await client.createPaymentPayload(2, requirements())).payload as ExactGalaChainPayload;
    expect(a.dto.uniqueKey).not.toBe(b.dto.uniqueKey);
  });
});

describe("utils", () => {
  it("round-trips atomic and decimal GALA quantities", () => {
    expect(atomicToGalaQuantity("100000000")).toBe("1");
    expect(atomicToGalaQuantity("1000000")).toBe("0.01");
    expect(atomicToGalaQuantity("123456789")).toBe("1.23456789");
    expect(galaQuantityToAtomic("1")).toBe("100000000");
    expect(galaQuantityToAtomic("0.01")).toBe("1000000");
    expect(galaQuantityToAtomic("1.23456789")).toBe("123456789");
    expect(() => galaQuantityToAtomic("1.123456789")).toThrow();
    expect(() => galaQuantityToAtomic("-1")).toThrow();
    expect(() => atomicToGalaQuantity("1.5")).toThrow();
  });

  it("encodes token classes as pipe-joined asset ids", () => {
    expect(tokenInstanceToAssetId({ collection: "GALA", category: "Unit", type: "none", additionalKey: "none" })).toBe(GALA_ASSET_ID);
  });
});

describe("gateway: duplicate conflict parsing", () => {
  it("extracts the original transaction id from the 409 message", () => {
    const tx = "d03eb7dfbe4148ec47409693f4902a406217625a03b7ae8b8abf4f7cba26036d";
    expect(extractOriginalTransactionId(`Unique transaction key x402-abc is already saved for transaction ${tx}`)).toBe(tx);
    expect(extractOriginalTransactionId("something else")).toBeUndefined();
  });
});
