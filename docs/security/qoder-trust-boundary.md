# Qoder Work Trust Boundary

Status: planned security contract. The current shipped boundary is the nine-tool, read-only STDIO
server documented in [Qoder Work MCP integration](../developer/qoder-mcp.md). This document defines
the additional invariants required before graph and mutation milestones.

## Security Position

Qoder Work is a user interface and tool selector. It is not an OpenSlack policy engine, identity
provider, plan authority, workflow approval store, GitHub reviewer, or business system of record.

The trust chain is:

```text
Qoder intent
  -> strict MCP tool input
  -> OpenSlack projection or canonical preview
  -> bound OpenSlack principal and current policy
  -> existing governed package API
  -> authoritative external system
```

No statement in Qoder conversation memory, Skill instructions, Skill UI state, IM, or a generated
HTML artifact can replace current OpenSlack/GitHub evidence.

## Decisions That Must Remain Separate

| Decision                           | Authority                             | What it permits                     |
| ---------------------------------- | ------------------------------------- | ----------------------------------- |
| Qoder connector/tool permission    | Qoder user/environment                | one MCP call attempt                |
| OpenSlack plan confirmation        | bound OpenSlack principal             | exact immutable canonical plan      |
| OpenSlack workflow-effect approval | authorized workflow approver          | one pending workflow effect         |
| GitHub human review                | authorized non-author GitHub identity | repository review/approval evidence |

The terms map to the canonical [Approval vocabulary](../product/approval-vocabulary.md): plan
confirmation is **Approve Plan**; workflow-effect approval is **Confirm Operation**, or **Confirm
Merge** for a merge effect; and GitHub human review is **GitHub Review Approval**. Qoder
connector/tool permission is authorization, not an approval action. A current-head GitHub approval
may also carry a `Workflow-Trust` marker for workflow governance; the marker is a facet of the
fourth decision, not a fifth decision.

An agent or bot cannot originate the fourth decision. GitHub review must be current-head,
non-author, policy-valid evidence; MCP never emits an approval token for it.

## STDIO Actor Boundary

STDIO authenticates neither the desktop user nor an enterprise identity. Read calls use a fixed
transport actor. Mutation mode is disabled unless server startup binds one active OpenSlack
principal, workspace, and permission snapshot.

An agent principal cannot decide a human-owned workflow effect. The
`openslack_decide_workflow_approval` tool is registered only with a separately host-attested,
authorized human binding; otherwise it is absent or returns `blocked`. A Qoder permission prompt,
IM sender label, or client-provided actor string is not that attestation.

Client arguments cannot select an actor, installation identity, workspace root, capability,
approval source, or collision-prone correlation ID. Missing or stale binding fails closed.

The server does not widen the kernel provider enum merely to label MCP provenance. It records
bounded transport metadata while the existing runtime identity remains authoritative.

## Threats and Controls

| Threat                                                      | Required control                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Prompt injection requests a shell or direct GitHub mutation | explicit tool catalog; no generic dispatcher                         |
| Qoder invents executable plan steps                         | OpenSlack rebuilds a canonical plan from sealed registries           |
| Client replays or edits confirmation                        | actor/workspace/hash/expiry/source binding and atomic single claim   |
| Client claims another correlation                           | server-generated collision-resistant correlation ID                  |
| Skill or UI fabricates authority                            | evidence-labelled result envelope; authority sources are typed       |
| Oversized graph floods model context                        | depth/item/byte limits, deterministic truncation, query-bound cursor |
| Raw evidence leaks secrets                                  | bounded projection, secret scan, no raw transcripts/vendor bodies    |
| Stale PR review is presented as approval                    | current-head PRMS evidence required                                  |
| Missing source appears as success                           | explicit blocked/unknown and completeness gaps                       |
| STDIO diagnostics corrupt JSON-RPC                          | stdout frames only; diagnostics on stderr                            |
| Local reset deletes live objects                            | demo-only registration and fixture-root containment                  |

## Tool and Output Boundary

MCP tools are explicit, sealed, schema-bounded package functions. The server never:

- forwards arbitrary commands to Operator;
- executes CLI and parses stdout;
- imports private CLI command modules;
- exposes shell, policy, permission, registry, approval, or direct-merge tools;
- returns credentials, tokens, arbitrary source prose, webhook payloads, or vendor bodies.

Structured and text MCP content derive from the same sanitized object. Evidence references are
bounded identifiers, not data-bearing escape hatches.

## Canonical Mutation Boundary

Mutation input selects a registered scenario/workflow and supplies bounded business inputs.
OpenSlack resolves:

- definition and registry hashes;
- target repository and current source/head versions;
- active principal and granted capabilities;
- effect manifest, risk, owner, and human gates;
- one immutable ActionPlan and plan hash.

Confirmation revalidates every binding immediately before a single execution claim. Expiry, drift,
replay, partial failure, and ambiguous remote outcomes require reconciliation and a new preview.

No direct MCP action approves or merges a GitHub PR. Existing PRMS and Merge Steward remain the
only merge path.

## Transport Evolution

The interview MVP is local STDIO. A remote Streamable HTTP/SSE Connector is a separate product
boundary requiring HTTPS, OAuth 2.0, revocable scopes, subject-to-principal mapping, health checks,
privacy/terms, and deployment qualification.

Remote transport must preserve every catalog, schema, canonical-plan, authority, and approval
invariant here. OAuth permission does not become OpenSlack workflow or GitHub approval.

## Qualification and Non-Claims

Local tests prove only local contract behavior. `QODER_VERIFIED` requires a named Qoder desktop
build to initialize, list the exact catalog, and call every required read tool with bounded,
credential-free evidence.

It does not prove:

- Scenario rehearsal or live GitHub delivery;
- public Connector publication;
- formal Qoder Workbench qualification;
- DingTalk writeback;
- Notification Delivery admission, release, vendor delivery, or live verification.

## Related Documents

- [Qoder product boundary](../product/qoder-work-integration.md)
- [Qoder MCP contract](../developer/qoder-mcp-contract.md)
- [Human approval](human-approval.md)
- [Workflow execution security](workflow-execution.md)
