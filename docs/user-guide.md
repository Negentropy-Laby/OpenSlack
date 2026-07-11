# OpenSlack User Guide

Complete CLI reference for the OpenSlack Agent Company OS.

## Start With User Goals

| If you want to...                                | Start with                                                                     | Notes                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Verify a fresh checkout                          | `openslack setup`                                                              | Runs workspace, golden, GitHub, genesis, and agent-runtime readiness checks.       |
| Get guided setup with prompts                    | `openslack setup interactive`                                                  | Walks fixable items step by step; supports `--format plain`                        |
| Run CI-style setup checks                        | `openslack setup --strict`                                                     | Treats warnings as failures. Use this for release or PR validation.                |
| Check GitHub readiness without changing anything | `openslack setup github`                                                       | Read-only by default. Use `--apply` only for explicit repairs.                     |
| Ask OpenSlack what to do                         | `openslack ask "检查系统状态"`                                                 | Uses LLM-first routing when configured; otherwise uses the keyword router.         |
| Preview a task before creating an Issue          | `openslack task create --title "..." --path "docs/**" --preview`               | Preview is the safe first step. Add `--create-issue` only when ready.              |
| Let an agent pick up ready work                  | `openslack agent tick --agent-id <id> --source github-issues`                  | Requires a registered and bootstrapped agent identity.                             |
| Diagnose an Aby external runtime                 | `openslack agent-runtime doctor --provider aby`                                | Checks local bridge configuration without launching a task.                        |
| Configure an Aby external runtime                | `openslack agent-runtime setup aby --root <path> --write`                      | Writes local gitignored bridge config after validation.                            |
| Configure the built-in model runtime             | `openslack agent-runtime setup openai-compatible ...`                          | Preview-first; writes only endpoint, model, limits, and a credential reference.    |
| Diagnose why a PR cannot merge                   | `openslack pr doctor <n>`                                                      | Shows blocker owner, evidence, and next action.                                    |
| See team state across events and PRs             | `openslack collaboration dashboard`                                            | Projection-only; does not create dashboard-specific state.                         |
| Record a handoff or decision                     | `openslack collaboration handoff ...` / `openslack collaboration decision ...` | Creates auditable collaboration objects.                                           |
| Keep the org profile in sync                     | `openslack collaboration workflow profile-sync check`                          | Profile Sync Robot checks and previews are read-only; `run` requires confirmation. |
| Start a conversation with an agent               | `openslack conversation start --title "..."`                                   | Creates a typed thread with JSONL persistence and secret scanning.                 |

## Common Workflows

### 1. Start using OpenSlack on a new checkout

```bash
bun run openslack setup interactive    # Guided onboarding with step-by-step prompts
bun run openslack status               # See module status and recommended next steps
bun run openslack tui                  # Open the conversation-first workbench
```

### 2. Create a task for work

```bash
bun run openslack task create --title "Fix login redirect" --path "packages/kernel/**" --preview
# Review the preview, then:
bun run openslack task create --title "Fix login redirect" --path "packages/kernel/**" --create-issue
```

### 3. Check if a PR can merge

```bash
bun run openslack pr doctor 42         # Full 11-gate governance diagnosis
bun run openslack pr recommend 42      # What to do next
# If ready:
bun run openslack pr merge 42
```

If GitHub reports that base branch policy blocks the merge, check unresolved
review conversations first, then confirm that the latest human approval was not
dismissed by a newer commit.

### 4. See team activity and blockers

```bash
bun run openslack collaboration dashboard          # Overview with blockers
bun run openslack collaboration room show pr:42     # Focus on one PR
bun run openslack collaboration activity --since 8  # Recent events
```

### 5. Hand off work to another agent or human

```bash
bun run openslack collaboration handoff create \
  --from claude --to codex \
  --context "Refactoring auth middleware, 3 files remain" \
  --steps "Complete auth refactor,Run tests,Open PR" \
  --pr 42
```

### 6. Start a workflow

```bash
bun run openslack collaboration workflow start --prompt "verify this migration end to end"
bun run openslack collaboration workflow catalog
bun run openslack collaboration workflow runs
```

Use `workflow start --prompt` as the default path for new workflow work. Use `catalog` to choose known orchestration patterns and `runs` to inspect running, paused, or completed workflow evidence.

Advanced file workflow path:

```bash
bun run openslack collaboration workflow preview <file> --input issue_number=7
bun run openslack collaboration workflow dry-run <file> --input issue_number=7
bun run openslack collaboration workflow run <file> --input issue_number=7
```

Use an existing workflow YAML or JS module path for `<file>`. Use `dry-run` to simulate side effects safely; use `run` to execute with real side effects.

### 7. Maintain organization profile

