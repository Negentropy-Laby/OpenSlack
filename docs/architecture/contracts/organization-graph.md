---
schema: openslack.document.v1
id: contract-organization-graph
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-08-02
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Organization Graph Contract

Status: composite graph and governed local rehearsal implemented; live qualification pending.
Organization Graph is a pure, bounded, rebuildable projection. Its v1 data, hashing, query,
explanation, local-store behavior, software-delivery projector, and Contract-to-Delivery Lite
composite projector are implemented. The application-layer rehearsal assembler calls the sealed
builder explicitly after durable governed evidence. Query and explain never create or change Graph
authority state; an explicitly enabled GS3-A read mirror may append only a bounded observational
Collaboration audit event after the TypeScript result has been computed. Live multi-system source
assembly and the HTML artifact remain deferred.

## Authority Model

Graph never becomes a system of record. Its composition adapter receives typed, bounded source
snapshots from GitHub, workflow runs, Agent Runtime, PRMS, Collaboration, notification evidence,
and versioned demo fixtures. The pure graph package does not call Octokit, parse CLI output, read
PRMS directly, or perform business mutations.

Every node identifies its authority:

```ts
interface AuthorityRef {
  provider: 'github' | 'openslack' | 'demo_fixture' | 'dingtalk' | 'crm' | 'erp' | 'hr';
  objectType: string;
  objectId: string;
  version: string;
  observedAt: string;
}

interface ActorRef {
  id: string;
  kind: 'human' | 'agent' | 'system';
  displayName?: string;
}
```

`demo_fixture` is visibly non-live. It cannot be reported as observed external authority.

## Snapshot and Delta

The v1 graph uses closed JSON Schemas for:

```ts
interface GraphNode {
  id: string;
  type: string;
  scenarioDefinitionId: string;
  scenarioInstanceId: string;
  title: string;
  status?: string;
  authorityRef: AuthorityRef;
  owners: ActorRef[];
  properties: Record<string, unknown>;
  sourceEventIds: string[];
  evidenceRefs: string[];
  projectorVersion: string;
  validFrom: string;
  validTo?: string;
}

interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  scenarioInstanceId: string;
  authorityRef?: AuthorityRef;
  sourceEventIds: string[];
  evidenceRefs: string[];
  projectorVersion: string;
  validFrom: string;
  validTo?: string;
}

interface GraphCompleteness {
  sourcesRequested: string[];
  sourcesObserved: string[];
  missingSources: string[];
  warnings: string[];
}

interface GraphSnapshot {
  schema: 'openslack.graph_snapshot.v1';
  cursor: string;
  scenarioInstanceId: string;
  generatedAt: string;
  projectorVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  completeness: GraphCompleteness;
  integrityHash: string;
}

interface GraphDelta {
  schema: 'openslack.graph_delta.v1';
  scenarioInstanceId: string;
  fromCursor: string;
  toCursor: string;
  generatedAt: string;
  upsertNodes: GraphNode[];
  closeNodeIds: string[];
  upsertEdges: GraphEdge[];
  closeEdgeIds: string[];
  evidenceRefs: string[];
  integrityHash: string;
}
```

Stable IDs derive from scenario instance, graph type, and authority object identity. Source removal
closes a node or edge through a delta; it does not erase history silently.
Graph Delta v1 models one validity interval per stable ID: an upsert cannot reopen a node or edge
whose `validTo` is already set. A future multi-interval schema must represent any reopen explicitly
without overwriting the closed interval.

## Canonicalization and Integrity

Canonicalization:

1. validates the closed schema and fatal UTF-8;
2. validates dates, IDs, AuthorityRefs, and scenario scope;
3. bounds and secret-scans `properties`;
4. deduplicates and sorts source/evidence references;
5. sorts nodes and edges by stable ID;
6. recursively orders object keys;
7. serializes canonical JSON without platform paths or locale ordering.

`integrityHash` is `sha256:<lowercase hex>` over canonical JSON excluding only `generatedAt` and
`integrityHash`. A generated-time change alone leaves the hash unchanged; a source cursor,
authority version, completeness finding, node, edge, or property change alters it.

