# OpenSlack v1.0 Product Document

> ⚠️ **HISTORICAL** — This document describes the original OpenSlack product
> specification dated 2026-05-15. The current implementation has diverged
> significantly: GitHub Issues (not Project v2) is the primary task queue,
> GitHub App installation tokens (not OAuth) are the primary credential,
> and the architecture has been consolidated into 7 packages across 6 CLI
> groups. See [`docs/status/current.md`](../status/current.md) for the
> single source of truth.

## 1. Product Definition

OpenSlack is a **local-first, Git-backed, multi-agent company operating system**. It lets heterogeneous AI agents (Claude Code, Codex, reviewer, researcher, sync, custom) function as employees that discover tasks from a GitHub Project board, work in isolated local worktrees, synchronize state through GitHub PRs, and communicate with humans via any chat platform for approvals and exception handling.

**Core formula:**

```
OpenSlack =
  Local Workspace (company state)
+ GitHub Project (task market + visual queue)
+ GitHub PR (async collaboration protocol)
+ Agent Control Plane (scheduling, claims, policy)
+ Multi-Chat Gateway (human interface)
+ Agent Adapters (runtime bindings)
+ Human Governance Layer (approval, strategy, exception)
```

**What OpenSlack is NOT:**
- A chat application. Chat platforms are pluggable frontends, not the system core.
- An AI chatbot or copilot. Agents are autonomous workers, not conversational assistants.
- A SaaS platform. All durable state lives in Git repos; the control plane can be rebuilt from them.

---

## 2. Design Goals

| # | Goal | Rationale |
|---|------|-----------|
| 1 | **State is local-first and Git-backed** | Clone the workspace repo on any machine and read the full company state. No proprietary database is the source of truth. |
| 2 | **Tasks flow through GitHub Project** | Agents don't find work via chat. They query a structured GitHub Project with standardized fields and views. |
| 3 | **Agents self-onboard** | A new agent reads its onboarding package (registry, START_HERE, contracts) and knows its identity, where to find tasks, how to claim, and what to produce. |
| 4 | **Heterogeneous agents collaborate uniformly** | Claude Code, Codex, custom runners all use the same task protocol, claim protocol, and PR protocol. |
| 5 | **Humans only intervene at governance gates** | High-risk changes, merges, deploys, policy changes, and external messages require human approval. Everything else runs autonomously. |

---

## 3. State Architecture

### 3.1 Authoritative State Hierarchy

OpenSlack has three state layers. When they conflict, the hierarchy resolves as follows:

| Layer | Type | Authority | Backed by |
|-------|------|-----------|-----------|
| **Workspace Repo** (Git) | Durable source of truth | **Highest** — definitive for policies, registry, org, task records | GitHub (`openslack-workspace`) |
| **GitHub Project** | Task index + visual queue | **Index** — reflects workspace state, may lag | GitHub Projects API |
| **ACP DB** | Runtime cache | **Ephemeral** — rebuildable from workspace + Project | SQLite or Postgres (local/remote) |

**Rebuild rule:** If the ACP DB is destroyed, the system must be able to reconstruct all runtime state from the workspace repo's `tasks/` and `leases/` directories plus the GitHub Project's field values.

### 3.2 Workspace Directory Structure

```
openslack-workspace/
├── README.md
├── workspace.yaml              # Company manifest: name, repos, project ref, chat config
├── AGENTS.md                   # Global agent instructions (read by Codex, Claude Code)

├── governance/                 # Human-authored, agent-read-only
│   ├── charter.md
│   ├── operating_principles.md
│   └── goals/

├── org/                        # Human-authored organizational structure
│   ├── departments/
│   └── roles/

├── agents/                     # Mixed: human authors registry + prompts; agents write run artifacts
│   ├── registry/               # Human-authored: one YAML per agent (immutable by agents)
│   ├── prompts/                # Human-authored: one prompt file per agent (immutable by agents)
│   ├── onboarding/             # Human-authored: per-agent onboarding packages
│   └── runbooks/               # Human-authored: reusable procedure templates

├── policies/                   # Human-authored, agent-read-only
│   ├── risk.yaml
│   ├── approvals.yaml
│   ├── path_permissions.yaml
│   ├── claim_policy.yaml
│   └── chat_trust.yaml

├── integrations/               # Human-authored connection configs
│   ├── github.yaml
│   ├── chat/
│   └── repos/                  # Product repo allowlist with per-repo permissions

├── tasks/                      # Agent-authored runtime state
│   ├── open/
│   ├── claimed/
│   ├── running/
│   ├── review/
│   ├── blocked/
│   ├── done/
│   └── cancelled/

├── leases/                     # Agent-authored lease records
│   ├── active/
│   ├── expired/
│   └── released/

├── decisions/                  # Agent-authored decision logs
├── memory/                     # Agent-authored persistent memory
├── inbox/                      # External events queued for processing
├── outbox/                     # PR proposals awaiting sync
├── sync/                       # Sync state tracking
└── audit/                      # Audit trail
```

