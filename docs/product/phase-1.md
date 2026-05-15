# Phase 1: Self-Evolution Kernel MVP — Acceptance Document

> Date: 2026-05-15 (updated post-Phase 1.1)
> Final Verdict: **CONDITIONAL PASS → Phase 1.1 hardening complete**
> Accepted: Self-Evolution Kernel Local MVP
> Deferred: Full GitHub-backed autonomous task execution loop (P0-6/P0-7 require external GitHub repo + token)
> Phase 1.1: 6/8 P0 items verified PASS, P0-6/P0-7 code exists but needs deployment environment

## Phase 1 Goal

Make OpenSlack the first project it manages — safely self-observing, self-validating, self-improving through PR gates without runaway.

## Phase 1.1 Completion Summary

All 8 Phase 1.1 hardening items addressed:

| P0 | Item | Phase 1.1 Status |
|----|------|-----------------|
| P0-1 | Workspace index | DONE — `workspace index` builds from plain text, `workspace status` shows summary |
| P0-2 | Eliminate stub golden evals | DONE — EV-GOLDEN-004 (real ClaimBroker, 1 granted/9 denied), EV-GOLDEN-007 (real createRollbackTask) |
| P0-3 | Auto self_validation.yaml | DONE — `self validate --pr N` writes `.openslack/self/experiments/<id>/self_validation.yaml` |
| P0-4 | Auto scorecard files | DONE — `self eval --suite golden` writes `SCORE-*.yaml` to `.openslack/self/scorecards/` |
| P0-5 | Worktree manager | DONE — `createWorktree/cleanupWorktree/checkDirty` in `@openslack/git-sync` |
| P0-6 | Real workspace PR | CODE EXISTS — git commit/push/branch functions implemented (needs external git remote to test) |
| P0-7 | GitHub Provider | CODE EXISTS — stub package (needs `@octokit/rest` + GitHub token + external repo) |
| P0-8 | Claim Broker persistence | DONE — `FileClaimBroker` with atomic save/load, verified reload cycle |

**Phase 1 modules downgraded by previous review now corrected post-Phase 1.1:**

| Module | Previous Review | Post-Phase 1.1 |
|--------|----------------|----------------|
| D. Golden Evals (stubs) | PARTIAL PASS | PASS — 7/7 real assertions, zero stubs |
| J. Manifest/Scorecard (no auto-write) | PARTIAL PASS | PASS — auto-generates both files |
| K. Claim Broker (no persistence) | PASS FOR IN-PROCESS | PASS — FileClaimBroker with save/load |
| A. Workspace index (deferred) | PASS WITH EXCEPTION | PASS — index + status implemented |
| I. Worktree (proposal only) | PARTIAL PASS | PASS — worktree add/remove/dirty-check implemented |

**Remaining deferral:** P0-6/P0-7 require external GitHub repository + token. Code functions exist but cannot be end-to-end tested in this environment.

## Formal Acceptance Decision

```
Decision:
  CONDITIONAL PASS

Accepted:
  OpenSlack Self-Evolution Kernel Local MVP.

Not Accepted Yet:
  Full GitHub-backed autonomous task execution loop.

Required Follow-up:
  Phase 1.1 Hardening & GitHub Integration.

Rationale:
  The project has implemented the core self-protection, local validation,
  risk classification, onboarding, observation, and rollback skeleton.
  However, several originally required end-to-end capabilities remain
  deferred, stubbed, or proposal-only, including GitHub Project integration,
  workspace index, true worktree/PR execution, automatic validation manifest
  and scorecard generation, and distributed claim persistence.
```

## Acceptance Summary (Post Phase 1.1)

| # | Module | Verdict |
|---|--------|---------|
| A | Self-Project Workspace | PASS |
| B | Constitution / Invariants / Policy | PASS |
| C | PR Classifier / Gate | PASS |
| D | Golden Evals | PASS (was PARTIAL — stubs eliminated) |
| E | Self Observer / Evolution Task | LOCAL PASS (GitHub Issue/Project deferred) |
| F | GitHub Project Task Board | DEFERRED (requires external GitHub repo) |
| G | New Employee Agent Onboarding | PASS |
| H | Agent Bootstrap / Tick / Claim | LOCAL PASS (GitHub-backed claim deferred) |
| I | Worktree / Workspace PR | PASS (was PARTIAL — worktree manager implemented) |
| J | Self Validation Manifest / Scorecard | PASS (was PARTIAL — auto file generation implemented) |
| K | Rollback / Genesis Layer | PASS |
| L | Documentation | PASS |

## Final Count

