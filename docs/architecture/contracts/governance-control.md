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
  - packages/operator/src/governed-plan-shadow.ts
  - services/governance-control/docs/api/openapi.yaml
---

# Governance Control Contract

Status: GS4 contract freeze and credential-free Go read model implemented; GS5 adds a durable Go
shadow for TypeScript-authored plan, confirmation, and audit observations. GS6 mutation receipts
and authority transfer are not implemented.

## Authority boundary

`@openslack/operator` remains the sole writer, plan compiler, confirmation authority, execution
claim owner, and mutation dispatcher. The runtime store remains:

```text
.openslack.local/operator/governed-plans
```

Memory Bank is governance and documentation context. It is not a runtime plan store and grants no
mutation authority. The GS5 `services/governance-control` runtime has a separate PostgreSQL shadow
namespace and bounded internal HTTP observation route. It has no credential, Qoder, GitHub,
Workflow, confirmation-capability, or action-execution authority. A shadow receipt records only
observational acceptance and parity; it cannot authorize or complete a governed mutation.

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

## GS5 durable shadow

The TypeScript authority emits a closed `openslack.governance_shadow_observation.v1` envelope with
`authority: typescript`. Each envelope binds one canonical `record`, `confirmation`, or `audit`
observation to the exact workspace, plan, and positive `sourceSequence`. TypeScript remains the
only sequence issuer. Go accepts no caller-selected authority and does not read the authoritative
runtime plan store.

The idempotency key is derived from the exact canonical envelope bytes. The request fingerprint
additionally binds the HTTP method and path, TypeScript authority, workspace, plan, source sequence,
and exact body. Same-key/same-fingerprint replay returns the original durable shadow receipt;
same-key/different-fingerprint and sequence gaps fail closed. A semantic transition or parity
mismatch is durably accepted as observational evidence with `parity: mismatched` and a bounded
code, without advancing the matched record head. `reconciliation_required` is reserved for an
unknown database commit outcome and never means that parity was evaluated as mismatched.

Confirmation observations contain only `presentedTokenHash`, the TypeScript authority outcome, and
the bounded current binding hashes needed for differential recomputation. The raw confirmation
capability is forbidden from the envelope, HTTP configuration, receipts, projections, logs, and
durable shadow rows. Go can report whether its recomputation matches TypeScript; it cannot consume
the capability, claim execution, or dispatch an action.

The TypeScript observation port journals source-ordered canonical envelopes outside the runtime
plan store and publishes them asynchronously. Shadow unavailability, timeout, mismatch, response
loss, or journal recovery never changes the TypeScript user response, authoritative record,
approval state, audit decision, or external effect. Restart recovery replays only the observation
journal and surfaces durable Go shadow receipts; it does not retry a governed mutation.

## Qualification and evidence ceiling

`bun run governance:golden -- --check` regenerates the TypeScript authority in memory and rejects
stale or unexpected generated files. Go golden tests replay canonicalization, hashing, opaque-hash
comparison, all eight states, calendar-overflow v1 timestamps, read projections, binding drift,
canonical byte envelopes, audit types, opaque bounds, and invalid state.

The reviewed Go workspace verifier classifies this module as
`capabilities=database,distribution,http-openapi,prometheus` with runtime profile
`governance-control-v1`. Its GS5 qualification uses an isolated PostgreSQL database and network,
replays idempotency/fingerprint, OCC, confirmation, expiry/drift, audit correlation, conflict,
response-loss, and reconciliation cases, then restarts PostgreSQL on the same owned volume and
verifies durable state from a new process. The built image must pass exact live, ready, and version
response smoke in addition to OpenAPI, Prometheus, SBOM/source-manifest, image, and common race
gates.

Passing these gates proves only a local or hosted GS5 durable shadow, according to where they ran.
It does not prove Go mutation acceptance, a second or replacement writer, GS6 durable mutation
receipts, Qoder mutation cutover, authenticated Desktop, `QODER_VERIFIED`, remote MCP, release,
live, or production readiness.
