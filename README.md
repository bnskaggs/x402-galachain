# x402-galachain

Experimental x402 `exact` scheme for paying with GALA on GalaChain.

This is a lab package, not an upstream x402 SDK package. It exists to prove
that a stock x402 client/server can carry a GalaChain payment through a custom
scheme plug-in, then run the `x402-probe` attack catalogue against it.

## Shape

- Network: `galachain:mainnet` (provisional CAIP-2 identifier for the probe).
- Asset: `GALA|Unit|none|none`, backed by the GalaChain token class
  `{ collection: "GALA", category: "Unit", type: "none", additionalKey: "none" }`.
- Payer signs a `TransferTokenDto`.
- A facilitator relays the signed DTO through the public GalaChain gateway.
- GalaChain burns a 1 GALA `TransferToken` fee from the payer; the facilitator
  does not sponsor fees.

## Exports

- `x402-galachain/exact/client`: client-side payload creator.
- `x402-galachain/exact/server`: resource-server price parser and requirements
  enhancer.
- `x402-galachain/exact/facilitator`: verification and settlement against the
  GalaChain REST gateway.

## Status

Core scheme classes are implemented. The first milestone is an end-to-end demo:
a stock x402 fetch client pays an express seller in GALA on GalaChain mainnet,
through this plug-in and without editing the x402 SDK.