**Write boundary:** Everything under `governance/`, `org/`, `agents/registry/`, `agents/prompts/`, `policies/`, and `integrations/` is read-only to agents. Agents write only under `tasks/`, `leases/`, `decisions/`, `memory/`, `inbox/`, `outbox/`, `sync/`, and `audit/`.

---

## 4. Core Modules

### 4.1 GitHub Project Task Board

Every OpenSlack company has at least one GitHub Project (v2) serving as the task market.

**Why GitHub Project + Issues (not draft items alone):**
- Issues support comments, labels, assignees, linked PRs, timeline events, and automation triggers.
- GitHub Project provides the structured view layer (fields, filters, grouping, layout).
- Together they form a task object with both structured metadata and conversational context.

#### Standard Fields

| Field | Type | Description |
|-------|------|-------------|
| `OpenSlack Status` | Single select | `Intake` → `Ready` → `Claimed` → `Running` → `Review` → `Done` / `Blocked` / `Cancelled` |
| `Required Agent Type` | Single select | `codex` / `claude_code` / `reviewer` / `research` / `sync` / `memory` / `ops` |
| `Required Capabilities` | Text | Comma-separated, e.g. `typescript, ci_fix, react, security_review` |
| `Risk Level` | Single select | `low` / `medium` / `high` / `critical` |
| `Priority` | Single select | `p0` / `p1` / `p2` / `p3` |
| `Product Repo` | Text | Target product repository, e.g. `your-org/product-app` |
| `Workspace Path` | Text | Relative path in workspace, e.g. `tasks/open/TASK-2026-000123` |
| `Claimed By` | Text | Agent ID currently holding the lease |
| `Lease ID` | Text | Active lease identifier |
| `Lease Expires At` | Text | ISO 8601 timestamp |
| `Last Heartbeat` | Text | ISO 8601 timestamp |
| `Human Approval Required` | Single select | `none` / `merge` / `deploy` / `external_message` / `policy_change` |
| `Output Contract` | Text | Expected output type: `workspace_pr`, `product_pr`, `review_comment`, `research_memo` |

#### Standard Views

| View | Filter | Purpose |
|------|--------|---------|
| Agent Intake | Status = Intake | New tasks awaiting triage |
| Ready for Agents | Status = Ready | Tasks available for claiming |
| Claimed / Running | Status in (Claimed, Running) | Active work in progress |
| Human Review | `Human Approval Required != none` OR Status = Review | Tasks needing human attention |
| Blocked | Status = Blocked | Stuck tasks |
| Done (This Week) | Status = Done, updated within 7 days | Recently completed work |

### 4.2 Agent Control Plane (ACP)

The ACP is the scheduling and enforcement brain. It is **not** a chat-dependent service. It runs as either a local CLI process or a lightweight server, providing:

- Task normalization and ID generation
- Agent registry validation
- Claim brokering (atomic lease acquisition)
- Policy evaluation (risk, path permissions, approval rules)
- Budget enforcement (daily cost, task count, runtime limits)
- Worktree isolation management
- PR orchestration (proposal, validation, merge eligibility)
- Heartbeat monitoring and lease expiry
- Audit logging

**Deployment modes:**
1. **Embedded CLI** — `openslack agent tick` runs the full ACP cycle locally per agent invocation. Suitable for single-machine setups.
2. **Server mode** — A persistent process exposes the Claim API and heartbeat endpoints. Suitable for multi-agent coordination across machines.
3. **Hybrid** — Server handles claims and heartbeats; agents run ticks locally with worktree isolation.

### 4.3 Chat Gateway

The Chat Gateway translates OpenSlack events into chat-platform-specific messages and translates human commands back into OpenSlack actions.

**It only does:**
- Status notifications (task claimed, completed, blocked)
- Approval cards (merge request, deploy request, policy change)
- Exception escalation (lease expired, agent error, conflict)
- Human commands (`/openslack approve`, `/openslack reject`, `/openslack block`)

