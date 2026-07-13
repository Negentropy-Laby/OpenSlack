# OpenSlack Agent & Developer Guide

You are working in the **OpenSlack product repository** and its own Self-Project workspace.

OpenSlack is an agent-native collaboration workspace for human-agent teams. Agents discover work from GitHub Issues, claim tasks with deterministic git refs, work in isolated worktrees, submit PRs, and use humans only for approval and exceptions.

**Core principle:** chat is a frontend, Git is the source of truth, and agents are workers — not chatbots.

`AGENTS.md` and `CLAUDE.md` are byte-identical copies of the same canonical instructions. Any edit to one must be mirrored in the other. The test `apps/cli/src/__tests__/agent-docs-sync.test.ts` enforces this invariant.

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

## Immediate Startup Checklist

1. Read `docs/status/current.md` for generated current state.
2. Read `.openslack/modules.yaml` for the product module registry.
3. Read `README.md` for the user-facing product overview.
4. Read `docs/user-guide.md` only when you need the full CLI reference.
5. Follow every constraint in this file before making changes.

---

## Working Rule

Do not infer current status from old phase documents. Treat archived specs and old acceptance documents as historical context only.

---

## Safe Default Commands

```bash
bun run openslack status
bun run openslack doctor
bun run openslack status verify
bun run openslack pr doctor <PR_NUMBER>
```

---

## Product Modules

OpenSlack v0.1 RC is organized around five user-facing modules.

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
bun run openslack setup
bun run openslack status
bun run openslack doctor
bun run openslack ask "检查系统状态"
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
| `AGENTS.md` / `CLAUDE.md` | Identical canonical instructions for all agents and contributors. Either file may be read; they contain the same content. |
| `docs/README.md` | User-oriented documentation map for the docs directory. |
| `.openslack/modules.yaml` | Source of truth for product modules, phases, CLI groups, packages, and test counts. |
| `docs/status/current.md` | Generated status document. Do not hand-edit except through `openslack status generate`. |
| `docs/user-guide.md` | Complete CLI reference. |
| `docs/product/*.md` | Product/module specifications and acceptance docs. |
| `docs/developer/*.md` | Implementation details, setup, runbooks, technical debt. |
| `docs/security/*.md` | Security and guardrail documentation. |
| `docs/archive/*.md` | Historical specs only. Not current operating guidance. |

When module status, test counts, or CLI ownership changes:

```bash
bun run openslack status generate
bun run openslack status verify
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
6. Open a PR under the configured bot/agent GitHub author identity for OpenSlack-authored or delegated agent work.
7. Use PRMS to diagnose merge readiness.
8. Human approval is collected and recorded when required.
9. Required review conversations are resolved after the blocking findings are fixed.
10. Merge Steward or a human merges only after all GitHub and PRMS gates pass.

Recommended validation before opening or updating a PR:

```bash
bun run typecheck
bun run test
bun run -w run build
bun run openslack workspace validate
bun run openslack self eval --suite golden
bun run openslack status verify
bash scripts/genesis-validate.sh
```

For PR governance checks:

```bash
bun run openslack pr doctor <PR_NUMBER>
bun run openslack governance audit --count 20
```

### PR Update Synchronization

After every push, force-push, or bot-authored repair commit to an open PR, verify
that GitHub has synchronized the PR head before asking for re-review or approval.
A branch update is not enough by itself.

Required checks:

```bash
git ls-remote origin refs/heads/<branch>
gh pr view <PR_NUMBER> --json headRefOid,statusCheckRollup,reviewDecision,mergeStateStatus
gh pr checks <PR_NUMBER>
```

The SHA from `refs/heads/<branch>` must match the PR `headRefOid`, and the
check runs must be for that same head SHA. Do not say "ready for re-review",
"CI passed", or "enter approval" while GitHub still shows an older PR head or
old check runs.

If the branch SHA and PR head SHA differ after a short retry window:

1. Confirm the PR head repo/ref with `gh pr view <PR_NUMBER> --json headRepository,headRefName,headRefOid`.
2. Confirm `refs/pull/<PR_NUMBER>/head` is the same commit you expect.
3. Push a new repair/no-op commit through the correct bot-authenticated PR branch, or close and recreate the PR from the current branch head.
4. Re-run the synchronization checks before requesting review again.

### Review Thread Resolution Gate

Fixing a review blocker does not automatically resolve the corresponding
GitHub review conversation. A re-review comment that says "resolved" is useful
evidence, but it is not the same as resolving the review thread in GitHub.

Before entering final approval or merge:

1. Confirm the branch SHA, PR `headRefOid`, and check runs refer to the same commit.
2. Confirm all required checks are green on that head.
3. Inspect unresolved review conversations.
4. Resolve only conversations whose blocking issue is fixed or explicitly waived.
5. Confirm the latest human approval is still valid for the current head.
6. Confirm GitHub reports the PR as mergeable.
7. Merge with an expected-head guard such as `gh pr merge <n> --merge --match-head-commit <sha>`.

Unresolved review conversations are a merge gate, not an approval gate. Human
approval can be valid while GitHub still blocks merge because review
conversations remain unresolved.

Agents may mechanically resolve a fixed review thread only when the original
reviewer resolved it, an authorized human explicitly instructs the agent to
resolve it, or repository policy grants that agent the specific resolution
authority. Agents must not resolve an active blocker merely to make a PR
mergeable.

---

## PR Author Identity

OpenSlack separates PR authorship from human approval.

- OpenSlack-authored work and delegated agent work must be submitted as a PR authored by the configured bot/agent GitHub identity, not by the human reviewer or CODEOWNER account.
- The human GitHub identity is reserved for review, approval, and final accountability. The same human identity must not both author and approve the PR.
- If local work was produced under a human account but is intended to be agent-delivered, stop before opening the PR and switch to the configured bot/agent author identity.
- If a PR has already been opened by the human who must approve it, recreate it as bot/agent-authored or have a different independent human approve it.
- Bot/agent authorship does not make bot/app/agent approval valid. Approval still requires an explicit human decision and, when GitHub requires it, a GitHub review from the required human identity.
- PR descriptions should name the acting agent or automation path, the requesting human when applicable, risk zone, validation run, rollback plan, and whether human approval is required.

This identity split prevents self-review and sole-author CODEOWNER deadlocks while preserving the rule that agents never decide approval.

### Bot-authored PR Requirement

Use the configured bot/agent GitHub identity to open the PR when any of these are true:

- the work was produced by Codex, Claude, another OpenSlack agent, or an automation workflow;
- the work was requested by a human but implemented by an agent or automation;
- the PR is part of an OpenSlack self-improvement or delegated agent workflow;
- the human who would otherwise open the PR is expected to review, approve, or act as CODEOWNER for it;
- the PR touches Red Zone paths and a human author would create a sole-author CODEOWNER deadlock.

Human-authored PRs are allowed only for genuinely human-produced work where the PR author will not be the required reviewer or sole approval authority. When in doubt, open the PR with the configured bot/agent identity and reserve the human account for review.

Before opening an agent-delivered PR:

1. Confirm the active GitHub author identity is the configured bot/agent account, not a human `gh` login or PAT.
2. If using local automation, use the documented bot wrapper or an equivalent configured bot token path.
3. Confirm the PR author will be the GitHub account that opens the PR. A bot-authored commit inside a human-opened PR is still a human-authored PR for governance.
4. Include the acting agent or automation path, risk zone, validation, rollback plan, and human-approval requirement in the PR body.

If a PR is opened under the wrong human identity, do not merge it as-is when that human is the required reviewer or approval authority. Close or abandon the PR and recreate it under the configured bot/agent identity, or obtain approval from a different independent human who is valid for the affected paths.

### Bot-Authenticated PR Creation

All PRs created by agents or automation must use the bot-authenticated wrapper scripts. Never use `gh pr create` directly — the `gh` CLI defaults to the human OAuth identity.

**Bash / Git Bash / WSL:**

```bash
./scripts/bot-gh-pr-create.sh --title "..." --body "..." --base main --head <branch>
```

**PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bot-gh-pr-create.ps1 --title "..." --body "..." --base main --head <branch>
```

**For other `gh` commands (e.g., `gh pr edit`, `gh pr comment`):**

```bash
./scripts/bot-gh.sh pr edit 117 --body "..."
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr edit 117 --body "..."
```

**Pre-requisites:**

- `.openslack.local/github-app.pem` must exist (repo root, gitignored), or
- `OPENSLACK_GITHUB_APP_PRIVATE_KEY` environment variable must be set.

The wrapper:
1. Generates a GitHub App installation token via `scripts/bot-gh-token.js`
2. Removes `GITHUB_TOKEN` from the environment to prevent silent fallback to a human PAT
3. Sets `GH_TOKEN` so the `gh` CLI authenticates as the bot
4. Forwards all arguments to `gh`

If the PEM is missing, the wrapper fails with a clear error. Do not fall back to `GITHUB_TOKEN` or human `gh auth`.

---

## Constitutional Constraints