The Profile Sync Robot keeps the organization's GitHub profile README in sync with an upstream whitepapers or content repository. All commands are safe by default: `check` and `preview` are read-only, and `run` requires explicit confirmation.

```bash
openslack collaboration workflow profile-sync check        # Verify source and target are accessible
openslack collaboration workflow profile-sync preview       # Preview what a sync would change (no side effects)
openslack collaboration workflow profile-sync run           # Run sync and open a PR (prompts for confirmation)
openslack collaboration workflow profile-sync status        # Show last sync date and pending PR
```

Start with `check` to confirm readiness, then `preview` to review the proposed changes, and `run` only when you are ready for real side effects.

## Quick Reference by Role

### New Team Member

First actions: understand the workspace and check status.

```bash
bun run openslack setup interactive     # Guided onboarding
bun run openslack status                # What's happening
bun run openslack collaboration digest  # Recent summary
```

### Task Creator

Create, track, and manage issues.

```bash
bun run openslack task create --title "..." --preview   # Preview before creating
bun run openslack task create --title "..." --create-issue  # Create on GitHub
bun run openslack github metrics                         # Check task loop health
```

### PR Reviewer

Diagnose and approve PRs.

```bash
bun run openslack pr doctor <n>          # Full governance diagnosis
bun run openslack pr recommend <n>       # Next action
bun run openslack pr review <n> --comment  # Post review as PR comment
bun run openslack pr queue               # All open PRs by readiness
```

### Agent Operator

Manage agent lifecycle and task claiming.

```bash
bun run openslack agent hire --agent-id <id>    # Generate onboarding package
bun run openslack agent bootstrap --agent-id <id>  # Verify readiness
bun run openslack agent tick --agent-id <id> --source github-issues  # Claim work
bun run openslack agent-runtime doctor --provider aby  # Diagnose Aby bridge config
bun run openslack agent-runtime doctor --provider openai-compatible  # Diagnose built-in provider
```

### Repository Admin

Governance, branch protection, and workspace health.

```bash
bun run openslack governance audit              # Check direct-push compliance
bun run openslack governance audit --count 50   # Wider audit scope
bun run openslack setup github --repair-labels --apply  # Fix missing labels
bun run openslack status generate && bun run openslack status verify  # Sync docs
```

## Understanding Output Formats

Several commands support a `--format` option:

| Format               | When to use                                                        | Example                                 |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `standard` (default) | Human-readable terminal output                                     | `openslack pr doctor 42`                |
| `plain`              | Plain language with status/owner/next-action; good for logs and CI | `openslack pr doctor 42 --format plain` |
| `tui`                | Interactive terminal UI with keyboard navigation; requires TTY     | `openslack tui`                         |
| `json`               | Structured data for scripting or piping                            | (Coming in future release)              |

Commands with `--format plain`:

- `openslack agent-runtime doctor --provider aby --format plain`
- `openslack pr doctor <n> --format plain`
- `openslack doctor --format plain`
- `openslack setup interactive --format plain`
- `openslack collaboration dashboard --format plain`
- `openslack collaboration activity --format plain`
- `openslack collaboration digest --format plain`
- `openslack collaboration room show <id> --format plain`
- `openslack governance audit --format plain`

Commands with `--format tui`:

- `openslack agent-runtime doctor --provider aby --format tui` — Interactive runtime diagnostics view
- `openslack tui` — Conversation-first workbench for Ask OpenSlack, workflows, PRs, approvals, profile sync, and subagent mentions
- `openslack collaboration dashboard --format tui` — Interactive team dashboard with blockers, handoffs, decisions
- `openslack collaboration room show <id> --format tui` — Focused room view for a PR or issue
- `openslack pr doctor <n> --format tui` — Interactive PR governance diagnosis with gates, checks, reviews
- `openslack setup interactive --format tui` — Read-only setup report TUI with readiness classification

`openslack tui` opens with `Ask OpenSlack:` focused. Normal natural language asks are routed through the Operator planner and produce safe recommendations/action cards instead of executing side effects. `@agent-id prompt` dispatches through the existing conversation subagent path. Ask results and card actions are written to the current workbench conversation thread.

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

| Command                                          | Purpose                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `openslack setup`                                | Full workspace validation plus explicit agent-runtime readiness (alt: `openslack setup run`)  |
| `openslack setup --strict`                       | Run setup and fail on warnings as well as critical failures                                   |
| `openslack setup run --strict`                   | Run the full checklist with CI-style strict warning handling                                  |
| `openslack setup smoke`                          | Run read-only smoke checks with GitHub setup warnings non-blocking                            |
| `openslack setup smoke --strict`                 | Run smoke checks and fail on warnings                                                         |
| `openslack setup github`                         | Read-only setup report for GitHub auth, labels, CODEOWNERS, rulesets, and local prerequisites |
| `openslack setup github --repair-labels`         | Preview required OpenSlack label repair                                                       |
| `openslack setup github --repair-labels --apply` | Apply required OpenSlack label repair                                                         |
| `openslack setup interactive --format tui`       | Read-only setup report TUI with readiness classification                                      |

