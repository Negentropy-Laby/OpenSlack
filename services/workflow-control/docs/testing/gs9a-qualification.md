# GS9-A Qualification

GS9-A is a pure contract qualification. Its local gate must prove that the TypeScript-owned
Workflow Control authority v2 bundle and its generated Go mirror are byte-identical and that both
implementations agree on every frozen positive and negative vector.

## Frozen inventory

The TypeScript authority bundle and generated Go mirror each contain exactly these six files:

```text
schemas/workflow-control-authority-state.v2.schema.json
schemas/workflow-control-authority-message.v2.schema.json
schemas/workflow-control-authority-prepared-message.v2.schema.json
schemas/workflow-control-authority-receipt.v2.schema.json
golden-vectors.json
manifest.json
```

The manifest locks the first five artifacts by byte length and SHA-256, then locks the closed
six-file inventory through `bundleFiles`. The golden file contains one authority state, eight
prepared protocol-message cases, two receipt cases, two transition cases, three quantity cases,
three USD-to-`nano_usd` conversion cases, seven negative cases, and the four unchanged v1 artifact
hashes. This inventory is deliberately deterministic and finite; GS9-A makes no randomized-vector
claim.

The focused TypeScript suite contains 15 cases and additionally validates all four schemas as
closed schemas against their corresponding runtime-positive values. The Go package contains 12
top-level tests across `bundle_test.go`, `golden_test.go`, `invariants_test.go`, `json_test.go`,
`quantity_test.go`, and the external-consumer `consumer_import_test.go`. It replays the complete
finite golden inventory, verifies source/mirror bytes and manifest locks, exercises closed
decoders and cross-field fail-closed bindings, and keeps `AuthorityClaim == "NO_AUTHORITY"`
executable.

The required vector families cover:

1. run-state revision/CAS independently from GS8 attempt/lease/fencing identity;
2. immutable authority route and positive safe-integer routing epoch;
3. distinct legacy run-gate and workflow-effect approval v2 planes;
4. checkpoint commit identity, phase ordering, exact replay, and fingerprint conflict;
5. resume-generation advancement and stale-generation rejection;
6. cumulative budget reservation/settlement with canonical decimal strings bounded by
   `9223372036854775807`, `nano_usd` scale 9, `half_up_nonnegative` conversion, overflow, and
   concurrent-reservation boundaries; and
7. all 12 retained v1 kinds plus `checkpoint_commit`, `budget_reserve_request`,
   `budget_usage_report`, `budget_authorization`, `effect_authorization`, and `resume_offer` as the
   six added `openslack.workflow_runner.v2` kinds without changing v1 bytes; and
8. v2 `hello` / `hello_ack` negotiation plus the closed durable-receipt operation vocabulary,
   without a runtime negotiation or delivery claim.

Source/mirror manifest parity, schema closure, canonical bytes, duplicate-key rejection, bounds,
error codes, hashes, and the finite golden inventory are part of the same gate. Any byte, hash,
transition, arithmetic, approval-plane, or error-code difference fails qualification.

## Local gate

Run the generator in check mode so it cannot silently bless drift, then run the focused
TypeScript and Go suites:

```bash
bun run workflow:authority-golden -- --check
bunx vitest run packages/workflows/src/__tests__/workflow-control-authority-contract.test.ts

cd services/workflow-control
GOWORK=off go test -race ./authoritycontract -count=1
```

`LOCAL_PASS` may be recorded only when all three commands succeed against the same checkout. A
normal generation run is an authoring operation, not qualification evidence.

Passing this gate is `GS9-A LOCAL_PASS`. TypeScript remains the sole Workflow Control writer and
user-visible read authority. The v2 protocol bytes and validators are frozen, but no PostgreSQL
authority migration, HTTP mutation route, v2 runtime negotiation/delivery, new-record route,
effect execution, budget enforcement, checkpoint/resume execution, canary, or rollback is
exercised. Consequently Go authority is `NOT_CLAIMED`; hosted CI, review state, independent
approval, live deployment, release, and production readiness remain separate evidence.
