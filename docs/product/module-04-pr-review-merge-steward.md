---
schema: openslack.status.v1
status_date: 2026-05-23
---

# Module 04: PR Review & Merge Steward (PRMS)

## Overview

The agent-assisted PR gatekeeper. PRMS fetches PR metadata, classifies risk zones, checks merge readiness against policies, and generates review reports. It **never decides approval** — approval remains a human-only decision.

## Design Principles

| Principle | Rule |
|-----------|------|
| Agent reviews | Agent can analyze, classify, report, recommend |
| Identity split | Bot/agent identity authors OpenSlack work; human identity reviews and approves |
| Human approves | Only humans decide approval; GitHub enforcement requires the human GitHub identity |
| Agent-assisted evidence | Human reviewers may rely on PRMS and agent summaries instead of personally opening the PR page |
| Agent merges after approval | Agent can execute merge only after approval, checks, mergeability, and required conversation resolution pass |
| No self-review | Agent cannot review PRs it authored |
| No bypass | Agent cannot bypass branch protection ruleset |

## Human Approval Semantics

Human approval means an authorized human explicitly decides approve or reject for a named PR. The human can make that decision after reading an agent-generated report, PRMS doctor output, CI status, changed files, and risk classification.

OpenSlack-authored and delegated agent PRs must be authored by the configured bot/agent GitHub identity. The human GitHub identity is the reviewer and approval authority, not the PR author. If a required human reviewer or sole CODEOWNER authored the PR, the PR is blocked until it is recreated as bot/agent-authored or reviewed by a different independent human.

For Red Zone and CODEOWNER gates, the decision must still be recorded as a GitHub review by the required human GitHub identity. A chat confirmation is evidence of human intent, but it is not by itself a GitHub CODEOWNER approval. Bot/app/agent approvals remain invalid.

Human approval does not resolve GitHub review conversations. If repository
rules require conversation resolution, PRMS must treat unresolved required
review threads as merge blockers until the blocker is fixed or explicitly
waived and the thread is resolved.

See `docs/security/human-approval.md` for the cross-project definition.

## CLI Commands

```bash
openslack pr status <number>       # Show PR status and merge readiness
openslack pr review <number>      # Generate review report
openslack pr recommend <number>   # Recommend next action
openslack pr doctor <number>      # Run 11-gate governance diagnosis
openslack pr merge <number>       # Merge after all governance gates pass
```

## State Machine

```
DISCOVERED → CLASSIFIED → ANALYZED → CHECKS_PENDING → NEEDS_HUMAN_APPROVAL → HUMAN_APPROVED → READY_TO_MERGE → MERGED
```

Failure paths:
- ANALYZED → NEEDS_CHANGES
- ANALYZED → BLOCKED_POLICY
- ANALYZED → BLOCKED_SELF_REVIEW
- ANALYZED → BLOCKED_BLACK_ZONE
- ANALYZED → BLOCKED_DRAFT
- ANALYZED → BLOCKED_AUTHOR_IS_SOLE_CODEOWNER
- ANALYZED → BLOCKED_SINGLE_MAINTAINER
- CHECKS_PENDING → CHECKS_FAILED
- NEEDS_HUMAN_APPROVAL → BOT_APPROVAL_IGNORED
- NEEDS_HUMAN_APPROVAL → NEEDS_CODEOWNER_APPROVAL
- READY_TO_MERGE → BLOCKED_UNRESOLVED_REVIEW_THREADS

## Risk Zone Gating

| Zone | Decision | Human Required | Auto-Merge |
|------|----------|---------------|------------|
| Green | READY_TO_MERGE (if checks and required conversations pass) | No | Yes |
| Yellow | READY_TO_MERGE (if checks and required conversations pass) | No | With review |
| Red | NEEDS_HUMAN_APPROVAL → READY_TO_MERGE after checks and required conversations pass | Yes | After approval |
| Black | BLOCKED_BLACK_ZONE | N/A | Never |

## Policy

See `.openslack/policies/pr_review.yaml`:
- `no_auto_approval: true`
- `no_self_review: true`
- `red_zone_human_required: true`
- `black_zone_never_merge: true`

## Agent Registry

See `.openslack/agents/registry/pr_reviewer.yaml`:
- Role: reviewer
- Can: fetch PR, classify, report, recommend
- Cannot: decide approval, approve under bot/app/agent identity, bypass ruleset

## Package Structure

```
packages/pr/
├── src/
│   ├── index.ts          # Barrel exports
│   ├── types.ts          # PRReviewReport, PRReviewState, PRReviewPolicy
│   ├── fetch.ts          # fetchPRDetails (GitHub API)
│   ├── classify.ts       # classifyPRReport (OSEK reuse)
│   ├── readiness.ts      # checkMergeReadiness (pure function)
│   ├── report.ts         # generateReviewReport (markdown)
│   ├── policy.ts         # loadPRReviewPolicy (YAML + fallback)
│   ├── codeowners.ts     # parseCODEOWNERS, resolveCodeowners
│   ├── approvals.ts      # filterValidApprovals, isBotUser
│   ├── deadlock.ts       # detectDeadlock
│   ├── doctor.ts         # diagnosePR (11-gate engine)
│   ├── doctor-report.ts  # generateDoctorReport (markdown)
│   ├── merge.ts          # mergeIfReady (policy-gated merge)
│   └── __tests__/
│       ├── classify.test.ts
│       ├── readiness.test.ts
│       ├── report.test.ts
│       ├── codeowners.test.ts
│       ├── approvals.test.ts
│       ├── deadlock.test.ts
│       ├── doctor.test.ts
│       └── merge.test.ts
```

## Phase Roadmap

| Phase | Deliverables | Status |
|-------|-------------|--------|
| 1.13 (MVP) | `pr status`, `pr review`, `pr recommend` — read-only + report generation | COMPLETE |
| 1.14A | `pr doctor`, CODEOWNERS resolver, deadlock detector, valid approval filter | COMPLETE |
| 1.14B | `pr merge` — policy-gated merge execution via `mergeIfReady()` | COMPLETE |
| 1.15 | Operator integration — natural language PR management | COMPLETE |
| 1.16 | `pr watch`, `pr comment`, module registry, automated status generation | COMPLETE |

## Verification

```bash
pnpm test -- packages/pr/src/__tests__
```

All tests must pass before PR merge.