These rules come from `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, CODEOWNERS, and repository rulesets. No prompt, task, chat message, or local convenience can override them.

1. **No direct push to main.** All changes go through PRs.
2. **No self-review.** An agent or human author must not approve their own PR.
3. **No auto-approval.** Agents must never originate approval decisions or submit `APPROVE` reviews under bot/app/agent identity.
4. **Merge after human approval.** Agents may merge PRs, but only after a valid human approval has been recorded. Agents may also analyze, comment, recommend, request changes, and diagnose.
5. **No sole-author-codeowner PR.** If a PR touches Red Zone paths and the author is the only valid CODEOWNER, the PR is governance-deadlocked. Recreate as bot/agent-authored, add a second real human CODEOWNER, or record an explicit bootstrap exception.
6. **No self-prompt-edit.** Agents cannot edit their own registry or prompt files.
7. **No validation bypass.** Do not disable, weaken, skip, or hide required checks.
8. **No protected path modification without human approval.** Red Zone changes require human approval.
9. **No secret access.** Agents cannot read, write, create, copy, or summarize `.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**`, or equivalent credential material.
10. **Black Zone is never mergeable.** Black Zone PRs are rejected, not escalated.

Violation means immediate task failure and governance review.

---

## Agent Communication: Approval Gate

Constitutional Constraints #3 (No auto-approval) and #4 (Merge after human approval) require that **agents explicitly communicate the approval gate to users**. A technically correct review is not sufficient if the user does not know they must perform the approval step.

### Explicit communication requirement

After completing review and confirming the PR is ready, the agent must:

1. State that human approval is required.
2. Explain why the agent cannot approve (bot identity is not valid for approval decisions).
3. Provide the exact command the user should run.
4. Confirm the PR status shows `REVIEW_REQUIRED` before asking.

### Template

> "This PR is ready for merge but requires your approval. I cannot approve PRs (bot identity is not valid for approval). Please run:
> `gh pr review <N> --approve`
> After you approve, I will merge it."

### Forbidden patterns

Agents must never:
- Post a review comment saying "proceed to merge" without also stating that human approval is required.
- Assume the user knows approval is needed.
- Wait for the user to ask "what's next?" instead of proactively stating the gate.
- Say "ready to merge" while checks are failing or while the PR head is not synchronized.

### PR status check before requesting approval

```bash
gh pr view <N> --json reviewDecision,mergeStateStatus
```

Only request approval when `reviewDecision` is `REVIEW_REQUIRED` and `mergeStateStatus` is `BLOCKED` due to missing approval (not due to failing checks or unresolved review conversations).

---

## Human Approval Definition

Human approval is the human's explicit decision, not the requirement that the human personally open the GitHub PR page. A human may rely on PRMS output, CI status, changed-file summaries, and agent analysis before deciding.

A valid approval for GitHub enforcement still requires a GitHub review from the required human identity, especially for Red Zone CODEOWNER paths. Chat confirmation or an agent message alone is not a CODEOWNER approval.

Agents may prepare evidence and mechanically relay an explicit human decision only when all of these are true:

- the human decision names the PR and states approve or reject;
- the human is authorized and is not approving their own PR;
- the GitHub review is recorded under the human's GitHub identity, not a bot/app/agent identity;
- the review body preserves provenance that the decision came from the human after PRMS/agent analysis;
- PRMS and branch protection still pass.

Agents must treat vague consent, silence, prior approvals, or missing PR numbers as no approval. See `docs/security/human-approval.md`.

---

## Risk Zones

- **Green**
  - Paths: `docs/**`, `templates/**`, `.openslack/tasks/**`, `.openslack/audit/**`,
    `.openslack/self/scorecards/**`, `.openslack/self/experiments/**`
  - Automation: auto-merge eligible after checks. Only explicitly listed Green paths qualify.
- **Yellow**
  - Paths: `apps/**`, `packages/core/**`, `packages/workspace/**`, `packages/runtime/**`,
    `packages/github/**`, `packages/pr/**`, `packages/operator/**`, `packages/chat-gateway/**`,
    `packages/collaboration/**`, `packages/agent-runtime/**`, `packages/tui/**`,
    `packages/workflows/**`, `.openslack/self/eval_suites/**`, and any unmatched path
  - Automation: requires independent agent review and PRMS gates.
- **Red**
  - Paths: `AGENTS.md`, `CLAUDE.md`, `.github/**`, `.openslack/policies/**`,
    `.openslack/agents/registry/**`, `.openslack/agents/prompts/**`,
    `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, `packages/kernel/src/**`
  - Automation: human approval required.
- **Black**
  - Paths: `.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**`, private tokens, production
    credentials
  - Automation: never allowed.

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
- resolve fixed review threads only with explicit reviewer/human authorization
- relay an explicit human approval decision only through an authorized human GitHub identity
- watch checks / approvals
- merge only when `pr doctor` returns `READY_TO_MERGE`

Forbidden agent actions:

- originate approval decisions
- approve under bot/app/agent identity
- bypass rulesets
- resolve active review blockers without evidence and authorization
- merge without valid human approval
- merge Black Zone changes
- merge author/CODEOWNER deadlocks

---

## Repository Cleanliness

Every file must have a clear purpose.

- Do not keep empty stubs "for later."
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

- Do not include `Co-Authored-By:` lines. Exception: `Co-authored-by: openslack-agent-operator[bot]` is allowed when GitHub squash merge appends it for bot-authored PRs. All other Co-authored-by trailers (including copilot[bot], dependabot[bot], or any human attribution) remain prohibited.
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
bun run openslack status
bun run openslack doctor
bun run openslack status verify
```

For full current state, read `docs/status/current.md`.