## Workspace

| Command                        | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `openslack workspace validate` | Validate Self-Project workspace           |
| `openslack workspace index`    | Build index from `.openslack/` plain text |
| `openslack workspace status`   | Show workspace summary                    |

## Self-Evolution (OSEK)

| Command                                          | Purpose                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| `openslack self classify-pr --paths "..."`       | Classify PR risk zone                                |
| `openslack self validate --pr <n> --paths "..."` | Full PR validation + manifest                        |
| `openslack self eval --suite golden`             | Run golden evals (add `--clean` to remove artifacts) |
| `openslack self observe`                         | Check system health                                  |
| `openslack self triage --create-issues`          | Create EVOL task issues on GitHub                    |
| `openslack self review --pr <n>`                 | Review PR for merge eligibility                      |
| `openslack self scorecard --experiment <id>`     | Compute fitness score                                |
| `openslack self monitor --experiment <id>`       | Post-merge regression check                          |

## Agent

| Command                                                       | Purpose                     |
| ------------------------------------------------------------- | --------------------------- |
| `openslack agent hire --agent-id <id>`                        | Generate onboarding package |
| `openslack agent bootstrap --agent-id <id>`                   | Verify agent readiness      |
| `openslack agent tick --agent-id <id> --source github-issues` | Claim a task from GitHub    |

## Agent Runtime

| Command                                                                                                                | Purpose                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `openslack agent-runtime setup aby --root <path> --dry-run`                                                            | Preview the local Aby bridge configuration without writing it                                                       |
| `openslack agent-runtime setup aby --root <path> --write`                                                              | Validate and write `.openslack.local/agent-runtime.json`                                                            |
| `openslack agent-runtime setup openai-compatible --base-url <url> --model <model> --credential-ref env:<NAME>`         | Preview non-secret built-in provider configuration                                                                  |
| `openslack agent-runtime setup openai-compatible --base-url <url> --model <model> --credential-ref env:<NAME> --write` | Merge the non-secret provider config into `.openslack.local/agent-runtime.json`                                     |
| `openslack agent-runtime doctor --provider aby`                                                                        | Diagnose runtime readiness as `not_configured`, `misconfigured`, `unavailable`, or `ready` without launching a task |
| `openslack agent-runtime doctor --provider openai-compatible`                                                          | Validate config and credential reference, then probe the compatible `/models` endpoint                              |
| `openslack agent-runtime doctor --provider openai-compatible --format json`                                            | Emit redacted structured diagnostics for scripting                                                                  |
| `openslack agent-runtime doctor --provider aby --format json`                                                          | Emit redacted structured diagnostics for scripting                                                                  |
| `openslack agent-runtime smoke --provider aby`                                                                         | Run a read-only bridge smoke through the existing launcher                                                          |
| `openslack agent-runtime smoke --provider aby --agent <agentId>`                                                       | Smoke a specific Aby-backed agent id                                                                                |
| `openslack agent-runtime smoke --provider openai-compatible`                                                           | Execute one governed, read-only Chat Completions smoke and persist terminal run evidence                            |
| `openslack agent-runtime mcp status --provider aby --agent <agentId>`                                                  | Show required/available MCP descriptor status for an agent                                                          |
| `openslack agent-runtime mcp status --provider aby --run <runId>`                                                      | Show MCP tool evidence from a run transcript                                                                        |

Aby is a configurable external provider, not a bundled OpenSlack backend. See
`docs/guides/aby-integration.md` for setup and smoke-test steps.
Agent calls fail with `RUNTIME_NOT_CONFIGURED` until an execution provider is
selected and ready; OpenSlack never substitutes placeholder output.

The built-in `openai-compatible` provider uses Chat Completions tool calls and
exposes only `repo.read`, `repo.search`, `repo.apply_patch`, and `repo.diff` after
permission filtering. It never exposes an unrestricted shell. Write-capable runs
are isolated in disposable Git worktrees; dirty worktrees are preserved as
recoverable handoffs. `plan` and `strict` are read-only, and provider-driven Red
Zone writes are always rejected. See `docs/guides/openai-compatible-runtime.md`
for the configuration and agent-registry contract.

## Task

