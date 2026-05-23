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
| Operator Interface | 2A/2B | ACTIVE | Structured planner active. Webhook and Slack chat adapters active. PRMS chat cards active. LLM planner remains deferred. |
| PR Review & Merge Steward | 1.14 | ACTIVE | Phase 2C-1 chat report active. Supports status/review/recommend/doctor/merge/watch, review/doctor comments, governance audit, deadlock detection, and chat-friendly PR summaries. |

## Packages (9 active)

- @openslack/kernel
- @openslack/workspace
- @openslack/runtime
- @openslack/github
- @openslack/core
- @openslack/cli
- @openslack/operator
- @openslack/chat-gateway
- @openslack/pr

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

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

237 unit tests across 30 test files. All passing.

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
