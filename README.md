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

## Harness

The repo carries its own demo and attack harness (moved here from the
x402-probe repo to keep this thread self-contained):

- `npm run demo` — a stock x402 fetch client pays a stock express seller
  1 GALA on GalaChain mainnet through this plug-in. Tries the SDK's default
  spend controls first (they refuse a non-default asset), then reruns with an
  `allowedAssets` entry for GALA.
- `npm run attack -- A1|A1b|A2|A3a|A3b|A4|A5|A7` — the x402-probe attack
  catalogue ported to GalaChain terms.
- `runs/` — JSONL receipts from the mainnet runs.

Test wallets are read from `~/.x402-probe/.env` (override with
`X402_PROBE_ENV`); keys never enter this repo.

## Status

Demo landed 2026-09-29: HTTP 200, tx
`9fc797fda6a98926ec974a24ca1fa6f2b5603a131a5a637f53d815d70ffff419`,
buyer −2 GALA (1 payment + 1 fee burned), seller +1 — no x402 SDK edits.
Naive attack round A1–A7 run the same day; all rows matched the plumbing
predictions, and GalaChain's `uniqueKey` conflict returned the original tx id
on duplicates without burning a second fee.
