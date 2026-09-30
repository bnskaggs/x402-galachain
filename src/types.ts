export interface GalaChainTokenInstance {
  collection: string;
  category: string;
  type: string;
  additionalKey: string;
  instance: string;
}

export interface GalaChainTransferTokenDto {
  from?: string;
  to: string;
  tokenInstance: GalaChainTokenInstance;
  quantity: string;
  uniqueKey: string;
  dtoExpiresAt: number;
  signature?: string;
  // Optional ChainCallDTO envelope fields a wallet may set. The facilitator
  // constrains them (see spec rule 4); it never sets them.
  signerPublicKey?: string;
  signerAddress?: string;
  multisig?: string[];
  prefix?: string;
  domain?: Record<string, unknown>;
  types?: Record<string, unknown>;
}

/** `Data` of a gateway `DryRun` response. The simulated call's own outcome is `response`. */
export interface GalaChainDryRunResult {
  reads?: Record<string, string>;
  writes?: Record<string, string>;
  deletes?: Record<string, string>;
  response?: {
    Status?: number;
    Data?: unknown;
    ErrorCode?: number;
    ErrorKey?: string;
    ErrorPayload?: unknown;
    Message?: string;
  };
}

export interface ExactGalaChainPayload extends Record<string, unknown> {
  dto: GalaChainTransferTokenDto;
  signerPublicKey: string;
}

export interface GalaChainResponse<T = unknown> {
  Data?: T;
  Status?: number;
  error?: {
    ErrorCode?: number;
    ErrorKey?: string;
    ErrorPayload?: unknown;
    Message?: string;
    Status?: number;
  };
  message?: string;
  method?: string;
  transactionId?: string;
}

export interface GalaChainBalance {
  collection: string;
  category: string;
  type: string;
  additionalKey: string;
  instance?: string;
  quantity: string | number;
}

export interface GatewayResult<T = unknown> {
  status: number;
  body: GalaChainResponse<T>;
}

