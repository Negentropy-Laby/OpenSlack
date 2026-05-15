---
schema: openslack.status.v1
status_date: 2026-05-16
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

| Field | Value |
|-------|-------|
| Remote | `https://github.com/wsman/OpenSlack` |
| Branch | `main` |
| Commits | 12 |
| Last commit | `docs: update stale file paths and CLI references for post-1.3 architecture` |

## Packages (7 libraries + 1 CLI app)

| Package | Status | Tests | Key capability |
|---------|--------|-------|---------------|
| `@openslack/kernel` | ACTIVE | 21 | Zone classifier, merge decision, invariants |
| `@openslack/workspace` | ACTIVE | 5 | Workspace validate, index, schemas, golden evals |
| `@openslack/core` | ACTIVE | 0 | ClaimBroker, FileClaimBroker |
| `@openslack/self-evolution` | ACTIVE | 29 | Observe, triage, review, scorecard, monitor, rollback |
| `@openslack/agent-runtime` | ACTIVE | 0 | Agent bootstrap, tick (local task discovery) |
| `@openslack/git-sync` | ACTIVE | 0 | Worktree manager, PR proposal |
| `@openslack/github-provider` | ACTIVE | 0 | GitHub Issues/PR/Project v2 API (dry-run when no token) |
| `@openslack/cli` (app) | ACTIVE | 0 | 4 command groups: workspace, self, agent, task |

**Note:** `runtime` and `providers` consolidated packages do not yet exist. These are Phase 1.4 targets.

## CLI Command Groups (4)

| Group | Subcommands |
|-------|------------|
| `openslack workspace` | validate, index, status |
| `openslack self` | init, classify-pr, validate, observe, triage, eval, review, scorecard, monitor |
| `openslack agent` | hire, bootstrap, tick |
| `openslack task` | checkout, cleanup, status, sync |

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

60 unit tests across 7 test files. All passing.

## Genesis

`scripts/genesis-validate.sh` — 5/5 checks passing. Zero OpenSlack runtime dependency.

## Known Issues (Phase 1.4)

| Issue | Impact |
|-------|--------|
| Worktree switches main branch before add | Multi-agent worktree isolation at risk |
| Task sync only generates PR body (no commit/push) | PR creation not automated |
| tickAgent() does not call ClaimBroker | Agent tick is discovery-only |
| FileClaimBroker has no cross-process lock | Concurrent claim safety not guaranteed |
| GitHub provider updateProjectField param mismatch | Project v2 field updates may fail |
| GitHub Project v2 node_id empty | Project configuration not completed |
| CI workflows use soft-fails (|| echo) | Critical validation may pass when failing |

## Deferred Items

| Item | Reason |
|------|--------|
| GitHub Project v2 task board | Needs Project v2 configured on `wsman/OpenSlack` |
| End-to-end agent tick via Project | Needs `GITHUB_TOKEN` + Project configured |
| Chat gateway | Phase 2 |
| Web dashboard | Phase 2 |