| Command                                                                          | Purpose                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| `openslack task create --title "..."`                                            | Preview a schema-valid GitHub Issue task |
| `openslack task create --template bugfix --title "..." --path "packages/**"`     | Preview a task from a product template   |
| `openslack task create --title "..." --create-issue`                             | Create the GitHub Issue after validation |
| `openslack task checkout --issue-number <n> --agent-id <id>`                     | Create isolated worktree                 |
| `openslack task sync --agent-id <id> --task-id <id> --run-id <id> --paths "..."` | Commit + push + create draft PR          |
| `openslack task repair worktrees`                                                | Preview orphaned local worktree cleanup  |
| `openslack task repair worktrees --apply`                                        | Apply orphaned local worktree cleanup    |

## GitHub

| Command                                          | Purpose                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `openslack github doctor`                        | Check GitHub setup                                             |
| `openslack github repair labels`                 | Preview required label repair                                  |
| `openslack github repair labels --apply`         | Apply required label repair                                    |
| `openslack github repair claims`                 | Preview stale claim repair                                     |
| `openslack github repair claims --apply`         | Apply stale claim repair                                       |
| `openslack github repair all`                    | Preview all GitHub repairs                                     |
| `openslack github repair all --apply`            | Apply all GitHub repairs                                       |
| `openslack github repair-labels`                 | Compatibility alias for label repair; default is dry-run       |
| `openslack github repair-claims`                 | Compatibility alias for claim repair; default is dry-run       |
| `openslack github repair-all`                    | Compatibility alias for all GitHub repairs; default is dry-run |
| `openslack github metrics`                       | Task loop metrics                                              |
| `openslack github issue-done --issue-number <n>` | Release claim + mark done                                      |

## PR Review & Merge Steward (PRMS)

| Command                                                    | Purpose                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `openslack pr status <n>`                                  | Show PR status and merge readiness                                         |
| `openslack pr review <n>`                                  | Generate review report for a PR                                            |
| `openslack pr review <n> --comment`                        | Post review report as PR comment                                           |
| `openslack pr recommend <n>`                               | Recommend next action for a PR                                             |
| `openslack pr doctor <n>`                                  | Run governance diagnosis (11 gates)                                        |
| `openslack pr doctor <n> --repo owner/name`                | Diagnose a PR in an explicit repository                                    |
| `openslack pr doctor <n> --auth auto\|app\|token\|dry-run` | Select the GitHub evidence mode                                            |
| `openslack pr doctor <n> --dry-run`                        | Show the simulated diagnosis plan only; no governance decision is produced |
| `openslack pr doctor <n> --format tui`                     | Interactive PR doctor view (q/Esc to exit)                                 |
| `openslack pr doctor <n> --comment`                        | Post doctor report as PR comment                                           |
| `openslack pr workflow-evidence --base <sha> --head <sha>` | Compute deterministic evidence for governed workflow artifacts             |
| `openslack pr workflow-governance <n>`                     | Bot-create the single Governance Issue required for a new or core artifact |
| `openslack pr queue`                                       | Show open PRs sorted by readiness and blocker owner                        |
| `openslack pr watch <n>`                                   | Poll PR status until ready or timeout                                      |
| `openslack pr merge <n>`                                   | Merge PR after all gates pass                                              |

`pr doctor` requires live GitHub evidence by default. If no supported credential
is configured, it exits with `AUTH_REQUIRED` instead of producing a dry-run
governance report. Use `--dry-run` only when you want simulation output; dry-run
reports are marked `Decision: NOT_EVALUATED` and must not be used for merge
readiness.

Direct `bun run openslack pr doctor <n>` reads explicit environment credentials
only. It does not read `.openslack.local\github-app.pem` and does not reuse the
human `gh` keyring login. For GitHub App bot-authenticated diagnosis, use:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\openslack-bot.ps1 pr doctor <n>
```

Posting doctor reports with `--comment` is a PR mutation and requires GitHub App
bot authentication. Token or human-authenticated diagnosis may be used for
read-only evidence only.

Workflow Trust is evaluated only for tracked workflow artifacts, not for the
workflow engine, tests, or fixtures. One current-head human review records both
merge approval and the trust decision:

```bash
gh pr review <n> --approve --body "Workflow-Trust: trusted"
```

Use `untrusted` to retain read-only runtime restrictions. `core` is limited to
builtins/catalog/pattern artifacts and requires a CODEOWNER review. New or core
artifacts also require one bot-created `Workflow governance #N`; existing
non-core artifact updates use the PR itself as the governance record. Evidence
hashes are computed from base/head Git trees and never need to be copied into
the PR body manually.

