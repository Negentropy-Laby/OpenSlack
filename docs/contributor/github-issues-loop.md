---
schema: openslack.document.v1
id: contributor-github-issues-loop
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-08-10
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Module: GitHub Issues Task Loop (GITL)

> Status: ACTIVE (Phase 1.7 — Productized)
> Sources: `packages/github/src/{issue-tasks,claims,manifest,lifecycle,task-filter,repair}.ts`
> CLI: `openslack agent tick --source github-issues [--issue-number <n>]`

## Overview

The GitHub Issues-First Autonomous Task Loop enables OpenSlack agents to discover, claim, execute, and complete tasks entirely through GitHub Issues — without requiring GitHub Project v2, OAuth device flow, or browser interaction.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  OBSERVE                                                         │
│  openslack self observe → triageObservations()                   │
│  ↓                                                               │
│  CREATE ISSUE                                                    │
│  createTaskIssue(title, body, [openslack:task, openslack:ready]) │
│  ↓                                                               │
│  AGENT TICK                                                      │
│  tickAgent(id, { source: 'github-issues', issueNumber? })         │
│  → targeted: getIssueTaskByNumber() → GitHub Issues API          │
│  → unscoped: queryReadyIssueTasks() → GitHub Search API          │
│  → manifest/risk/path authorization → git ref atomic lock        │
│  ↓                                                               │
│  WORK IN WORKTREE                                                │
│  openslack task checkout → git worktree add -b HEAD             │
│  ↓                                                               │
│  SUBMIT PR                                                       │
│  openslack task sync → git commit → GitHubDeliveryService       │
│  → PUSHED → PR_CREATED/UPDATED → HEAD_SYNCHRONIZED              │
│  → AWAITING_GATES (PRMS owns readiness and merge)               │
│  → reviewClaim() → verify owner/ref/PR → review                 │
│  ↓                                                               │
│  COMPLETE                                                        │
│  PR merged → completeClaim() → verify PR/ref/done postconditions │
└──────────────────────────────────────────────────────────────────┘
```

## Claim Protocol

### Atomic Claim via Git Ref

The claim lock uses deterministic Git references as an atomic gate. This is the only reliable lock mechanism available at the repository level without a database.

```
ref: refs/heads/openslack/claims/issue-{issueNumber}
```

**Protocol:**

1. Agent either queries ready issues through GitHub Search or reads one exact Issue with
   `--issue-number`.
2. Open state, task/ready labels, manifest status, capability, risk, allowed paths, forbidden paths,
   and candidate-specific authorization must all pass before a claim request.
3. Targeted selection never falls back to another Issue; any mismatch returns
   `TARGET_ISSUE_NOT_CLAIMABLE`.
4. For an eligible candidate, the agent gets main branch HEAD SHA.
5. Agent attempts `POST /repos/{owner}/{repo}/git/refs` with the claim ref pointing to HEAD SHA.
6. **If ref created (HTTP 201):** re-read the exact Issue and compare its state, labels, body,
   node identity, update timestamp, and canonical SHA-256 snapshot with the gated candidate.
7. If the Issue changed, delete the tentative ref and prove it is absent. A proven cleanup returns
   `STALE_CANDIDATE`; uncertain cleanup returns `RECONCILIATION_REQUIRED`.
8. For an unchanged Issue, write and read back `openslack.claim.v1` owner evidence containing a
   unique claim ID, task snapshot digest, task ID, effective risk, TTL, heartbeat interval, and next
   heartbeat. Missing owner evidence rolls the ref back before any lease is returned.
9. **If creation returns HTTP 422:** re-read the exact claim ref. Only an observed ref is
   `ALREADY_CLAIMED`; an absent/unreadable ref is `API_ERROR`.
10. Unscoped discovery may continue after candidate rejection, a proven stale snapshot, or
    `ALREADY_CLAIMED`, but transport,
    authentication, rate-limit, missing-reason, and unexpected gate failures stop the batch.
11. Finally project labels by removing `openslack:ready` and adding `openslack:claimed`. A label-only
    failure preserves the authoritative ref plus owner evidence and returns
    `projection: repair_required` with `openslack github repair claims --apply`.

**Why git refs and not labels?**

Labels are not atomic. Two agents can simultaneously read label state, both see "ready", and both attempt to claim. Git ref creation is a server-side atomic operation — the first agent to create the ref wins, all others get HTTP 422.

### Completion Protocol

```
DELETE /repos/{owner}/{repo}/git/refs/heads/openslack/claims/issue-{issueNumber}
```

`completeClaim({ issueNumber, agentId, prUrl })` verifies structured ownership,
exact PR evidence, and the linked PR's merged state before any completion
mutation. It then removes the claim ref, writes `openslack:done`, and re-reads
GitHub to prove both final postconditions. A 404 is idempotent success only when
the final Issue state is already complete.

## Issue Label Lifecycle

| Label               | State                    | Claim Ref                               | Notes                                         |
| ------------------- | ------------------------ | --------------------------------------- | --------------------------------------------- |
| `openslack:task`    | Marked as OpenSlack task | N/A                                     | Always present on task issues                 |
| `openslack:ready`   | Available for claim      | None                                    | Agent can attempt claim                       |
| `openslack:claimed` | Claimed by agent         | `refs/heads/openslack/claims/issue-{n}` | Claim ref is authoritative                    |
| `openslack:running` | Agent working            | Claim ref exists                        | Set manually by agent after worktree creation |
| `openslack:review`  | PR submitted             | Claim ref exists                        | Set and verified by `reviewClaim()`           |
| `openslack:done`    | Completed                | Claim ref deleted                       | Set and verified by `completeClaim()`         |
| `openslack:blocked` | Needs human              | Claim ref may exist                     | Set manually when agent cannot proceed        |

Initial claim labels remain a repairable projection of the atomic claim ref plus its verified owner
evidence. Repair never invents a missing owner. It synchronizes ready/claimed labels for active
claims and expires a claim from the latest valid heartbeat rather than the initial deadline.
Heartbeat, review, and completion commands are stricter: they never report
success until their required ref, owner, comment, label, and PR postconditions
have been re-read from GitHub. Partial mutations return a fixed error code and
one idempotent recovery command. The `openslack github repair claims` command
still reconciles stale projection state (dry-run by default, `--apply` to
mutate).

## Task Manifest

Task issues embed structured metadata in YAML frontmatter within the issue body:

```yaml
schema: openslack.github_issue_task.v1
task_id: TASK-2026-000123
title: Fix failing workspace validation
status: ready
agent_type: codex
risk_level: medium
required_capabilities:
  - typescript
  - ci-fix
