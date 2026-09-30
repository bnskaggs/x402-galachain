# Scheme: `exact` on GalaChain

## Summary

The `exact` scheme on GalaChain transfers a specific amount of a GalaChain fungible token class from the Client to the Resource Server's account.

The Client signs a GalaChain `TransferTokenDto` naming `payTo` as receiver but does not submit it. The Facilitator relays the signed DTO to a GalaChain REST gateway during settlement. GalaChain authenticates the DTO by its own signature, not by the identity of whoever submits it, so the Facilitator holds no key, signs nothing, and cannot alter the amount or destination.

GalaChain is a Hyperledger Fabric-based layer 1 (TypeScript chaincode, REST gateways, no EVM, no JSON-RPC). Two properties shape this scheme:

- **The payer funds the chain fee.** GalaChain's `TransferToken` fee gate debits the fee from the DTO signer, not from the submitter. The Facilitator sponsors nothing.
- **Replay is exclusive and distinguishable.** Every DTO carries a client-chosen single-use `uniqueKey` enforced on chain. Resubmitting a settled DTO fails with a conflict that names the original transaction and, because a failed Fabric transaction writes nothing, burns no second fee.

This scheme defines one asset transfer method:

| AssetTransferMethod | Family | Fee payer | Replay primitive | Validity window | Duplicate submission |
| --- | --- | --- | --- | --- | --- |
| **`transfer-token`** (default) | Facilitator-submitted | Self-funded by the payer | Exclusive to this payment (`uniqueKey`, enforced on chain) | Bounded by `dtoExpiresAt` (unix ms); REQUIRED by this scheme | Distinguishable: HTTP 409 `UNIQUE_TRANSACTION_CONFLICT` naming the original transaction |

If no `assetTransferMethod` is specified in `PaymentRequirements.extra`, clients and facilitators MUST behave as `transfer-token`. A facilitator MUST reject any other value (`invalid_exact_galachain_unsupported_asset_transfer_method`).

Facilitators SHOULD advertise the method per network in `/supported`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "galachain:mainnet",
      "extra": {
        "assetTransferMethods": ["transfer-token"]
      }
    }
  ]
}
```

There is no `extra.feePayer`: the facilitator has no account on the payment path.

## Networks

| Network | CAIP-2 |
| --- | --- |
| GalaChain mainnet | `galachain:mainnet` |
| GalaChain testnet | `galachain:testnet` |

The `galachain` namespace is proposed in [ChainAgnostic/namespaces#232](https://github.com/ChainAgnostic/namespaces/pull/232). Each network is reached through its REST gateway (`https://gateway-mainnet.galachain.com/api`, `https://gateway-testnet.galachain.com/api`); the token contract on the `asset` channel is at `/asset/token-contract/<Method>`.

## Protocol Flow

1. **Client** requests a resource from a **Resource Server**.
2. **Resource Server** responds with a payment-required signal carrying `PaymentRequirements` for `galachain:<network>`, priced in atomic units of a GalaChain token class.
3. **Client** builds a `TransferTokenDto`: `to = payTo`, `tokenInstance` = the token class from `asset` with `instance "0"`, `quantity` = `amount` converted to decimal token units, a fresh `uniqueKey`, and `dtoExpiresAt = now + maxTimeoutSeconds`.
4. **Client** signs the DTO with its secp256k1 key and sends a new request carrying the `PaymentPayload` (`dto` with `signature`, plus `signerPublicKey`).
5. **Resource Server** forwards `PaymentPayload` and `PaymentRequirements` to the **Facilitator** `/verify`.
6. **Facilitator** checks the signature, the DTO fields against the requirements, and the validity window, then runs an unsigned `DryRun` of `TransferToken` against the gateway to confirm the payer can fund both the transfer and the fee.
7. **Resource Server**, on a valid response, serves the resource and calls `/settle`.
8. **Facilitator** POSTs the signed DTO unchanged to the gateway's `TransferToken` endpoint and returns a `SettlementResponse` carrying the transaction id.

## Phase 1: `PAYMENT-SIGNATURE` Header Payload

