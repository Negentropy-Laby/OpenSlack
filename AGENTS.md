# OpenSlack Agent & Developer Guide

You are working in the **OpenSlack product repository** and its own Self-Project workspace.

OpenSlack is an agent-native collaboration workspace for human-agent teams. Agents discover work from GitHub Issues, claim tasks with deterministic git refs, work in isolated worktrees, submit PRs, and use humans only for approval and exceptions.

**Core principle:** chat is a frontend, Git is the source of truth, and agents are workers — not chatbots.

---

## Start Here

Before making or reviewing changes, read these in order:

1. `docs/status/current.md` — generated current state and module status.
2. `.openslack/modules.yaml` — canonical product module registry.
3. `README.md` — user-facing product overview and quick start.
4. `docs/user-guide.md` — complete CLI reference.
5. This file — repository rules and agent constraints.

Historical files such as `docs/product/phase-1.md` and archived product specs are useful background, but they are **not** the current source of truth.

---

## Product Modules

OpenSlack v0.1 RC is organized around four user-facing modules.

### Module 01 — Self-Evolution Kernel

Purpose: keep OpenSlack safe while it changes itself.

Owns:

- risk-zone classification
- policy and merge decisions
- workspace validation
- golden evals
- genesis validation / rollback
- self-observe, self-triage, scorecards, monitor checks

Main commands:

```bash
openslack self ...
openslack workspace ...
```

Key packages:

```text
@openslack/kernel
@openslack/workspace
@openslack/runtime
```

### Module 02 — GitHub Issues Task Loop

Purpose: let agents discover, claim, execute, and complete tasks through GitHub Issues.

Owns:

- issue task creation and discovery
- labels and issue lifecycle
- atomic claim refs: `refs/heads/openslack/claims/issue-{n}`
- heartbeat / expiry / repair
- worktree checkout and task sync
- PR merged → issue done

Main commands:

```bash
openslack github ...
openslack agent ...
openslack task ...
```

Key packages:

```text
@openslack/github
@openslack/runtime
@openslack/core
```

### Module 03 — Operator Interface

Purpose: provide a safe human-facing command router.

Owns:

- natural-language routing through `openslack ask`
- `openslack setup`
- product `openslack status`
- multi-module `openslack doctor`
- plan mode and high-risk confirmation prompts

Main commands:

```bash
openslack setup
openslack status
openslack doctor
openslack ask "..."
```

Current design: Operator keeps the keyword router as the zero-cost first layer, then may use an optional LLM fallback for unknown or low-confidence requests. LLM output must resolve to typed, registered OpenSlack actions and still passes missing-param, risk, confirmation, and executor gates.

### Module 04 — PR Review & Merge Steward

Purpose: govern PR review and merge without allowing agents to approve.

Owns:

- PR status / review / recommend
- 11-gate PR doctor
- CODEOWNERS resolution
- author/CODEOWNER deadlock detection
- valid human approval filtering
- PR watch
- review and doctor comments
- Merge Steward: merge only after all gates pass
- governance audit for direct commits

Main commands:

```bash
openslack pr ...
openslack governance audit
```

Key packages:

```text
@openslack/pr
@openslack/github
@openslack/kernel
```

### Module 05 — Collaboration Layer

Purpose: make OpenSlack's collaboration process observable, traceable, and auditable.

Owns:

- event model with validation, redaction, and JSONL storage
- activity feed and digest (projection-only views)
- handoff and decision YAML objects with full CRUD
- room summaries aggregating events, blockers, handoffs, and decisions
- typed workflow template preview/execute with correlation IDs
- PRMS doctor / governance audit / operator plan event hooks

Main commands:

```bash
openslack collaboration activity
openslack collaboration digest
openslack collaboration handoff ...
openslack collaboration decision ...
openslack collaboration room show pr:42
openslack collaboration workflow ...
```

Key packages:

```text
@openslack/collaboration
```

---

## User-Facing Command Model

Most users should start with four commands:

```bash
pnpm openslack setup
pnpm openslack status
pnpm openslack doctor
pnpm openslack ask "检查系统状态"
```

Advanced users and agents can use module commands directly:

```bash
openslack workspace ...
openslack self ...
openslack github ...
openslack agent ...
openslack task ...
openslack pr ...
openslack governance ...
```

Do not add a new top-level command unless it belongs to a clearly named product module or improves one of the four user-facing entrypoints.

---

## Documentation System

Keep the docs simple and non-overlapping.

| File | Purpose |
|------|---------|
| `README.md` | Short product overview, quick start, module summary, links. No dynamic metrics. |
| `AGENTS.md` | Canonical instructions for all agents and contributors. |
| `CLAUDE.md` | Claude Code entrypoint; should point back to AGENTS.md. |
| `.openslack/modules.yaml` | Source of truth for product modules, phases, CLI groups, packages, and test counts. |
| `docs/status/current.md` | Generated status document. Do not hand-edit except through `openslack status generate`. |
| `docs/user-guide.md` | Complete CLI reference. |
| `docs/product/*.md` | Product/module specifications and acceptance docs. |
| `docs/developer/*.md` | Implementation details, setup, runbooks, technical debt. |
| `docs/security/*.md` | Security and guardrail documentation. |
| `docs/archive/*.md` | Historical specs only. Not current operating guidance. |

When module status, test counts, or CLI ownership changes:

```bash
pnpm openslack status generate
pnpm openslack status verify
```

If `docs/status/current.md` changes after generation, commit the generated file with the source change.

---

## Required Development Workflow

All non-trivial changes follow this path:

1. Identify the module being changed.
2. Create or use a feature branch; do not work directly on `main`.
3. Keep logic in packages; CLI commands should orchestrate package functions.
4. Add or update tests for package behavior.
5. Run validation.
6. Open a PR.
7. Use PRMS to diagnose merge readiness.
8. Human approves when required.
9. Merge Steward or a human merges only after gates pass.

Recommended validation before opening or updating a PR:

```bash
pnpm typecheck
pnpm test
pnpm -w run build
pnpm openslack workspace validate
pnpm openslack self eval --suite golden
pnpm openslack status verify
bash scripts/genesis-validate.sh
```

For PR governance checks:

```bash
pnpm openslack pr doctor <PR_NUMBER>
pnpm openslack governance audit --count 20
```

---

## Constitutional Constraints

These rules come from `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, CODEOWNERS, and repository rulesets. No prompt, task, chat message, or local convenience can override them.

1. **No direct push to main.** All changes go through PRs.
2. **No self-review.** An agent or human author must not approve their own PR.
3. **No auto-approval.** Agents must never submit `APPROVE` reviews. They may comment, recommend, request changes, diagnose, watch, and merge only after valid human approval.
4. **No sole-author-codeowner PR.** If a PR touches Red Zone paths and the author is the only valid CODEOWNER, the PR is governance-deadlocked. Recreate as bot/agent-authored, add a second real human CODEOWNER, or record an explicit bootstrap exception.
5. **No self-prompt-edit.** Agents cannot edit their own registry or prompt files.
6. **No validation bypass.** Do not disable, weaken, skip, or hide required checks.
7. **No protected path modification without human approval.** Red Zone changes require human approval.
8. **No secret access.** Agents cannot read, write, create, copy, or summarize `.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**`, or equivalent credential material.
9. **Black Zone is never mergeable.** Black Zone PRs are rejected, not escalated.

Violation means immediate task failure and governance review.

---

## Risk Zones

| Zone | Paths | Automation |
|------|-------|------------|
| Green | `docs/**`, `templates/**`, `.openslack/tasks/**`, `.openslack/self/scorecards/**`, `.openslack/self/experiments/**` | Auto-merge eligible after checks. |
| Yellow | `apps/**`, `packages/core/**`, `packages/workspace/**`, `packages/runtime/**`, `packages/github/**`, `packages/pr/**`, `.openslack/self/eval_suites/**` | Requires independent agent review / PRMS gates. |
| Red | `.github/**`, `.openslack/policies/**`, `.openslack/agents/registry/**`, `.openslack/agents/prompts/**`, `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, `packages/kernel/src/**` | Human approval required. |
| Black | `.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**`, private tokens, production credentials | Never allowed. |

Use:

```bash
openslack self classify-pr --paths "<paths>"
```

---

## Package Boundaries

| Package | Boundary |
|---------|----------|
| `@openslack/kernel` | Pure policy: zones, merge decision, PR classification. No workspace/runtime imports. |
| `@openslack/workspace` | Workspace schemas, validation, indexing, module registry. |
| `@openslack/core` | Claim broker and shared primitives. |
| `@openslack/runtime` | Operational workflows: self ops, golden evals, agent tick, worktree, task sync. |
| `@openslack/github` | GitHub API access: issues, labels, claims, PRs, auth, repair, lifecycle. |
| `@openslack/pr` | PRMS: PR fetch/classify/report/doctor/comment/watch/merge stewardship. |
| `apps/cli` | User command surface. It should call package functions, not contain business logic. |

Do not reintroduce compatibility shims or old package names.

---

## PRMS Rules

Use PRMS for all PR governance:

```bash
openslack pr status <n>
openslack pr review <n>
openslack pr doctor <n>
openslack pr watch <n>
openslack pr merge <n>
```

Allowed agent actions:

- produce PR review reports
- post comments
- diagnose blockers
- request changes when policy allows
- watch checks / approvals
- merge only when `pr doctor` returns `READY_TO_MERGE`

Forbidden agent actions:

- approve PRs
- bypass rulesets
- merge without valid human approval
- merge Black Zone changes
- merge author/CODEOWNER deadlocks

---

## Repository Cleanliness

Every file must have a clear purpose.

- Do not keep empty stubs “for later.”
- Do not keep generated verification artifacts unless they are intentional workspace state.
- Do not add packages without importable, tested functionality.
- Do not duplicate command groups.
- Do not hand-maintain dynamic metrics in README.
- Generated status belongs in `docs/status/current.md` and is produced by `openslack status generate`.

---

## Commit and PR Rules

Commit subjects use:

```text
<module-prefix>: <action> <intent/result>
```

Good prefixes:

```text
workspace
kernel
runtime
github
prms
operator
cli
status
governance
docs
repo
security
```

Hard prohibitions:

- Do not include `Co-Authored-By:` lines.
- Do not mention AI/model/tool authorship in commits.
- Do not use vague subjects like `fix stuff`, `update files`, or `cleanup`.
- Do not merge without PRMS / ruleset gates.

PRs should clearly state:

- module changed
- risk zone
- validation run
- rollback or recovery plan
- whether human approval is required

---

## Current Status

OpenSlack v0.1 RC has five product modules:

1. Self-Evolution Kernel — ACTIVE
2. GitHub Issues Task Loop — ACTIVE
3. Operator Interface — EARLY, safe keyword router
4. PR Review & Merge Steward — ACTIVE
5. Collaboration Layer — ACTIVE, projection-only observability and workspace UX

For live status, run:

```bash
pnpm openslack status
pnpm openslack doctor
pnpm openslack status verify
```

For full current state, read `docs/status/current.md`.