For local bot-authenticated PRMS diagnosis or Merge Steward execution, use the
fixed GitHub App wrapper pipeline instead of reading credentials manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber <n>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber <n> -Merge -Method merge
```

The pipeline reads `.openslack.local\github-app.pem` only inside the wrapper
process. Add `-Merge` only after required human approval is recorded; Merge
Steward still re-runs PRMS and blocks unless all gates pass.

## Operator

| Command                                            | Purpose                                     |
| -------------------------------------------------- | ------------------------------------------- |
| `openslack operator ask "..."`                     | Natural language → CLI routing              |
| `openslack operator ask "..." --plan`              | Show execution plan without running         |
| `openslack ask plan list`                          | List pending Operator plans                 |
| `openslack ask plan show <id>`                     | Show a pending Operator plan                |
| `openslack ask plan resume <id> --set prNumber=42` | Fill clarification slots and re-plan        |
| `openslack ask plan approve <id>`                  | Approve and execute a pending Operator plan |
| `openslack ask plan cancel <id>`                   | Cancel a pending Operator plan              |

When an LLM provider is configured (`OPENSLACK_LLM_PROVIDER`, `OPENSLACK_LLM_MODEL`, `OPENSLACK_LLM_API_KEY`), OpenSlack uses LLM-first intent classification. The deterministic keyword router serves as fallback when the LLM is unavailable or returns an invalid response. Without LLM configuration, all routing uses the keyword router. LLM output is restricted to registered OpenSlack actions; raw shell commands are rejected.

## Chat Gateway

| Command                                                                      | Purpose                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `openslack chat start --adapter webhook --port 3000`                         | Start generic webhook chat adapter                     |
| `openslack chat start --adapter webhook --port 3000 --secret <secret>`       | Start webhook adapter with HMAC signature verification |
| `openslack chat start --adapter slack --port 3000 --secret <signing-secret>` | Start Slack Events API adapter                         |

Chat Gateway is projection-only. GitHub/Git/.openslack remain the sole source of truth. Slack confirmation can carry an explicit human decision, but it is not by itself a GitHub CODEOWNER approval.

Actor mappings are loaded from `GatewayConfig.actorMappingPath` when configured.
Unmapped users are read-only by default. PRMS chat cards render compact PR
doctor summaries in chat. Blocked PRs show the blocker, owner, reason, and next
step. Ready PRs display a Confirm merge button.

## Status & Health

| Command                     | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `openslack status`          | Product dashboard with modules and GitHub ops |
| `openslack status generate` | Generate `docs/status/current.md`             |
| `openslack status verify`   | Verify consistency across docs                |
| `openslack doctor`          | Multi-module health check                     |

## Collaboration Layer

| Command                                                                                                | Purpose                                               |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `openslack collaboration activity`                                                                     | Show collaboration activity feed                      |
| `openslack collaboration activity --since 24`                                                          | Filter events from last N hours                       |
| `openslack collaboration activity --object pr:42`                                                      | Filter by object                                      |
| `openslack collaboration digest`                                                                       | Show grouped event summary                            |
| `openslack collaboration digest --since 24`                                                            | Digest for last N hours                               |
| `openslack collaboration handoff create --from claude --to codex --context "..."`                      | Create a handoff                                      |
| `openslack collaboration handoff list`                                                                 | List all handoffs                                     |
| `openslack collaboration handoff show <id>`                                                            | Show a handoff                                        |
| `openslack collaboration handoff accept <id>`                                                          | Accept a handoff                                      |
| `openslack collaboration handoff close <id>`                                                           | Close a handoff                                       |
| `openslack collaboration decision record --topic "..." --decision "..." --rationale "..." --by claude` | Record a decision                                     |
| `openslack collaboration decision list`                                                                | List all decisions                                    |
| `openslack collaboration decision show <id>`                                                           | Show a decision                                       |
| `openslack collaboration decision supersede <id> --by <new-id>`                                        | Supersede a decision                                  |
| `openslack collaboration dashboard`                                                                    | Show projection-only team dashboard                   |
| `openslack collaboration dashboard --since 0`                                                          | Show dashboard over all recorded events               |
| `openslack collaboration dashboard --format tui`                                                       | Interactive team dashboard (q/Esc to exit)            |
| `openslack collaboration room show pr:42`                                                              | Show room summary for an object                       |
| `openslack collaboration room show pr:42 --format tui`                                                 | Interactive room view (q/Esc to exit)                 |
| `openslack collaboration workflow preview <file>`                                                      | Preview a typed workflow template                     |
| `openslack collaboration workflow preview <file> --input pr_number=42`                                 | Preview with template inputs                          |
| `openslack collaboration workflow dry-run <name>`                                                      | Simulate workflow execution without real side effects |
| `openslack collaboration workflow dry-run <name> --input key=value`                                    | Dry-run with input values                             |
| `openslack collaboration workflow run <name>`                                                          | Execute a workflow with real side effects             |
| `openslack collaboration workflow run <name> --agent-id <id>`                                          | Execute with agent principal authorization            |

The Collaboration Layer is projection-only. GitHub/Git/.openslack remain the sole source of truth. Activity feed, digest, handoffs, decisions, and room views are all derived from events and YAML files.

## Agent Conversations

Agent Conversations provide structured, observable multi-turn interaction threads
between humans and agents. Threads are stored in `.openslack.local/conversations/`
with JSONL persistence and secret scanning on all messages.

| Command                                                 | Purpose                             |
| ------------------------------------------------------- | ----------------------------------- |
| `openslack conversation start --title "..."`            | Create a new conversation thread    |
| `openslack conversation start --title "..." --pr 42`    | Create thread linked to a PR        |
| `openslack conversation start --title "..." --issue 15` | Create thread linked to an issue    |
| `openslack conversation list`                           | List all conversation threads       |
| `openslack conversation list --status active`           | Filter threads by status            |
| `openslack conversation show <threadId>`                | Show thread details and messages    |
| `openslack conversation send <threadId> <message>`      | Append a user message to a thread   |
| `openslack conversation summarize <threadId>`           | Show thread summary and next action |
| `openslack conversation archive <threadId>`             | Archive a conversation thread       |

Thread IDs follow the format `CONV-YYYYMMDD-XXXXXXXX` (8 random base-36 characters).
Messages support 7 kinds: `user_message`, `agent_response`, `tool_event`, `plan`,
`approval_request`, `decision`, `handoff`.

**Memory policies:** Threads can be created with `--memory-policy local` (default,
24h retention), `project` (7-day retention), or `none` (ephemeral, not persisted).

## Profile Sync Robot

The Profile Sync Robot keeps an organization's public profile (README, blog posts, featured content) in sync with an upstream whitepapers repository. It is read-only by default: `check` and `preview` have no side effects, and `run` requires explicit confirmation or `--yes`.

| Command                                                                   | Purpose                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `openslack collaboration workflow profile-sync check`                     | Check profile sync readiness without side effects                  |
| `openslack collaboration workflow profile-sync preview`                   | Preview what a sync would change (no side effects)                 |
| `openslack collaboration workflow profile-sync preview --format diff`     | Preview changes as a diff                                          |
| `openslack collaboration workflow profile-sync preview --format markdown` | Preview changes as Markdown                                        |
| `openslack collaboration workflow profile-sync run`                       | Run profile sync with real side effects (prompts for confirmation) |
| `openslack collaboration workflow profile-sync run --yes`                 | Run sync and skip interactive confirmation                         |
| `openslack collaboration workflow profile-sync run --agent-id <id>`       | Run sync with agent principal authorization                        |
| `openslack collaboration workflow profile-sync status`                    | Show current profile sync status, last sync date, and pending PR   |

### Options

All profile-sync subcommands accept these configuration override flags. When not provided, values are loaded from `.openslack/profile-sync.yaml`.

| Option                      | Description                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--source <repo>`           | Source whitepapers repository (e.g. `org/whitepapers`)                                                  |
| `--target <repo>`           | Target profile repository (e.g. `org/org.github.io`)                                                    |
| `--path <path>`             | Target README path within the target repo                                                               |
| `--posts <dir>`             | Posts directory in the source repo                                                                      |
| `--marker <name>`           | HTML comment marker name used to identify the injection point                                           |
| `--max <n>`                 | Maximum number of posts to include                                                                      |
| `--on-existing-pr <action>` | Action when an open profile-sync PR already exists: `skip`, `update`, or `create_new` (default: `skip`) |

