---
schema: openslack.document.v1
id: contract-governance-control
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-08-03
sources:
  - docs/architecture/ts-to-go-migration-roadmap.md
  - packages/operator/contracts/governed-plan/v1/manifest.json
  - packages/operator/contracts/governed-plan-authority/v1/manifest.json
  - packages/operator/src/governed-plan-shadow.ts
  - services/governance-control/docs/api/openapi.yaml
---

# Governance Control Contract

Status: GS4 contract freeze and credential-free Go read model implemented; GS5 adds a durable Go
shadow for TypeScript-authored plan, confirmation, and audit observations. GS6 freezes the
new-record authority route and moves durable record acceptance and transitions to Go only for
records explicitly routed to `go / governance-control`.

## Authority boundary

GS6 establishes one immutable authority route per governed-plan record:

```text
missing route or ts-local / typescript
  -> .openslack.local/operator/governed-plans is the sole durable writer

go / governance-control
  -> services/governance-control PostgreSQL is the sole durable writer
```

Existing records without a route remain `ts-local / typescript`; GS6 does not migrate them. A
higher routing epoch changes only newly accepted records and cannot rewrite a record's route.
There is no per-request fallback and no TypeScript/Go double write.

The Go host is fail-closed for new acceptance by default. Activation binds one active epoch, an
explicit `accept-new-records` switch, and a bounded allowlist of drain epochs. `accept` is available
only when `accept-new-records=true` and the request route equals the active epoch. Authority read,
receipt read, transition, and audit projection may address the active epoch or an explicitly listed
drain epoch, but must still match the record's persisted route. Rollback disables new acceptance,
moves the previous Go epoch into the drain allowlist, and routes only new records to TypeScript; it
never strands or reroutes an older Go record.

TypeScript remains the plan compiler, one-time confirmation token and binding validator, action
dispatcher, and Collaboration audit projector. Go owns only durable plan acceptance, CAS execution
claim, terminal transition, cancellation, expiry, and reconciliation state for a `go`-routed
record. A durable Go receipt is the handoff: after strict receipt validation, TypeScript never
writes that record to its local governed-plan store. Memory Bank remains governance and
documentation context, not a runtime plan store. Go receives neither raw confirmation capability
nor executable arbitrary action input and gains no Qoder identity, GitHub review, Workflow-effect,
or external-system authority.

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
Confirmation observations are decision-sequence evidence: `claim_eligible` may precede the
TypeScript execution-claim CAS and never asserts that execution authority was acquired.

The TypeScript observation port journals source-ordered canonical envelopes outside the runtime
plan store and publishes them asynchronously. Shadow unavailability, timeout, mismatch, response
loss, or journal recovery never changes the TypeScript user response, authoritative record,
approval state, audit decision, or external effect. Restart recovery replays only the observation
journal and surfaces durable Go shadow receipts; it does not retry a governed mutation.
When a process observes a confirmation or audit for a newer record revision, the journal places
that validated record prerequisite first and coalesces record revisions already journaled by
another process. This keeps dependent observations behind their record across process races.
The projection endpoint reads its head, matched record, and parity counts in one PostgreSQL
statement so every response represents one coherent database snapshot.

## GS6 durable authority contract

The independently versioned exact-byte bundle under
`packages/operator/contracts/governed-plan-authority/v1/` contains closed schemas for route,
accept, transition, durable receipt, and authority read, plus golden request/fingerprint/receipt
vectors and a hash manifest. It references, rather than changes, `openslack.governed_plan.v1`.
GS4 record bytes and GS5 shadow bytes remain frozen.

Accept uses `openslack.governance_authority_accept.v1`, `operation: accept`, and
`POST /v1/governance/plans:accept`. Transitions use
`openslack.governance_authority_transition.v1` and one exact operation/path pair:

| Body operation           | HTTP path                                              |
| ------------------------ | ------------------------------------------------------ |
| `claim_execution`        | `/v1/governance/plans/{planId}:claim-execution`        |
| `complete_execution`     | `/v1/governance/plans/{planId}:complete-execution`     |
| `cancel`                 | `/v1/governance/plans/{planId}:cancel`                 |
| `expire`                 | `/v1/governance/plans/{planId}:expire`                 |
| `require_reconciliation` | `/v1/governance/plans/{planId}:require-reconciliation` |

Every exact request body contains only `schema`, `operation`, `workspaceId`, `planId`,
`expectedRevision`, immutable `route`, and one canonical governed-plan v1 `record`. The required
headers are `Content-Type`, `Idempotency-Key`, `X-OpenSlack-Governance-Caller-ID`,
`X-OpenSlack-Governance-Workspace-ID`, `X-OpenSlack-Governance-Routing-Epoch`, and
`X-OpenSlack-Governance-Expected-Build-SHA`. Workspace is the tenant binding. Header/body scope,
canonical positive safe-integer epoch, expected build, route, plan, correlation, revision, state,
and record hashes must all agree. The Go API accepts only `go / governance-control`; the route
schema also represents `ts-local / typescript` so routing and rollback policy share one closed
contract.

The exact canonical body bytes, including one trailing LF, determine the idempotency key:

```text
openslack.governance-authority.v1. + SHA256(exactBodyBytes)
```

The idempotency digest intentionally excludes headers and path. The distinct request fingerprint
binds them:

```text
sha256:hex(SHA256(
  UTF8(method + "\n" + path + "\n" + callerId + "\n" + workspaceId + "\n"
       + canonicalEpoch + "\n" + expectedBuildSha + "\n")
  + exactBodyBytes
))
```

Same key and fingerprint returns the durable content of the original commit, with `duplicate`
identifying a replay; the same key with any different binding fails closed. An `accepted` or
`duplicate` receipt proves a committed record and therefore includes
`acceptedRevision`, `state`, exact `record`, matching `recordHash`, and canonical millisecond UTC
`committedAt`. A `reconciliation_required` receipt represents an unknown outcome. It includes only
the requested `targetRevision`, `targetState`, `recordHash`, and opaque `reconciliationToken`; it
must not invent `acceptedRevision`, `state`, `record`, `committedAt`, or proof that the write did or
did not commit. The bounded authority read is the only way to reconcile before another mutation.

### Bounded pending-audit recovery

Every accepted Go mutation atomically creates one pending audit delivery for its accepted revision.
The authority permits at most one pending delivery per plan, that delivery is always bound to the
current authority-head revision, and Go rejects the next transition until the current delivery has
been recorded. Normal projection first persists the exact Collaboration event in the bounded
TypeScript authority journal, appends it to Collaboration, and only then acknowledges the Go
delivery. If the process stops before the local journal exists, restart recovery scans only the
bounded immutable route sidecars, strictly loads the current plan through the authority read, and
performs one point read for that current revision:

```text
GET /v1/governance/plans/{planId}/authority-events/{revision}:pending
```

The request has no query or body and carries exactly the four governance binding headers: caller,
workspace, routing epoch, and expected build. A `200` response is exact canonical JSON plus LF with
only `schema`, `status: pending`, `workspaceId`, `planId`, `revision`, the original authority
mutation `operation`, immutable `route`, `recordHash`, and `serviceBuildSha`. It deliberately
contains no plan record, state, audit event, or caller-selected details. Recovery validates the
sidecar against the separately loaded current record, deterministically reconstructs the bounded
audit event, durably journals it, projects it once, and acknowledges it through the existing audit
record route.

The operation is one of `accept`, `claim_execution`, `complete_execution`, `cancel`, `expire`, or
`require_reconciliation`; it is not an audit event type. Lookup is the exact
`workspaceId + planId + revision` tuple. A missing or already recorded delivery returns the same
closed `404`; a persisted-route epoch mismatch returns `409`; invalid identity or binding returns
`422`; internal and unavailable storage return closed `500` and `503`. There is no unbounded list
endpoint, no record body in the sidecar response, no fallback to a TypeScript plan writer, and no
blind audit acknowledgement. Because a later transition cannot overtake a pending delivery, the
current-revision point read is complete: recovery never needs to search older revisions.

## Qualification and evidence ceiling

`bun run governance:golden -- --check` regenerates the TypeScript authority in memory and rejects
stale or unexpected generated files. Go golden tests replay canonicalization, hashing, opaque-hash
comparison, all eight states, calendar-overflow v1 timestamps, read projections, binding drift,
canonical byte envelopes, audit types, opaque bounds, and invalid state.

The reviewed Go workspace verifier classifies this module as
`capabilities=database,distribution,http-openapi,prometheus` with runtime profile
`governance-control-v2`. It retains all GS5 isolated PostgreSQL shadow bounds, restart, and image
smoke gates, then adds separate GS6 authority-cutover gates for accept, transition, duplicate,
strict fingerprint conflict, OCC/CAS, immutable route, response loss, reconciliation read, restart,
drain-only access, and image responses. Qualification explicitly sets
`GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true` for the active fixture epoch and registers a distinct
drain epoch; no default enables new Go writes. The built image must also pass exact live, ready, and
version response smoke
in addition to OpenAPI, Prometheus, SBOM/source-manifest, image, and common race gates.

The hosted GS6 cross-language gate starts an isolated pinned PostgreSQL instance and the real Go
authority, then launches `scripts/governance-control-contracts/gs6-mcp-client.ts`. That client uses
the production `mcpCommands`, production agent-bound composition, and the official MCP SDK
`InMemoryTransport`; it requires the exact 16-tool catalog, performs Scenario preview and confirm,
reads the terminal plan through the production Go HTTP port, verifies the immutable Go route, and
proves that the TypeScript local governed-plan store contains zero records before and after every
mutation. The Go test strictly decodes the client's closed
`openslack.gs6_mcp_authority_qualification.v1` receipt. No mocked composition or Go transport can
satisfy this gate, and the exact named test runs with `OPENSLACK_GS6_CROSS_LANGUAGE=1` so a skip is
not accepted as qualification.

Passing these gates proves only the local or hosted GS5 shadow and GS6 new-record Go-writer path,
according to where each gate ran. It does not prove authenticated Qoder Desktop,
`QODER_VERIFIED`, remote MCP/OAuth, live deployment, release, production activation, old-record
migration, or TypeScript writer deletion.