### `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "galachain:mainnet",
  "amount": "100000000",
  "asset": "GALA|Unit|none|none",
  "payTo": "eth|f936C4b8d5D6F3B6B5b8dC7A1e2F3a4B5c6D7fcEF",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "transfer-token",
    "decimals": 8,
    "name": "GALA"
  }
}
```

- `amount`: integer, atomic units of `asset`. GALA has 8 decimals, so `"100000000"` is 1 GALA.
- `asset`: the GalaChain token class key `collection|category|type|additionalKey`. GALA is `GALA|Unit|none|none`.
- `payTo`: a GalaChain user alias. For secp256k1 users this is `eth|` followed by the checksummed Ethereum-style address derived from the public key.
- `maxTimeoutSeconds`: bounds `dto.dtoExpiresAt` (verification rule 9).

**`extra` field definitions:**

- `extra.assetTransferMethod` (optional, default `"transfer-token"`): if present, MUST be `"transfer-token"`.
- `extra.decimals` (required): decimals of the token class, used to convert `dto.quantity` to atomic units.
- `extra.name` (optional): display name of the token.

### `PaymentPayload`

The `payload` field MUST contain:

- `dto`: the signed `TransferTokenDto`.
- `signerPublicKey`: the payer's secp256k1 public key (hex), used to verify `dto.signature` and to derive the payer address.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "galachain:mainnet",
    "amount": "100000000",
    "asset": "GALA|Unit|none|none",
    "payTo": "eth|f936C4b8d5D6F3B6B5b8dC7A1e2F3a4B5c6D7fcEF",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "transfer-token",
      "decimals": 8,
      "name": "GALA"
    }
  },
  "payload": {
    "signerPublicKey": "04a1b2c3...",
    "dto": {
      "to": "eth|f936C4b8d5D6F3B6B5b8dC7A1e2F3a4B5c6D7fcEF",
      "tokenInstance": {
        "collection": "GALA",
        "category": "Unit",
        "type": "none",
        "additionalKey": "none",
        "instance": "0"
      },
      "quantity": "1",
      "uniqueKey": "x402-3f9c2a6e-8d41-4b7e-9c1a-2e5f7a8b9c0d",
      "dtoExpiresAt": 1790715000000,
      "signature": "5c1e...9f1b"
    }
  }
}
```

**DTO field semantics:**

- `to`: receiver alias; MUST equal `payTo`.
- `tokenInstance`: the token class from `asset` plus `instance: "0"` (fungible).
- `quantity`: **decimal token units** as a string, the chain API's convention. `"1"` with `decimals: 8` corresponds to `amount: "100000000"`.
- `uniqueKey`: client-chosen, single-use on chain. Clients SHOULD use a random UUID with a recognisable prefix; the value is opaque to the facilitator.
- `dtoExpiresAt`: unix time in milliseconds after which the chain rejects the DTO. Optional on GalaChain; REQUIRED by this scheme.
- `from`: MAY be omitted (the chain then uses the signer). If present it MUST equal the payer derived from `signerPublicKey`.
- `signature`: secp256k1 signature over the keccak256 hash of the DTO's deterministic JSON serialisation with `signature` excluded, hex-encoded with recovery byte, as produced by `signatures.getSignature` in `@gala-chain/api`.

### `SettlementResponse`

```json
{
  "success": true,
  "transaction": "9fc797fda6a98926ec974a24ca1fa6f2b5603a131a5a637f53d815d70ffff419",
  "network": "galachain:mainnet",
  "payer": "eth|867E1a2B3c4D5e6F708192A3b4C5d6E7f8091A2b"
}
```

- `transaction`: the GalaChain (Fabric) transaction id, 64 hex characters.
- `payer`: the alias derived from `signerPublicKey`; the account debited `amount` plus the chain fee.

## Phase 2: Verification Logic

A facilitator MUST enforce every rule below, in order, before reporting `isValid: true`. Each rule names the `invalidReason` returned on failure.

