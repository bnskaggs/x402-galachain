export const GALACHAIN_NETWORK = "galachain:mainnet" as const;
export const GALACHAIN_CAIP_FAMILY = "galachain:*" as const;
export const GALACHAIN_GATEWAY_URL =
  "https://gateway-mainnet.galachain.com/api/asset/token-contract";

export const GALA_ASSET_ID = "GALA|Unit|none|none" as const;
export const GALA_DECIMALS = 8;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

export const GALA_TOKEN_CLASS = {
  collection: "GALA",
  category: "Unit",
  type: "none",
  additionalKey: "none",
} as const;

export const GALA_TOKEN_INSTANCE = {
  ...GALA_TOKEN_CLASS,
  instance: "0",
} as const;

export const TRANSFER_TOKEN_FEE_CODE = "TransferToken";
export const ASSET_TRANSFER_METHOD = "transfer-token";

