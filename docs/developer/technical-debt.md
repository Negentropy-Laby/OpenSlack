# Technical Debt Register

> Owner: OpenSlack OSEK
> Updated: 2026-05-15
> Convention: P0 = blocks next phase, P1 = should fix this phase, P2 = nice to have

## Open Items

### P0-0: Headless GitHub OAuth — cannot add project scope to gh token without manual browser interaction

**Source:** Phase 1.5 GitHub wiring (2026-05-16)
**Requirement:** Fully automated, zero manual steps. No browser. No manual PAT creation. No copy-paste of tokens.
**Impact:** Entire GitHub-backed autonomous task loop is blocked. Without `read:project` + `project` scopes, the OpenSlack runtime cannot query or update GitHub Project v2 items. This single gap blocks: `openslack github project-query-ready`, `openslack self triage --create-issues`, `agent tick --source github-project`, `task sync --createDraftPR`.

**Attempts made:**

| Method | Result |
|--------|--------|
| `gh auth refresh -s project` | Opens browser — fails in headless env |
| `gh auth refresh -s project --reset-scopes` | Resets to default scopes, removes `repo` |
| `gh auth login -s repo,read:project,project` | Device flow code displayed (0860-44E9), user approved at github.com/login/device, but gh never received the token exchange response. After 180s polling, `gh auth status` still "not logged in." OAuth app granted on GitHub side, token not delivered to gh. |
| `@octokit/rest` direct API call | Cannot import from repo root — workspace isolation |
| `curl -H "Authorization: Bearer $GITHUB_TOKEN"` | `GITHUB_TOKEN` env var empty — no token injected into shell |
| Classic PAT creation | **Rejected** — requires manual browser at github.com/settings/tokens |
| Fine-grained PAT creation | **Rejected** — requires manual browser |
| `apps/auth-callback/` local OAuth server | Implemented and deployed. Listens on localhost:8200/callback. Cannot self-initiate OAuth flow — GitHub requires browser redirect to `/login/oauth/authorize`. Server can capture token but cannot start the flow. |

**Root cause:** GitHub's OAuth device flow (`gh auth login`) successfully displays device code, user approves at github.com/login/device, but the subsequent token exchange (polling `POST /login/oauth/access_token`) never completes in the gh CLI process. The authorization grant succeeds on GitHub's side but gh never receives the response. This may be a firewall/proxy issue, a gh binary version mismatch, or a credential store conflict (Windows keyring vs in-memory).

**Required solution:** A fully automated method that:
1. Does not require browser interaction
2. Does not require manual token creation or copy-paste
3. Works in Windows Server 2025 headless environment
4. Uses only: gh CLI, node.js, curl, or direct HTTP API calls
5. Can be triggered programmatically via `openslack github auth` command

**Possible approaches (to investigate):**
- Direct OAuth device flow via raw HTTP: POST to `https://github.com/login/device/code` to get `device_code` + `user_code`, display `user_code`, poll `POST https://github.com/login/oauth/access_token` with `device_code` until token returns. Bypass gh CLI entirely.
- GitHub App installation token: Create a GitHub App (one-time manual step), then use `POST /app/installations/{id}/access_tokens` with the App's private key to get tokens programmatically. JWT-signed, no browser needed after initial App creation.
- Environment variable injection: Use `gh auth token` output from a successfully-authenticated session (requires one-time manual auth to establish the keyring entry, then all subsequent runs use the cached token).

**P0-1: No GitHub remote — blocks end-to-end PR / task board workflow**

**Source:** Phase 1 acceptance review §F
**Impact:** Cannot run Demo 1 (clean clone bootstrap), Demo 2 (Green PR gate), Demo 6 (agent tick from Project), Demo 7 (agent claim), Demo 9 (workspace PR). Worktree tests blocked without remote. GitHub Provider package is deleted (will be recreated from spec when remote exists).
**Resolution:** Create `MY-DOGE/OpenSlack` GitHub repository with Project v2, configure branch protection rulesets per `.github/workflows/`, push this repo.
**Depends on:** External GitHub org access.

### P0-2: EV-GOLDEN-004 and EV-GOLDEN-007 use in-process only

**Source:** Phase 1.1 P0-2 implementation at `packages/workspace/src/evals/runner.ts`
**Impact:** Concurrent claim test uses synchronous ClaimBroker (not multi-process). Rollback test creates local file only (no git revert PR). Both pass golden suite but don't represent production behavior.
**Resolution:** When Claim Broker is server-mode (Phase 2), update EV-GOLDEN-004 to use HTTP client. When git remote exists, update EV-GOLDEN-007 to verify git revert + PR creation.
**Depends on:** P0-1 (GitHub remote), Phase 2 Claim Broker server.

### P0-3: Golden eval runner auto-generates artifacts that must be manually cleaned

**Source:** `packages/workspace/src/evals/runner.ts` `generateScorecard()` writes to `.openslack/self/scorecards/`. EV-GOLDEN-007 `createRollbackTask()` writes to `.openslack/self/evolution_backlog/`.
**Impact:** Each `self eval --suite golden` run leaves files on disk. The Repository Cleanliness rule (AGENTS.md) requires cleanup of verification artifacts. Currently manual.
**Resolution:** Add `--clean` flag to `self eval` that removes artifacts after run. Or route artifacts to a temp directory that is gitignored.
**Filed:** 2026-05-15 cleanup commits (0cc1e2a, 8ed99d1).

### P1-1: Self-Validation Manifest writes `.yaml` extension but file extension says `.yaml`

**Source:** `packages/self-evolution/src/ops/validate.ts:91` — `writeFileSync(..., 'self_validation.yaml')`
**Impact:** The `yaml` package is a hard dependency of `@openslack/self-evolution`, so the file is always YAML. The extension is correct. No actual bug — this was flagged as observation in a verification run where the verifier misread the output.
**Resolution:** Close as not-a-bug. Verified in Phase 1.1 final verification (PASS).
**Filed:** 2026-05-15 verification run.

