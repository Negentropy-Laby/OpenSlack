# Technical Debt Register

> Owner: OpenSlack
> Updated: 2026-05-16
> Convention: P0 = blocks next phase, P1 = should fix this phase, P2 = nice to have

## Open Items

### P0-1: Branch protection ruleset not configured

**Source:** Phase 1.8 P0-3 review (2026-05-16).
**Impact:** All commits go directly to main. No PR history exists on wsman/OpenSlack. Violates AGENTS.md constitutional rule: "No direct push to main. All changes go through PRs."
**Resolution:** Configure via GitHub Settings → Rules → Rulesets (requires human admin — App token lacks Administration permission by design). Require PR before merging, status checks, CODEOWNERS review, block force push.
**Filed:** 2026-05-16.

### P0-2: github-provider has zero unit test coverage

**Source:** Phase 1.7 verification review (2026-05-16). All 60 existing tests are in other packages (kernel, self-evolution, workspace).
**Impact:** New modules (manifest, claims, lifecycle, task-filter, repair) have no regression protection. Manifest parser, filter logic, and repair functions are tested only through indirect integration (golden evals, `openslack ask` smoke tests).
**Modules with 0 tests:**
- `packages/github-provider/src/manifest.ts`
- `packages/github-provider/src/claims.ts`
- `packages/github-provider/src/lifecycle.ts`
- `packages/github-provider/src/task-filter.ts`
- `packages/github-provider/src/repair.ts`
**Resolution:** Add unit tests for manifest parsing (valid/invalid/edge cases), claim lifecycle (heartbeat, expiry, ownership), task filtering (capability/risk/path), and repair (label creation, expired claim detection).
**Filed:** 2026-05-16.

### P1-1: Golden eval runner auto-generates artifacts that must be manually cleaned

**Source:** `packages/workspace/src/evals/runner.ts` `generateScorecard()` + EV-GOLDEN-007 `createRollbackTask()`.
**Impact:** Each `self eval --suite golden` run leaves scorecard YAML and EVOL YAML files on disk. Must be manually deleted after each run. Caused 7 artifact commits across development.
**Resolution:** Add `--clean` flag to `self eval` that removes artifacts after run, or route artifacts to `.openslack.local/runs/` which is gitignored.
**Filed:** 2026-05-15.

### P2-2: `rollback.ts` has no unit tests

**Source:** `packages/self-evolution/src/ops/rollback.ts`. Simple file-write functions with 0 test coverage.
**Resolution:** Add unit tests for YAML output structure and file path correctness. Mock filesystem.
**Filed:** 2026-05-15.

### P2-3: Claim broker deny reason is `NOT_READY` not `ALREADY_CLAIMED`

**Source:** `packages/core/src/claim-broker.ts:62`. Task state transition short-circuits before `getActiveLease()` check.
**Impact:** Denied claims show `NOT_READY` even when real reason is `ALREADY_CLAIMED`. Functionally correct (exactly 1 granted) but misleading diagnostics.
**Resolution:** Reorder checks: call `getActiveLease()` first, return `ALREADY_CLAIMED` when active lease exists.
**Filed:** 2026-05-15.

### P2-4: `checkDirty` returns `true` for non-existent paths

**Source:** `packages/git-sync/src/worktree.ts`. Catch block returns `true` (fail-safe).
**Resolution:** Return discriminated type: `{ status: 'clean' | 'dirty' | 'error', reason?: string }`.
**Filed:** 2026-05-15.

### P2-5: Empty state directories in `.openslack/`

**Source:** `.openslack/agents/prompts`, `.openslack/agents/runbooks`, `.openslack/audit`, `.openslack/decisions`, `.openslack/memory`, `.openslack/org`, `.openslack/sync`, `.openslack/tasks/*`.
**Impact:** Violates "every directory must have a purpose" principle. These are structural templates for future workspace state.
**Resolution:** Accept as workspace schema contract (defined in `openslack.yaml`, validated by `validateWorkspace()`).
**Filed:** 2026-05-15.

### P2-6: Packages not consolidated to 5-package target

