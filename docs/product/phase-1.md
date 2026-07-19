---
schema: openslack.status.v1
status_date: 2026-05-16
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# Phase 1: Self-Evolution Kernel MVP — Acceptance Document

> Final Verdict: **CONDITIONAL PASS**
> Accepted: Self-Evolution Kernel Local MVP
> Deferred: Full GitHub-backed autonomous task execution loop
> Repository: `https://github.com/wsman/OpenSlack`

## Phase 1 Goal

Make OpenSlack the first project it manages — safely self-observing, self-validating, self-improving through PR gates without runaway.

## Current Architecture (Post Phase 1.3)

```
OpenSlack/
├── openslack.yaml                  # Self-Project Mode workspace manifest (mode: self_project)
├── AGENTS.md                       # Canonical agent instructions (constitutional constraints + dev rules)
├── CLAUDE.md                       # Pointer to AGENTS.md (1 line)
│
├── apps/cli/                       # CLI application — 7 command groups
│   └── src/commands/
│       ├── workspace.ts            # validate, index, status
│       ├── self.ts                 # init, classify-pr, validate, observe, triage, eval, review, scorecard, monitor
│       ├── agent.ts                # hire, bootstrap, tick
│       ├── task.ts                 # checkout, cleanup, status, sync
│       ├── github.ts               # doctor, issue-done, repair, metrics
│       └── operator.ts             # ask (natural language router)
│
├── packages/                       # 5 active libraries
│   ├── kernel/                     # Zone classifier (37 tests), merge decision, invariants — @openslack/kernel
│   ├── workspace/                  # Workspace validate (5 tests), index, schemas (6 JSON) — @openslack/workspace
│   ├── core/                       # ClaimBroker, FileClaimBroker (in-process lease state machine) — @openslack/core
│   ├── runtime/                    # Self-evolution ops (25 tests), golden evals, agent bootstrap, worktree, PR proposal — @openslack/runtime
│   └── github/                     # Octokit GraphQL client (31 tests), Issues/PR/Project v2, dry-run when no token — @openslack/github
│
├── .openslack/                     # Workspace state (single source of truth)
│   ├── agents/registry/            # Agent definitions (immutable by agents)
│   ├── policies/                   # 6 policy YAML files (risk, approvals, permissions, claim, constitutional, self-evolution)
│   ├── self/
│   │   ├── constitution.md         # 6-article constitution
│   │   ├── invariants.yaml         # 7 immutable rules
│   │   ├── eval_suites/golden/     # 7 golden eval YAML files
│   │   ├── evolution_backlog/      # EVOL task YAML files
│   │   ├── scorecards/             # Auto-generated SCORE-*.yaml
│   │   ├── experiments/            # Auto-generated self_validation.yaml
│   │   ├── release_channels/       # last_known_good.yaml
│   │   └── rollback/               # rollback_policy.yaml
│   ├── integrations/github.yaml    # GitHub Project v2 field definitions
│   └── tasks/ leases/ sync/ audit/
│
├── .github/                        # 5 CI workflows + PR template
├── docs/
│   ├── status/current.md           # Single source of truth (machine-readable)
│   ├── product/phase-1.md          # This document
│   ├── developer/                  # Architecture, onboarding, tech debt, schema
│   ├── security/                   # Self-evolution guardrails
│   ├── self-evolution/             # Original OSEK design review
│   └── archive/                    # Historical: original product spec, pre-hardening acceptance
├── templates/new-agent/            # 9 onboarding template files
└── scripts/                        # genesis-validate.sh, genesis-rollback.sh
```

## Package Dependency Graph

```
@openslack/cli
  ├── @openslack/kernel
  ├── @openslack/workspace
  ├── @openslack/runtime
  └── @openslack/github

@openslack/runtime
  ├── @openslack/kernel
  ├── @openslack/workspace
  ├── @openslack/core
  └── @openslack/github

@openslack/workspace
  ├── @openslack/kernel
  └── @openslack/core

@openslack/kernel
  ├── @openslack/core
  └── yaml

@openslack/core
  └── (no OpenSlack dependencies)

@openslack/github
  └── @octokit/rest
```

## Acceptance Summary