1. **Envelope.** `x402Version` MUST be `2` (`invalid_exact_galachain_x402_version`); `accepted.scheme` and `requirements.scheme` MUST be `exact` (`unsupported_scheme`); `accepted.network` MUST equal `requirements.network` and be a network this facilitator serves (`network_mismatch`).
2. **Payload shape.** `payload.dto` MUST be an object (`invalid_exact_galachain_payload_missing_dto`); `payload.signerPublicKey` MUST be a string (`invalid_exact_galachain_payload_missing_signer_public_key`); `dto.signature` MUST be present (`invalid_exact_galachain_payload_missing_signature`).
3. **Signature.** `dto.signature` MUST verify against the DTO with `signature` removed and `signerPublicKey`, per `signatures.isValid` (`invalid_exact_galachain_payload_signature`). The proven payer is the `eth|` alias derived from `signerPublicKey`; it is reported as `payer` in every subsequent response.
4. **Sender binding.** If `dto.from` is present it MUST equal the proven payer (`invalid_exact_galachain_from_mismatch`). A foreign `from` would make the chain look for a transfer allowance rather than debit the signer.
5. **Replay primitive present.** `dto.uniqueKey` MUST be a non-empty string (`invalid_exact_galachain_missing_unique_key`).
6. **Destination.** `dto.to` MUST equal `requirements.payTo` (`invalid_exact_galachain_pay_to_mismatch`).
7. **Asset.** `dto.tokenInstance` encoded as `collection|category|type|additionalKey` MUST equal `requirements.asset` and be a class this facilitator supports (`invalid_exact_galachain_asset_mismatch`); `tokenInstance.instance` MUST be `"0"` (`invalid_exact_galachain_asset_instance_mismatch`).
8. **Amount exactness.** `dto.quantity` MUST parse as a non-negative decimal with at most `extra.decimals` fractional digits (`invalid_exact_galachain_quantity`), and its atomic value MUST equal `requirements.amount` exactly (`invalid_exact_galachain_amount_mismatch`).
9. **Validity window.** `dto.dtoExpiresAt` MUST be a finite number (`invalid_exact_galachain_missing_expiry`); MUST be later than now plus a safety margin of at least 1 s (`invalid_exact_galachain_expired`); `requirements.maxTimeoutSeconds` MUST be a finite number (`invalid_exact_galachain_requirements_timeout`); and `dtoExpiresAt` MUST NOT exceed now + `maxTimeoutSeconds` × 1000 + a skew allowance of at most 5 s (`invalid_exact_galachain_expiry_mismatch`). This is the client's protection against a resource server asking for an arbitrarily long-lived authorization; it is the facilitator's job to enforce it because the chain does not know `maxTimeoutSeconds`.
10. **Dry run** (`authorization` flow). The facilitator MUST call the gateway `DryRun` endpoint with `{ "method": "TransferToken", "callerPublicKey": signerPublicKey, "dto": <dto without signature> }` and require `Status: 1`. The dry run evaluates the transfer and the fee gate against current state without writing, so it fails if the payer cannot cover `amount` plus the fee. A `PAYMENT_REQUIRED` error MUST map to `insufficient_funds`; any other error maps to `invalid_exact_galachain_dry_run_failed:<ErrorKey>`.

Facilitators MAY add stricter policy (allowed assets, maximum amount, per-payer limits) and MUST NOT relax the rules above.

## Phase 3: Settlement Logic

The facilitator MUST re-run the verification rules, then POST `payload.dto` **unchanged** (including `signature`) to the gateway `TransferToken` endpoint. It MUST NOT modify, re-serialise with different key order, or re-sign the DTO; any change invalidates the payer's signature.

Outcomes:

| Gateway response | `SettlementResponse` |
| --- | --- |
| 2xx with `Status: 1` | `success: true`, `transaction` = the transaction id (see note below) |
| 409, or `ErrorKey: UNIQUE_TRANSACTION_CONFLICT` | `success: false`, `errorReason: invalid_exact_galachain_duplicate`, `transaction` = the original transaction id parsed from the error message |
| 402, or `ErrorKey: PAYMENT_REQUIRED` | `success: false`, `errorReason: insufficient_funds` |
| any other error | `success: false`, `errorReason` = the gateway `ErrorKey`, or `unexpected_settle_error` if none |

A consumed `uniqueKey` MUST be reported as settlement failure, never success, per `scheme_exact.md`. The original transaction id in the response lets the caller reconcile which earlier settlement consumed it.

**Transaction id on success.** At time of writing the public mainnet gateway's success response omits the transaction id. A facilitator that needs one MAY re-present the same signed DTO once: GalaChain rejects it with a 409 whose message names the original transaction (`... transaction <64 hex> ...`), and the failed submission burns no fee. This costs one extra gateway round trip and no funds. Facilitators SHOULD prefer a gateway that returns the id directly when one is available.

If the submission succeeds but the transaction id cannot be established (gateway error or timeout on the re-present), the facilitator MAY return `success: true` with an empty `transaction`, or `settlement_pending` per the core specification, and SHOULD document which.

## Payment Flows

`authorization` (default): verify → resource → settle, as described above. This is the only flow this specification declares.

An `upfront` flow (settle → resource) is mechanically possible on GalaChain but has not been exercised and is not declared here. A future revision MAY add it once an implementation has demonstrated it.

## Error Codes