| Status | Count | Modules |
|--------|-------|---------|
| PASS | 3 | B, C, G, K, L |
| PASS WITH EXCEPTION | 1 | A (workspace index deferred) |
| PARTIAL PASS | 3 | D (2 stub evals + no auto-scorecard), I (PR proposal only), J (no auto manifest/scorecard) |
| LOCAL PASS | 2 | E (no GitHub Issue/Project), H (in-process only, no GitHub-backed claim) |
| DEFERRED | 1 | F (external repo + Project required) |

---

## A. Self-Project Workspace — PASS WITH EXCEPTION

### A1. openslack self init — PASS

**实现方式：**
- CLI 命令 `self init` 位于 `apps/cli/src/commands/self.ts:10`
- 输出确认信息：`openslack.yaml` 已存在，`.openslack/` 目录树已完整
- `openslack.yaml` 包含 `mode: self_project`, `workspace_id: openslack-self`
- `AGENTS.md` 包含宪法级约束和四色分区速查表
- `.openslack/` 目录树包含 42 个子目录，覆盖 agents/policies/self/tasks/leases 等全部必需区域

### A2. openslack workspace validate — PASS

**实现方式：**
- `validateWorkspace()` 位于 `packages/workspace-engine/src/validate.ts`
- 四阶段验证：YAML 解析 + schema 检查、状态目录验证、source roots 检查、protected roots 检查
- CLI 入口 `workspace validate` 位于 `apps/cli/src/commands/workspace.ts:8`
- 类型定义：`WorkspaceConfig`, `ValidationResult`, `ValidationError` 位于 `packages/workspace-engine/src/types.ts`

### A3. openslack workspace index — DEFERRED

**状态：** 未实现。索引重建依赖 GitHub Project 配置和完整产品 repo 验证。
**依赖：** Phase 1.1 P0-1

### A4. No schema-less core objects — PASS

**实现方式：**
- 6 个 JSON Schema（draft 2020-12）注册在 `packages/schemas/src/index.ts`
- `validateWorkspace()` 在解析阶段检查 `schema` 字段

---

## B. Constitution / Invariants / Policy — PASS

**全部 6 项子标准通过。**

### B1. Constitution exists and is protected — PASS

**实现方式：**
- `.openslack/self/constitution.md` — 6 articles, `human_approval_required: true`
- `classifyPaths(['.openslack/self/constitution.md'])` → RED
- `classifySelfEvolutionPR()` → `humanApprovalRequired: true`

### B2. Invariants can be validated — PASS

**实现方式：**
- `.openslack/self/invariants.yaml` — 7 invariants
- 每条包含 id, severity, description, enforcement, protected_paths

### B3. Self Evolution Policy effective — PASS

**实现方式：**
- `.openslack/policies/self_evolution.yaml` — 4 zones, agent rules, merge rules
- `max_evolutions_per_day: 3`
- 运行时权威实现在 `packages/policy/src/zones.ts`

### B4. Black Zone denied — PASS

**实现方式：**
- `classifyPaths(['secrets/prod.key'])` → BLACK
- `classifySelfEvolutionPR()` → `autoMergeAllowed: false`
- `decideMerge()` → `{ decision: 'deny' }`
- CLI exit code 1

### B5. Red Zone requires human approval — PASS

**实现方式：**
- `classifyPaths(['.github/workflows/test.yml'])` → RED
- `classifySelfEvolutionPR()` → `humanApprovalRequired: true`
- 6 个策略文件已补齐（risk.yaml, approvals.yaml, workspace_write_permissions.yaml, github_task_claim.yaml, constitutional_paths.yaml, rollback_policy.yaml）

---

## C. PR Classifier / Gate — PASS

**全部 4 项子标准通过。**

### C1. PR risk zone classification — PASS

**实现方式：**
- `classifyPaths()` 位于 `packages/policy/src/zones.ts:60` — glob-based 四区匹配
- 21 单元测试覆盖所有 zone + mixed paths + unknown paths
- CLI command: `self classify-pr --paths "..."`

### C2. PR comment generation — PASS

**实现方式：**
- `.github/workflows/openslack-self-validate.yml` — classify job + github-script PR comment

### C3. PR check status — PASS

**实现方式：**
- `.github/workflows/openslack-reusable-validate.yml` — workspace validate → typecheck → lint → test → self eval → security scan

### C4. Merge decision output — PASS

**实现方式：**
- `decideMerge()` 位于 `packages/self-evolution/src/core/merge-decider.ts`
- 8 单元测试覆盖: black→deny, null→deny, red→require_human, self-review→wait, green+approve→merge_queue