**It never does:**
- Store durable state
- Hold task locks
- Serve as agent scheduling source
- Serve as company memory

**MVP platforms:** Slack, generic webhook. All others (Teams, Discord, Telegram, Feishu, DingTalk, WeCom, Mattermost, Matrix) are post-MVP.

### 4.4 Agent Adapters

Each agent runtime (Codex, Claude Code, custom) gets an adapter that implements:

```typescript
interface AgentAdapter {
  agentId: string;
  type: "codex" | "claude_code" | "custom" | "reviewer" | "research" | "sync";

  capabilities(): AgentCapability[];

  // Onboarding: clone workspace, read registry, validate setup
  bootstrap(input: AgentBootstrapInput): Promise<BootstrapResult>;

  // Main loop: query project, claim task, execute, produce output
  tick(input: AgentTickInput): Promise<TickResult>;

  // Execute a specific task in an isolated worktree
  runTask(input: AgentTaskRunInput): Promise<AgentRunResult>;

  // Send heartbeat for active lease
  heartbeat(input: AgentHeartbeatInput): Promise<void>;

  // Cancel a running task
  cancel(runId: string): Promise<void>;
}
```

Adapters are responsible for translating OpenSlack task context into the native prompt/instruction format of each runtime, and for enforcing path permissions at the worktree level.

---

## 5. Task Lifecycle

```
1. TASK CREATED
   Source: GitHub issue, chat /command, webhook, CI alert, monitoring, manual CLI
   Status: Intake

2. TASK NORMALIZED
   Generates: TASK-ID, workspace folder, GitHub issue, Project item with fields
   Status: Intake

3. TASK ENTERS READY
   Human or triage agent moves to Ready
   Status: Ready

4. AGENT WAKES UP
   Trigger: GitHub Actions schedule, Codex automation, Claude routine, local cron, server scheduler
   Agent reads registry and onboarding contract

5. AGENT QUERIES PROJECT
   Filters: Status=Ready, matching agent_type, intersecting capabilities, within risk limit, no excluded labels
   Sorts: priority descending, oldest first

6. AGENT CLAIMS TASK
   Sends claim request to Claim Broker with agent_id, issue_node_id, capabilities
   Status: Claimed (on grant)

7. ACP UPDATES STATE
   Updates: GitHub Project fields, issue comment (claim announcement), workspace lease file, ACP DB

8. AGENT EXECUTES
   Creates isolated worktree from workspace repo
   Reads task context, policies, relevant project files
   Creates run record under tasks/claimed/<TASK-ID>/runs/<RUN-ID>/
   Works only within allowed paths
   Sends heartbeat every N minutes

9. AGENT PRODUCES OUTPUT
   Product PR (if code changed) or workspace PR (for state changes) or review comment or research memo
   Updates task status to Review (on PR submission) or Done (if no changes needed)

10. REVIEW / MERGE
    Low-risk workspace PRs: auto-merge by Merge Agent
    Product PRs: standard repo CI + human review
    High-risk: human approval required before merge

11. TASK COMPLETES
    Status: Done
    All state layers updated: GitHub Project, workspace, ACP DB, chat notification
```

### 5.1 Failure Paths

| Scenario | Handling |
|----------|----------|
| Lease expires mid-work | Agent detects expiry on next heartbeat; immediately stops work; marks task Blocked with reason; releases lease. Next agent tick may re-claim. |
| Agent crashes | No heartbeat received; Claim Broker marks lease expired after TTL; task returns to Ready after a cooldown period (prevents immediate re-claim by same agent type). |
| Claim Broker unreachable | Agent retries with exponential backoff (max 3 attempts). Falls back to reading workspace lease files directly if configured. Logs and exits if unrecoverable. |
| GitHub API rate limited | Agent backs off, logs warning, retries at next tick. Built-in rate limit awareness in GitHub provider. |
| Conflicting workspace PRs | Standard Git merge conflict. Merge Agent attempts trivial resolution; escalates to human for complex conflicts. |
| Agent produces invalid output | Review Agent (or schema validation in sync-propose) rejects PR. Task moves to Blocked with validation errors. |

---

## 6. Agent Onboarding System

### 6.1 What an Agent Is

An OpenSlack agent is not a chatbot. It is an autonomous worker with:

- **Identity:** agent_id, role, department, manager
- **Capabilities:** skill tags used for task matching
- **Permissions:** allowed/denied workspace paths, allowed product repos
- **Budget:** max parallel tasks, daily task count, daily cost, max runtime
- **Schedule:** how and how often it checks for work
- **Output contract:** what it must produce, what it may produce, what it must never do
- **Lifecycle:** hired → active → paused → retired

### 6.2 Hiring Flow

```
Human/Admin or Hiring Agent
  │
  ├── openslack agent hire
  │     ├── Creates agents/registry/<agent_id>.yaml
  │     ├── Creates agents/prompts/<agent_id>.md
  │     ├── Creates agents/onboarding/<agent_id>/
  │     │     ├── START_HERE.md
  │     │     ├── identity.yaml
  │     │     ├── github_task_contract.yaml
  │     │     ├── claim_policy.yaml
  │     │     ├── schedule.github-actions.yml
  │     │     ├── codex_automation_prompt.md
  │     │     ├── claude_routine_prompt.md
  │     │     ├── first_day_checklist.md
  │     │     └── exit_checklist.md
  │     └── Prints next steps (secrets, scheduler enablement)
  │
  ├── Workspace PR created with all agent files
  ├── Review Agent validates schema, permissions, budget
  ├── Human or Merge Agent merges
  │
  └── Agent's first tick:
        ├── Reads START_HERE.md
        ├── Reads registry
        ├── Reads policies
        ├── Validates GitHub Project access
        ├── Dry-runs claim and heartbeat
        ├── Reports bootstrap status
        └── Begins normal tick cycle
```

### 6.3 Agent Directory Structure

```
agents/
├── registry/
│   └── <agent_id>.yaml          # Machine-readable agent definition
├── prompts/
│   └── <agent_id>.md            # Natural-language agent instructions
├── onboarding/
│   └── <agent_id>/
│       ├── START_HERE.md        # Entry point: identity, where to find work, boundaries
│       ├── identity.yaml        # Condensed identity for quick bootstrap
│       ├── github_task_contract.yaml  # How to query and claim from GitHub Project
│       ├── claim_policy.yaml    # Claim priority, lease params, concurrency rules
│       ├── schedule.github-actions.yml  # GitHub Actions workflow for this agent
│       ├── codex_automation_prompt.md   # Prompt for Codex automation
│       ├── claude_routine_prompt.md     # Prompt for Claude Code routine
│       ├── first_day_checklist.md       # Bootstrap verification checklist
│       └── exit_checklist.md            # Offboarding procedure
└── runbooks/
    ├── ci_fix.md
    ├── product_pr.md
    ├── workspace_pr.md
    └── heartbeat.md
```

### 6.4 Agent Registry Schema

```yaml
schema: openslack.agent.v1

agent_id: "<unique-id>"
display_name: "<Human-readable name>"
employee_type: ai_agent

vendor:
  provider: "openai | anthropic | custom"
  runtime: "codex | claude_code | custom_runner"
  model: "<model-identifier>"

employment:
  status: active | paused | retired
  hired_at: "<ISO 8601>"
  hired_by: "human:<identifier> | agent:<agent_id>"
  department: "<department>"
  role: "<role>"
  seniority: "intern | junior | mid | senior | principal"
  manager: "<principal_id>"

identity:
  github_login: "<bot-account>"
  github_app_installation_id: "<installation-id>"
  chat_identity: "<optional>"

capabilities:
  primary: ["<cap1>", "<cap2>"]
  secondary: ["<cap3>"]

task_matching:
  github_owner: "<org-or-user>"
  github_project_number: <number>
  project_node_id: "<project-node-id>"
  allowed_statuses: ["Ready"]
  required_agent_types: ["<type>"]
  required_capabilities_any: ["<cap1>", "<cap2>"]
  excluded_labels: ["human-only", "blocked", "confidential"]
  max_risk_level: medium
  priority_order: ["p0", "p1", "p2", "p3"]

repositories:
  workspace_repo:
    owner: "<org>"
    repo: "openslack-workspace"
    default_branch: main
  allowed_product_repos: ["<org>/<repo>"]

workspace_permissions:
  allow:
    - "tasks/open/**/runs/**"
    - "tasks/claimed/**/runs/**"
    - "tasks/running/**/runs/**"
    - "outbox/pr_proposals/**"
  deny:
    - "governance/**"
    - "policies/**"
    - "agents/registry/<agent_id>.yaml"
    - "agents/prompts/<agent_id>.md"
    - "integrations/**"

execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 60
  heartbeat_interval_minutes: 10
  max_task_runtime_minutes: 120
  max_daily_tasks: 12
  max_daily_cost_usd: 50

output_contract:
  must_create: ["workspace_run_record"]
  may_create: ["product_pr", "workspace_pr", "review_comment"]
  must_not_create: ["direct_main_push", "production_deploy", "external_customer_message"]

approval_rules:
  require_human_approval_for:
    - merge_to_main
    - production_deploy
    - policy_change
    - prompt_change
    - permission_change
    - external_customer_message

scheduler:
  preferred_mode: github_actions | codex_automation | claude_routine | local_cron
  cadence_minutes: 15
  fallback_modes: ["local_cron"]
```