The implementation must produce the same hash on Windows and Linux for identical contract values.
It does not normalize authority object IDs or arbitrary strings as filesystem paths.

## Completeness

A requested source that cannot be read, authenticated, bounded, or proven current appears in
`missingSources` or `warnings`. It never becomes a fabricated empty authoritative dataset.

Current-head claims require a matching authority version:

- GitHub review and check nodes bind to the PR head SHA they evaluated;
- PRMS readiness binds to the report's base/head evidence;
- workflow and Agent Run nodes bind to versioned run records;
- notification delivery binds to a receipt/reconciliation version;
- demo facts bind to a versioned fixture hash.

Cached or synthetic projections can be informational nodes only. They never become PRMS, review,
merge, or external delivery authority.

## Query Contract

Hard maximums:

| Dimension                            | Maximum |
| ------------------------------------ | ------: |
| graph depth                          |       3 |
| nodes                                |     200 |
| edges                                |     500 |
| response bytes                       | 512 KiB |
| property depth                       |       8 |
| keys per property object             |      64 |
| items per property array             |     200 |
| evidence references per node or edge |      50 |

Queries are scenario-scoped and deterministic. Output reports truncation and applies canonical
ordering. Pagination cursors are opaque, expiring, and bound to the normalized query hash; a cursor
cannot be reused for a different scenario, filter, root, depth, or limit.

`explain` returns only bounded authority, source event IDs, evidence references, projector version,
validity, and completeness. It never returns raw transcripts, webhook payloads, vendor bodies, or
credentials.

### GS3-A mirror-read boundary

GS3-A can explicitly mirror successful MCP `query` and `explain` calculations to the Go Graph
service while returning only the TypeScript result. The mirror is disabled by default and cannot
be inferred from environment state. Its HTTP client:

- accepts only an exact credential-free IP-literal HTTP origin; loopback is the default and
  private/link-local addressing requires the explicit `internal` mode;
- posts the canonical input to the fixed `/v1/graph:query` or `/v1/graph:explain` route with manual
  redirect handling, a 2-second default/30-second hard timeout, and the existing 512 KiB response
  ceiling;
- accepts only strict canonical JSON, rejects duplicate keys, BOMs, unexpected content types,
  non-200 responses, and oversized bodies, and compares every result field;
- treats pagination cursor presence and token differences as parity failures. A future issuer
  change must use the reviewed routing-epoch and TTL-drain design, never implicit translation;
- records only request/result SHA-256 digests, bounded difference codes, timing, scenario ID,
  cursor/query hashes, and outcome. It does not persist the service endpoint, request body, graph
  nodes/edges, target payload, evidence, or source event contents.

A mirror mismatch, timeout, invalid response, network failure, or audit-sink failure cannot replace
or modify the TypeScript result and does not cause a per-request fallback because no cutover has
occurred. Audit-sink failure emits only the fixed
`OPENSLACK_GRAPH_READ_MIRROR_AUDIT_FAILED` stderr diagnostic so operators can distinguish audit
damage from the absence of a mismatch. The audit append is observational evidence, not Graph or
business-state mutation.

### GS3-B bounded canary boundary

GS3-B adds a second, default-off route that is authoritative only for an exact process-start policy:

- the policy binds the canonical workspace ID, one to 16 exact scenario-instance IDs, one positive
  safe-integer routing epoch, one backend, and an expiry no more than seven days after startup;
- `go` requires one exact credential-free loopback or explicitly internal IP-literal origin plus a
  64-lowercase-hex expected service build SHA. Both epoch and build are sent and checked on every
  `/v1/canary/graph:query` or `/v1/canary/graph:explain` request and repeated in the closed response;
- selected Go requests never open the TypeScript local snapshot. Timeout, network, HTTP, strict or
  canonical JSON, schema, result-bound, build, epoch, cursor, or audit failure returns an explicit
  blocked MCP result and never invokes a per-request fallback;
