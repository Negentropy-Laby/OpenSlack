---
schema: openslack.document.v1
id: architecture-adr-task-claim-v2-single-host
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: github-task-loop
updated: 2026-11-03
sources:
  - design/cdd/modules/github-task-loop.md
  - docs/architecture/contracts/task-claim-v2-c0.md
  - docs/architecture/control-manifest.md
---

# ADR-0005: Separate single-host Claim authority from exact Cleanup permission

## Status

**Proposed.** This is a C0 decision candidate, not an accepted implementation
decision. No Task Control service, action grant, migration or deployment is
authorized by its existence. Current Cleanup Permit-only qualification proceeds
independently. Review recommendations do not accept this ADR.

## Acceptance Record

Pending. The approved work plan authorizes drafting, local review and task
preparation, not acceptance of these exact bytes. Separate acceptance must bind
the retained reviewed Proposed revision's full SHA-256 and byte length, actual
decision authority/time, precise implementation scope and unresolved exceptions.
Do not invent an acceptance date or inherit acceptance from ADR-0003/0004.

## Date

2026-11-03 (Asia/Shanghai), candidate drafting date, not decision acceptance.

## Technology Compatibility

| Input               | Observation and limit                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline            | OpenSlack `b8b11ed64238c3b622d110e5d2d11944a342609e`; C0 changes uncommitted until separately delivered                                                                                                                             |
| Product domain      | Task orchestration, authorization, durable leases and external effects; not a game module                                                                                                                                           |
| Source pins         | Node >=22, Bun/bun-types 1.4.0; existing Go services pin Go 1.26.5 and PostgreSQL 18.4                                                                                                                                              |
| First server target | Linux/WSL2 single host, Unix pathname socket, PostgreSQL; no TCP, remote authentication or native Windows server                                                                                                                    |
| Knowledge risk      | Incomplete: no project `docs/reference/<stack>/VERSION.md` original. Source pins do not prove compatibility or qualification                                                                                                        |
| Verified references | [Linux Unix sockets](https://man7.org/linux/man-pages/man7/unix.7.html), [PostgreSQL authority-time semantics](https://www.postgresql.org/docs/current/functions-datetime.html), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) |
| Required validation | Session revocation/UID reuse, slot-lock timing, transactional single winner, independent TS/Go canonical vectors, old-writer denial, unknown-effect reconciliation and restored-generation refusal                                  |

## ADR Dependencies

| Field                  | Candidate constraint                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends On             | No Accepted predecessor establishes this new Claim authority. ADR-0002 is still In Review and is context, not Accepted permission. Its independent-module/build constraints remain the current repository convention |
| Enables                | C1 state kernel, then C2 authenticated PostgreSQL authority, then C3 independently governed Claim-required cleanup; each has separate readiness and delivery gates                                                   |
| Blocks                 | Those new Claim implementations until this exact decision and the C0 contract are accepted, or an exact existing-governance exception is recorded                                                                    |
| Does not block         | Existing `pr.cleanup_branch_scoped.v1`, Cleanup real qualification, #411 preparation, or legacy Task Loop operation                                                                                                  |
| Related accepted scope | ADR-0003/0004 govern Harness and RunStore repairs, not task-slot authentication or a Claim cutover                                                                                                                   |

## Context

The legacy GitHub protocol has real claim refs, comments, heartbeat, repair and
delivery. They do not jointly prove that a particular authenticated run holds a
current, unrevoked generation/revision-bound lease at an effect boundary. The
local `FileClaimBroker` has a lease identity but is not the remote task authority.
Treating either as v2 verified would reinterpret historical evidence.

Merged Cleanup already has exact Permit binding, single consumption and a
controlled send boundary. Its `taskRef` is administrative scope, not Claim proof.
Requiring the source development task to remain claimed would conflict with
Cleanup's correct refusal to delete a branch still needed by that task.

## Decision

1. Keep current Cleanup **Permit-only**. A future **separate** action,
   `pr.cleanup_branch_claimed.v1`, will require Permit plus a Claim on an
   independent cleanup task. This ADR neither registers nor enables that action.
2. Select `services/task-control/` as a future independent Go/PostgreSQL
   authority. GitHub owns task business facts; PostgreSQL owns the admitted
   Claim slot, epochs/revisions, receipts, reservations and outbox. Comments,
   labels, Graph and TUI are projections, never a second current authority.
3. First deployment is one Linux/WSL2 host. Kernel peer credentials must match
   an administrator-controlled immutable run-session mapping. Every admission
   checks current session/generation, expiry and revocation. A connection UID
   alone, request body or local file cannot establish runtime/run identity.
4. Agents and effect Brokers authenticate as different principals. A Broker
   acts for an Agent only through an authority-stored scoped delegation and
   one-use reservation; it cannot manufacture an Agent from request fields.
5. Claim ID, task reassignment epoch, transition revision and authority/routing
   generation remain distinct. Preserve terminal slot history. Idempotent
   operations return the original request-bound receipt; conflicts never
   automatically retry against a newly read revision.
6. Judge lease time after acquiring the task-slot lock. PostgreSQL transaction-
   start time is not sufficient after contention. Clock uncertainty or old-
   backup restoration closes admission until independent fresh activation.
7. Preserve `issue_task_snapshot.v1`. A new closed definition projection uses
   the C0's restricted JCS profile and domain-separated SHA-256, with data-only
   proposed vectors. No old record receives fabricated run/epoch evidence.
8. Keep high-privilege external credentials in the controlled effect Broker.
   Before cutover, disable every old producer and credential route for that
   scope and prove denial. New namespaces, version fields and UI warnings do
   not fence old writers. Rollback closes admission and drains v2; it never
   re-enables a bypass or deletes unresolved history.

### Key interfaces and limits

The [C0 contract](../contracts/task-claim-v2-c0.md) defines acquire, heartbeat,
phase/submit, release/complete, expire/revoke, repair, observations and operation
receipts, plus the source producer/consumer inventory. The session and delegation
are authenticated authority records, not caller-provided authorization objects.
`active` plus `authorityTime < expiresAt` is necessary for new effect admission;
`closing` admits no new effect. The final controlled sender revalidates Claim,
Permit and resource scope before one reservation-bound send.

This provides controlled-entry fencing, not a distributed transaction with
GitHub. Revocation before sending can prevent a send; after an unknown send,
freeze and reconcile. A historical successful receipt is not a fresh permission.
Expected-SHA deletion compares ref values, not branch lifecycle identity (same-
name/same-SHA ABA remains a documented limitation).

## Alternatives Considered

| Alternative                                         | Benefit                                                     | Reason not selected for this workstream                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend legacy comments/ref presence as strong proof | Small apparent change, existing Task Loop remains available | Cannot supply current exact run/generation authentication or execution-side fencing; would overclaim historical evidence                    |
| Git record commits plus expected-head CAS           | Useful state-chain primitive; avoids initial service        | Still needs trusted sessions/time, rollback generation and effect fencing; Go/PostgreSQL is the approved long-term authority                |
| Remote authenticated Claim service immediately      | Broader deployment                                          | Adds unreviewed network/session/control-plane scope. First version deliberately single-host; remote support needs a later accepted decision |
| Make #418 wait for Claim v2 or change its action    | One apparent authorization concept                          | Conflates Permit and Claim, changes a delivered contract and delays independent qualification                                               |

## Consequences and Performance

Positive: explicit subject/run binding, durable generations, one transactional
winner, recoverable operation receipts and a truthful separation of Claim from
permission. Negative: administrator session/credential setup, database and Broker
availability, per-operation authority reads, migration coordination and retained
history. No latency/throughput claim is qualified; C2 must measure lock waits,
receipt/outbox size and admission budgets before deployment. Bound all requests,
reads, connection lifetime and lock waits; never extend an expired lease to meet
an availability target.

The trust model does not protect against root, sudo/Docker access, shared service
UIDs or a malicious process inside the same authorized run. Those are deployment
violations, not reasons to downgrade checks. No auto-failover or cloned active
authority is supported. Restored state cannot self-activate.

## CDD Requirements Addressed

| Project-owned CDD requirement                         | Response                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GitHub Task Loop: identity-bound single winner        | Authenticated session, transactional slot CAS and distinct run/epoch/revision             |
| Work outside canonical checkout, observable ownership | Separate runtime session and honest legacy/v2 projection; checkout alone is not authority |
| Completion reconciles Issue and PR evidence           | Authoritative receipts/outbox and precise delivery binding, not automatic Issue closure   |
| PR review/merge: controlled destructive effect        | Independent claimed action; retain Permit-only action and source-task/dependency blockers |

This project uses Issues, not an assigned Story/TR registry. No synthetic TR IDs,
Source framework registry or implementation readiness is created by this ADR.

## Migration Plan

Follow C1 → C2 → C3 → consumer migration → fault qualification → one-repository
cutover → old-write retirement. Inventory in C0 includes exported helpers,
both repair aliases, watch/tick, PR sync, local read-triggered expiry, Harness
and Graph consumers. Close old admission, drain/reconcile, remove old direct
write capabilities, test each denial, then activate bounded new admission.
Rollback closes new admission, preserves the authority and unresolved records,
and drains there. Legacy comments never reconstruct a v2 Claim.

## Validation and Review Gates

- Full-mode independent technical-director and architecture/security review of
  exact retained C0/ADR/vector bytes, followed by separate decision acceptance.
- C1–C3 remain blocked backlog tasks until their predecessors and scopes close.
- Independent TS/Go vectors, concurrency/ABA, lock-wait expiry, response loss,
  stale/delegated subject denial, restart and old-backup refusal.
- Actual OS/credential fencing and GitHub qualification distinct from local
  regression, hosted CI, human GitHub review, merge and release.

No C1 service code, SQL migration, new action registration, identity or live
effect was performed for this proposal.