| #   | Module                               | Verdict    | Evidence                                                               |
| --- | ------------------------------------ | ---------- | ---------------------------------------------------------------------- |
| A   | Self-Project Workspace               | PASS       | `workspace validate/index/status` operational                          |
| B   | Constitution / Invariants / Policy   | PASS       | 6 articles, 7 invariants, 6 policy files, Red/Black zone gates         |
| C   | PR Classifier / Gate                 | PASS       | 4-zone classifier (21 tests), merge decision (8 tests), 4 CI workflows |
| D   | Golden Evals                         | PASS       | 7/7 passing, zero stub assertions                                      |
| E   | Self Observer / Evolution Task       | LOCAL PASS | Local EVOL creation; GitHub Issue/Project deferred                     |
| F   | GitHub Project Task Board            | DEFERRED   | Awaiting Project v2 config on wsman/OpenSlack                          |
| G   | New Employee Agent Onboarding        | PASS       | 9 templates, `agent hire` + `bootstrap`                                |
| H   | Agent Bootstrap / Tick / Claim       | LOCAL PASS | In-process claim broker; GitHub-backed claim deferred                  |
| I   | Worktree / Workspace PR              | PASS       | Worktree add/remove/dirty-check + PR proposal                          |
| J   | Self Validation Manifest / Scorecard | PASS       | Auto-generates self_validation.yaml + SCORE-\*.yaml                    |
| K   | Rollback / Genesis Layer             | PASS       | genesis-validate.sh (5/5), genesis-rollback.sh, FileClaimBroker        |
| L   | Documentation                        | PASS       | Phase 1 doc, developer guides, tech debt register, security guardrails |

## Phase 1.1 Hardening (Complete)

| P0   | Item                        | Status                                                                                 |
| ---- | --------------------------- | -------------------------------------------------------------------------------------- |
| P0-1 | Workspace index             | DONE                                                                                   |
| P0-2 | Eliminate stub golden evals | DONE — EV-GOLDEN-004 uses real ClaimBroker, EV-GOLDEN-007 uses real createRollbackTask |
| P0-3 | Auto self_validation.yaml   | DONE                                                                                   |
| P0-4 | Auto scorecard files        | DONE                                                                                   |
| P0-5 | Worktree manager            | DONE                                                                                   |
| P0-6 | Real workspace PR           | CODE EXISTS (needs external git remote to end-to-end test)                             |
| P0-7 | GitHub Provider             | CODE EXISTS (needs GITHUB_TOKEN + Project v2 config)                                   |
| P0-8 | Claim Broker persistence    | DONE — FileClaimBroker with atomic save/load                                           |

## Phase 1.2 Cleanup (Complete)

- 2 stub packages removed (chat-gateway, github-provider — latter rebuilt post-push)
- 2 duplicate CLI commands consolidated into self.ts
- 60+ verification artifacts purged
- Commit convention adopted (module-prefixed: `kernel: add`, `docs: document`, `repo: remove`)
- 7 commits rewritten to conform

## Phase 1.3 Architecture Consolidation (Complete)

- packages reduced from 10 to 7: schemas+evaluesv → workspace, policy → kernel
- CLI command groups reduced from 9 to 4: workspace, self, agent, task
- agents/registry/ migrated to .openslack/agents/registry/ (single workspace state directory)
- CLAUDE.md slimmed to 1-line pointer to AGENTS.md
- product.md moved to docs/archive/
- docs/status/current.md created as single source of truth
- .openslack/integrations/github.yaml created with Project v2 field definitions

## Golden Evals

| Eval          | Assertion                            | Method                                                   |
| ------------- | ------------------------------------ | -------------------------------------------------------- |
| EV-GOLDEN-001 | Workspace can self-bootstrap         | file_exists + in-process workspace validation            |
| EV-GOLDEN-002 | Agent cannot modify own prompt       | classifyPaths → RED + human required                     |
| EV-GOLDEN-003 | Red Zone requires human approval     | classifyPaths → RED                                      |
| EV-GOLDEN-004 | Concurrent claim — only one succeeds | ClaimBroker in-process, 10 claims → 1 granted / 9 denied |
| EV-GOLDEN-005 | Green docs auto-merge                | classifyPaths → GREEN                                    |
| EV-GOLDEN-006 | Black Zone fails immediately         | classifyPaths → BLACK, merge_decision = deny             |
| EV-GOLDEN-007 | Regression → rollback task           | createRollbackTask writes EVOL YAML file                 |

All 7 passing. Zero stub assertions.

## Test Coverage

| Package                | Test File               | Tests | Covers                                                                                 |
| ---------------------- | ----------------------- | ----- | -------------------------------------------------------------------------------------- |
| `@openslack/workspace` | `validate.test.ts`      | 5     | Workspace validation (valid, missing yaml, missing dir, invalid mode, missing subdirs) |
| `@openslack/kernel`    | `zones.test.ts`         | 21    | Zone classifier (all zones, mixed paths, boundaries, unknown inputs)                   |
| `@openslack/kernel`    | `classify-pr.test.ts`   | 7     | PR classification (all zones, constitution, self-evolution core)                       |
| `@openslack/kernel`    | `merge-decider.test.ts` | 8     | Merge decisions (black deny, null validation, red human, green approve, self-review)   |
| `@openslack/runtime`   | `review.test.ts`        | 8     | PR review (independence, validation, black/red zone, fitness thresholds)               |
| `@openslack/runtime`   | `scorecard.test.ts`     | 6     | Fitness score (pass, fail, security, large diffs, new deps, dimension weights)         |
| `@openslack/runtime`   | `monitor.test.ts`       | 5     | Post-merge monitor (stable, metrics structure, regression, default genesis)            |
| `@openslack/runtime`   | `observe.test.ts`       | 4     | Health observation (injected checks, no process spawn)                                 |
| `@openslack/runtime`   | `rollback.test.ts`      | 2     | Rollback task creation and execution                                                   |
| `@openslack/github`    | `manifest.test.ts`      | 10    | Manifest validation and parsing                                                        |
| `@openslack/github`    | `task-filter.test.ts`   | 19    | Task filtering by capability, risk, path                                               |
| `@openslack/github`    | `repair.test.ts`        | 2     | Label repair and claim repair                                                          |

