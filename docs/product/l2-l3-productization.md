---
schema: openslack.product_plan.v1
status: planned
created: 2026-06-05
source_status: docs/status/current.md
---

# OpenSlack L2/L3 Productization Plan

## Purpose

This document defines the next productization track after the
conversation-first workbench. It is a product contract for turning OpenSlack
from a CLI/TUI/chat product into an embeddable agent collaboration control
plane.

This document does not claim the new API, SDK, receipt, or rehydrate surfaces
are implemented. Current implementation state remains in
`docs/status/current.md` and `.openslack/modules.yaml`.

The frontmatter schema is a planning-document marker for documentation review.
It is not a runtime validation schema and does not add a generated status
contract by itself.

## Product Layers

OpenSlack keeps the existing human entrypoints and adds a stable integration
layer around them.

| Layer | Name | Role | Current entrypoints |
|-------|------|------|---------------------|
| L1 | CLI/TUI/Chat | Human-facing operation and confirmation surface | `openslack tui`, `openslack ask`, `openslack chat`, module CLI commands |
| L2 | Local Control Plane | Local read models, receipts, traces, surface generations, and audit evidence | Collaboration events, conversations, workflow runs, agent runs, PRMS evidence |
| L3 | API/SDK/Frontend Gateway | Read-first local API, generated OpenAPI, SDK facades, and future external dashboard support | Planned `/v1/*` loopback API and TypeScript SDK |

The default user path remains `bun run openslack tui`. L3 exists for embedded
frontends, smoke tools, SDK consumers, chat adapters, and external automation.

## Product Principles

1. **Source-of-truth boundaries stay unchanged.** GitHub, Git, `.openslack`,
   and `.openslack.local` remain the authoritative stores. API, TUI, SDK, and
   chat views read from or project those stores.
2. **API v0 is read-first.** It may plan actions and return receipts, but it
   must not execute side effects directly.
3. **Events are not truth.** Realtime signals only indicate that a surface
   changed. Consumers must re-read the surface snapshot before treating data as
   current.
4. **Receipts explain work.** Mutating paths must expose owner, risk,
   decision, evidence, linked objects, and next action.
5. **Approvals stay governed.** TUI, chat, and API confirmations are never
   GitHub PR approvals. PRMS and valid human GitHub approval remain merge gates.
6. **No dashboard-only state.** External dashboards and SDKs must not create
   approval, merge, workflow, or task state that cannot be reconstructed from
   OpenSlack's existing truth sources.

## Delivery Tracks

Tracks are intended to ship as independent PRs with explicit dependencies.
Track 1 defines the product contract. Tracks 2-4 provide the shared contracts,
trace model, and snapshot model needed by Tracks 5-6. Tracks 7-8 can ship
independently when their authorization and provider-read-model tests are in
place.

### Track 1: Product Contract Refresh

Document the L1/L2/L3 model, route the documentation map to this plan, and
make the GA gates explicit. This is the prerequisite for all implementation
work in the remaining tracks.

### Track 2: Shared Control Plane Contracts

Add internal contract types for:

- `OpenSlackCommandReceipt`
- `OpenSlackEntityEnvelope<T>`
- `OpenSlackTraceRef`
- `OpenSlackLinkedObjectRef`
- `OpenSlackSurfaceGeneration`

These types describe read models and execution evidence. They do not migrate
or replace existing persistence.

### Track 3: Trace And Audit Convergence

Carry a consistent trace reference through TUI Ask, ActionCards, conversation
messages, workflow runs, agent runs, PRMS doctor output, and approval center
actions. Conversation metadata remains backward compatible.

### Track 4: Surface Generation And Rehydrate

Introduce a local surface registry for:

- `status`
- `conversations`
- `workflow-runs`
- `approvals`
- `pr-queue`
- `agent-runs`
- `profile-sync`

Each registered surface gets a snapshot builder and generation counter. Future
TUI/API consumers use snapshots as the final read model.

### Track 5: Local API Server V0

Add a loopback-only API server under the existing Collaboration module command
surface:

```bash
openslack collaboration api start
openslack collaboration api doctor
openslack collaboration api openapi
```

The first API version exposes read routes for status, conversations, workflow
runs, approvals, PR queue, agent runs, surface generations, and OpenAPI JSON.
The only write-like route is `POST /v1/actions/plan`, which returns a receipt
and safe recommendations without executing side effects.

`actions.plan` evaluates intent, missing parameters, risk, permission status,
and recommended next commands or cards. Its receipt may be `planned`,
`blocked`, or `failed`; it must not return `applied` because API v0 does not
execute the requested action. A confirmation-required plan is still only a
recommendation until a governed CLI/TUI/PRMS path performs the side effect.

### Track 6: Route Specs, OpenAPI, And TypeScript SDK

Define typed route specs for `/v1/*`, generate OpenAPI JSON, and publish a
minimal internal TypeScript SDK with read facades for the same resources. The
SDK must not expose token files, daemon internals, or direct GitHub mutation
helpers.

### Track 7: Fine-Grained Conversation Permissions

Replace generic conversation action treatment with explicit permission IDs:

- `conversation.create`
- `conversation.list`
- `conversation.show`
- `conversation.send`
- `conversation.archive`
- `conversation.summarize`
- `conversation.dispatch_agent`
- `conversation.record_action`

CLI, TUI, chat, and API planning use the same authorization result.

### Track 8: External Runtime Provider Profile

Productize the external runtime bridge as a provider profile read model. The
profile exposes configured root, bridge entrypoint status, MCP descriptor
status, last smoke result, compatible agent IDs, and remediation text. OpenSlack
continues to own governance, permissions, run storage, transcripts, and PRMS.

## GA Gates

Before OpenSlack can call this track production-ready:

- Read routes can reconstruct the status, conversations, workflow run,
  approval, PR queue, agent run, and profile sync views without parsing CLI
  stdout.
- Every mutating path returns or records a receipt with owner, risk, decision,
  evidence, linked objects, and next action.
- Surface generation and rehydrate tests prove consumers can recover after
  missed events.
- API and SDK tests prove unauthenticated access fails closed and `actions.plan`
  cannot execute side effects.
- Conversation permissions are enforced consistently across CLI, TUI, chat,
  and API planning.
- External runtime failures produce the same diagnostic evidence in CLI, TUI,
  and API read models.
- No OpenSlack API, chat action, or TUI confirmation can create a GitHub
  approval or bypass PRMS.

## Non-Goals

- Do not replace `openslack tui` as the default user entrypoint.
- Do not add a top-level `openslack api` command; API commands stay under
  Collaboration.
- Do not copy external product module names into OpenSlack.
- Do not introduce a multi-tenant SaaS control plane in this track.
- Do not expose local daemon paths, token files, transcripts, secrets, or raw
  local evidence through API or SDK.
- Do not alter persistent schemas until a later track requires an explicit
  migration plan.

## Measurement

Track 1 establishes the baseline for these metrics. Until later tracks land,
the expected baseline for snapshot-backed TUI surfaces, side-effect receipts,
API route coverage, SDK smoke coverage, permission-denial evidence, and
external runtime provider evidence is zero or documentation-only.

Track these metrics while implementing the eight tracks:

- Percentage of TUI surfaces backed by shared snapshot builders.
- Percentage of side-effect actions with receipts and linked objects.
- API read route coverage for TUI-visible resources.
- SDK smoke coverage for status, conversations, PR queue, workflow runs, and
  agent runs.
- Number of authorization denials with owner, reason, evidence, and fallback.
- Number of external runtime failures with a user-actionable remediation.
