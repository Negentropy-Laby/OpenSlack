# OpenSlack

**OpenSlack — agent-native collaboration workspace for human-agent teams.**

OpenSlack lets heterogeneous AI agents (Claude Code, Codex, reviewers, researchers, custom) function as employees: discover tasks from GitHub Issues, claim them with deterministic git ref locks, work in isolated worktrees, submit output through PRs, and communicate with humans only for approvals and exceptions.

> **Status:** Developer Preview. GitHub-backed autonomous task loop verified E2E.
> **Repository:** [`Negentropy-Laby/OpenSlack`](https://github.com/Negentropy-Laby/OpenSlack)
> **Live status:** [`docs/status/current.md`](docs/status/current.md) -- run `openslack status` for current metrics

---

## The Short Version

Three commands to get going:

```bash
bun run openslack setup          # Validate workspace, GitHub auth, golden evals
bun run openslack collaboration dashboard --format tui   # Interactive team dashboard
bun run openslack status         # Module health, test counts, GitHub ops
```

```
Workflow --> Agent Work --> PRMS Review --> Human Approval --> Merge --> Collaboration Memory
```

Preview the work, let agents execute it, review the PR, confirm governed actions, and keep the collaboration record.

See the step-by-step guides: [`docs/guides/core-workflows.md`](docs/guides/core-workflows.md)

---

## Quick Start

```bash
# Prerequisites: Node.js >= 22, bun, python (for genesis scripts)

# 1. Clone and install
git clone https://github.com/Negentropy-Laby/OpenSlack.git
cd OpenSlack
bun install

# 2. One-step setup (validate + eval + doctor + all checks)
bun run openslack setup

# 3. Check GitHub setup without mutating external state
bun run openslack setup github

# 4. Check status
bun run openslack status

# 5. Ask the Operator anything
bun run openslack ask "检查系统状态"
```

See [Advanced Setup](#advanced-setup) for development mode, production builds, and manual steps.

## What Should I Run?

| Goal | Command |
|------|---------|
| First local health check | `bun run openslack setup` |
| Check status without guessing modules | `bun run openslack status` |
| Ask in natural language | `bun run openslack ask "检查系统状态"` |
| Create a task preview | `bun run openslack task create --title "Fix docs" --path "docs/**" --preview` |
| Diagnose a PR | `bun run openslack pr doctor <PR_NUMBER>` |
| See team activity | `bun run openslack collaboration dashboard` |
| Start a conversation thread | `bun run openslack conversation start --title "Review PR #42"` |
| Launch the interactive TUI | `bun run openslack tui` |
| Maintain organization profile | `bun run openslack collaboration workflow profile-sync status` |
| Find the full CLI reference | [`docs/user-guide.md`](docs/user-guide.md) |

Mutation-oriented commands default to preview or require explicit confirmation flags where possible. Chat confirmations are never GitHub approvals, and PR merges still require PRMS and GitHub governance gates.

OpenSlack-authored and delegated agent work must be submitted as PRs opened by the configured bot/agent GitHub identity. Human GitHub identities are reserved for review and approval; a bot-authored commit inside a human-opened PR is still a human-authored PR for governance. See [`AGENTS.md`](AGENTS.md#bot-authored-pr-requirement) and [`docs/security/human-approval.md`](docs/security/human-approval.md#pr-author-identity).

## Architecture

```
OpenSlack/
├── openslack.yaml           # Self-Project Mode workspace
├── .openslack/              # Workspace state (policies, constitution, evals, tasks)
├── packages/                # Active packages; see docs/status/current.md
│   ├── kernel/              # Zone classifier, merge decision, policy engine
│   ├── workspace/           # Validation, indexing, schemas
│   ├── core/                # ClaimBroker with file-locked persistence
│   ├── runtime/             # Self-evolution ops, golden evals, agent tick, worktree, PR proposal
│   ├── github/              # App auth, Issues task loop, task creation, claims, lifecycle, repair
│   ├── pr/                  # PR Review & Merge Steward (fetch, classify, readiness, report)
│   ├── operator/            # Structured planner and intent router
│   ├── chat-gateway/        # Webhook / Slack projection frontend
│   ├── agent-runtime/       # Agent runs, bridge adapters, transcript, permissions, Aby provider diagnostics
│   ├── collaboration/       # Activity, digest, dashboard, handoff, decision, room views
│   ├── tui/                  # Ink TUI views, layout primitives, terminal workbench
│   └── workflows/           # Workflow engine: load, validate, execute, checkpoint, resume
├── apps/cli/                # User command surface and module command groups
├── templates/new-agent/     # 9 onboarding template files
├── scripts/                 # genesis-validate.sh, genesis-rollback.sh, setup-gh.sh
└── docs/                    # Full acceptance, developer, security documentation
```

## Modules

### Module 01: OSEK (Self-Evolution Kernel)

The self-protection core. OpenSlack validates, classifies, reviews, and rolls back changes to itself.

- **Classify:** `openslack self classify-pr --paths "..."` → Green/Yellow/Red/Black zone
- **Validate:** 7 golden evals (concurrent claim, black zone rejection, rollback recovery)
- **Review:** Fitness scoring (6 weighted dimensions) + independent agent review
- **Rollback:** Genesis validate/rollback scripts (zero runtime dependency)

See: [`docs/product/phase-1.md`](docs/product/phase-1.md)

### Module 02: GITL (GitHub Issues Task Loop)

The autonomous execution core. Agents discover, claim, and complete tasks through GitHub Issues — no Project v2, no OAuth, no browser.

- **Create:** `task create --title "..."` previews or creates schema-valid task Issues
- **Discover:** `agent tick --source github-issues` queries GitHub for ready issues
- **Claim:** Atomic `refs/heads/openslack/claims/issue-{n}` git refs prevent duplicate claims
- **Execute:** Worktree isolation → git commit → push → draft PR
- **Complete:** PR merged → claim ref deleted → issue → done

See: [`docs/developer/github-issues-loop.md`](docs/developer/github-issues-loop.md)

### Module 03: Operator Interface

The human-facing entry point. Natural language queries route through a structured planner to the appropriate CLI commands.

- **Ask:** `openslack operator ask "..."` — natural language → parse intent → optional LLM fallback → typed registered actions → execute → summarize
- **Chat:** `openslack chat start --adapter webhook|slack` — chat gateway for Slack/HTTP projections
- **Setup:** `openslack setup` — one-step workspace validation + health check
- **Setup GitHub:** `openslack setup github` — read-only setup report; `--apply` required for repairs
- **Plan Memory:** `openslack ask plan ...` — inspect, resume, approve, or cancel 24h pending plans
- **Planner:** Structured pipeline (`parseIntent/resolveIntent → planActions → executePlan`) with typed tool registry, allowlisted actions, risk gates, and confirmation for high-risk actions

See: [`AGENTS.md`](AGENTS.md) for command reference

### Module 04: PR Review & Merge Steward (PRMS)

The agent-assisted PR gatekeeper. Reviews PRs, classifies risk, checks merge readiness, and executes merge only after human approval.

- **Review:** `openslack pr review 10` → fetches diff, classifies zone, generates report
- **Status:** `openslack pr status 10` → merge readiness + checks + human approvals
- **Recommend:** `openslack pr recommend 10` → next action (approve? merge? wait?)
- **Doctor:** `openslack pr doctor 10` → 11-gate governance diagnosis (deadlock, checks, approvals)
- **Queue:** `openslack pr queue` → open PRs sorted by readiness and blocker owner
- **Merge:** `openslack pr merge 10` → execute merge only after all gates pass
- **Policy:** No auto-approval. No self-review. Red Zone requires an explicit human decision recorded through the required human GitHub identity. Black Zone blocked.

See: [`docs/product/module-04-pr-review-merge-steward.md`](docs/product/module-04-pr-review-merge-steward.md)

### Module 05: Collaboration Layer

The projection and coordination layer. It makes tasks, PRs, handoffs, decisions, rooms, workflows, and chat-originated actions observable without replacing GitHub, Git, or `.openslack` as the source of truth.

- **Dashboard:** `openslack collaboration dashboard` → tasks, PRs, blockers, handoffs, decisions, and next owner
- **Activity:** `openslack collaboration activity --since 24` → event feed from the last 24 hours
- **Handoff:** `openslack collaboration handoff create ...` → transfer context between humans and agents
- **Decision:** `openslack collaboration decision record ...` → record auditable decisions
- **Room:** `openslack collaboration room show pr:42` → reconstruct object-centered collaboration context
- **Workflow Engine:** `openslack collaboration workflow preview <file>` → validate typed workflow templates before execution
- **Workflow Execution:** `openslack collaboration workflow run <name>` → execute workflows with preview, dry-run, and execute modes, checkpointing, resume, trust levels, and inspect (HTML/JSON/Markdown)
- **Dynamic Workflows:** `openslack ask --effort ultracode "..."` and `openslack collaboration workflow generate --prompt "..."` → recommend or draft workflow harnesses for broad, long-running, or verification-heavy tasks without bypassing OpenSlack permissions
- **Profile Sync Robot:** `openslack collaboration workflow profile-sync check` → keep an organization's public profile in sync with an upstream whitepapers repository (check, preview, run, status)
- **Agent Conversations:** `openslack conversation start --title "..."` → structured multi-turn interaction threads between humans and agents with JSONL persistence, 7 typed message kinds, secret scanning, and memory policy control (`start`, `list`, `show`, `send`, `summarize`, `archive`)

See: [`docs/product/collaboration-layer.md`](docs/product/collaboration-layer.md), [`docs/product/agent-conversations.md`](docs/product/agent-conversations.md), [`docs/product/dynamic-workflows.md`](docs/product/dynamic-workflows.md)

## Advanced Setup

### Development mode (tsx, no build)

```bash
alias openslack="node --import tsx $(pwd)/apps/cli/src/index.ts"
```

### Production build

```bash
bun run build
export PATH="$(pwd)/apps/cli/dist:$PATH"
openslack setup
```

### Manual verification steps

If you prefer to run checks individually instead of `openslack setup`:

```bash
bun run typecheck              # Build all packages + type-check
openslack workspace validate
openslack self eval --suite golden    # 7/7 must pass
openslack doctor                        # Multi-module health check
bash scripts/genesis-validate.sh      # use Git Bash on Windows
```

## CLI Reference

See [`docs/user-guide.md`](docs/user-guide.md) for the complete command reference.

## Authentication

Three-tier model (see [`docs/developer/github-automation.md`](docs/developer/github-automation.md)):

1. **GitHub App installation token** — primary runtime credential (JWT, auto-refresh, zero manual)
2. **PAT / GITHUB_TOKEN** — local dev fallback
3. **OAuth / gh CLI** — human login only

```bash
# GitHub App auth (preferred)
export OPENSLACK_GITHUB_APP_ID=3728623
export OPENSLACK_GITHUB_APP_INSTALLATION_ID=<installation-id>
export OPENSLACK_GITHUB_APP_PRIVATE_KEY="$(cat .openslack.local/github-app.pem)"

# PAT fallback
export GITHUB_TOKEN=ghp_xxxxxxxx
```

On Windows, keep the PEM under the gitignored `.openslack.local/` directory and
run commands through the bot-auth wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 setup github
```

## Task Lifecycle

```
CREATE → READY → CLAIMED → RUNNING → REVIEW → DONE
                ↑          ↓         ↓
                └── EXPIRED     BLOCKED
```

- **READY:** Issue has `openslack:ready` label. Agent can attempt claim.
- **CLAIMED:** `refs/heads/openslack/claims/issue-{n}` exists. Atomic lock prevents duplicates.
- **RUNNING:** Agent created worktree. Heartbeat extends lease.
- **REVIEW:** Draft PR submitted. Issue label updated.
- **DONE:** PR merged. Claim ref deleted. Issue closed.
- **EXPIRED:** No heartbeat within TTL. Claim ref deleted. Task returns to ready.

## Issues-First Task Format

Tasks are GitHub Issues with structured YAML in an `openslack-task` code fence:

````markdown
```openslack-task
schema: openslack.github_issue_task.v1
task_id: TASK-2026-000123
title: Fix failing workspace validation
agent_type: codex
risk_level: low
required_capabilities:
  - typescript
  - workspace
allowed_paths:
  - packages/workspace/**
  - docs/**
forbidden_paths:
  - .github/**
output_contract:
  - draft_pr
  - workspace_run_record
```
````

## Documentation

| User Need | Start Here |
|-----------|------------|
| Documentation home | [`docs/README.md`](docs/README.md) |
| Current status, modules, commands, and test counts | [`docs/status/current.md`](docs/status/current.md) |
| Complete CLI reference | [`docs/user-guide.md`](docs/user-guide.md) |
| Product documentation map | [`docs/product/openslack-product-current.md`](docs/product/openslack-product-current.md) |
| Product UX roadmap and remaining productization work | [`docs/product/user-experience-roadmap.md`](docs/product/user-experience-roadmap.md) |
| Self-evolution architecture | [`docs/product/phase-1.md`](docs/product/phase-1.md), [`docs/developer/self-evolution-kernel.md`](docs/developer/self-evolution-kernel.md) |
| GitHub Issues task loop | [`docs/developer/github-issues-loop.md`](docs/developer/github-issues-loop.md) |
| GitHub watch daemon and realtime Issue notifications | [`docs/developer/github-watch-daemon.md`](docs/developer/github-watch-daemon.md) |
| PR review and merge governance | [`docs/product/module-04-pr-review-merge-steward.md`](docs/product/module-04-pr-review-merge-steward.md) |
| Collaboration, handoff, decision, room, workflow views | [`docs/product/collaboration-layer.md`](docs/product/collaboration-layer.md), [`docs/developer/collaboration-events.md`](docs/developer/collaboration-events.md) |
| Agent Conversations and subagent runtime | [`docs/product/agent-conversations.md`](docs/product/agent-conversations.md), [`docs/developer/subagent-runtime.md`](docs/developer/subagent-runtime.md) |
| Aby external runtime setup | [`docs/guides/aby-integration.md`](docs/guides/aby-integration.md) |
| Subagent security and permissions | [`docs/security/subagent-permissions.md`](docs/security/subagent-permissions.md) |
| TUI workbench guide | [`docs/guides/tui-workbench.md`](docs/guides/tui-workbench.md) |
| Workflow engine runtime and execution model | [`docs/developer/workflow-runtime.md`](docs/developer/workflow-runtime.md) |
| Workflow security model and trust levels | [`docs/security/workflow-execution.md`](docs/security/workflow-execution.md) |
| Agent identity and onboarding | [`docs/developer/agent-registry-schema.md`](docs/developer/agent-registry-schema.md), [`docs/developer/new-agent-onboarding.md`](docs/developer/new-agent-onboarding.md) |
| GitHub authentication and setup | [`docs/developer/github-automation.md`](docs/developer/github-automation.md) |
| Guardrails and security boundaries | [`docs/security/self-evolution-guardrails.md`](docs/security/self-evolution-guardrails.md), [`docs/security/collaboration-audit.md`](docs/security/collaboration-audit.md) |
| Technical debt register | [`docs/developer/technical-debt.md`](docs/developer/technical-debt.md) |

## Repository Rules

Every file must have a clear purpose. See [`AGENTS.md`](AGENTS.md) for:

- Constitutional constraints (never override)
- Risk zone classification (Green/Yellow/Red/Black)
- Package rule, artifact rule, CLI rule
- Commit message convention (module-prefixed)
- Pre-commit checklist (`typecheck`, `test`, `genesis-validate`, `lint`)

## Contributing

1. Read [`AGENTS.md`](AGENTS.md) — it contains the immutable rules.
2. Create a feature branch (`agent/{agent_id}/{task_id}/{run_id}`).
3. Work in an isolated worktree.
4. Submit output through a draft PR.
5. Self-validate before requesting review.
6. Red Zone changes require human approval.

## Status

Run `openslack status` for live project metrics, or see [`docs/status/current.md`](docs/status/current.md).