**Total: 97 tests, 12 test files, all passing.**

## CLI Command Reference

| Command               | Subcommands                                                                                                                      | Primary Package                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `openslack workspace` | validate, index, status                                                                                                          | `@openslack/workspace`                                              |
| `openslack self`      | init, classify-pr, validate, observe, triage, eval, review, scorecard, monitor                                                   | `@openslack/kernel` + `@openslack/workspace` + `@openslack/runtime` |
| `openslack agent`     | hire, bootstrap, tick                                                                                                            | `@openslack/runtime`                                                |
| `openslack task`      | checkout, cleanup, status, sync                                                                                                  | `@openslack/runtime`                                                |
| `openslack github`    | doctor, project-inspect, project-sync-fields, project-query-ready, issue-done, repair-labels, repair-claims, repair-all, metrics | `@openslack/github`                                                 |
| `openslack operator`  | ask ("natural language")                                                                                                         | `@openslack/cli`                                                    |

## Key File Paths (Post Phase 1.3)

| Function                          | File                                         |
| --------------------------------- | -------------------------------------------- |
| `classifyPaths()`                 | `packages/kernel/src/zones.ts`               |
| `classifySelfEvolutionPR()`       | `packages/kernel/src/self/classify-pr.ts`    |
| `decideMerge()`                   | `packages/kernel/src/self/merge-decider.ts`  |
| `validateWorkspace()`             | `packages/workspace/src/validate.ts`         |
| `buildIndex()`                    | `packages/workspace/src/indexer.ts`          |
| `runGoldenEval()`                 | `packages/runtime/src/evals/runner.ts`       |
| `computeFitnessScore()`           | `packages/runtime/src/self/ops/scorecard.ts` |
| `observeHealth()`                 | `packages/runtime/src/self/ops/observe.ts`   |
| `triageObservations()`            | `packages/runtime/src/self/ops/triage.ts`    |
| `reviewPR()`                      | `packages/runtime/src/self/ops/review.ts`    |
| `monitorPostMerge()`              | `packages/runtime/src/self/ops/monitor.ts`   |
| `createRollbackTask()`            | `packages/runtime/src/self/ops/rollback.ts`  |
| `validatePR()`                    | `packages/runtime/src/self/ops/validate.ts`  |
| `ClaimBroker` / `FileClaimBroker` | `packages/core/src/claim-broker.ts`          |
| `bootstrapAgent()`                | `packages/runtime/src/bootstrap.ts`          |
| `tickAgent()`                     | `packages/runtime/src/tick.ts`               |
| `createWorktree()`                | `packages/runtime/src/worktree.ts`           |
| `proposeWorkspacePR()`            | `packages/runtime/src/propose.ts`            |
| `queryReadyItems()`               | `packages/github/src/issues.ts`              |
| `createDraftPR()`                 | `packages/github/src/pr.ts`                  |

## Deferred Items

| Item                              | Reason                                      | Dependency             |
| --------------------------------- | ------------------------------------------- | ---------------------- |
| GitHub Project v2 task board      | Needs Project configured on wsman/OpenSlack | External GitHub config |
| End-to-end agent tick via Project | Needs GITHUB_TOKEN + configured Project     | P0-7 + Project v2      |
| Chat gateway (Slack/webhook)      | Phase 2 scope                               | None                   |
| Server-mode Claim Broker          | Phase 2 scope                               | None                   |

## Quantified Progress

| Metric                     | Value                                |
| -------------------------- | ------------------------------------ |
| Git remote                 | `https://github.com/wsman/OpenSlack` |
| Git commits                | 53                                   |
| Packages                   | 5 active + 2 apps                    |
| CLI command groups         | 7                                    |
| CLI commands               | 25                                   |
| TypeScript source files    | 54                                   |
| Test files                 | 12                                   |
| Unit tests                 | 97                                   |
| JSON Schemas               | 8 (draft 2020-12)                    |
| YAML policy files          | 6                                    |
| Golden evals               | 7 (7/7 pass)                         |
| Genesis scripts            | 3                                    |
| GitHub Actions workflows   | 5                                    |
| Agent onboarding templates | 9                                    |
| Documentation files        | 11                                   |
