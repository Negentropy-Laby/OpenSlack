---
schema: openslack.status.v1
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

| Field | Value |
|-------|-------|
| Remote | `https://github.com/Negentropy-Laby/OpenSlack` |
| Branch | `main` |

## Modules

| Module | Phase | Status | Notes |
|--------|-------|--------|-------|
| Self-Evolution Kernel | 1.6 | ACTIVE |  |
| GitHub Issues Task Loop | 1.7 | ACTIVE |  |
| Operator Interface | 2A/2B/2C | ACTIVE | Structured planner active. Webhook and Slack chat adapters active. PRMS chat cards and action confirmation active. LLM planner remains deferred. |
| PR Review & Merge Steward | 1.14 | ACTIVE | Phase 2C chat report and action confirmation active. Supports status/review/recommend/doctor/merge/watch, review/doctor comments, governance audit, deadlock detection, and chat-friendly PR summaries with confirm-merge flow. |
| Collaboration Layer | 2D/2E | ACTIVE | Event model, activity feed, digest, and handoff active. PRMS doctor, governance audit, and operator plan events hooked. Handoff YAML schema with create/list/show/accept/close. Projection-only; reads from .openslack.local/collaboration/events.jsonl and .openslack/collaboration/handoffs/. Decision and room views planned for 2E. |

## Packages (10 active)

- @openslack/kernel
- @openslack/workspace
- @openslack/runtime
- @openslack/github
- @openslack/core
- @openslack/cli
- @openslack/operator
- @openslack/chat-gateway
- @openslack/pr
- @openslack/collaboration

## CLI Commands

- openslack self
- openslack workspace
- openslack github
- openslack agent
- openslack task
- openslack ask
- openslack setup
- openslack status
- openslack doctor
- openslack chat
- openslack pr
- openslack governance
- openslack collaboration activity
- openslack collaboration digest
- openslack collaboration handoff

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

311 unit tests across 36 test files. All passing.

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
