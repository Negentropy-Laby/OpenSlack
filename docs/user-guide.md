# OpenSlack User Guide

Complete CLI reference for the OpenSlack Agent Company OS.

## Start With User Goals

| If you want to... | Start with | Notes |
|-------------------|------------|-------|
| Verify a fresh checkout | `openslack setup` | Runs workspace validation, golden evals, GitHub doctor, and genesis validation. |
| Get guided setup with prompts | `openslack setup interactive` | Walks fixable items step by step; supports `--format plain` |
| Run CI-style setup checks | `openslack setup --strict` | Treats warnings as failures. Use this for release or PR validation. |
| Check GitHub readiness without changing anything | `openslack setup github` | Read-only by default. Use `--apply` only for explicit repairs. |
| Ask OpenSlack what to do | `openslack ask "检查系统状态"` | Uses the local keyword router first; LLM fallback is optional. |
| Preview a task before creating an Issue | `openslack task create --title "..." --path "docs/**" --preview` | Preview is the safe first step. Add `--create-issue` only when ready. |
| Let an agent pick up ready work | `openslack agent tick --agent-id <id> --source github-issues` | Requires a registered and bootstrapped agent identity. |
| Diagnose why a PR cannot merge | `openslack pr doctor <n>` | Shows blocker owner, evidence, and next action. |
| See team state across events and PRs | `openslack collaboration dashboard` | Projection-only; does not create dashboard-specific state. |
| Record a handoff or decision | `openslack collaboration handoff ...` / `openslack collaboration decision ...` | Creates auditable collaboration objects. |

## Common Workflows

### 1. Start using OpenSlack on a new checkout

```bash
pnpm openslack setup interactive    # Guided onboarding with step-by-step prompts
pnpm openslack status               # See module status and recommended next steps
pnpm openslack collaboration dashboard  # Check team activity
```

### 2. Create a task for work

```bash
pnpm openslack task create --title "Fix login redirect" --path "packages/kernel/**" --preview
# Review the preview, then:
pnpm openslack task create --title "Fix login redirect" --path "packages/kernel/**" --create-issue
```

### 3. Check if a PR can merge

```bash
pnpm openslack pr doctor 42         # Full 11-gate governance diagnosis
pnpm openslack pr recommend 42      # What to do next
# If ready:
pnpm openslack pr merge 42
```

### 4. See team activity and blockers

```bash
pnpm openslack collaboration dashboard          # Overview with blockers
pnpm openslack collaboration room show pr:42     # Focus on one PR
pnpm openslack collaboration activity --since 8  # Recent events
```

### 5. Hand off work to another agent or human

```bash
pnpm openslack collaboration handoff create \
  --from claude --to codex \
  --context "Refactoring auth middleware, 3 files remain" \
  --steps "Complete auth refactor,Run tests,Open PR" \
  --pr 42
```

### 6. Run a workflow template

```bash
pnpm openslack collaboration workflow preview <file> --input issue_number=7
# Review the preview, then:
pnpm openslack collaboration workflow execute <file> --input issue_number=7
```

Use an existing workflow YAML file path for `<file>`.

## Quick Reference by Role

### New Team Member

First actions: understand the workspace and check status.

```bash
pnpm openslack setup interactive     # Guided onboarding
pnpm openslack status                # What's happening
pnpm openslack collaboration digest  # Recent summary
```

### Task Creator

Create, track, and manage issues.

```bash
pnpm openslack task create --title "..." --preview   # Preview before creating
pnpm openslack task create --title "..." --create-issue  # Create on GitHub
pnpm openslack github metrics                         # Check task loop health
```

### PR Reviewer

Diagnose and approve PRs.

```bash
pnpm openslack pr doctor <n>          # Full governance diagnosis
pnpm openslack pr recommend <n>       # Next action
pnpm openslack pr review <n> --comment  # Post review as PR comment
pnpm openslack pr queue               # All open PRs by readiness
```

### Agent Operator

Manage agent lifecycle and task claiming.

```bash
pnpm openslack agent hire --agent-id <id>    # Generate onboarding package
pnpm openslack agent bootstrap --agent-id <id>  # Verify readiness
pnpm openslack agent tick --agent-id <id> --source github-issues  # Claim work
```

### Repository Admin

Governance, branch protection, and workspace health.