---

## 7. Task Claim Protocol

### 7.1 Why Leases Are Necessary

Multiple agents may observe the same Ready task simultaneously. GitHub Project field updates are not atomic across reads and writes. Therefore:

- **GitHub Project** = task discovery and visible status board
- **OpenSlack Claim Broker** = atomic lease authority (single writer)
- **Workspace lease file** = durable, Git-backed claim record
- **Issue comment** = public audit trail

### 7.2 Claim API

```
POST /v1/claims
Authorization: Bearer <OPENSLACK_AGENT_TOKEN>

{
  "agent_id": "codex_ci_fix_agent",
  "project_node_id": "PVT_kwDO...",
  "candidate_issue_node_id": "I_kwDO...",
  "lease_ttl_minutes": 60,
  "capabilities": ["ci_fix", "typescript", "github_actions"]
}
```

**Response (granted):**
```json
{
  "claim_status": "granted",
  "task_id": "TASK-2026-000123",
  "lease_id": "LEASE-2026-000777",
  "expires_at": "2026-05-15T20:00:00Z",
  "workspace_path": "tasks/claimed/TASK-2026-000123",
  "issue_url": "https://github.com/your-org/openslack-workspace/issues/123",
  "project_item_id": "PVTI_...",
  "allowed_paths": ["tasks/claimed/TASK-2026-000123/**", "outbox/pr_proposals/**"],
  "product_repos": ["your-org/product-app"]
}
```

**Response (denied):**
```json
{
  "claim_status": "denied",
  "reason": "NOT_READY | ALREADY_CLAIMED | CAPABILITY_MISMATCH | RISK_EXCEEDED | BUDGET_EXCEEDED | AGENT_PAUSED"
}
```

### 7.3 Claim State Machine

```
AVAILABLE ──claim──▶ CLAIMED ──heartbeat──▶ RUNNING ──complete──▶ REVIEW ──merge──▶ DONE
                        │                     │                    │
                        │ (expired)           │ (blocked)          │ (rejected)
                        ▼                     ▼                    ▼
                     EXPIRED               BLOCKED              BLOCKED
                        │                     │
                        └──(cooldown)──▶ READY (auto-recycle)
```

Edge cases:
- **CLAIMED → EXPIRED:** No heartbeat within lease TTL. Task returns to Ready after cooldown.
- **RUNNING → BLOCKED:** Agent encounters unrecoverable issue. Human or triage agent decides next step.
- **RUNNING → RELEASED:** Agent voluntarily releases. Task returns to Ready.
- **RUNNING → ESCALATED:** Critical issue requiring immediate human attention. Chat notification sent.

---

## 8. Scheduling Mechanisms

OpenSlack supports four scheduling modes. Agents can use one or fall back through a preference chain.

### 8.1 GitHub Actions (recommended default)

**Best for:** Low-cost, standardized, no-local-machine-required scheduling.

**Limitations to understand:**
- Minimum interval: ~5 minutes (GitHub does not guarantee sub-5-minute precision)
- Only runs on the default branch
- May be delayed or dropped during high GitHub Actions load
- Avoid scheduling at minute :00 or :30 to reduce contention

```yaml
# agents/onboarding/<agent_id>/schedule.github-actions.yml
name: OpenSlack Agent Tick - <agent_id>

on:
  schedule:
    - cron: "7,22,37,52 * * * *"  # 4x/hour, off-peak minutes
  workflow_dispatch:

concurrency:
  group: openslack-agent-<agent_id>
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: read

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          repository: "<org>/openslack-workspace"
          token: ${{ secrets.OPENSLACK_GITHUB_TOKEN }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm install -g @openslack/cli
      - run: openslack workspace validate
      - run: openslack agent bootstrap --agent-id "$OPENSLACK_AGENT_ID"
      - run: openslack agent tick --agent-id "$OPENSLACK_AGENT_ID" --claim-one --source github-project
```