- the returned snapshot `generatedAt` must pass the same read-freshness boundary as TypeScript:
  24 hours by default, configurable only within one minute to seven days, with at most five minutes
  of future clock skew. Stale evidence returns `SOURCE_EVIDENCE_STALE`; an invalid future time is
  rejected as an invalid canary response before a served audit can be committed;
- unselected scenarios continue using the TypeScript local store. Rollback requires a new explicit
  `ts-local` policy with a higher routing epoch; it is not inferred from Go health;
- ordinary query cursors retain the frozen v1 five-minute HMAC contract. Canary reads issue v2
  cursors that additionally bind the routing epoch. A v1 or cross-epoch token returns
  `GRAPH_QUERY_CURSOR_MISMATCH`; an expired same-epoch token returns
  `GRAPH_QUERY_CURSOR_EXPIRED`. No backend translates or accepts the other issuer's token;
- Collaboration records only operation, served/blocked/rolled-back outcome, backend, epoch, expected
  build SHA, latency, bounded code/status, and a request fingerprint. It never stores the origin,
  request body, raw cursor, graph objects, evidence, or source-event contents. A successful selected
  read is not returned if this audit evidence cannot be committed.

This canary does not change Graph-head or writer ownership. TypeScript projectors and the local
publication path still feed the Go store through the existing durable ingest contract. It also does
not change MCP tool names, input schemas, `openslack.mcp_result.v2`, the 12/16/17 profile counts,
Qoder Skill behavior, or any confirmation, workflow-effect, or human-attestation boundary.

### GS3-C global read-authority boundary

GS3-C is a separate all-scenario process policy, not an expanded canary allowlist:

- it binds one canonical workspace/tenant, positive routing epoch, expiry no more than seven days,
  exact credential-free Go origin, and 64-hex service build;
- the Go service independently requires the same epoch/build/tenant headers on dedicated authority
  ingest, query, and explain routes. These plaintext equality bindings are not authentication; the
  service remains restricted to the documented loopback or explicitly isolated internal network
  boundary, and public or remote authenticated transport remains deferred;
- TypeScript keeps deterministic projector calculation but publishes through a fail-closed port.
  Only an exact durable `accepted` or `duplicate` receipt completes publication; conflict, transport,
  invalid receipt, or `reconciliation_required` does not update a TypeScript authority copy or claim
  success;
- Go's PostgreSQL head is the only Graph head used by authority query/explain. MCP never opens the
  local snapshot while `backend=go` is active and never falls back per request;
- query cursors use the existing v2 HMAC contract bound to the global routing epoch. v1, expired, or
  cross-epoch tokens fail explicitly without translation;
- a successful Go read or explicit global `ts-local` rollback must commit a bounded redacted
  Collaboration event before the result is released;
- mirror, bounded canary, and global authority are mutually exclusive in one MCP process. Rollback
  requires a new global `ts-local` policy with a higher epoch;
- Go-authority and TypeScript-local publication are deliberately disjoint and never dual-write.
  Before activating that higher epoch, every active scenario must be reprojected from current
  bounded source evidence into the local CAS store and its local query/explain freshness verified.
  A missing or stale local snapshot blocks with `SOURCE_EVIDENCE_UNAVAILABLE` or
  `SOURCE_EVIDENCE_STALE`, records `graph.read_authority.blocked`, and cannot record
  `graph.read_authority.rolled_back`.

This authority is limited to the derived Organization Graph projection. It grants no source-system
mutation, Scenario/Workflow execution, Qoder identity, approval, GitHub review, remote transport,
live, release, or production authority.

## Local Store

The MVP store is:

```text
.openslack.local/graph/
  snapshots/
  deltas/
  cursors/
  locks/
```

The store:

- limits candidate bytes, directory entries, total bytes, and records before parsing;
- accepts fatal UTF-8 and strict JSON only;
- rejects BOMs, duplicate JSON keys, symlinks, traversal, alternate data streams, and non-regular
  files;