Standard v2 codes (`insufficient_funds`, `invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`, `unexpected_verify_error`, `unexpected_settle_error`, `settlement_pending`) apply. Scheme-specific values:

| Code | Rule | Meaning |
| --- | --- | --- |
| `invalid_exact_galachain_x402_version` | 1 | `x402Version` is not 2 |
| `unsupported_scheme` | 1 | scheme is not `exact` |
| `network_mismatch` | 1 | networks disagree or are unsupported |
| `invalid_exact_galachain_unsupported_asset_transfer_method` | — | `extra.assetTransferMethod` is not `transfer-token` |
| `invalid_exact_galachain_payload_missing_dto` | 2 | `payload.dto` absent or not an object |
| `invalid_exact_galachain_payload_missing_signer_public_key` | 2 | `payload.signerPublicKey` absent |
| `invalid_exact_galachain_payload_missing_signature` | 2 | `dto.signature` absent |
| `invalid_exact_galachain_payload_signature` | 3 | signature does not verify for `signerPublicKey` |
| `invalid_exact_galachain_from_mismatch` | 4 | `dto.from` is not the signer |
| `invalid_exact_galachain_missing_unique_key` | 5 | `dto.uniqueKey` absent |
| `invalid_exact_galachain_pay_to_mismatch` | 6 | `dto.to` is not `payTo` |
| `invalid_exact_galachain_asset_mismatch` | 7 | token class is not `asset` or is unsupported |
| `invalid_exact_galachain_asset_instance_mismatch` | 7 | `tokenInstance.instance` is not `"0"` |
| `invalid_exact_galachain_quantity` | 8 | `dto.quantity` is malformed or has too many decimals |
| `invalid_exact_galachain_amount_mismatch` | 8 | atomic quantity is not `amount` |
| `invalid_exact_galachain_missing_expiry` | 9 | `dto.dtoExpiresAt` absent |
| `invalid_exact_galachain_expired` | 9 | `dtoExpiresAt` is in the past or inside the safety margin |
| `invalid_exact_galachain_requirements_timeout` | 9 | `maxTimeoutSeconds` is not a finite number |
| `invalid_exact_galachain_expiry_mismatch` | 9 | `dtoExpiresAt` exceeds `maxTimeoutSeconds` |
| `invalid_exact_galachain_dry_run_failed:<ErrorKey>` | 10 | `DryRun` returned an error other than `PAYMENT_REQUIRED` |
| `invalid_exact_galachain_duplicate` | settle | `uniqueKey` already consumed; `transaction` names the original |

## Security Considerations

1. **Facilitator safety.** The facilitator has no key and no account on the payment path. The signed DTO debits only the signer, for `amount` plus the chain fee. There is no sponsorship to abuse and no gas to drain.
2. **Authorization scope.** The signature covers every DTO field. `to`, `tokenInstance`, `quantity`, `uniqueKey` and `dtoExpiresAt` cannot be changed by the facilitator or the resource server without invalidating the signature (rule 3), and rules 6–8 pin them to the requirements. A resource server that changes its price after issuing requirements gets a payload that fails rule 8.
3. **Replay.** `uniqueKey` is authoritative on chain. A settled DTO cannot settle twice; the second attempt fails with a conflict and burns nothing. Nothing needs to be remembered off chain after settlement. Resource servers SHOULD still refuse to serve twice for one `transaction`.
4. **Duplicate delivery.** Resubmission is distinguishable at the gateway (409 with the original transaction id), so a resubmitted payload cannot cause a second success and the deduplication requirement of `scheme_exact.md` for indistinguishable methods does not apply.
5. **Anyone holding the signed DTO can submit it.** As with any facilitator-submitted method, the payload is a bearer instrument for exactly this transfer. A resource server that receives it at `/verify` could submit it directly to the gateway and withhold the resource. The client's exposure is bounded to `amount` plus one fee per signed DTO, and by `maxTimeoutSeconds` in time. Clients SHOULD cap `maxTimeoutSeconds` they will sign and SHOULD NOT re-sign for the same resource while an earlier authorization is unresolved.
6. **Validity window.** The chain enforces `dtoExpiresAt`; the facilitator enforces that it does not exceed `maxTimeoutSeconds` (rule 9). Without rule 9 a resource server could request a multi-year window and settle at leisure.
7. **Verify/settle race.** Payer balance can change between `DryRun` and `TransferToken`. The outcome is a clean settlement failure (`insufficient_funds`) with no fee burned, because a failed Fabric transaction writes nothing. The facilitator loses nothing; the resource server has served a resource it will not be paid for, which is inherent to the `authorization` flow.
8. **Settlement atomicity.** One Fabric transaction performs the debit, the credit, and the fee. It either commits whole or writes nothing; there is no partial state and no soft failure with a success status.
9. **Fee floor.** The `TransferToken` fee (1 GALA on mainnet at time of writing) is paid by the payer on top of `amount`. Payments much smaller than the fee are fee-dominated; resource servers pricing micropayments SHOULD account for this.

