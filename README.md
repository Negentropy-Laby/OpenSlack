# OpenSlack

**A local-first, Git-backed operating system for AI agents.**

OpenSlack lets heterogeneous AI agents (Claude Code, Codex, reviewers, researchers, custom) function as employees: discover tasks from GitHub Issues, claim them with deterministic git ref locks, work in isolated worktrees, submit output through PRs, and communicate with humans only for approvals and exceptions.

> **Status:** PARTIAL PRODUCT PASS. Two active modules. GitHub-backed autonomous task loop verified E2E.  
> **Repository:** [`wsman/OpenSlack`](https://github.com/wsman/OpenSlack) · 29 commits · 7 packages · 60 tests

---

## Architecture

```
OpenSlack/
├── openslack.yaml           # Self-Project Mode workspace
├── .openslack/              # Workspace state (policies, constitution, evals, tasks)
├── packages/                # 7 libraries (kernel, workspace, core, ...)
│   ├── kernel/              # Zone classifier (21 tests) + merge decision + invariant enforcement
│   ├── workspace/           # Validation (5 tests) + indexing + schemas + golden evals
│   ├── core/                # ClaimBroker + FileClaimBroker (file-locked)
│   ├── self-evolution/      # Observe, triage, review, scorecard, monitor, rollback (29 tests)
│   ├── agent-runtime/       # Agent bootstrap + tick (local + GitHub Issues)
│   ├── git-sync/            # Worktree manager + PR proposal/commit/push
│   └── github-provider/     # GitHub App auth + issue tasks + claims + lifecycle + repair
├── apps/
│   ├── cli/                 # 6 command groups (workspace, self, agent, task, github, operator)
│   └── auth-callback/       # Headless OAuth server (human login only)
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

- **Discover:** `agent tick --source github-issues` queries GitHub for ready issues
- **Claim:** Atomic `refs/heads/openslack/claims/issue-{n}` git refs prevent duplicate claims
- **Execute:** Worktree isolation → git commit → push → draft PR
- **Complete:** PR merged → claim ref deleted → issue → done

See: [`docs/developer/github-issues-loop.md`](docs/developer/github-issues-loop.md)

## Quick Start

```bash
# Prerequisites: Node.js >= 22, pnpm

# 1. Clone and install
git clone https://github.com/wsman/OpenSlack.git
cd OpenSlack
pnpm install
pnpm typecheck         # Verify build
pnpm test               # 60 tests

# 2. Verify workspace
openslack workspace validate
openslack workspace index
openslack workspace status

# 3. Run self-evaluation
openslack self eval --suite golden    # 7/7 must pass

# 4. Check system health
openslack github doctor               # Auth, config, labels

# 5. Genesis validation (zero runtime dependency)
bash scripts/genesis-validate.sh      # 5/5 checks
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `openslack workspace validate` | Validate Self-Project workspace |
| `openslack workspace index` | Build index from `.openslack/` plain text |
| `openslack workspace status` | Show workspace summary |
| `openslack self classify-pr --paths "..."` | Classify PR risk zone |
| `openslack self validate --pr <n> --paths "..."` | Full PR validation + manifest |
| `openslack self eval --suite golden` | Run 7 golden evals |
| `openslack self observe` | Check system health |
| `openslack self triage --create-issues` | Create EVOL task issues on GitHub |
| `openslack self review --pr <n>` | Review PR for merge eligibility |
| `openslack self scorecard --experiment <id>` | Compute fitness score |
| `openslack self monitor --experiment <id>` | Post-merge regression check |
| `openslack agent hire --agent-id <id>` | Generate onboarding package |
| `openslack agent bootstrap --agent-id <id>` | Verify agent readiness |
| `openslack agent tick --agent-id <id> --source github-issues` | Claim a task from GitHub |
| `openslack task checkout --issue-number <n>` | Create isolated worktree |
| `openslack task sync --issue-number <n> --paths "..."` | Commit + push + create draft PR |
| `openslack github doctor` | Check GitHub setup |
| `openslack github repair-labels` | Idempotently create required labels |
| `openslack github repair-claims` | Expire stale claims |
| `openslack github repair-all` | Run all repair operations |
| `openslack github metrics` | Task loop metrics |
| `openslack github issue-done --issue-number <n>` | Release claim + mark done |
| `openslack operator ask "..."` | Natural language → CLI routing |

## Authentication

Three-tier model (see [`docs/developer/github-automation.md`](docs/developer/github-automation.md)):

1. **GitHub App installation token** — primary runtime credential (JWT, auto-refresh, zero manual)
2. **PAT / GITHUB_TOKEN** — local dev fallback
3. **OAuth / gh CLI** — human login only

```bash
# GitHub App auth (preferred)
export OPENSLACK_GITHUB_APP_ID=3728623
export OPENSLACK_GITHUB_APP_INSTALLATION_ID=132714795
export OPENSLACK_GITHUB_APP_PRIVATE_KEY="$(cat .openslack.local/github-app.pem)"

# PAT fallback
export GITHUB_TOKEN=ghp_xxxxxxxx
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

| Document | Content |
|----------|---------|
| [`docs/status/current.md`](docs/status/current.md) | Single source of truth — current state |
| [`docs/product/phase-1.md`](docs/product/phase-1.md) | Phase 1 acceptance + architecture |
| [`docs/developer/github-issues-loop.md`](docs/developer/github-issues-loop.md) | GITL module reference |
| [`docs/developer/github-automation.md`](docs/developer/github-automation.md) | Auth architecture + setup |
| [`docs/developer/self-evolution-kernel.md`](docs/developer/self-evolution-kernel.md) | OSEK module reference |
| [`docs/developer/new-agent-onboarding.md`](docs/developer/new-agent-onboarding.md) | Agent hiring guide |
| [`docs/developer/technical-debt.md`](docs/developer/technical-debt.md) | P0/P1/P2 register |
| [`docs/security/self-evolution-guardrails.md`](docs/security/self-evolution-guardrails.md) | Zone classification + agent rules |

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

## Metrics

| Metric | Value |
|--------|-------|
| Packages | 7 libraries + 2 apps |
| CLI commands | 25 |
| CLI command groups | 6 |
| Unit tests | 60 |
| Golden evals | 7 (7/7 passing) |
| JSON Schemas | 7 (draft 2020-12) |
| GitHub Actions workflows | 5 |
| Genesis scripts | 3 |
| Agent onboarding templates | 9 |
| Policy files | 6 |
| Documentation files | 11 |
| Git commits | 29 |
