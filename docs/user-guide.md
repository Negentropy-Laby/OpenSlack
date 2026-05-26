# OpenSlack User Guide

Complete CLI reference for the OpenSlack Agent Company OS.

## Start With User Goals

| If you want to... | Start with | Notes |
|-------------------|------------|-------|
| Verify a fresh checkout | `openslack setup` | Runs workspace validation, golden evals, GitHub doctor, and genesis validation. |
| Run CI-style setup checks | `openslack setup --strict` | Treats warnings as failures. Use this for release or PR validation. |
| Check GitHub readiness without changing anything | `openslack setup github` | Read-only by default. Use `--apply` only for explicit repairs. |
| Ask OpenSlack what to do | `openslack ask "检查系统状态"` | Uses the local keyword router first; LLM fallback is optional. |
| Preview a task before creating an Issue | `openslack task create --title "..." --path "docs/**" --preview` | Preview is the safe first step. Add `--create-issue` only when ready. |
| Let an agent pick up ready work | `openslack agent tick --agent-id <id> --source github-issues` | Requires a registered and bootstrapped agent identity. |
| Diagnose why a PR cannot merge | `openslack pr doctor <n>` | Shows blocker owner, evidence, and next action. |
| See team state across events and PRs | `openslack collaboration dashboard` | Projection-only; does not create dashboard-specific state. |
| Record a handoff or decision | `openslack collaboration handoff ...` / `openslack collaboration decision ...` | Creates auditable collaboration objects. |

## Safety Defaults

- Setup and repair commands are read-only or preview-first unless `--apply` is supplied.
- Task creation previews by default; GitHub Issue creation requires `--create-issue`.
- PRs for OpenSlack-authored or delegated agent work should be opened under the configured bot/agent GitHub author identity so humans remain independent reviewers.
- Human approval can be based on OpenSlack's PRMS/agent summary; the human does not need to manually browse the PR page.
- Chat confirmation alone is not GitHub approval; CODEOWNER gates still require a GitHub review from the human identity.
- Agents cannot decide PR approval, approve under bot/app/agent identity, bypass CODEOWNERS, or merge without PRMS and GitHub gates.
- Agent-scoped mutating commands require `--agent-id` and an authorized runtime identity.

## Setup

| Command | Purpose |
|---------|---------|
| `openslack setup` | One-step full workspace validation (alt: `openslack setup run`) |
| `openslack setup --strict` | Run setup and fail on warnings as well as critical failures |
| `openslack setup run --strict` | Run the full checklist with CI-style strict warning handling |
| `openslack setup smoke` | Run read-only smoke checks with GitHub setup warnings non-blocking |
| `openslack setup smoke --strict` | Run smoke checks and fail on warnings |
| `openslack setup github` | Read-only setup report for GitHub auth, labels, CODEOWNERS, rulesets, and local prerequisites |
| `openslack setup github --repair-labels` | Preview required OpenSlack label repair |
| `openslack setup github --repair-labels --apply` | Apply required OpenSlack label repair |

## Workspace

| Command | Purpose |
|---------|---------|
| `openslack workspace validate` | Validate Self-Project workspace |
| `openslack workspace index` | Build index from `.openslack/` plain text |
| `openslack workspace status` | Show workspace summary |

## Self-Evolution (OSEK)

| Command | Purpose |
|---------|---------|
| `openslack self classify-pr --paths "..."` | Classify PR risk zone |
| `openslack self validate --pr <n> --paths "..."` | Full PR validation + manifest |
| `openslack self eval --suite golden` | Run golden evals (add `--clean` to remove artifacts) |
| `openslack self observe` | Check system health |
| `openslack self triage --create-issues` | Create EVOL task issues on GitHub |
| `openslack self review --pr <n>` | Review PR for merge eligibility |
| `openslack self scorecard --experiment <id>` | Compute fitness score |
| `openslack self monitor --experiment <id>` | Post-merge regression check |

## Agent

| Command | Purpose |
|---------|---------|
| `openslack agent hire --agent-id <id>` | Generate onboarding package |
| `openslack agent bootstrap --agent-id <id>` | Verify agent readiness |
| `openslack agent tick --agent-id <id> --source github-issues` | Claim a task from GitHub |

## Task

| Command | Purpose |
|---------|---------|
| `openslack task create --title "..."` | Preview a schema-valid GitHub Issue task |
| `openslack task create --template bugfix --title "..." --path "packages/**"` | Preview a task from a product template |
| `openslack task create --title "..." --create-issue` | Create the GitHub Issue after validation |
| `openslack task checkout --issue-number <n> --agent-id <id>` | Create isolated worktree |
| `openslack task sync --agent-id <id> --task-id <id> --run-id <id> --paths "..."` | Commit + push + create draft PR |
| `openslack task repair worktrees` | Preview orphaned local worktree cleanup |
| `openslack task repair worktrees --apply` | Apply orphaned local worktree cleanup |

## GitHub