The `preview` command also accepts `--format <format>` (`diff`, `json`, or `markdown`; default: `diff`).

### Quick Workflow

1. **Check readiness** — confirm source and target are accessible:

   ```bash
   openslack collaboration workflow profile-sync check
   ```

2. **Preview changes** — review what a sync would produce before committing:

   ```bash
   openslack collaboration workflow profile-sync preview --format diff
   ```

3. **Create the sync PR** — run the sync and let it open a pull request:

   ```bash
   openslack collaboration workflow profile-sync run
   ```

4. **View status** — check last sync date, pending PR, and any failures:
   ```bash
   openslack collaboration workflow profile-sync status
   ```

## Workflow Engine

The workflow engine loads, validates, executes, checkpoints, and resumes OpenSlack workflow modules. Workflows are TypeScript/JavaScript files that declare metadata, permissions, and phases, and can run in preview, dry-run, or execute mode.

| Command                                                                                | Purpose                                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `openslack collaboration workflow list`                                                | List all available workflows (YAML templates and JS modules)                           |
| `openslack collaboration workflow show <name>`                                         | Show detailed information about a workflow (phases, inputs, permissions, side effects) |
| `openslack collaboration workflow validate <name>`                                     | Validate a workflow template or JS module by name                                      |
| `openslack collaboration workflow preview <file>`                                      | Preview a YAML workflow template without executing it                                  |
| `openslack collaboration workflow preview <file> --input key=value`                    | Preview with template input values                                                     |
| `openslack collaboration workflow preview-js <name>`                                   | Preview a JS workflow module in read-only mode                                         |
| `openslack collaboration workflow preview-js <name> --input key=value`                 | Preview JS module with input values                                                    |
| `openslack collaboration workflow preview-js <name> --budget-tokens 10000`             | Preview with custom token budget                                                       |
| `openslack collaboration workflow dry-run <name>`                                      | Simulate workflow execution without real side effects                                  |
| `openslack collaboration workflow dry-run <name> --input key=value`                    | Dry-run with input values                                                              |
| `openslack collaboration workflow dry-run <name> --budget-tokens 50000`                | Dry-run with custom token budget                                                       |
| `openslack collaboration workflow run <name>`                                          | Execute a workflow with real side effects                                              |
| `openslack collaboration workflow run <name> --input key=value`                        | Execute with input values                                                              |
| `openslack collaboration workflow run <name> --yes`                                    | Auto-approve all side effects without interactive confirmation                         |
| `openslack collaboration workflow run <name> --agent-id <id>`                          | Execute with agent principal authorization                                             |
| `openslack collaboration workflow run <name> --budget-tokens 100000`                   | Execute with custom token budget                                                       |
| `openslack collaboration workflow resume <runId>`                                      | Resume a paused workflow run from its last checkpoint                                  |
| `openslack collaboration workflow resume <runId> --yes`                                | Resume with auto-approved side effects                                                 |
| `openslack collaboration workflow resume <runId> --agent-id <id>`                      | Resume with agent principal authorization                                              |
| `openslack collaboration workflow start --prompt "..."`                                | Start the Dynamic Workflow path from a prompt by generating a previewable draft        |
| `openslack collaboration workflow start --pattern <pattern>`                           | Start from a known orchestration pattern without executing                             |
| `openslack collaboration workflow start --saved <name>`                                | Show preview, dry-run, and run commands for a saved workflow                           |
| `openslack collaboration workflow patterns list`                                       | List dynamic workflow orchestration patterns                                           |
| `openslack collaboration workflow patterns show <pattern>`                             | Show a dynamic workflow pattern                                                        |
| `openslack collaboration workflow catalog list`                                        | List workflow use-case catalog entries                                                 |
| `openslack collaboration workflow catalog show <id>`                                   | Show when to use a catalog workflow and required evidence                              |
| `openslack collaboration workflow catalog preview <id>`                                | Preview the catalog phases and draft command without writing a draft                   |
| `openslack collaboration workflow generate --prompt "..."`                             | Generate a safe dynamic workflow draft without running it                              |
| `openslack collaboration workflow generate --pattern fanout-synthesize --prompt "..."` | Generate a draft from a specific pattern                                               |
| `openslack collaboration workflow preview-draft <draftId>`                             | Preview a generated draft's phases, budget, permissions, and side effects              |
| `openslack collaboration workflow runs list`                                           | List recorded workflow runs                                                            |
| `openslack collaboration workflow runs show <runId>`                                   | Show run-level phase evidence                                                          |
| `openslack collaboration workflow runs show <runId> --detail progress`                 | Show run, phase, agent, transcript, and budget evidence                                |
| `openslack collaboration workflow runs show <runId> --detail progress --format json`   | Emit structured run progress evidence                                                  |
| `openslack collaboration workflow runs control <runId> --action pause`                 | Record a workflow run control action                                                   |
| `openslack collaboration workflow config show`                                         | Show project workflow policy                                                           |
| `openslack collaboration workflow config enable --ultracode`                           | Enable workflows and ultracode draft triggers                                          |
| `openslack collaboration workflow config disable`                                      | Disable workflow generation and execution                                              |
| `openslack collaboration workflow save <name> --to project`                            | Save a reusable workflow to project workflow storage                                   |
| `openslack collaboration workflow save <name> --to claude-project`                     | Save a reusable workflow to `.claude/workflows/` for Claude-compatible project sharing |
| `openslack collaboration workflow save-run <runId> --to project`                       | Save the workflow script associated with a recorded run                                |
| `openslack collaboration workflow export-skill <name> --out skills/<name>`             | Export a workflow as a skill-style package                                             |
| `openslack collaboration workflow trust <name>`                                        | View the current trust level for a workflow                                            |
| `openslack collaboration workflow trust <name> --level <level>`                        | Set trust level (untrusted, trusted)                                                   |
| `openslack collaboration inspect <runId>`                                              | Inspect a workflow run (HTML, JSON, or Markdown)                                       |
| `openslack collaboration inspect <runId> --format html`                                | Inspect with self-contained HTML artifact                                              |
| `openslack collaboration inspect <runId> --format json`                                | Inspect as structured JSON                                                             |
| `openslack collaboration inspect <runId> --format markdown`                            | Inspect as Markdown (default)                                                          |
| `openslack collaboration inspect <runId> --out <file>`                                 | Write output to file instead of stdout                                                 |
| `openslack collaboration inspect <runId> --no-run-output`                              | Exclude run output section from report                                                 |
| `openslack collaboration inspect <runId> --no-log`                                     | Exclude log entries from report                                                        |

