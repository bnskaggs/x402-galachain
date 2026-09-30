# x402-galachain

Experimental x402 `exact` scheme for paying with GALA on GalaChain.

This is a lab package, not an upstream x402 SDK package. It exists to prove
that a stock x402 client/server can carry a GalaChain payment through a custom
scheme plug-in, then run the `x402-probe` attack catalogue against it.

## Install

```sh
npm install x402-galachain @x402/core
```

Published on npm as [`x402-galachain`](https://www.npmjs.com/package/x402-galachain).
`@x402/core` is a peer dependency. Versions below 0.1.0 track an unreviewed
spec ([x402#3635](https://github.com/x402-foundation/x402/pull/3635)); expect
breaking changes between patch releases until that PR is resolved.

## Shape

- Network: `galachain:mainnet` (CAIP-2 namespace proposed in [ChainAgnostic/namespaces#232](https://github.com/ChainAgnostic/namespaces/pull/232)).
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

## Tests

`npm test` runs an offline suite (vitest, mocked gateway, no GALA moves):
one rejection test per facilitator verification rule, the settle paths
(success, tx-id reconciliation via the duplicate conflict, duplicate =
failure, fee shortfall), the nested `DryRun` result shape the gateway
actually returns, signer-envelope rejections, price parsing, client payload
shape and signing, and unit conversions. `npm run typecheck` covers `src/`,
`harness/` and `test/`. End-to-end behaviour is covered by the mainnet
receipts in `runs/`.

Two defects fixed 2026-09-29 (commit history). First, `/verify` read only
the outer `Status` of a `DryRun` response, which is `1` whenever the
simulation ran, so underfunded payers passed verification and failed at
settle. Second, the fix for that exposed a regression: `DryRun` also enforces
`uniqueKey`, so a dry run before settle reported a replayed payload as a
verification error instead of the duplicate-settlement failure the spec
requires. Settle now submits without a prior dry run and uses an unsigned
`DryRun` only to look up the transaction id afterwards. A3a and A3b were
re-run on mainnet after both fixes (receipts appended to `runs/`); the other
rows were measured before the fixes and did not exercise either path.

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

Mitigated round (same day, `npm run attack -- <id> --mitigated`): the
five-rule guard in `harness/guard.ts` cut the round's spend from 29.55 to
8.08 GALA — A5 and A7 to zero, A4 stopped by the budget, A1/A1b/A2 held to
one fair payment each. Draft scheme spec:
[`specs/scheme_exact_galachain.md`](specs/scheme_exact_galachain.md).

Upstream: scheme proposed in
[x402-foundation/x402#3634](https://github.com/x402-foundation/x402/issues/3634);
CAIP-2 namespace in
[ChainAgnostic/namespaces#232](https://github.com/ChainAgnostic/namespaces/pull/232).
