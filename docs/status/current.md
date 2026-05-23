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
| Operator Interface | 2A/2B | ACTIVE | Structured planner active. Webhook and Slack chat adapters active. LLM planner remains deferred. |
| PR Review & Merge Steward | 1.14 | ACTIVE | Phase 1.16 UX closure complete. Supports status/review/recommend/doctor/merge/watch and review/doctor comments. Governance audit and deadlock detection active. |

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

224 unit tests across 28 test files. All passing.

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
