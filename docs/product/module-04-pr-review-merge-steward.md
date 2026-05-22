---
schema: openslack.status.v1
status_date: 2026-05-23
---

# Module 04: PR Review & Merge Steward (PRMS)

## Overview

The agent-assisted PR gatekeeper. PRMS fetches PR metadata, classifies risk zones, checks merge readiness against policies, and generates review reports. It **never approves PRs** — approval remains a human-only action.

## Design Principles

| Principle | Rule |
|-----------|------|
| Agent reviews | Agent can analyze, classify, report, recommend |
| Human approves | Only humans submit `APPROVE` reviews |
| Agent merges after approval | Agent can execute merge only after GitHub confirms all gates satisfied |
| No self-review | Agent cannot review PRs it authored |
| No bypass | Agent cannot bypass branch protection ruleset |

## CLI Commands

```bash
openslack pr status <number>       # Show PR status and merge readiness
openslack pr review <number>      # Generate review report
openslack pr recommend <number>   # Recommend next action
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
- CHECKS_PENDING → CHECKS_FAILED

## Risk Zone Gating

| Zone | Decision | Human Required | Auto-Merge |
|------|----------|---------------|------------|
| Green | READY_TO_MERGE (if checks pass) | No | Yes |
| Yellow | READY_TO_MERGE (if checks pass) | No | With review |
| Red | NEEDS_HUMAN_APPROVAL → READY_TO_MERGE | Yes | After approval |
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
- Cannot: approve, merge, bypass ruleset

## Package Structure

```
packages/pr/
├── src/
│   ├── index.ts       # Barrel exports
│   ├── types.ts       # PRReviewReport, PRReviewState, PRReviewPolicy
│   ├── fetch.ts       # fetchPRDetails (GitHub API)
│   ├── classify.ts    # classifyPRReport (OSEK reuse)
│   ├── readiness.ts   # checkMergeReadiness (pure function)
│   ├── report.ts      # generateReviewReport (markdown)
│   ├── policy.ts      # loadPRReviewPolicy (YAML + fallback)
│   └── __tests__/
│       ├── classify.test.ts
│       ├── readiness.test.ts
│       └── report.test.ts
```

## Phase Roadmap

| Phase | Deliverables |
|-------|-------------|
| 1.13 (MVP) | `pr status`, `pr review`, `pr recommend` — read-only + report generation |
| 1.14 | `pr merge`, `pr watch`, `pr comment` — merge execution + GitHub comment posting |
| 1.15 | Operator integration — natural language PR management |

## Verification

```bash
pnpm test -- packages/pr/src/__tests__
```

All tests must pass before PR merge.