### Workflow Discovery

Workflows are discovered from:

1. `.openslack/workflows/*.ts` -- project-local TypeScript workflows
2. `.openslack/workflows/*.js` -- project-local JavaScript workflows
3. `.claude/workflows/*.js` -- Anthropic-compatible workflows (legacy path)
4. `packages/workflows/src/builtins/` -- core workflows shipped with OpenSlack
5. `templates/workflows/*.yaml` -- YAML workflow templates

### Workflow Execution Modes

| Mode       | Description                                               | Side Effects                 |
| ---------- | --------------------------------------------------------- | ---------------------------- |
| `validate` | Static validation only; no execution                      | None                         |
| `preview`  | Read-only execution with agent calls                      | Read-only API calls only     |
| `dry-run`  | Simulated execution; side effects logged but not executed | Simulated                    |
| `execute`  | Full execution with real side effects                     | Real (requires confirmation) |

### Workflow Trust Levels

| Level       | Applies To                                       | Capabilities                                         |
| ----------- | ------------------------------------------------ | ---------------------------------------------------- |
| `untrusted` | Legacy Anthropic paths, unknown workflows        | Read-only agent and GitHub calls                     |
| `trusted`   | Project workflows explicitly trusted by operator | Declared permissions, side effects gated             |
| `core`      | Built-in workflows from `@openslack/workflows`   | Full API access (except hardcoded forbidden actions) |

