# OpenSlack User Guide

Complete CLI reference for the OpenSlack Agent Company OS.

## Setup

| Command | Purpose |
|---------|---------|
| `openslack setup` | One-step full workspace validation (alt: `openslack setup run`) |
| `openslack setup github` | Guided GitHub auth + label setup (coming soon) |

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
| `openslack task checkout --issue-number <n>` | Create isolated worktree |
| `openslack task sync --issue-number <n> --paths "..."` | Commit + push + create draft PR |

## GitHub

| Command | Purpose |
|---------|---------|
| `openslack github doctor` | Check GitHub setup |
| `openslack github repair-labels` | Idempotently create required labels |
| `openslack github repair-claims` | Expire stale claims |
| `openslack github repair-all` | Run all repair operations |
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
| `openslack pr watch <n>` | Poll PR status until ready or timeout |
| `openslack pr merge <n>` | Merge PR after all gates pass |

## Operator

| Command | Purpose |
|---------|---------|
| `openslack operator ask "..."` | Natural language → CLI routing |
| `openslack operator ask "..." --plan` | Show execution plan without running |

## Chat Gateway

| Command | Purpose |
|---------|---------|
| `openslack chat start --adapter webhook --port 3000` | Start generic webhook chat adapter |
| `openslack chat start --adapter webhook --port 3000 --secret <secret>` | Start webhook adapter with HMAC signature verification |
| `openslack chat start --adapter slack --port 3000 --secret <signing-secret>` | Start Slack Events API adapter |

Chat Gateway is projection-only. GitHub/Git/.openslack remain the sole source of truth. Slack confirmation is not a GitHub CODEOWNER approval.

PRMS chat cards render compact PR doctor summaries in chat. Blocked PRs show the blocker, reason, and next step. Ready PRs display a Confirm merge button.

## Status & Health

| Command | Purpose |
|---------|---------|
| `openslack status` | Product dashboard with modules and GitHub ops |
| `openslack status generate` | Generate `docs/status/current.md` |
| `openslack status verify` | Verify consistency across docs |
| `openslack doctor` | Multi-module health check |

## Governance

| Command | Purpose |
|---------|---------|
| `openslack governance audit` | Audit recent main commits for direct-push compliance |
| `openslack governance audit --count <n>` | Audit last N commits |