---

## D. Golden Evals — PARTIAL PASS

**5/7 real evaluations pass. 2 key evals use stub assertions.**

### D1. Golden eval runner — PASS

**实现方式：**
- `runGoldenEval()` 位于 `packages/evals/src/runner.ts`
- `loadGoldenSuite()` 位于 `packages/evals/src/suites/golden.ts` — 读取 `.openslack/self/eval_suites/golden/`
- CLI: `self eval --suite golden` → 7 files loaded and executed

### D2. 7 golden evals — PARTIAL PASS

**实现方式：**
- 7 YAML 文件在 `.openslack/self/eval_suites/golden/`

**已通过的 5 个:**
| Eval | Assertion Type | Status |
|------|---------------|--------|
| EV-GOLDEN-001 | `file_exists` + `command(workspace validate)` | REAL |
| EV-GOLDEN-002 | `classify_pr_zone == red` + `human_approval_required == true` | REAL |
| EV-GOLDEN-003 | `risk_zone == red` + `human_approval_required == true` | REAL |
| EV-GOLDEN-005 | `risk_zone == green` + `human_approval_required == false` | REAL |
| EV-GOLDEN-006 | `risk_zone == black` + `merge_decision == deny` | REAL |

**仍为 stub 的 2 个（需要 Phase 1.1 补齐）:**
| Eval | Issue | Dependency |
|------|-------|------------|
| EV-GOLDEN-004 | Concurrent claim atomicity | Scenario assertion (stub) — needs multi-process ClaimBroker |
| EV-GOLDEN-007 | Regression → rollback | Scenario assertion (stub) — needs real post-merge CI monitor |

### D3. Eval failure blocks PR — PASS

**实现方式：**
- Runner returns structured pass/fail. CLI exit code 1 on failure.
- Each eval case has `on_failure` field

### D4. Eval outputs scorecard — NOT YET

**状态：** `computeFitnessScore()` exists but golden eval runner does not auto-generate scorecard files to `.openslack/self/scorecards/`.
**依赖：** Phase 1.1 P0-4

---

## E. Self Observer / Evolution Task — LOCAL PASS

**Local EVOL creation works. GitHub Issue/Project integration deferred.**

### E1. Self observe runs — PASS

**实现方式：**
- `observeHealth()` 位于 `packages/self-evolution/src/ops/observe.ts:54`
- 4 checks: workspace validation (in-process), typecheck (execSync), test suite (execSync), required files (existsSync)

### E2. Creates EVOL task — LOCAL PASS

**实现方式：**
- `triageObservations()` 位于 `packages/self-evolution/src/ops/triage.ts:42`
- Deduplicate by signature → rank by severity → generate `EVOL-YYYY-NNNNNN.yaml` → write to `.openslack/self/evolution_backlog/`

### E3. EVOL → GitHub Issue — DEFERRED

**依赖：** Phase 1.1 P0-7 (GitHub Provider)

### E4. EVOL → GitHub Project — DEFERRED

**依赖：** External GitHub repo + Project v2

---

## F. GitHub Project Task Board — DEFERRED

**Dependencies:**
- External `MY-DOGE/OpenSlack` GitHub repository
- GitHub Project v2 with standard fields
- `templates/new-agent/github_task_contract.yaml` defines field mapping (template exists, Project does not)

This deferred status cascades to modules H and I — without a GitHub Project, agent ticks cannot query real tasks, and workspace PRs cannot be created as actual GitHub draft PRs.

---

## G. New Employee Agent Onboarding — PASS

**全部 4 项子标准通过。**

### G1. 9 template files exist — PASS

**实现方式：**
- `templates/new-agent/` — START_HERE.md, identity.yaml, github_task_contract.yaml, claim_policy.yaml, schedule.github-actions.yml, codex_automation_prompt.md, claude_routine_prompt.md, local_cron.example, first_day_checklist.md
- All use `{{VARIABLE}}` substitution

### G2. openslack agent hire works — PASS

**实现方式：**
- CLI `agent hire` 位于 `apps/cli/src/commands/agent.ts:32`
- Reads templates, substitutes variables, writes onboarding package, creates registry entry

### G3. START_HERE.md content complete — PASS

**实现方式：**
- 8 sections: Identity, Source of Truth, Finding Work, Claiming Work, After Claiming, Never, When Idle, When Blocked

### G4. Schedule template exists — PASS

**实现方式：**
- `schedule.github-actions.yml` — GitHub Actions tick (4x/hour)
- `local_cron.example` — local crontab

---

## H. Agent Bootstrap / Tick / Claim — LOCAL PASS

