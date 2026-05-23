# Technical Debt Register

> Owner: OpenSlack
> Updated: 2026-05-22
> Convention: P0 = blocks next phase, P1 = should fix this phase, P2 = nice to have

## Open Items

### CLOSED: P0-1 — Branch protection ruleset configured

**Resolution:** Ruleset "Protect main" created and active on `Negentropy-Laby/OpenSlack`. Direct push blocked (GH013). Required checks: classify, validate, canary. CODEOWNERS review enforced (`require_code_owner_review: true`). Block force push enabled. Verified via test PRs #8 and #9.
**Closed:** 2026-05-23.

### CLOSED: P2-5 — Empty state directories in `.openslack/`

**Resolution:** Accepted as workspace schema contract (defined in `openslack.yaml`, validated by `validateWorkspace()`). `.gitkeep` files added to required directories to ensure fresh CI checkouts pass validation.
**Closed:** 2026-05-22.

### P1-2: Node 20 Actions deprecation (time-bounded)

**Source:** GitHub Actions runner deprecation notice. `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`, `actions/github-script@v7` all run on Node 20.
**Impact:** Starting June 2, 2026, GitHub will force Node 24 for all actions. Node 20 support removed September 16, 2026. CI will break if action versions are not upgraded.
**Resolution:** Compatibility verified: `openslack-self-canary.yml` runs successfully with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`. Continue monitoring for v5 releases; upgrade all 5 workflow files in a single PR when available. Fallback: enable `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` globally if v5 not released by May 30.
**Filed:** 2026-05-22.

### CLOSED: P2-6 — Compat shim package cleanup

**Resolution:** Deleted `packages/compat/` entirely (4 shim packages, ~2000 lines). CLI imports migrated: `agent.ts` → `@openslack/runtime`, `task.ts` → `@openslack/runtime`. Dead dependencies removed from `apps/cli/package.json`. Root `tsconfig.json` references updated. Zero consumer breakage.
**Closed:** 2026-05-22.

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

### CLOSED: P0-2 — github-provider unit tests

**Resolution:** 31 tests added: manifest.ts (10), task-filter.ts (19), repair.ts (2). 137 total tests across 19 files.
**Closed:** 2026-05-16.

### CLOSED: P1-1 — Golden eval artifacts

**Resolution:** `self eval --suite golden --clean` flag removes scorecard and EVOL artifacts automatically.
**Closed:** 2026-05-16.

### CLOSED: P2-2 — rollback.ts unit tests

**Resolution:** 2 tests added: creates valid YAML file, executeRollback callable.
**Closed:** 2026-05-16.

### CLOSED: P2-3 — Claim broker deny reason

**Resolution:** Reordered checks: `getActiveLease()` before task state. Returns `ALREADY_CLAIMED` for duplicate claims.
**Closed:** 2026-05-16.

### CLOSED: P2-4 — checkDirty discriminated return

**Resolution:** Changed from `boolean` to `{ status: 'clean'|'dirty'|'error', reason?: string }`. Task CLI updated.
**Closed:** 2026-05-16.

### CLOSED: P2-6 — Package consolidation 7→5

**Resolution:** 5 active packages (kernel, workspace, core, runtime, github) + 4 compat shims in `packages/compat/`.
**Closed:** 2026-05-16.

### CLOSED: P2-7 — task checkout --issue-number

**Resolution:** Added `--issue-number` flag to `task checkout`. Auto-derives task-id and run-id.
**Closed:** 2026-05-16.

### CLOSED: AGENTS.md stale product.md references

**Resolution:** All 4 references updated to point to current docs (commit 29fe79c, e0f26fa).
**Closed:** 2026-05-16.