- performs realpath/containment and same-file checks before and after reads;
- on POSIX, uses `O_NOFOLLOW` where the platform provides it;
- on Windows, opens the path with
  [`FILE_FLAG_OPEN_REPARSE_POINT`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
  rejects reparse-point attributes, and compares handle-derived volume plus
  [`FILE_ID_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
  identity before and after the bounded read;
- fails closed when a platform cannot provide equivalent no-follow, regular-file, and stable
  handle-identity guarantees;
- writes with explicit modes through atomic temp-file, fsync, and rename;
- serializes updates with a per-scenario lock and compare-and-swap cursor;
- never publishes a cursor that references a partial snapshot or delta;
- verifies schema and integrity before returning stored content.

A stored file is evidence/cache, not authority. Rebuild and source comparison are required for
current claims.

## Projector Port

Projectors are registered by reviewed host code. A Scenario Pack may reference a registered
projector ID but cannot supply executable projector code or register one.

Each projector is deterministic and side-effect free:

```text
typed source snapshot + scenario definition/instance + projector version
  -> GraphSnapshot or GraphDelta
```

The first projector maps existing software-delivery evidence. Existing GitHub task, claim, watch,
PR, and merge behavior remains unchanged.

During GS2-A, the TypeScript Software Delivery projector remains the calculation authority. A pure
Go shadow receives the same bounded typed-source bytes and replays a generated exact-byte contract
bundle covering valid, missing, incomplete, `demo_fixture`, boundary, randomized, and invalid
inputs. Qualification compares the complete canonical Snapshot bytes, integrity hash, node and edge
identities, completeness, warnings, and fail-closed errors. The Go package has no external readers,
HTTP route, durable writer, Scenario registration, or Qoder integration, so this shadow does not
create a read cutover or an authority transfer.

GS2-B retains that boundary for the TypeScript Contract-to-Delivery projector. A second generated
bundle freezes the closed composite source schema, including its embedded Software Delivery schema,
and 43 historical, missing, incomplete, promotion-boundary, bridge-drift, ordering, bounded,
randomized, and invalid vectors. The Go `contracttodelivery` package accepts only caller-supplied
strict JSON, delegates the nested projection to the qualified pure Go `softwaredelivery` package,
and reproduces the full composite Snapshot bytes, integrity, identities, completeness, warnings,
and blocking errors. It does not read GitHub, Workflow, CRM, ERP, environment state, or a clock and
does not register an HTTP route, store writer, Scenario projector, MCP path, or Qoder cutover.
TypeScript remains the calculation and user-visible read authority.

GS3-A retains that authority while adding the opt-in MCP read mirror described above. Official MCP
SDK coverage proves that the stock 12-tool catalog and `openslack.mcp_result.v2` response remain
unchanged while matching Go query/explain observations are audited. The same optional port is
composed for 12-, 16-, and 17-tool profiles without changing their tool names, schemas, permission,
plan-confirmation, workflow-effect, or independent-human-attestation boundaries. GS3-A does not
select Go for any request, transfer Graph-head ownership, change the cursor issuer, or claim a
Qoder Desktop, remote Connector, release, live, or production qualification.

GS3-B keeps TypeScript as the default and unselected-scenario read authority but permits the exact
bounded canary policy above to return Go query/explain results. A hosted cross-language gate starts
the real Go handler and exercises query, explanation, v2 cursor continuation, v1 cursor rejection,
build-drift rejection, freshness rejection, and the explicit higher-epoch TypeScript rollback.
GS3-C adds the explicit global Graph-head/query/explain authority described above. Hosted
cross-language qualification must prove the full path from TypeScript projection through a durable
Go ingest receipt to authority query/explain, v2 cursor rejection across epochs, receipt replay,
reconciliation blocking, and explicit higher-epoch rollback. This is local repository evidence and
does not establish authenticated Desktop, live, release, or production qualification. The hosted
exact-head workspace verifier additionally runs `go test -race ./...`, covering the authority
handlers and their shared store access before this Red Zone change can merge.

## Related Documents

- [Organization Graph product contract](../../../design/cdd/workstreams/organization-graph/README.md)
- [Scenario Runtime product contract](../../../design/cdd/workstreams/scenario-runtime/README.md)
- [Scenario Pack v1](../../contributor/scenario-pack.md)
- [Collaboration Layer](../../../design/cdd/modules/collaboration.md)
