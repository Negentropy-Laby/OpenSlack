---
schema: openslack.document.v1
id: contract-organization-graph
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-29
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Organization Graph Contract

Status: composite graph and governed local rehearsal implemented; live qualification pending.
Organization Graph is a pure, bounded, rebuildable projection. Its v1 data, hashing, query,
explanation, local-store behavior, software-delivery projector, and Contract-to-Delivery Lite
composite projector are implemented. The application-layer rehearsal assembler calls the sealed
builder explicitly after durable governed evidence; query and explain remain side-effect free.
Live multi-system source assembly and the HTML artifact remain deferred.

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

## Related Documents

- [Organization Graph product contract](../../../design/cdd/workstreams/organization-graph/README.md)
- [Scenario Runtime product contract](../../../design/cdd/workstreams/scenario-runtime/README.md)
- [Scenario Pack v1](../../contributor/scenario-pack.md)
- [Collaboration Layer](../../../design/cdd/modules/collaboration.md)