allowed_paths:
  - packages/workspace/**
  - .openslack/tasks/**
forbidden_paths:
  - .github/**
output_contract:
  - draft_pr
  - workspace_run_record
```

`parseIssueTaskManifest(body)` extracts and validates this block. `status` is required. An entirely
missing `lease` uses the runtime default, while an explicit lease must contain valid
`ttl_minutes` and `heartbeat_minutes`. `renderIssueTaskManifest(manifest)` generates the canonical
YAML string for issue creation.

`agent_type` is a closed routing category (`codex`, `reviewer`, `sync`, or `memory`). The Issue must
carry exactly one `agent-type:*` label and it must match the manifest. That label does not grant
execution authority: registry capabilities, canonical risk, and path permissions remain decisive.

Before an atomic claim, OpenSlack reclassifies `allowed_paths` with the Kernel's canonical risk
policy. A manifest cannot lower that derived risk, Black Zone scope is never auto-claimable, and
Red Zone scope must declare `red_zone_change` human approval. The paths remain the task's declared
scope; actual changed files are independently rechecked during execution and PR governance.

## API Reference

### `createTaskIssue(title, body, labels)`

Creates a new GitHub issue with task labels. Returns `{ issueNumber, url, nodeId }`.

```
import { createTaskIssue } from '@openslack/github';

const { issueNumber, url } = await createTaskIssue(
  'Fix failing workspace validation',
  '## Task\n...',
  ['openslack:task', 'openslack:ready', 'risk:low', 'agent-type:codex'],
);
// → Issue #42: https://github.com/Negentropy-Laby/OpenSlack/issues/42
```

### `queryReadyIssueTasks(options?)`

Searches for issues with `label:openslack:task` + `label:openslack:ready`. Returns `IssueTask[]`.

```
import { queryReadyIssueTasks } from '@openslack/github';

const tasks = await queryReadyIssueTasks({
  agentType: 'codex',
  capabilities: ['typescript'],
  maxRisk: 'medium',
});
// → [{ issueNumber: 42, title: '...', labels: [...], body: '...' }]
```

### `getIssueTaskByNumber(issueNumber)`

Reads exactly one GitHub Issue without invoking Search. The discriminated result is `found`,
`not_found`, or `pull_request`; a found Issue retains its open/closed state so runtime gates can
fail closed before atomic claim creation.

```ts
import { getIssueTaskByNumber } from '@openslack/github';

const result = await getIssueTaskByNumber(42);
if (result.status === 'found') {
  console.log(result.task.state, result.task.labels);
}
```

### `claimIssueTask({ issueNumber, agentId, taskId, taskSnapshot, riskZone, ... })`

Creates a tentative atomic ref, revalidates the current Issue snapshot, persists owner evidence,
and then returns `{ claimStatus, claimRef, lease, projection }`.

```
import { claimIssueTask } from '@openslack/github';

const result = await claimIssueTask({
  issueNumber: 42,
  agentId: 'codex_developer_ci-bot',
  taskId: manifest.task_id,
  taskSnapshot: task.snapshot,
  riskZone: 'yellow',
  ttlMinutes: 60,
  heartbeatMinutes: 15,
  principal,
});
if (result.claimStatus === 'granted') {
  console.log('Claimed:', result.claimRef);  // refs/heads/openslack/claims/issue-42
  console.log('Next heartbeat:', result.lease.nextHeartbeatAt);
}
```

### Strict Claim lifecycle

`heartbeatClaim`, `reviewClaim`, and `completeClaim` return
`openslack.claim_lifecycle.v1`. They require a live GitHub client, structured
claim/heartbeat ownership, and verified remote postconditions. Raw transport
errors are replaced with fixed, non-secret error codes.
If heartbeat omits `ttlMinutes`, it inherits the original claim TTL. Explicit TTL overrides accept
`1..480`; every successful result reports the heartbeat interval and next heartbeat time. A
one-shot `agent tick` reports this schedule but does not start a background scheduler.

## CLI Usage

```bash
# Agent discovers and claims issues
openslack agent tick --agent-id codex_developer --source github-issues

# Agent claims only Issue #42; any mismatch fails without selecting another Issue
openslack agent tick \
  --agent-id codex_developer \
  --source github-issues \
  --issue-number 42

# Self-observe creates issues from EVOL tasks
openslack self triage --create-issues

# Task sync creates PR and links to issue
openslack task sync \
  --agent-id codex_developer \
  --task-id TASK-2026-000999 \
  --run-id RUN-2026-000001 \
  --paths "packages/core/src/fix.ts" \
  --issue-number 1

# Recover a published PR whose Issue review transition was interrupted
openslack github claim review \
  --issue-number 1 \
  --agent-id codex_developer \
  --pr-url https://github.com/owner/repo/pull/42

# Repair active ready/claimed projections and expire leases from latest heartbeat evidence
openslack github repair claims --apply

# Complete only after merge/review evidence exists
openslack github claim complete \
  --issue-number 1 \
  --agent-id codex_developer \
  --pr-url https://github.com/owner/repo/pull/42
```

The strict claim lifecycle currently accepts canonical `https://github.com/.../pull/<n>`
URLs only. GitHub Enterprise Server hosts are outside the v0.2.0 support boundary and fail closed
with `CLAIM_INVALID_INPUT`.

## Authentication

Uses the three-tier auth model from `docs/operations/github-automation.md`:

1. `OPENSLACK_GITHUB_APP_ID` + `OPENSLACK_GITHUB_APP_INSTALLATION_ID` + private key → GitHub App installation token (preferred)
2. `GITHUB_TOKEN` → PAT fallback
3. Neither → dry-run mode

## Required GitHub Labels

Created once (idempotent) via REST API:

| Label                 | Color    | Purpose          |
| --------------------- | -------- | ---------------- |
| `openslack:task`      | `1f6feb` | OpenSlack task   |
| `openslack:ready`     | `2da44e` | Ready for claim  |
| `openslack:claimed`   | `fbca04` | Claimed by agent |
| `openslack:running`   | `d29922` | Agent working    |
| `openslack:review`    | `8250df` | PR submitted     |
| `openslack:done`      | `6e7781` | Completed        |
| `openslack:blocked`   | `cf222e` | Blocked          |
| `risk:low`            | `2da44e` |                  |
| `risk:medium`         | `fbca04` |                  |
| `risk:high`           | `d29922` |                  |
| `risk:critical`       | `cf222e` |                  |
| `agent-type:codex`    | `0969da` |                  |
| `agent-type:reviewer` | `0969da` |                  |
| `agent-type:sync`     | `0969da` |                  |
| `agent-type:memory`   | `0969da` |                  |

## E2E Verification

```bash
# Prerequisites: GITHUB_TOKEN with repo scope, or GitHub App env vars set

# 1. Check readiness
openslack github doctor

# 2. Create a schema-valid ready test issue through the canonical task creator
openslack task create \
  --template docs \
  --title "E2E Smoke Test" \
  --path "docs/**" \
  --create-issue

# 3. Agent discovers and claims
openslack agent tick --agent-id anthropic_architect_aby --source github-issues
# → Action: claimed, Task: #<n>, Claim: refs/heads/openslack/claims/issue-<n>

# 4. Verify claim ref exists on GitHub
# → https://github.com/Negentropy-Laby/OpenSlack/tree/openslack/claims

# 5. Verify issue labels changed
# → openslack:ready removed, openslack:claimed added

# 6. Complete claim through the verified CLI contract
openslack github claim complete \
  --issue-number <n> \
  --agent-id <agent-id> \
  --pr-url https://github.com/owner/repo/pull/<n>

# 7. Verify claim ref deleted and issue → done
```

## Phase 1.7 Additions

### Manifest Validation (`manifest.ts`)

```bash
node -e "parseIssueTaskManifest(body)"  # uses openslack-task code fence + JSON Schema
```

- Required fields: `task_id` (TASK-YYYY-NNNNNN), `status`, closed `agent_type`, and `risk_level` (low/medium/high/critical)
- Red Zone detection: `allowed_paths` hitting `.github/`, `.openslack/policies/`, etc. requires `human_approval_required_for: [red_zone_change]`
- Path conflict detection: intersecting allowed/forbidden paths

### Heartbeat + Expiry (`claim-lifecycle.ts`, `claims.ts`)

```bash
heartbeatClaim({ issueNumber: 42, agentId: 'agent-x' })  # inherits the original claim TTL
reviewClaim({ issueNumber: 42, agentId: 'agent-x', prUrl })
completeClaim({ issueNumber: 42, agentId: 'agent-x', prUrl })
expireIssueClaim(42)  # deletes ref, resets to ready
```

### Task Filtering (`task-filter.ts`)

```bash
filterByCapability(manifest, agentCaps)  # required_capabilities ⊆ agent capabilities
filterByRisk(manifest, 'medium')  # blocks critical, respects max_risk_level
filterByPath(manifest, changedPaths)  # checks forbidden_paths + Black Zone
filterRedZonePaths(changedPaths)  # identifies Red Zone crossing (.github/, kernel/src, etc.)
```

### Repair (`repair.ts`)

```bash
repairLabels()  # idempotently creates 7 openslack:state labels
repairExpiredClaims()  # verifies owner, uses latest heartbeat, and repairs active/expired labels
```