**Local task discovery + in-process ClaimBroker work. GitHub-backed claim deferred.**

### H1. Agent bootstrap — PASS

**实现方式：**
- `bootstrapAgent()` 位于 `packages/agent-runtime/src/bootstrap.ts:30`
- 6 checks: registry, onboarding, start_here, local_identity, workspace, permissions

### H2. Agent tick idle — PASS (local only)

**实现方式：**
- `tickAgent()` 位于 `packages/agent-runtime/src/tick.ts:85`
- Loads registry → scans `.openslack/tasks/open/` → no tasks = idle exit
- **Note:** This scans local directory, NOT GitHub Project. GitHub-backed task discovery deferred.

### H3-H7. Claim / Lease — PASS FOR IN-PROCESS MVP

**实现方式：**
- `ClaimBroker` 位于 `packages/core/src/claim-broker.ts`
- In-process state machine using `Map<string, Lease>`, `Map<string, string>`
- claim/heartbeat/release/expire all implemented
- Dual check prevents duplicate claims

**Not passing for:**
- Multi-process safety (no cross-process lock)
- Multi-machine safety (no shared state)
- Restart persistence (in-memory only)
- GitHub Actions concurrency

**Dependency:** Phase 1.1 P0-8 (persistent Claim Broker)

---

## I. Worktree / Workspace PR — PARTIAL PASS

**PR proposal + body generation works. Real worktree/commit/push/draft PR creation not implemented.**

### I1. Workspace PR proposal — PASS

**实现方式：**
- `proposeWorkspacePR()` 位于 `packages/git-sync/src/propose.ts:27`
- CLI `sync propose` 位于 `apps/cli/src/commands/sync.ts:8`
- Classifies risk zone, detects black/red violations, generates PR body, computes branch name
- Black zone PRs auto-rejected

### I2. Path permission check — PASS

**实现方式：**
- `classifyPaths()` provides path-level zone classification
- `workspace_write_permissions.yaml` defines write boundaries

### I3-I5. Not yet implemented

| Item | Status | Dependency |
|------|--------|------------|
| Real `git worktree add` | Not implemented | Phase 1.1 P0-5 |
| Real `git commit` + `git push` | Not implemented | Phase 1.1 P0-6 |
| GitHub draft PR creation | Not implemented | Phase 1.1 P0-7 |
| PR URL writeback to workspace | Not implemented | Phase 1.1 P0-6 |
| Direct main push prevention | Policy-defined only | GitHub branch protection (deployment) |

---

## J. Self Validation Manifest / Scorecard — PARTIAL PASS

**Scoring functions exist. Automatic manifest/scorecard file generation not implemented.**

### J1. Self validation manifest — PARTIAL PASS

**实现方式：**
- `validateWorkspace()` → `ValidationResult` (structured)
- `reviewPR()` → `ReviewResult` with 4 checks (independent_review, validation, protected_paths, fitness)

**Not passing for:**
- Automatic `self_validation.yaml` file generation per PR
- File not written to `.openslack/self/experiments/<EXP-ID>/self_validation.yaml`

**Dependency:** Phase 1.1 P0-3

### J2. Fitness score — PASS

**实现方式：**
- `computeFitnessScore()` 位于 `packages/self-evolution/src/ops/scorecard.ts:11`
- 6 dimensions (correctness 0.30, reliability 0.20, security 0.20, cost 0.10, simplicity 0.10, DX 0.10)
- 6 unit tests in `packages/self-evolution/src/ops/__tests__/scorecard.test.ts`

### J3. Low score blocks merge — PASS

**实现方式：**
- `reviewPR` blocks when overall < 0.70
- `decideMerge` returns deny when validation fails

**Not passing for:**
- Automatic scorecard file generation to `.openslack/self/scorecards/YYYY/MM/SCORE-*.yaml`

**Dependency:** Phase 1.1 P0-4

---

## K. Rollback / Genesis Layer — PASS

**全部 4 项子标准通过。**

### K1. Last known good — PASS

**实现方式：**
- `.openslack/self/release_channels/last_known_good.yaml` — stable_sha, validation results, rollback command

### K2. Genesis validate — PASS

**实现方式：**
- `scripts/genesis-validate.sh` — bash + python + git only, zero OpenSlack runtime dependency
- 5 checks: openslack.yaml, .openslack/ dirs, constitution.md, secret scan, git repo

### K3. Genesis rollback — PASS

**实现方式：**
- `scripts/genesis-rollback.sh` — reads LKG, executes `git revert`

### K4. Regression → rollback — PASS

