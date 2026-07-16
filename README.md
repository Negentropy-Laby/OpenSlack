# OpenSlack

**OpenSlack — workflow-first agent collaboration workbench for GitHub-native human-agent teams. Runs standalone, with a planned Negentropy-Lab external slot-compatible scenario/workflow surface.**

OpenSlack lets heterogeneous AI agents (Claude Code, Codex, reviewers, researchers, custom) function as employees: discover tasks from GitHub Issues, claim them with deterministic git ref locks, work in isolated worktrees, submit output through PRs, and communicate with humans only for approvals and exceptions.

> **Status:** Developer Preview. The standalone local product path is `LOCAL_READY`; live GitHub delivery, clean-machine onboarding, and production claims remain evidence-gated.
> **Repository:** [`Negentropy-Laby/OpenSlack`](https://github.com/Negentropy-Laby/OpenSlack)
> **Live status:** [`docs/status/current.md`](docs/status/current.md) -- run `openslack status` for current metrics

---

## The Short Version

Three commands to get going:

```bash
bun run openslack setup          # Validate workspace, GitHub auth, golden evals
bun run openslack tui            # Conversation-first workbench
bun run openslack status         # Module health, test counts, GitHub ops
```

```
Workflow --> Agent Work --> PRMS Review --> Human Approval --> Merge --> Collaboration Memory --> Evidence Projection
```

Preview the work, let agents execute it, review the PR, confirm governed actions, and keep the collaboration record. **Evidence Projection** is the integration boundary where external authority systems such as Negentropy-Lab may absorb OpenSlack outputs as read-only audit data; the slot-level export into Negentropy-Lab's `scenario-pack.extension` is planned and not active today.

See the step-by-step guides: [`docs/guides/core-workflows.md`](docs/guides/core-workflows.md)
and [`docs/guides/dynamic-workflow-workbench.md`](docs/guides/dynamic-workflow-workbench.md)

---

## Two Integration Modes

OpenSlack runs as a **standalone workflow-first agent collaboration workbench** for GitHub-native human-agent teams. It also exposes a planned **Negentropy-Lab external slot-compatible scenario/workflow surface** without changing its standalone behavior.

### Standalone Workbench Mode

No external control plane is required. Local workspace, workflow, review, and evidence features are self-contained; GitHub delivery, model-backed execution, bot-authored PRs, and human approval still require their documented operator credentials and hosted-service configuration. The sources of truth are GitHub Issues, Pull Requests, Git branches, and the local `.openslack` workspace.

### Negentropy-Lab Slot Mode (Planned)

In the future, OpenSlack can contribute to the `scenario-pack.extension` slot on a Negentropy-Lab control plane as an external provider:

- `layer: L5`, `defaultGateMode: SHADOW`, `sealed: false`, `allowExternal: true` on the slot definition.
- The OpenSlack contribution would set `providerKind: external` and `gate.mode: SHADOW`.
- OpenSlack exports workflow run evidence, PRMS reports, profile-sync projections, and collaboration summaries as read-only audit material.
- OpenSlack **never owns `AuthorityState`**, never receives a writer handle, and never calls `proposeMutation` or `authorityWriterHandle`.
- All GitHub-side mutations remain ordinary GitHub Issues/PR mutations; any Negentropy-Lab authority mutation would be a governed action request processed by Negentropy-Lab itself.

The `openslack integration negentropy ...` commands are planned and not implemented yet. See [`docs/product/negentropy-lab-integration.md`](docs/product/negentropy-lab-integration.md).

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
| Initialize an ordinary Git repository | `bun run openslack init --root <repo> --repo <owner/name>` |
| Check status without guessing modules | `bun run openslack status` |
| Ask in natural language | `bun run openslack ask "检查系统状态"` |
| Create a task preview | `bun run openslack task create --title "Fix docs" --path "docs/**" --preview` |
| Diagnose a PR | `bun run openslack pr doctor <PR_NUMBER>` |
| See team activity | `bun run openslack collaboration dashboard` |
| Start a conversation thread | `bun run openslack conversation start --title "Review PR #42"` |
| Launch the conversation-first workbench | `bun run openslack tui` |
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
│   ├── plugin-api/          # Private declarative plugin contract, schema, and host policy ports
│   ├── plugin-host/         # Red integrity loader, lock, policy gates, and instance registries
│   ├── sdk/                 # Private authoring helpers for manifests and reviewed bundled code
│   ├── workspace/           # Validation, indexing, schemas
│   ├── credentials/         # Typed env/native OS keychain references and fail-closed backends
│   ├── core/                # ClaimBroker with file-locked persistence
│   ├── runtime/             # Self-evolution ops, golden evals, agent tick, worktree, PR proposal
│   ├── github/              # App auth, Issues task loop, task creation, claims, lifecycle, repair
│   ├── delivery/            # Bot-authenticated branch/PR publication and SHA synchronization
│   ├── pr/                  # PR Review & Merge Steward (fetch, classify, readiness, report)
│   ├── operator/            # Structured planner and intent router
│   ├── chat-gateway/        # Webhook / Slack projection frontend
│   ├── agent-runtime/       # Governed tool plane, OpenAI-compatible/Aby providers, runs and evidence
│   ├── collaboration/       # Activity, digest, dashboard, handoff, decision, room views
│   ├── tui/                  # Ink TUI views, layout primitives, terminal workbench
│   └── workflows/           # Workflow engine: load, validate, execute, checkpoint, resume
├── apps/cli/                # User command surface and module command groups
├── templates/new-agent/     # 9 onboarding template files
├── scripts/                 # genesis-validate.sh, genesis-rollback.sh, setup-gh.sh
└── docs/                    # Full acceptance, developer, security documentation
```

The plugin packages remain a private preview. `@openslack/plugin-host` now provides the Red,
instance-scoped integrity and activation boundary for declarative workspace/installed manifests
and explicitly imported reviewed bundles. It never executes auto-discovered code and is not yet a
public npm embedding runtime, dynamic CLI registry, or sandbox. See
[`docs/developer/plugins/host.md`](docs/developer/plugins/host.md) and
[`docs/developer/plugins/embedding.md`](docs/developer/plugins/embedding.md).

### Negentropy-Lab Slot Integration (Planned)

OpenSlack can contribute to the Negentropy-Lab slot platform as an external `scenario-pack.extension` contribution. The integration surface is one-way, evidence-only, and projection-only:

- Workflow run summaries and progress evidence (`openslack collaboration workflow runs show ...`)
- PRMS readiness reports and diagnostics (`openslack pr status`, `openslack pr doctor`)
- Profile-sync projection payloads (`openslack collaboration workflow profile-sync status`)
- Collaboration event/activity summaries (projection-only, from `.openslack.local/collaboration/events.jsonl`)

OpenSlack **never owns `AuthorityState`**, never receives a writer handle, and never calls `proposeMutation` or `authorityWriterHandle`. The contribution would start with `gate.mode: SHADOW` and remain an external, non-authority-writing contribution. Planned commands: `openslack integration negentropy export-slot`, `openslack integration negentropy doctor`, and `openslack integration negentropy status`.

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
- **Execute:** Worktree isolation → git commit → governed delivery → synchronized draft PR
- **Complete:** PR merged → claim ref deleted → issue → done

See: [`docs/developer/github-issues-loop.md`](docs/developer/github-issues-loop.md)

### Module 03: Operator Interface

The human-facing entry point. Natural language queries route through a structured planner to the appropriate CLI commands.

- **Ask:** `openslack ask "..."` — natural language → parse intent → optional LLM fallback → typed registered actions → preview, plan, or execute through risk gates
- **TUI Ask:** `openslack tui` — opens on `Ask OpenSlack:`. Natural language produces Operator recommendations and safe action cards; `@agent-id prompt` dispatches through the conversation subagent path
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
- **Dynamic Workflows:** `openslack ask --effort ultracode "..."`, `openslack collaboration workflow start --prompt "..."`, and `openslack collaboration workflow runs show <runId> --detail progress` -> recommend, draft, watch/control, budget, save/share, and publish workflow harnesses for broad, long-running, or verification-heavy tasks without bypassing OpenSlack permissions
- **Profile Sync Robot:** `openslack collaboration workflow profile-sync check` → keep an organization's public profile in sync with an upstream whitepapers repository (check, preview, run, status)
- **Agent Conversations:** `openslack conversation start --title "..."` → structured multi-turn interaction threads between humans and agents with JSONL persistence, 7 typed message kinds, secret scanning, and memory policy control (`start`, `list`, `show`, `send`, `summarize`, `archive`)
- **Conversation-first TUI:** `openslack tui` → Ask OpenSlack from the first screen, get safe action cards for PRMS, workflow drafts, approvals, profile sync, and subagent dispatch, and record asks/actions into the current conversation thread

See: [`docs/product/collaboration-layer.md`](docs/product/collaboration-layer.md), [`docs/product/agent-conversations.md`](docs/product/agent-conversations.md), [`docs/product/dynamic-workflows.md`](docs/product/dynamic-workflows.md), [`docs/product/dynamic-workflow-ux-closure.md`](docs/product/dynamic-workflow-ux-closure.md)

### Cross-Cutting Integration: Negentropy-Lab Slot Surface (Planned)

Target slot: `scenario-pack.extension` on Negentropy-Lab.

**What OpenSlack contributes**

- Workflow run evidence, phase summaries, and correlation IDs
- PRMS `doctor`/`status` reports and merge-readiness payloads
- Profile-sync projection payloads (whitepapers → `.github/profile/README.md`)
- Collaboration activity/digest/room/handoff/decision summaries
- Agent conversation metadata and redacted summaries

**What OpenSlack must not own**

- Negentropy-Lab `AuthorityState` or policy truth
- Writer handles or direct mutation routes (`authorityWriterHandle`, `proposeMutation`)
- Negentropy-Lab transport/runtime internals

OpenSlack remains a standalone GitHub-agent workbench; the planned Negentropy-Lab slot contribution would be an external, `gate.mode: SHADOW`, projection-only contribution. See [`docs/product/negentropy-lab-integration.md`](docs/product/negentropy-lab-integration.md), [`docs/developer/negentropy-slot-adapter.md`](docs/developer/negentropy-slot-adapter.md), and [`docs/security/negentropy-slot-boundary.md`](docs/security/negentropy-slot-boundary.md).

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
| Negentropy-Lab integration, slot surface, and boundary | [`docs/product/negentropy-lab-integration.md`](docs/product/negentropy-lab-integration.md), [`docs/developer/negentropy-slot-adapter.md`](docs/developer/negentropy-slot-adapter.md), [`docs/security/negentropy-slot-boundary.md`](docs/security/negentropy-slot-boundary.md), [`docs/guides/embed-openslack-in-negentropy-lab.md`](docs/guides/embed-openslack-in-negentropy-lab.md) |
| Profile Sync Robot and projection | [`docs/product/profile-sync.md`](docs/product/profile-sync.md) |
| Documentation home | [`docs/README.md`](docs/README.md) |
| Current status, modules, commands, and test counts | [`docs/status/current.md`](docs/status/current.md) |
| Complete CLI reference | [`docs/user-guide.md`](docs/user-guide.md) |
| Plugin manifest, Red host, and private embedding boundary | [`docs/developer/plugins/manifest.md`](docs/developer/plugins/manifest.md), [`docs/developer/plugins/authoring.md`](docs/developer/plugins/authoring.md), [`docs/developer/plugins/host.md`](docs/developer/plugins/host.md), [`docs/developer/plugins/embedding.md`](docs/developer/plugins/embedding.md) |
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
| Dynamic workflow workbench guide | [`docs/guides/dynamic-workflow-workbench.md`](docs/guides/dynamic-workflow-workbench.md) |
| Workflow engine runtime, UX closure, and execution model | [`docs/product/dynamic-workflow-ux-closure.md`](docs/product/dynamic-workflow-ux-closure.md), [`docs/developer/workflow-runtime.md`](docs/developer/workflow-runtime.md) |
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