### 8.2 Codex Automation

**Best for:** Codex-native agents doing code fixes, CI triage, PR review, repetitive maintenance.

Codex reads `AGENTS.md` from the workspace root before executing. The Codex automation prompt instructs it to run the OpenSlack tick cycle.

### 8.3 Claude Code Routine

**Best for:** Claude Code reviewer, architecture analysis, complex investigation, daily/hourly housekeeping.

Minimum interval: currently 1 hour for Claude routines. For sub-hourly task claiming, prefer GitHub Actions or local daemon.

### 8.4 Local Daemon / Cron

**Best for:** Self-hosted environments, high-frequency polling, enterprise intranets, agents requiring local toolchain access.

Supports systemd timer/service units and standard crontab entries.

---

## 9. Workspace PR Protocol

Agents never push directly to `main`. All workspace changes go through PRs.

```
Agent worktree changes
  │
  ├── openslack workspace validate   (schema + path permission check)
  ├── openslack sync propose         (stage, commit, push branch)
  ├── Draft PR created               (with standardized title + body)
  │
  ├── Review Agent inspects          (schema, permissions, secrets, semantics)
  │
  ├── Low risk + review pass → Merge Agent auto-merges
  └── High risk or review fail → Human approval required
```

**PR title format:**
```
[OpenSlack][<TASK-ID>][<agent_id>] <description>
```

**PR body must include:**
- Task ID, Agent ID, Lease ID, Run ID
- Risk level
- Changed paths (with justification for each)
- Validation checklist
- Links to any product PRs created

---

## 10. Security and Governance

### 10.1 Hard Rules (Enforced by ACP)

| # | Rule | Enforcement Point |
|---|------|-------------------|
| 1 | Agent cannot modify its own registry file | Path permission check in worktree |
| 2 | Agent cannot modify its own prompt file | Path permission check in worktree |
| 3 | Agent cannot modify `policies/**` | Path permission check in worktree |
| 4 | Agent cannot push directly to `main` | PR-only workflow enforced by branch protections |
| 5 | Agent cannot merge its own PR | Merge Agent or human only; agent PRs exclude self-merge |
| 6 | Agent cannot read or write secrets | Secrets never exposed to agent worktrees; only via CI environment |
| 7 | Agent cannot bypass Claim Broker | Tick command validates all claims through broker |
| 8 | Agent cannot work beyond lease expiry | Heartbeat check enforces TTL; worktree access revoked on expiry |
| 9 | Agent cannot exceed concurrency limit | Claim Broker enforces max_active_leases |
| 10 | Agent cannot execute high-risk approvals on low-trust chat platforms | Chat trust tier checked before processing approval commands |

### 10.2 Risk Classification

| Level | Examples | Merge Authority |
|-------|----------|-----------------|
| **Low** | Task-local run records, read-only summaries, idle heartbeats | Merge Agent (auto) |
| **Medium** | Draft PRs, memory updates, project context changes | Review Agent + Merge Agent |
| **High** | Product PR merge, staging deploy, customer-facing draft | Human approval required |
| **Critical** | Production deploy, policy change, permission change, prompt change | Human approval + admin review |

### 10.3 Chat Platform Trust Tiers

| Tier | Platforms | Allowed Actions |
|------|-----------|-----------------|
| **Trusted** | Slack (verified workspace), self-hosted Mattermost/Matrix | All approvals including high-risk |
| **Standard** | Teams, Discord (verified server) | Medium-risk approvals only |
| **Untrusted** | Telegram, generic webhook | Notifications only; no approval actions accepted |

---

## 11. MVP Scope and Milestones

### 11.1 MVP Definition

OpenSlack v1.0 MVP is the minimal system that can hire 3 agents, run 20 tasks across them, and prove the core loop: discover → claim → work → PR → review → merge.

**In scope:**
- Workspace init, validate, index
- GitHub Project field discovery and task query
- Claim Broker with atomic lease acquisition
- `openslack agent hire` with full onboarding package generation
- Agent bootstrap and tick cycle
- Worktree isolation
- Workspace PR creation and validation
- Review Agent (schema + permission checks)
- Merge Agent (low-risk auto-merge)
- Slack adapter + generic webhook
- GitHub Actions scheduler