Invariants:

| ID | Invariant | Enforced by |
| --- | --- | --- |
| I1 | The facilitator is never debited | It holds no key and appears in no DTO field |
| I2 | `payTo` is credited exactly `amount` of `asset` | Rules 6–8 over signed fields; one transfer per DTO |
| I3 | Only the signer is debited, by `amount` plus the fee | Rule 4; chain fee gate debits the signer |
| I4 | One `uniqueKey` settles at most once | On-chain uniqueness; consumed key is a settlement failure |
| I5 | No signed payment outlives `maxTimeoutSeconds` (plus skew) | Rule 9 at verification; `dtoExpiresAt` on chain |
| I6 | Settlement success means the transfer committed | Fabric transaction atomicity; `Status: 1` only on commit |

## Implementer Notes

- **Signing.** Use `signatures.getSignature(dto, privateKey)` and `signatures.isValid(signature, dto, publicKey)` from `@gala-chain/api` rather than reimplementing the serialisation; key ordering and BigNumber handling are part of the signed bytes.
- **Address derivation.** `payer` is `eth|` + `signatures.getEthAddress(publicKey)`. Compare aliases case-insensitively on the address part.
- **Quantity conversion.** `dto.quantity` is decimal token units; `amount` is atomic. Convert with `extra.decimals` using exact decimal arithmetic, and reject quantities with more fractional digits than `decimals`.
- **Dry run is unsigned.** The gateway rejects a signed DTO on `DryRun` ("The dto should have no signature"). Strip `signature` and pass the signer as `callerPublicKey`.
- **Success response shape.** Check `Status === 1` in the body in addition to the HTTP status.
- **Stateless facilitator.** Because replay is on chain and the facilitator signs nothing, a facilitator for this scheme can run with no persistent state and no secrets.

## Appendix

### Gateway endpoints used

All under `<gateway>/asset/token-contract/`:

| Endpoint | Body | Used for |
| --- | --- | --- |
| `POST DryRun` | `{ "method": "TransferToken", "callerPublicKey": "<hex>", "dto": <unsigned dto> }` | Verification rule 10 |
| `POST TransferToken` | the signed `TransferTokenDto` | Settlement |
| `POST FetchBalances` | `{ "owner": "<alias>", "collection", "category", "type", "additionalKey" }` | Optional balance display / receipts |

Responses are `{ "Status": 1, "Data": ... }` on success and `{ "Status": 0, "error": { "ErrorKey", "Message", ... } }` on failure; HTTP status mirrors the error class (402 for `PAYMENT_REQUIRED`, 409 for `UNIQUE_TRANSACTION_CONFLICT`).

### Measured behaviour (GalaChain mainnet, 2026-09-29)

Reference implementation and receipts: [bnskaggs/x402-galachain](https://github.com/bnskaggs/x402-galachain).

- End-to-end `authorization` flow through the stock `@x402/core` 2.27 plugin interfaces with no core changes: HTTP 200, transaction `9fc797fda6a98926ec974a24ca1fa6f2b5603a131a5a637f53d815d70ffff419`, payer −2 GALA (1 payment + 1 fee), payee +1 GALA.
- Resubmitting a settled DTO: HTTP 409, `UNIQUE_TRANSACTION_CONFLICT`, message names the original transaction id, payer balance unchanged.
- Two concurrent submissions of one DTO: exactly one settled.
- Adversarial resource servers (take-and-run, price change, double settle, concurrent replay, pay-to swap, long validity window): every scenario resolved as this specification predicts; the naive stock client lost only what it had signed for, and a client enforcing rule 9 and its own pay-to/price pins lost nothing beyond fair payments.

### Known limitations

- The reference implementation supports the GALA token class only; the scheme itself is written for any fungible GalaChain token class.
- The `galachain` CAIP-2 namespace is proposed, not yet accepted; the network identifiers could change on editor feedback.
- The transaction-id gap on success is a gateway behaviour, not a chain property.