### P2-1: `observe.ts` has no unit tests

**Source:** `packages/self-evolution/src/ops/observe.ts`
**Impact:** `observeHealth()` calls `execSync('pnpm typecheck')` and `execSync('pnpm test')` which spawn child processes. Hard to test in vitest (process explosion risk). The function works correctly in CLI but has 0 test coverage.
**Resolution:** Refactor to accept test results as input (dependency injection pattern, same as `monitorPostMerge` already does). Then test the observation logic without spawning processes.
**Filed:** 2026-05-15 Phase 1.1 review.

### P2-2: `rollback.ts` has no unit tests

**Source:** `packages/self-evolution/src/ops/rollback.ts`
**Impact:** `createRollbackTask()` and `executeRollback()` are simple file-write functions. 0 test coverage.
**Resolution:** Add unit tests that verify YAML output structure and file path correctness. Mock filesystem.
**Filed:** 2026-05-15 Phase 1.1 review.

### P2-3: Claim broker deny reason is `NOT_READY` instead of `ALREADY_CLAIMED` on duplicate claim

**Source:** `packages/core/src/claim-broker.ts:62` — task state transition from `ready` to `claimed` short-circuits before `getActiveLease()` check.
**Impact:** Functionally correct (exactly 1 claim granted, 99 denied). But the deny reason string is imprecise — all denied claims show `NOT_READY` even when the real reason is `ALREADY_CLAIMED`. Could confuse diagnostics.
**Resolution:** Reorder the checks in `claimTask()`: call `getActiveLease()` before checking task state, return `ALREADY_CLAIMED` when an active lease exists.
**Filed:** 2026-05-15 Phase 1.1 final verification.

### P2-4: Agent ID comparison in `decideMerge` is case-sensitive

**Source:** `packages/self-evolution/src/core/merge-decider.ts:33` — `r.reviewerAgent === r.implementationAgent`
**Impact:** `Agent-X` and `agent-x` are treated as different agents, which allows self-review if IDs differ only in case. Low risk in practice (agent IDs follow lowercase convention: `codex_developer_ci-bot`).
**Resolution:** Add case-insensitive comparison: `r.reviewerAgent.toLowerCase() === r.implementationAgent.toLowerCase()`.
**Filed:** 2026-05-15 Phase 1.1 final verification.

### P2-5: `checkDirty` returns `true` for non-existent paths

**Source:** `packages/git-sync/src/worktree.ts:58` — catch block returns `true`
**Impact:** Intentional design choice (fail-safe: treat unknown as dirty). A non-existent path is semantically different from a dirty worktree. Could cause confusion in CI logs.
**Resolution:** Return a discriminated result type: `{ status: 'clean' | 'dirty' | 'error', reason?: string }` instead of boolean.
**Filed:** 2026-05-15 observation fix.

### P2-6: 5 empty state directories in `.openslack/`

**Source:** `.openslack/agents/prompts`, `.openslack/agents/runbooks`, `.openslack/audit`, `.openslack/decisions`, `.openslack/memory`, `.openslack/org`, `.openslack/sync`, `.openslack/self/governance`, `.openslack/self/rollback/revert_templates`, `.openslack/tasks/{open,claimed,running,review,blocked,done}`
**Impact:** These directories exist as structural templates for future workspace state. They contain no files. Not harmful, but violate "every directory must have a purpose" principle.
**Resolution:** Either add `.gitkeep` files to document intended use, or accept that empty directories represent the workspace schema contract (they are defined in `openslack.yaml` and validated by `validateWorkspace()`).
**Filed:** 2026-05-15 cleanup analysis.

## Closed Items

### CLOSED: 2 stub packages (chat-gateway, github-provider)
**Resolution:** Deleted in Phase 1.2 cleanup (commit 52a52d6). Will be recreated from product.md when Phase 2 needs them.
**Closed:** 2026-05-15.

### CLOSED: 2 duplicate CLI commands (eval.ts, observe.ts)
**Resolution:** Deleted in Phase 1.2 cleanup. Functionality consolidated into `self.ts`.
**Closed:** 2026-05-15.

### CLOSED: 6 `require()` calls in ESM modules
**Resolution:** Replaced with static imports in Phase 1.1 observation fixes. Lint now 0 errors.
**Closed:** 2026-05-15.

### CLOSED: Golden eval stubs (EV-GOLDEN-004, EV-GOLDEN-007)
**Resolution:** Replaced with real ClaimBroker and createRollbackTask in Phase 1.1 P0-2. 7/7 golden evals pass with zero stubs.
**Closed:** 2026-05-15.

### CLOSED: Auto-generated golden eval artifacts (scorecards + experiment manifests + rollback EVOLs)
**Resolution:** Phase 1.2 cleanup commits (0cc1e2a, 8ed99d1). Deleted 5 scorecard YAML files under `.openslack/self/scorecards/`, 1 experiment manifest (`EXP-FINAL-001`), and 1 rollback EVOL task (`EVOL-2026-000002`) — all auto-generated by `generateScorecard()` and `createRollbackTask()` during golden eval verification runs. Root cause documented in P0-3 (runner auto-generates artifacts).
**Closed:** 2026-05-15.

### CLOSED: Incomplete cleanup commit (0cc1e2a)
**Resolution:** First cleanup commit removed only `EVOL-2026-000002.yaml` but left 5 scorecard files and `EXP-FINAL-001` on disk. Second commit (8ed99d1) deleted the remaining 6 files. All golden-eval artifacts now purged from both disk and git history.
**Closed:** 2026-05-15.