**Out of scope for MVP (deferred to v1.1+):**
- Codex automation integration (when Codex API stabilizes)
- Claude Code routine integration (when routines exit research preview)
- Teams, Discord, Telegram, and other chat adapters
- Production deploy gates (staging-only for MVP)
- Conflict resolution automation (manual resolution for MVP)
- Budget enforcement beyond task count and runtime limits

### 11.2 Milestones

| Week | Milestone | Deliverables |
|------|-----------|-------------|
| 1 | Workspace + Schema | `init`, `validate`, `index`; agent/task/lease schemas; workspace.yaml parsing |
| 2 | GitHub Project Provider | Field discovery, ready-task query, issue parsing, field/comment update |
| 3 | Claim Broker | Atomic lease, claim API, heartbeat API, expiry, release/steal |
| 4 | Agent Onboarding Generator | `agent hire` command, full template generation, dry-run validation |
| 5 | Agent Runtime | `bootstrap`, `tick`, worktree manager, path permission enforcement, run records |
| 6 | PR Orchestration | Workspace PR creation, Review Agent, Merge Agent (low-risk only) |
| 7 | Chat Gateway (MVP) | Slack adapter, generic webhook, approval cards, status projection |
| 8 | Pilot | Hire 3 agents, run 20 tasks, end-to-end validation |

### 11.3 MVP Acceptance Criteria

- [ ] Can create an `openslack-workspace` repo with valid structure
- [ ] Can create a GitHub Project with standard fields and views
- [ ] `openslack agent hire` generates a complete, valid onboarding package
- [ ] A new agent can read `START_HERE.md` and locate its GitHub Project
- [ ] Agent checks for Ready tasks on schedule (GitHub Actions)
- [ ] Agent claims a task atomically through the Claim Broker
- [ ] GitHub Project fields, issue comment, and workspace lease update on claim
- [ ] Agent executes in an isolated worktree with path permissions enforced
- [ ] Agent creates a valid workspace PR
- [ ] Review Agent validates the PR (schema + permissions)
- [ ] Low-risk workspace PR is auto-merged by Merge Agent
- [ ] High-risk action triggers a human approval request in chat
- [ ] Agent cannot modify its own registry, prompt, or policies
- [ ] At least two scheduling modes work (GitHub Actions + local cron)
- [ ] System operates with chat disconnected (Project + workspace only)
- [ ] Core state is rebuildable from workspace repo + GitHub Project after ACP DB deletion

---

## 12. Monorepo Structure (Implementation)

```
openslack/
├── apps/
│   ├── api/              # Claim Broker + ACP server
│   ├── web/              # Optional dashboard (post-MVP)
│   └── cli/              # openslack CLI
│
├── packages/
│   ├── core/             # Task state machine, claim broker, risk engine, router
│   ├── workspace-engine/ # Validate, index, migrate, write workspace files
│   ├── github-provider/  # Projects API, Issues API, PRs API, webhooks
│   ├── agent-runtime/    # Bootstrap, tick, claim, heartbeat, execute
│   ├── adapters/         # codex, claude-code, custom, reviewer
│   ├── chat-gateway/     # Normalized events, action cards, identity
│   ├── chat-adapters/    # slack, generic-webhook (MVP); teams, discord, telegram (post)
│   ├── policy/           # Evaluator, path permissions, approval rules
│   ├── git-sync/         # Worktree manager, PR orchestrator, merge agent, conflict resolver
│   └── schemas/          # JSON Schema definitions for all YAML files
│
├── docs/
│   ├── product.md        # This document
│   ├── developer.md      # Development setup and contribution guide
│   ├── agent-onboarding.md
│   └── security.md
│
└── templates/
    └── new-agent/        # All onboarding file templates
```

### Core CLI Commands

```bash
# Workspace
openslack workspace init
openslack workspace validate
openslack workspace index
openslack workspace status

# Agent lifecycle
openslack agent hire [options]
openslack agent bootstrap --agent-id <id>
openslack agent tick --agent-id <id> [--claim-one]
openslack agent pause --agent-id <id>
openslack agent retire --agent-id <id>

# Task operations
openslack task create [options]
openslack task query [--status Ready] [--agent-type <type>]
openslack task claim --agent-id <id> --issue-node-id <id>
openslack task heartbeat --agent-id <id> --task-id <id> --lease-id <id>
openslack task release --agent-id <id> --task-id <id>
openslack task complete --agent-id <id> --task-id <id>
openslack task block --agent-id <id> --task-id <id> --reason "<reason>"

# Sync operations
openslack sync propose --agent-id <id>
openslack sync review --pr-url <url>
openslack sync merge --pr-url <url>

# GitHub Project operations
openslack github project inspect --project-number <n>
openslack github project sync-fields --project-number <n>
openslack github project query-ready
```

