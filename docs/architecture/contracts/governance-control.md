---
schema: openslack.document.v1
id: contract-governance-control
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-08-02
sources:
  - docs/architecture/ts-to-go-migration-roadmap.md
  - packages/operator/contracts/governed-plan/v1/manifest.json
---

# Governance Control Contract

Status: GS4 contract freeze and credential-free Go read model implemented; GS5 shadow state and
GS6 mutation receipts are not implemented.

## Authority boundary

`@openslack/operator` remains the sole writer, plan compiler, confirmation authority, execution
claim owner, and mutation dispatcher. The runtime store remains:

```text
.openslack.local/operator/governed-plans
```

Memory Bank is governance and documentation context. It is not a runtime plan store and grants no
mutation authority. `services/governance-control` is currently a pure Go module: it has no
filesystem store, database, HTTP server, credential, Qoder, GitHub, Workflow, or action-execution
capability.

## Frozen v1 artifacts

The TypeScript authority generates exact-byte artifacts under
`packages/operator/contracts/governed-plan/v1/` and mirrors them under
`services/governance-control/internal/contractmirror/generated/v1/`:

```text
governed-action-plan.v1.schema.json
governed-plan.v1.schema.json
governed-plan-audit.v1.schema.json
governed-plan-read-model.v1.schema.json
golden-vectors.json
manifest.json
```

The manifest freezes the schemas, states, state transitions, audit types, errors, limits, runtime
store, authority boundary, and algorithms. It hashes every schema and golden-vector file. Go tests
require the source and mirror bytes and their declared SHA-256 digests to match exactly.

The four JSON Schemas are closed structural prefilters, not complete semantic validators. Standard
JSON Schema cannot express UTF-8 byte counts, total node/depth budgets, ECMAScript UTF-16 edge
cases, exact canonical bytes, binding-hash recomputation, or the complete timestamp acceptance
domain. Callers must run the TypeScript or Go semantic validator after Schema validation; the
manifest freezes this requirement and the omitted semantic constraints explicitly.

## Canonical record and bindings

Governed JSON accepts only bounded, inert JSON. Objects reject accessors, proxies,
prototype-pollution keys, duplicate decoded keys, invalid UTF-8, BOMs, non-finite numbers, excess
depth, excess nodes, oversized containers, and oversized strings or keys.

Canonical JSON uses ECMAScript number/string behavior and UTF-16 code-unit object-key ordering.
Because this freezes the existing v1 authority instead of silently changing it, escaped lone
UTF-16 surrogates remain accepted and are emitted as `\uXXXX`; raw malformed UTF-8 record bytes are
rejected before JSON decoding. Opaque capability bounds are measured in ECMAScript UTF-16 code
units, matching the existing TypeScript behavior.
The stable bindings are:

```text
inputHash              = sha256(canonical(input))
planHash               = sha256(canonical(action plan))
sourceVersionHash
permissionSnapshotHash
actionCatalogHash
executorBindingHash
buildNonceHash
processNonceHash
confirmationTokenHash  = sha256(one-time opaque capability)
```

Only the token hash is persisted. The raw confirmation capability remains root-response-only.
Persisted record bytes are exact canonical UTF-8 plus one LF.

## State and CAS contract

The closed state graph is:

```text
pending -> executing -> succeeded
          |          -> blocked
          |          -> failed
          |          -> reconciliation_required
          -> cancelled
          -> expired
```

More precisely, only `pending` may transition to `executing`, `cancelled`, or `expired`; only
`executing` may transition to the four execution-terminal states. Every store mutation binds
`planId + expectedRevision`. An execution claim additionally binds the exact `executionId` and may
be won once. GS4 validates this frozen behavior but does not implement a second writer.

## Credential-free read model

The Go projection exposes identity, state, kind, goal, actor/workspace/correlation, timestamps,
action/effect counts, input/plan hashes, and bounded execution summary. It intentionally omits:

```text
confirmationTokenHash
sourceVersionHash
permissionSnapshotHash
actionCatalogHash
executorBindingHash
buildNonceHash
processNonceHash
raw plan input, action inputs, outcome data
```

`confirmationBound: true` says the validated source record contains a confirmation binding; it
does not disclose or recreate that capability. The Go `Record` is opaque, and projection
revalidates its private canonical root before setting this flag, so callers cannot construct an
unvalidated record that claims a confirmation binding.

## Qualification and evidence ceiling

`bun run governance:golden -- --check` regenerates the TypeScript authority in memory and rejects
stale or unexpected generated files. Go golden tests replay canonicalization, hashing, opaque-hash
comparison, all eight states, calendar-overflow v1 timestamps, read projections, binding drift,
canonical byte envelopes, audit types, opaque bounds, and invalid state.
The reviewed Go workspace verifier classifies this module as `capabilities=pure`.

Passing these gates proves a local contract/read-model implementation only. It does not prove a Go
durable store, shadow plan state, Qoder mutation acceptance, remote MCP, authenticated Desktop,
release, live, or production readiness.
