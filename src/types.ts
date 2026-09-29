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