| Command | Purpose |
|---------|---------|
| `openslack github doctor` | Check GitHub setup |
| `openslack github repair labels` | Preview required label repair |
| `openslack github repair labels --apply` | Apply required label repair |
| `openslack github repair claims` | Preview stale claim repair |
| `openslack github repair claims --apply` | Apply stale claim repair |
| `openslack github repair all` | Preview all GitHub repairs |
| `openslack github repair all --apply` | Apply all GitHub repairs |
| `openslack github repair-labels` | Compatibility alias for label repair; default is dry-run |
| `openslack github repair-claims` | Compatibility alias for claim repair; default is dry-run |
| `openslack github repair-all` | Compatibility alias for all GitHub repairs; default is dry-run |
| `openslack github metrics` | Task loop metrics |
| `openslack github issue-done --issue-number <n>` | Release claim + mark done |

## PR Review & Merge Steward (PRMS)

| Command | Purpose |
|---------|---------|
| `openslack pr status <n>` | Show PR status and merge readiness |
| `openslack pr review <n>` | Generate review report for a PR |
| `openslack pr review <n> --comment` | Post review report as PR comment |
| `openslack pr recommend <n>` | Recommend next action for a PR |
| `openslack pr doctor <n>` | Run governance diagnosis (11 gates) |
| `openslack pr doctor <n> --comment` | Post doctor report as PR comment |
| `openslack pr queue` | Show open PRs sorted by readiness and blocker owner |
| `openslack pr watch <n>` | Poll PR status until ready or timeout |
| `openslack pr merge <n>` | Merge PR after all gates pass |

## Operator

| Command | Purpose |
|---------|---------|
| `openslack operator ask "..."` | Natural language → CLI routing |
| `openslack operator ask "..." --plan` | Show execution plan without running |
| `openslack ask plan list` | List pending Operator plans |
| `openslack ask plan show <id>` | Show a pending Operator plan |
| `openslack ask plan resume <id> --set prNumber=42` | Fill clarification slots and re-plan |
| `openslack ask plan approve <id>` | Approve and execute a pending Operator plan |
| `openslack ask plan cancel <id>` | Cancel a pending Operator plan |

Known requests use the built-in keyword router. Unknown or low-confidence requests
may use the optional LLM fallback when `OPENSLACK_LLM_PROVIDER`,
`OPENSLACK_LLM_MODEL`, and `OPENSLACK_LLM_API_KEY` are configured. LLM output is
restricted to registered OpenSlack actions; raw shell commands are rejected.

## Chat Gateway

| Command | Purpose |
|---------|---------|
| `openslack chat start --adapter webhook --port 3000` | Start generic webhook chat adapter |
| `openslack chat start --adapter webhook --port 3000 --secret <secret>` | Start webhook adapter with HMAC signature verification |
| `openslack chat start --adapter slack --port 3000 --secret <signing-secret>` | Start Slack Events API adapter |

Chat Gateway is projection-only. GitHub/Git/.openslack remain the sole source of truth. Slack confirmation can carry an explicit human decision, but it is not by itself a GitHub CODEOWNER approval.

Actor mappings are loaded from `GatewayConfig.actorMappingPath` when configured.
Unmapped users are read-only by default. PRMS chat cards render compact PR
doctor summaries in chat. Blocked PRs show the blocker, owner, reason, and next
step. Ready PRs display a Confirm merge button.

## Status & Health

| Command | Purpose |
|---------|---------|
| `openslack status` | Product dashboard with modules and GitHub ops |
| `openslack status generate` | Generate `docs/status/current.md` |
| `openslack status verify` | Verify consistency across docs |
| `openslack doctor` | Multi-module health check |

## Collaboration Layer

| Command | Purpose |
|---------|---------|
| `openslack collaboration activity` | Show collaboration activity feed |
| `openslack collaboration activity --since 24` | Filter events from last N hours |
| `openslack collaboration activity --object pr:42` | Filter by object |
| `openslack collaboration digest` | Show grouped event summary |
| `openslack collaboration digest --since 24` | Digest for last N hours |
| `openslack collaboration handoff create --from claude --to codex --context "..."` | Create a handoff |
| `openslack collaboration handoff list` | List all handoffs |
| `openslack collaboration handoff show <id>` | Show a handoff |
| `openslack collaboration handoff accept <id>` | Accept a handoff |
| `openslack collaboration handoff close <id>` | Close a handoff |
| `openslack collaboration decision record --topic "..." --decision "..." --rationale "..." --by claude` | Record a decision |
| `openslack collaboration decision list` | List all decisions |
| `openslack collaboration decision show <id>` | Show a decision |
| `openslack collaboration decision supersede <id> --by <new-id>` | Supersede a decision |
| `openslack collaboration dashboard` | Show projection-only team dashboard |
| `openslack collaboration dashboard --since 0` | Show dashboard over all recorded events |
| `openslack collaboration room show pr:42` | Show room summary for an object |
| `openslack collaboration workflow preview <file>` | Preview a typed workflow template |
| `openslack collaboration workflow preview <file> --input pr_number=42` | Preview with template inputs |
| `openslack collaboration workflow execute <file> --dry-run` | Validate and dry-run a workflow template |
| `openslack collaboration workflow execute <file> --agent-id <id>` | Execute with agent principal authorization |

The Collaboration Layer is projection-only. GitHub/Git/.openslack remain the sole source of truth. Activity feed, digest, handoffs, decisions, and room views are all derived from events and YAML files.

## Governance

| Command | Purpose |
|---------|---------|
| `openslack governance audit` | Audit recent main commits for direct-push compliance |
| `openslack governance audit --count <n>` | Audit last N commits |