```bash
pnpm openslack governance audit              # Check direct-push compliance
pnpm openslack governance audit --count 50   # Wider audit scope
pnpm openslack setup github --repair-labels --apply  # Fix missing labels
pnpm openslack status generate && pnpm openslack status verify  # Sync docs
```

## Understanding Output Formats

Several commands support a `--format` option:

| Format | When to use | Example |
|--------|-------------|---------|
| `standard` (default) | Human-readable terminal output | `openslack pr doctor 42` |
| `plain` | Plain language with status/owner/next-action; good for logs and CI | `openslack pr doctor 42 --format plain` |
| `tui` | Interactive terminal UI with keyboard navigation; requires TTY | `openslack collaboration dashboard --format tui` |
| `json` | Structured data for scripting or piping | (Coming in future release) |

Commands with `--format plain`:

- `openslack pr doctor <n> --format plain`
- `openslack doctor --format plain`
- `openslack setup interactive --format plain`
- `openslack collaboration dashboard --format plain`
- `openslack collaboration activity --format plain`
- `openslack collaboration digest --format plain`
- `openslack collaboration room show <id> --format plain`
- `openslack governance audit --format plain`

Commands with `--format tui`:

- `openslack collaboration dashboard --format tui` — Interactive team dashboard with blockers, handoffs, decisions
- `openslack collaboration room show <id> --format tui` — Focused room view for a PR or issue
- `openslack pr doctor <n> --format tui` — Interactive PR governance diagnosis with gates, checks, reviews
- `openslack setup interactive --format tui` — Read-only setup report TUI with readiness classification

TUI views use q or Esc to exit. They require a terminal with at least 40 columns and 12 rows, and are disabled in CI, when `NO_COLOR` is set, or when `OPENSLACK_TUI=0`.

## Safety Defaults

- Setup and repair commands are read-only or preview-first unless `--apply` is supplied.
- Task creation previews by default; GitHub Issue creation requires `--create-issue`.
- PRs for OpenSlack-authored or delegated agent work must be opened under the configured bot/agent GitHub author identity so humans remain independent reviewers.
- PR author means the GitHub account that opened the PR, not only the commit author. A bot-authored commit inside a human-created PR is still a human-created PR.
- Human approval can be based on OpenSlack's PRMS/agent summary; the human does not need to manually browse the PR page.
- Chat confirmation alone is not GitHub approval; CODEOWNER gates still require a GitHub review from the human identity.
- Agents cannot decide PR approval, approve under bot/app/agent identity, bypass CODEOWNERS, or merge without PRMS and GitHub gates.
- Agent-scoped mutating commands require `--agent-id` and an authorized runtime identity.

### PR Author Identity Quick Rule

Use the configured bot/agent GitHub identity to open the PR whenever the implementation was produced by Codex, Claude, another OpenSlack agent, or delegated automation. Use a human account only for work that was genuinely human-produced and will be reviewed or approved by another independent human.

Before creating an agent-delivered PR:

1. Check that the active PR-creation credential is the bot/agent identity, not the human `gh` login.
2. Create the PR with the bot/agent credential path documented in `docs/developer/github-automation.md`.
3. Put the acting agent or automation path, risk zone, validation run, rollback plan, and human-approval requirement in the PR body.
4. If the PR was accidentally opened by the human who must review or approve it, close and recreate it as bot/agent-authored, or have a different independent human approve it.

After updating an existing PR branch, do not request re-review until the PR head
has synchronized:

```powershell
$branchSha = (git ls-remote origin "refs/heads/<branch>").Split()[0]
$prSha = gh pr view <pr> --json headRefOid --jq ".headRefOid"
if ($branchSha -ne $prSha) { throw "PR head is stale" }
gh pr checks <pr>
```

The branch SHA, PR `headRefOid`, and check runs must refer to the same commit.
If they differ, wait and retry; if they still differ, push a new bot-authored
repair/no-op commit to the actual PR branch or recreate the PR. Do not enter
approval on stale PR checks.

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
| `openslack setup interactive --format tui` | Read-only setup report TUI with readiness classification |

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
| `openslack pr doctor <n> --format tui` | Interactive PR doctor view (q/Esc to exit) |
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
| `openslack collaboration dashboard --format tui` | Interactive team dashboard (q/Esc to exit) |
| `openslack collaboration room show pr:42` | Show room summary for an object |
| `openslack collaboration room show pr:42 --format tui` | Interactive room view (q/Esc to exit) |
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