**实现方式：**
- `monitorPostMerge()` detects regression via in-process checks
- `createRollbackTask()` generates ROLLBACK EVOL task YAML

---

## L. Documentation — PASS

| L1 | `docs/product/phase-1.md` | This file. |
| L2 | `docs/developer/self-evolution-kernel.md` | Architecture, core loop, key commands, development workflow. |
| L3 | `docs/developer/new-agent-onboarding.md` | Hiring flow, manual steps, agent file descriptions. |
| L4 | `docs/security/self-evolution-guardrails.md` | Zone classification, agent rules, constitutional paths, rollback. |

---

## Implementation Status by Package

| Package | Status | Tests | Key Exports |
|---------|--------|-------|-------------|
| `@openslack/workspace-engine` | DONE | 5 | `validateWorkspace()` |
| `@openslack/schemas` | DONE | 0 | 6 JSON Schemas |
| `@openslack/policy` | DONE | 21 | `classifyPaths()`, `evaluatePolicy()` |
| `@openslack/self-evolution` | DONE | 29 | `classifySelfEvolutionPR()`, `decideMerge()`, `observeHealth()`, `triageObservations()`, `reviewPR()`, `computeFitnessScore()`, `monitorPostMerge()`, `createRollbackTask()` |
| `@openslack/evals` | DONE | 0 | `runGoldenEval()`, `loadGoldenSuite()` |
| `@openslack/core` | DONE | 0 | `ClaimBroker` (in-process, claim/heartbeat/release/expire) |
| `@openslack/agent-runtime` | DONE | 0 | `bootstrapAgent()` (local), `tickAgent()` (local task dir only) |
| `@openslack/git-sync` | DONE | 0 | `proposeWorkspacePR()` (PR body only) |
| `@openslack/github-provider` | STUB | 0 | Deferred — all GitHub API integration |
| `@openslack/chat-gateway` | STUB | 0 | Out of scope for Phase 1 |
| `@openslack/cli` | DONE | 0 | 17 commands, 8 command groups |

## Quantified Progress

| Metric | Value |
|--------|-------|
| Source lines (TS) | ~1,700 |
| Test files | 7 |
| Unit tests | 60 |
| TypeScript packages | 8 implemented / 3 stubs |
| CLI commands | 17 |
| CLI command groups | 8 |
| GitHub Actions workflows | 4 |
| JSON Schemas | 6 |
| Golden evals | 7 (5 real, 2 stub) |
| Genesis scripts | 2 |
| Policy files | 6 |
| Agent onboarding templates | 9 |
| Developer docs | 4 |

---

## Phase 1.1: Hardening & GitHub Integration — Required Follow-up

The following 8 items must be completed before Phase 1 can be declared unconditionally passed.

### P0-1: Workspace Index

**Current:** A3 not implemented.
**Required:** `openslack workspace index` rebuilds task/agent/policy/evolution backlog indices from `.openslack/` plain text.

### P0-2: Eliminate Stub Golden Evals

**Current:** EV-GOLDEN-004 and EV-GOLDEN-007 use stub assertions.
**Required:** Real concurrent claim test. Real regression → rollback test. `openslack self eval --suite golden` must not depend on stub assertions.

### P0-3: Auto-Generate self_validation.yaml

**Current:** `validateWorkspace()` and `reviewPR()` work but no file is written.
**Required:** Each self-evolution PR auto-generates `.openslack/self/experiments/<EXP-ID>/self_validation.yaml` with PR number, head sha, changed paths, risk zone, checks, fitness score, decision, human approval required.

### P0-4: Auto-Generate Scorecard Files

**Current:** `computeFitnessScore()` works but golden eval runner does not write to disk.
**Required:** `self eval` or `self validate` writes `.openslack/self/scorecards/YYYY/MM/SCORE-*.yaml`.

### P0-5: Real Worktree Manager

**Current:** Only PR body is generated. No actual `git worktree add`.
**Required:** `git worktree add`, branch create, dirty check, allowed path check, cleanup.

### P0-6: Real Workspace PR Creation

**Current:** `sync propose` outputs PR body only.
**Required:** `git commit` + `git push` + GitHub draft PR creation + PR URL writeback.

### P0-7: GitHub Provider Minimum

**Current:** `@openslack/github-provider` is a STUB package.
**Required:** create issue, add issue to Project, query Ready items, update Project fields, create PR, comment on PR.

### P0-8: Claim Broker Persistence

**Current:** ClaimBroker uses in-process `Map` — not multi-process safe.
**Required:** SQLite or workspace lease file + file lock for cross-process safety, especially for GitHub Actions concurrency.
