---
schema: openslack.status.v1
status_date: 2026-05-23
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
| Commits | 67 |
| Last commit | `121d60b` — repo: sync docs and wire operator prms integration |

## Modules

| Module | Phase | Status | Notes |
|--------|-------|--------|-------|
| Self-Evolution Kernel | 1.6 | ACTIVE |  |
| GitHub Issues Task Loop | 1.7 | ACTIVE |  |
| Operator Interface | 1.8 | EARLY | Keyword-based intent router. LLM planner deferred to Phase 2. |
| PR Review & Merge Steward | 1.14 | ACTIVE | Phase 1.14 core complete. Basic Operator keyword routing implemented. Watch/comment planned for 1.16. |

## Packages (7 active)

- @openslack/kernel
- @openslack/workspace
- @openslack/runtime
- @openslack/github
- @openslack/core
- @openslack/cli
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
- openslack pr

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

169 unit tests across 21 test files. All passing.

## Module Registry

Source: `.openslack/modules.yaml` — validated on 2026-05-23.