**Source:** Phase 1.3 architecture consolidation review.
**Impact:** 7 packages + 2 apps vs. 5-package target. Core/workspace/kernel/self-evolution could be merged into `packages/core`. Agent-runtime/git-sync could be merged into `packages/runtime`. Github-provider could be renamed to `packages/github`.
**Resolution:** Phase 1.9 consolidation — merge kernel + workspace + core + self-evolution into `packages/core`, agent-runtime + git-sync into `packages/runtime`, rename github-provider to `packages/github`. Preserve re-exports for backward compatibility.
**Filed:** 2026-05-16.

### P2-7: `task checkout` does not support `--issue-number` flag

**Source:** Phase 1.8 review. README claims `--issue-number <n>` but CLI requires `--task-id`.
**Resolution:** Add `--issue-number` flag to `task checkout`. When set, read issue manifest from GitHub to extract task_id, auto-generate run_id.
**Filed:** 2026-05-16.

## Closed Items

### CLOSED: P0-0 — Replace OAuth with GitHub App

**Resolution:** GitHub App created (ID 3728623), installed on wsman/OpenSlack. Three-tier auth model implemented. Issues-first autonomous loop verified E2E. Productization complete.
**Closed:** 2026-05-16.

### CLOSED: P0-1 — GitHub remote

**Resolution:** Repository published at `https://github.com/wsman/OpenSlack`. Remote configured. All demo scenarios unblocked.
**Closed:** 2026-05-15.

### CLOSED: P2-1 — observe.ts unit tests (process explosion fix)

**Resolution:** `observeHealth()` refactored to accept optional `InjectedChecks` parameter. CLI path unchanged — `self observe` still runs `pnpm typecheck` and `pnpm test` via default parameters. Tests inject `{ passed, output }` directly — zero `execSync`, zero child processes, zero tinypool workers. Confirmed no recursive `vitest → pnpm test → vitest` explosion.
**Closed:** 2026-05-16.

### CLOSED: P0-2 — Golden eval stubs

**Resolution:** EV-GOLDEN-004 uses real ClaimBroker (1 granted / 9 denied). EV-GOLDEN-007 uses real createRollbackTask(). 7/7 passing, zero stubs.
**Closed:** 2026-05-15.

### CLOSED: P0-3 — Auto self_validation.yaml

**Resolution:** `self validate --pr N` writes `.openslack/self/experiments/<id>/self_validation.yaml`.
**Closed:** 2026-05-15.

### CLOSED: P0-4 — Auto scorecard files

**Resolution:** `self eval --suite golden` writes `SCORE-*.yaml` to `.openslack/self/scorecards/`.
**Closed:** 2026-05-15.

### CLOSED: P0-5 — Worktree manager

**Resolution:** `createWorktree/cleanupWorktree/checkDirty` in `@openslack/git-sync`. Uses `git worktree add -b HEAD` — never switches main worktree.
**Closed:** 2026-05-16.

### CLOSED: P0-6 — Workspace PR creation

**Resolution:** `proposeWorkspacePR()` does git add/commit/push + createDraftPR() via GitHub provider. Graceful fallback when no remote.
**Closed:** 2026-05-16.

### CLOSED: P0-7 — GitHub Provider

**Resolution:** `@openslack/github-provider` with Octokit-based GraphQL client. Issues, PRs, claims, repair, lifecycle, filtering, manifest. Three-tier auth.
**Closed:** 2026-05-16.

### CLOSED: P0-8 — Claim broker persistence

**Resolution:** `FileClaimBroker` with atomic save/load + wx-based file locking. Verified reload cycle.
**Closed:** 2026-05-15.

### CLOSED: FilterByPath glob-to-regex bug

**Resolution:** Fixed placeholder-based replacement ordering (commit 29fe79c). `**` patterns now correctly match arbitrary directory depth.
**Closed:** 2026-05-16.

### CLOSED: CLI alias crash

**Resolution:** Top-level `ask/status/doctor` aliases wrapped in try/catch (commit 29fe79c).
**Closed:** 2026-05-16.

### CLOSED: AGENTS.md stale product.md references

**Resolution:** All 4 references updated to point to current docs (commit 29fe79c, e0f26fa).
**Closed:** 2026-05-16.
