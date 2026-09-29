# Scheme: `exact` on GalaChain

Status: draft, unsubmitted. Written against x402 protocol v2 and
`@gala-chain/api` 3.3.x, measured on GalaChain mainnet 2026-09-29
(receipts in `../runs/`).

## Summary

The client signs a GalaChain `TransferTokenDto` naming the merchant as
receiver, but does not submit it. A facilitator relays the signed DTO
through a GalaChain REST gateway. GalaChain authenticates the DTO
signature itself (the submitter's transport identity is irrelevant to
who pays), so any party that can reach a gateway can act as facilitator.

Family: **facilitator-submitted** (per `scheme_exact.md`).

| Declaration | Value |
|---|---|
| Fee payer | **Self-funded by the payer.** GalaChain's `TransferToken` fee gate burns the fee (1 GALA on mainnet at time of writing) from the DTO signer, not the submitter. The facilitator cannot sponsor it short of a curator-granted `FeeExemption`. |
| Replay primitive | **Exclusive to this payment.** `uniqueKey` is a client-chosen single-use key enforced on-chain (`UniqueTransactionService`); unrelated payer activity cannot invalidate it, and concurrent payments do not contend. |
| Validity window | **Bounded by `dtoExpiresAt`** (unix ms), checked on-chain before execution. This scheme makes it REQUIRED (upstream GalaChain treats it as optional). |
| Duplicate submission | **Distinguishable.** Resubmitting an already-settled DTO returns HTTP 409 `UNIQUE_TRANSACTION_CONFLICT` whose message names the original transaction id, and burns no second fee (a failed Fabric transaction rolls back all writes). |

## Networks

| Network | Identifier |
|---|---|
| GalaChain mainnet | `galachain:mainnet` (provisional; GalaChain has no registered CAIP-2 namespace) |

## `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "galachain:mainnet",
  "amount": "100000000",
  "asset": "GALA|Unit|none|none",
  "payTo": "eth|f936...fcEF",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "transfer-token",
    "decimals": 8,
    "name": "GALA"
  }
}
```

- `amount`: integer atomic units. GALA has 8 decimals, so `"100000000"` = 1 GALA.
- `asset`: `collection|category|type|additionalKey` of the GalaChain token
  class. This draft supports `GALA|Unit|none|none` only.
- `payTo`: GalaChain address (`eth|<checksummed-eth-address>` for
  secp256k1 users).
- `extra.assetTransferMethod`: MUST be `"transfer-token"`.

## `PaymentPayload.payload`

```json
{
  "signerPublicKey": "04...",
  "dto": {
    "to": "eth|f936...fcEF",
    "tokenInstance": {
      "collection": "GALA", "category": "Unit",
      "type": "none", "additionalKey": "none", "instance": "0"
    },
    "quantity": "1",
    "uniqueKey": "x402-<uuid>",
    "dtoExpiresAt": 1790715000000,
    "signature": "<65-byte secp256k1, keccak256 over deterministic JSON of the dto minus signature>"
  }
}
```

`quantity` is decimal token units (the chain API's convention), not atomic;
verifiers convert with `decimals` and compare against `amount` exactly.

## Facilitator verification rules (MUST)

1. `x402Version == 2`; scheme `exact`; `payload.accepted.network ==
   requirements.network`.
2. Payload carries `dto`, `dto.signature`, `signerPublicKey`.
3. `signature` verifies against the DTO (minus `signature`) and
   `signerPublicKey` (secp256k1 + keccak256 over deterministic JSON, as in
   `@gala-chain/api` `signatures.isValid`). The proven payer is
   `eth|getEthAddress(signerPublicKey)`.
4. `dto.from`, when present, MUST equal the proven payer (otherwise the
   chain would require a transfer allowance).
5. `dto.uniqueKey` present.
6. `dto.to == requirements.payTo`.
7. `dto.tokenInstance` == the token class encoded in `requirements.asset`,
   `instance == "0"` (fungible).
8. `dto.quantity`, converted at `extra.decimals`, MUST equal
   `requirements.amount` exactly.
9. `dto.dtoExpiresAt` REQUIRED; MUST be later than now + a safety margin
   and MUST NOT exceed now + `maxTimeoutSeconds` (+ small skew).
10. Under the `authorization` flow, an unsigned gateway `DryRun` of
    `TransferToken` with `callerPublicKey = signerPublicKey` MUST return
    `Status: 1`. This checks payer balance and the payer's fee balance
    without writing state. `PAYMENT_REQUIRED` maps to `insufficient_funds`.

## Settlement

POST the signed DTO unchanged to the gateway `TransferToken` endpoint.

- 2xx with `Status: 1` → success. Note: the public mainnet gateway
  currently omits the transaction id on success. A facilitator MAY
  re-present the same signed DTO: the 409 duplicate response names the
  original transaction id and burns no second fee. (Measured 2026-09-29;
  see `../runs/`.)
- 409 / `UNIQUE_TRANSACTION_CONFLICT` → the payment already settled once.
  Per `exact`, this MUST be reported as settlement **failure**
  (`invalid_exact_galachain_duplicate`), carrying the original transaction
  id for reconciliation.
- 402 / `PAYMENT_REQUIRED` → `insufficient_funds` (payer lacks the burn
  fee or the transfer balance).

## Payment flows

`authorization` (default): verify (rules 1–10) → resource → settle.
`upfront`: settle → resource; the settle result itself is the pre-resource
check (DryRun omitted).

## Error reason codes

`invalid_exact_galachain_x402_version`, `unsupported_scheme`,
`network_mismatch`, `invalid_exact_galachain_payload_missing_dto`,
`invalid_exact_galachain_payload_missing_signer_public_key`,
`invalid_exact_galachain_payload_missing_signature`,
`invalid_exact_galachain_payload_signature`,
`invalid_exact_galachain_from_mismatch`,
`invalid_exact_galachain_missing_unique_key`,
`invalid_exact_galachain_pay_to_mismatch`,
`invalid_exact_galachain_asset_mismatch`,
`invalid_exact_galachain_asset_instance_mismatch`,
`invalid_exact_galachain_quantity`,
`invalid_exact_galachain_amount_mismatch`,
`invalid_exact_galachain_missing_expiry`,
`invalid_exact_galachain_expired`,
`invalid_exact_galachain_expiry_mismatch`,
`invalid_exact_galachain_requirements_timeout`,
`invalid_exact_galachain_dry_run_failed:<key>`,
`invalid_exact_galachain_duplicate`, `insufficient_funds`,
`unexpected_settle_error`.

## Known limitations

- Single asset (GALA) and single network id in this draft.
- The payer must hold GALA for the burn fee on top of the payment; at a
  1 GALA fee, micropayments below ~$0.01 are fee-dominated.
- The provisional `galachain:mainnet` identifier needs a real CAIP-2
  registration before any upstream submission.
- The success-response transaction-id gap is a gateway behavior, not a
  chain property; the duplicate-re-present workaround costs one extra
  gateway round-trip.