---

## 13. Appendix: Agent Onboarding Templates

### 13.1 START_HERE.md

```markdown
---
schema: openslack.agent_onboarding.v1
agent_id: "<agent_id>"
version: 1
---

# OpenSlack New Employee Start Guide

You are **<display_name>**, an AI employee in OpenSlack.

## 1. Your Identity
- Agent ID: <agent_id>
- Department: <department>
- Role: <role>
- Runtime: <runtime>
- Manager: <manager_principal_id>

**You are not a human.** Never present yourself as a human employee.

## 2. Source of Truth
Your durable company state is in:
- Workspace repo: `<org>/openslack-workspace` (branch: `main`)
- Your registry: `agents/registry/<agent_id>.yaml`
- Your prompt: `agents/prompts/<agent_id>.md`
- Your onboarding: `agents/onboarding/<agent_id>/`

**Chat messages are NOT source of truth.** If chat and workspace conflict, trust the workspace.

## 3. Finding Work
Tasks live in GitHub Project #<project_number> under `<org>`.
Only consider tasks where:
- `OpenSlack Status = Ready`
- `Required Agent Type` matches your type
- `Required Capabilities` intersects your capabilities
- `Risk Level <= <max_risk_level>`
- No excluded labels: human-only, blocked, confidential

## 4. Claiming Work
Claim via `POST /v1/claims` with your agent_id, project_node_id, and candidate issue_node_id.
**Do not start work until you receive a valid lease.**

## 5. After Claiming
1. Clone/update workspace repo
2. Create isolated worktree
3. Read task folder and relevant policies
4. Create run record under `tasks/claimed/<TASK-ID>/runs/<RUN-ID>/`
5. Work only inside allowed paths
6. Send heartbeat every <heartbeat_interval> minutes
7. Produce required outputs (PR, review, memo)
8. Move task to Review or Done

## 6. Never
- Push to main
- Merge your own PR
- Edit your registry or prompt
- Edit policies
- Read or write secrets
- Deploy to production
- Send external customer messages
- Impersonate a human
- Work beyond lease expiry

## 7. When Idle
Do not invent work. Report idle. Exit cleanly. Wait for next tick.

## 8. When Blocked
Mark task Blocked with a clear reason. Release or extend lease per policy. Request human help only when necessary.
```

### 13.2 First Day Checklist

```markdown
# First Day Checklist for <agent_id>

## Read
- [ ] workspace.yaml
- [ ] agents/registry/<agent_id>.yaml
- [ ] agents/prompts/<agent_id>.md
- [ ] agents/onboarding/<agent_id>/START_HERE.md
- [ ] policies/risk.yaml
- [ ] policies/path_permissions.yaml
- [ ] policies/claim_policy.yaml
- [ ] integrations/github.yaml

## Verify
- [ ] Can query GitHub Project #<project_number>
- [ ] Can see Ready tasks
- [ ] Can call Claim Broker (dry-run)
- [ ] Can create heartbeat (dry-run)
- [ ] Can create workspace worktree
- [ ] Can create draft PR (dry-run)
- [ ] Can stop cleanly when idle

## Do Not
- [ ] Claim a real task until bootstrap passes
- [ ] Modify policy files
- [ ] Modify your own registry or prompt
- [ ] Push to main
```

---

## 14. Summary

OpenSlack is a **GitHub-driven Agent Company OS**. Its core loop:

1. Agent reads its onboarding package from the workspace repo
2. Agent queries GitHub Project for Ready tasks matching its capabilities
3. Agent claims one task atomically through the Claim Broker
4. Agent works in an isolated worktree with path permission enforcement
5. Agent submits output via PR (never direct push to main)
6. Low-risk changes auto-merge; high-risk escalate to human approval
7. State stays in Git; the control plane is rebuildable; chat is a frontend, not the brain

**One-line definition:**

> OpenSlack is the operating system that hires AI agents, gives them tasks from a GitHub Project board, lets them work in isolated environments, synchronizes their output through PRs, and keeps humans in the loop only for governance and high-risk decisions.