### Workflow Examples

```bash
# List all available workflows
openslack collaboration workflow list

# Validate a workflow before running
openslack collaboration workflow validate test-scan

# Preview a JS workflow in read-only mode
openslack collaboration workflow preview-js test-scan --input scope=packages/kernel

# Dry-run to see what would happen
openslack collaboration workflow dry-run test-scan --budget-tokens 50000

# Execute with confirmation and agent identity
openslack collaboration workflow run test-scan --yes --agent-id claude

# Resume a paused run
openslack collaboration workflow resume run-abc123

# Inspect a completed or paused run as HTML
openslack collaboration inspect run-abc123 --format html --out report.html

# Set a workflow to trusted level
openslack collaboration workflow trust my-workflow --level trusted

# Generate a dynamic workflow draft for a broad task
openslack collaboration workflow generate --prompt "audit every API endpoint"

# Ask the operator to draft an ultracode workflow when enabled
openslack ask --effort ultracode "review all workflow governance gates"
```

Dynamic workflows are best for broad, long-running, fan-out, or independently
verified tasks. They usually spend more tokens than direct operator actions.
`ultracode` is a draft trigger only; it does not bypass side-effect manifests,
permission profiles, trust levels, PRMS gates, or human approval.

## Governance

| Command                                  | Purpose                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| `openslack governance audit`             | Audit recent main commits for direct-push compliance |
| `openslack governance audit --count <n>` | Audit last N commits                                 |

## Negentropy-Lab Integration

OpenSlack runs as a standalone workflow-first agent collaboration workbench. A planned
Negentropy-Lab integration would export OpenSlack evidence and projections as an external
`scenario-pack.extension` slot contribution without OpenSlack ever owning Negentropy-Lab
`AuthorityState`.

The commands below inspect the evidence that a future slot contribution would export.
Commands marked **Planned** are not implemented in this docs-only change.

| Capability                   | Command                                                                              | Status      |
| ---------------------------- | ------------------------------------------------------------------------------------ | ----------- |
| Standalone check             | `openslack status`                                                                   | Real        |
| Export slot contribution     | `openslack integration negentropy export-slot`                                       | **Planned** |
| Diagnose slot integration    | `openslack integration negentropy doctor`                                            | **Planned** |
| Show slot integration status | `openslack integration negentropy status`                                            | **Planned** |
| Inspect workflow evidence    | `openslack collaboration workflow runs show <runId> --detail progress --format json` | Real        |
| Inspect workflow run bundle  | `openslack collaboration inspect <runId> --format json`                              | Real        |
| Inspect PR evidence          | `openslack pr status <n>` / `openslack pr doctor <n>`                                | Real        |
| Profile projection status    | `openslack collaboration workflow profile-sync status`                               | Real        |

**Planned** commands are design targets for a future `openslack integration` command
group. They are not available in the current release.
