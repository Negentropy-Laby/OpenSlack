# Technical Debt Register

> Owner: OpenSlack
> Updated: 2026-05-24
> Convention: P0 = blocks next phase, P1 = should fix this phase, P2 = nice to have

## Open Items

### CLOSED: P0-1 — Branch protection ruleset configured

**Resolution:** Ruleset "Protect main" created and active on `Negentropy-Laby/OpenSlack`. Direct push blocked (GH013). Required checks: classify, validate, canary. CODEOWNERS review enforced (`require_code_owner_review: true`). Block force push enabled. Verified via test PRs #8 and #9.
**Closed:** 2026-05-23.

### CLOSED: P2-5 — Empty state directories in `.openslack/`

**Resolution:** Accepted as workspace schema contract (defined in `openslack.yaml`, validated by `validateWorkspace()`). `.gitkeep` files added to required directories to ensure fresh CI checkouts pass validation.
**Closed:** 2026-05-22.

### CLOSED: P0-3 — Direct commits to main without PR

**Source:** Commits `aab64a9` and `f453cbd` pushed directly to main during Phase 1.16 delivery.
**Impact:** Bypasses branch protection ruleset and CODEOWNERS review. Creates governance inconsistency with documented `no direct push to main` invariant.
**Resolution:** Commits contain non-Red Zone changes (CI workflow, CLI commands, docs). Recorded as bootstrap exception during productization sprint. All subsequent commits must go through PR.
**Preventive measure:** Ruleset `current_user_can_bypass: "never"` is active. Future direct pushes would be blocked at the GitHub level. The only path for these commits was admin force-push, which requires explicit override.
**Closed:** 2026-05-24.
**Filed:** 2026-05-23.

### CLOSED: P0-2 — Author/CODEOWNER deadlock for Red Zone PRs

**Source:** PR #11 bootstrap (2026-05-23).
**Impact:** When the only CODEOWNER for Red Zone paths is also the PR author, GitHub ruleset blocks merge because authors cannot satisfy their own required approval. `current_user_can_bypass: "never"` prevents admin bypass.
**Resolution (bootstrap exception):** PR #11 merged via temporary admin bypass after PR #10 deadlocked. Recorded as bootstrap exception — not standard process.
**Resolution:** PRMS keeps bot approvals invalid, but now gives explicit bot/agent-authored PR remediation for sole-author CODEOWNER deadlocks. Workspace PR proposal preflight blocks Red Zone PR creation when the current authenticated human is the sole matching CODEOWNER. Bot/agent-authored Red Zone PRs remain valid only when a human CODEOWNER approves on GitHub.
**Closed:** 2026-05-24.
**Filed:** 2026-05-23.

### CLOSED: P0-4 — Duplicate rollback EVOL backlog loop

**Source:** Post-merge rollback task generation created 54 duplicate `rollback_proposed` EVOL files for `EXP-TEST` and `EXP-TEST-ROLLBACK`.
**Impact:** Creates a feedback loop and hides real rollback work behind test noise. The current schema does not support proposed cleanup statuses such as `closed_stale` or `expired`.
**Resolution:** `createRollbackTask()` now returns an idempotent result, writes a stable rollback signature, updates existing active rollback proposals, skips `EXP-TEST*` test artifacts, exports single-source TTL/rate-limit constants, and can expire stale proposals through schema-valid `rejected` status. The 54 untracked local test artifacts were removed from the workspace and not committed.
**Closed:** 2026-05-24.
**Filed:** 2026-05-24.

### CLOSED: P1-2 — Node 20 Actions deprecation (time-bounded)

**Source:** GitHub Actions runner deprecation notice. `actions/checkout@v4`, `actions/setup-node@v4`, `oven-sh/setup-bun@v2`, `actions/github-script@v7` all run on Node 20.
**Impact:** Starting June 2, 2026, GitHub will force Node 24 for all actions. Node 20 support removed September 16, 2026. CI will break if action versions are not upgraded.
**Resolution:** All five workflow files now use Node-24-capable pinned SHAs: `actions/checkout` v6.0.2, `actions/setup-node` v6.4.0, `oven-sh/setup-bun` v2, and `actions/github-script` v8.0.0. `setup-node` package-manager cache behavior is explicit.
**Closed:** 2026-05-24.
**Filed:** 2026-05-22.

