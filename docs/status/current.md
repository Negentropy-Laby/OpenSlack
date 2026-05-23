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
| Commits | 58 |
| Last commit | `PR #11 Module 04 PR Review & Merge Steward MVP merged` |

## Modules

| Module | Phase | Status | Description |
|--------|-------|--------|-------------|
| OSEK (Self-Evolution Kernel) | 1.6 | ACTIVE | Zone classifier, merge decision, policy engine, constitution, invariants, rollback, genesis |
| GITL (GitHub Issues Task Loop) | 1.7 | ACTIVE | Issues-first autonomous task loop: create → claim → heartbeat → worktree → PR → review → done |
| Operator Interface | 1.8 | EARLY | Natural language router: intent → plan → execute → summarize |
| PR Review & Merge Steward | 1.13 | MVP | PR fetch, classify, readiness, report. No auto-approval. Merge after human approval. |

## Packages (6 active + 2 apps)

| Package | Status | Tests | Key capability |
|---------|--------|-------|---------------|
| `@openslack/kernel` | ACTIVE | 37 | Zone classifier, merge decision, policy engine |
| `@openslack/workspace` | ACTIVE | 5 | Validation, indexing, schemas |
| `@openslack/core` | ACTIVE | 0 | ClaimBroker + FileClaimBroker (file-locked) |
| `@openslack/runtime` | ACTIVE | 25 | Self-evolution ops, golden evals, agent bootstrap, worktree, PR proposal |
| `@openslack/github` | ACTIVE | 31 | App auth, Issues, Claims, Repair, Lifecycle, Manifest |
| `@openslack/pr` | ACTIVE | 0 | PR fetch, classify, readiness, report (Phase 1.13 MVP) |
| `@openslack/cli` (app) | ACTIVE | 0 | 8 command groups: setup, ask, status, doctor, workspace, self, agent, task, github, pr, operator |
| `@openslack/auth-callback` (app) | ACTIVE | 0 | Headless OAuth server (human login only) |

## CLI Command Groups (8)

| Group | Subcommands |
|-------|------------|
| `openslack workspace` | validate, index, status |
| `openslack self` | init, classify-pr, validate, observe, triage, eval, review, scorecard, monitor |
| `openslack agent` | hire, bootstrap, tick |
| `openslack task` | checkout, cleanup, status, sync |
| `openslack github` | doctor, project-inspect, project-sync-fields, project-query-ready, issue-done, repair-labels, repair-claims, repair-all, metrics |
| `openslack pr` | status, review, recommend |
| `openslack operator` | ask ("natural language") |
| `openslack ask` | Top-level alias → operator ask |
| `openslack status` | Top-level alias → workspace status |
| `openslack doctor` | Top-level alias → github doctor |

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

119 unit tests across 15 test files. All passing.

## GitHub Integration

| Capability | Status |
|-----------|--------|
| GitHub App installation token | ACTIVE — JWT signing, auto-refresh, three-tier client |
| Issue task creation | ACTIVE — `createTaskIssue()` with labels |
| Issue task discovery | ACTIVE — `queryReadyIssueTasks()` with capability/filter |
| Atomic claim via git ref | ACTIVE — `refs/heads/openslack/claims/issue-{n}` |
| Claim heartbeat + expiry | ACTIVE — ownership check, auto-recycle |
| Issue lifecycle state machine | ACTIVE — running/blocked/done with event audit comments |
| Task filtering (capability/risk/path) | ACTIVE — `filterByCapability/ Risk/ Path()` |
| Label repair | ACTIVE — `repairLabels()` idempotent |
| Claim repair | ACTIVE — `repairExpiredClaims()` |
| PR merged → issue done | ACTIVE — `.github/workflows/openslack-issue-done.yml` |
| Manifest validation | ACTIVE — JSON Schema + YAML parse + Red Zone gating |
| Branch protection ruleset | ACTIVE — PR required, 1 approval, CODEOWNERS review, status checks, block force push |
| OAuth device flow | INACTIVE — human login only, not for agent runtime |
| Project v2 | DEFERRED — optional projection layer |

## Authentication

Three-tier model (see `docs/developer/github-automation.md`):
1. **GitHub App installation token** — primary runtime credential
2. **PAT / GITHUB_TOKEN** — local dev fallback
3. **OAuth / gh CLI** — human login only

## Genesis

`scripts/genesis-validate.sh` — 5/5 checks passing. Zero OpenSlack runtime dependency.

## Deferred Items

| Item | Reason |
|------|--------|
| GitHub Project v2 task board | Project v2 is optional projection; issues + labels are source of truth |
| Chat gateway (Slack/webhook) | Phase 2 |
| Web dashboard | Phase 2 |
| Project v2 node_id + field IDs | Deferred per issues-first architecture decision |

## CI Verification

| Date | Commit | Canary | Validate | Observe | Node 24 Compat |
|------|--------|--------|----------|---------|----------------|
| 2026-05-22 | 844afe9 | ✅ | ✅ | ✅ | ✅ (FORCE_JAVASCRIPT_ACTIONS_TO_NODE24) |