### CLOSED: P1-4 — LLM Planner safety boundary

**Source:** Operator was previously a keyword-based router for known intents.
**Impact:** Unknown, compound, or ambiguous user requests could not be handled conversationally. A naive LLM planner could also weaken the current allowlist and confirmation gates.
**Resolution:** Operator now keeps the keyword router as Layer 1 and adds optional LLM fallback for unknown or low-confidence requests. LLM output must normalize to typed `IntentKind`/slots or registered OpenSlack actions. Executor rejects registry-external raw commands and preserves risk, missing-param, and confirmation gates.
**Closed:** 2026-05-24.
**Filed:** 2026-05-24.

### CLOSED: P2-8 — Workflow Templates deferred

**Source:** Collaboration Layer Phase 2F was deferred.
**Impact:** Teams could not start reusable, parameterized workflows for release review, incidents, handoffs, or PR gates.
**Resolution:** Added `openslack.workflow_template.v1` preview/execute support under `openslack collaboration workflow`. Templates use typed inputs and registered OpenSlack action steps, plus handoff, decision-gate, record-decision, and wait steps. Raw command strings are rejected and runs emit correlation IDs.
**Closed:** 2026-05-24.
**Filed:** 2026-05-24.

### CLOSED: P1-3 — Historical AI attribution in commit history

**Source:** `AGENTS.md` hard prohibition added 2026-05-23 (PR #34): "Do not include `Co-Authored-By:` lines. Do not mention AI/model/tool authorship in commits."
**Impact:**
- Pre-PR-34 commits (approx. first 70 commits) contain `Co-authored-by: Claude Opus 4.6 <noreply@anthropic.com>` and `Co-Authored-By:` lines.
- Post-PR-34 squash-merge commits PR #35–#46 also contain Co-Authored-By lines because GitHub squash merge retained them from PR descriptions. These commits are in permanent git history:
  - `f7041666e5dae411821fa77a5e5589f2df9cf464` (PR #35)
  - `5202ba6f5fddaa1b3a0779c95ea2a30c0c5de379` (PR #36)
  - `c7bcb9d637d431fcf384205493bf59a49a026e7e` (PR #42)
  - `4456056a8c00cda2f5603a62aaf5a9982037dd05` (PR #43)
  - `43f1073b4cf1cfb5b16207fc6098c1e17a9bc04d` (PR #44)
  - `5f13d7edb0f30735c6c074e9ec231de0559cd88d` (PR #45)
  - `83d4235a3fe0f9e8d054b7475762b70efb01dfaf` (PR #46)
- These cannot be rewritten without force-pushing main, which is prohibited by branch protection ruleset.
**Resolution:** Accepted as historical artifacts. No rewrite of published history. All new commits from PR #47 onward must comply with the AGENTS.md hard prohibition. PR #54 added automated enforcement to `openslack governance audit`. PR #80 narrowed the bot attribution exemption to only `openslack-agent-operator[bot]` (the project's own bot) — all other bot Co-authored-by trailers (copilot[bot], dependabot[bot], etc.) remain violations.
**Preventive measure:**
1. `AGENTS.md` § Commit Convention prohibits all Co-authored-by lines except `openslack-agent-operator[bot]`.
2. `openslack governance audit` checks commit message content for prohibited attribution patterns (baseline: PR #34), stripping only the project bot trailer before checking.
3. All future commits must not contain prohibited Co-Authored-By lines. Agent/tool automation that appends them must be disabled or amended before merge.
**Closed:** 2026-05-24.
**Filed:** 2026-05-23.

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

**Resolution:** `observeHealth()` refactored to accept optional `InjectedChecks` parameter. CLI path unchanged — `self observe` still runs `bun run typecheck` and `bun run test` via default parameters. Tests inject `{ passed, output }` directly — zero `execSync`, zero child processes, zero tinypool workers. Confirmed no recursive `vitest → bun run test → vitest` explosion.
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

**Resolution:** `proposeWorkspacePR()` verifies declared paths against both the staged index and resulting commit, then delegates push, draft PR publication, and exact-head synchronization to `@openslack/delivery`. Missing credentials/remotes or any delivery failure now return `success: false`; the former PR-body-only graceful fallback was removed by the P0-3 fail-closed delivery contract.
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
