# Module: GitHub Issues Task Loop (GITL)

> Status: ACTIVE (Phase 1.7 — Productized)
> Sources: `packages/github/src/{issue-tasks,claims,manifest,lifecycle,task-filter,repair}.ts`
> CLI: `openslack agent tick --source github-issues`

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
│  tickAgent(id, { source: 'github-issues' })                     │
│  → queryReadyIssueTasks() → GitHub Search API                    │
│  → claimIssueTask() → git ref atomic lock                        │
│  ↓                                                               │
│  WORK IN WORKTREE                                                │
│  openslack task checkout → git worktree add -b HEAD             │
│  ↓                                                               │
│  SUBMIT PR                                                       │
│  openslack task sync → git commit → GitHubDeliveryService       │
│  → PUSHED → PR_CREATED/UPDATED → HEAD_SYNCHRONIZED              │
│  → AWAITING_GATES (PRMS owns readiness and merge)               │
│  → moveIssueToReview() → labels: running → review                │
│  ↓                                                               │
│  COMPLETE                                                        │
│  PR merged → releaseIssueClaim() → labels: review → done         │
└──────────────────────────────────────────────────────────────────┘
```

## Claim Protocol

### Atomic Claim via Git Ref

The claim lock uses deterministic Git references as an atomic gate. This is the only reliable lock mechanism available at the repository level without a database.

```
ref: refs/heads/openslack/claims/issue-{issueNumber}
```

**Protocol:**

1. Agent queries ready issues via GitHub Search API (`label:openslack:task label:openslack:ready`)
2. For each candidate, agent gets main branch HEAD SHA
3. Agent attempts `POST /repos/{owner}/{repo}/git/refs` with the claim ref pointing to HEAD SHA
4. **If ref created (HTTP 201):** claim granted — return lease
5. **If ref already exists (HTTP 422):** claim denied — task already claimed by another agent
6. Best-effort label update: remove `openslack:ready`, add `openslack:claimed`, post claim comment

**Why git refs and not labels?**

Labels are not atomic. Two agents can simultaneously read label state, both see "ready", and both attempt to claim. Git ref creation is a server-side atomic operation — the first agent to create the ref wins, all others get HTTP 422.

### Release Protocol

```
DELETE /repos/{owner}/{repo}/git/refs/heads/openslack/claims/issue-{issueNumber}
```

Calling `releaseIssueClaim(issueNumber)` deletes the claim ref and moves the issue label to `openslack:done`.

## Issue Label Lifecycle

| Label               | State                    | Claim Ref                               | Notes                                         |
| ------------------- | ------------------------ | --------------------------------------- | --------------------------------------------- |
| `openslack:task`    | Marked as OpenSlack task | N/A                                     | Always present on task issues                 |
| `openslack:ready`   | Available for claim      | None                                    | Agent can attempt claim                       |
| `openslack:claimed` | Claimed by agent         | `refs/heads/openslack/claims/issue-{n}` | Claim ref is authoritative                    |
| `openslack:running` | Agent working            | Claim ref exists                        | Set manually by agent after worktree creation |
| `openslack:review`  | PR submitted             | Claim ref exists                        | Set by `moveIssueToReview()`                  |
| `openslack:done`    | Completed                | Claim ref deleted                       | Set by `releaseIssueClaim()`                  |
| `openslack:blocked` | Needs human              | Claim ref may exist                     | Set manually when agent cannot proceed        |

Labels are best-effort — they are a projection of the claim ref state, not the authoritative source. If labels and refs disagree, the ref wins. The `openslack github repair claims` command reconciles label state from ref state (dry-run by default, `--apply` to mutate).

## Task Manifest

Task issues embed structured metadata in YAML frontmatter within the issue body:

```yaml
schema: openslack.github_issue_task.v1
task_id: TASK-2026-000123
agent_type: codex
risk_level: low
required_capabilities:
  - typescript
  - ci-fix
allowed_paths:
  - packages/**
  - .openslack/tasks/**
forbidden_paths:
  - .github/**
output_contract:
  - draft_pr
  - workspace_run_record
```

`parseTaskManifest(body)` extracts this from the issue body. `buildTaskManifestYaml(manifest)` generates the YAML string for issue creation.

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

### `claimIssueTask({ issueNumber, agentId, ttlMinutes })`

Creates atomic git ref claim. Returns `{ claimStatus, claimRef, lease }`.

```
import { claimIssueTask } from '@openslack/github';

const result = await claimIssueTask({
  issueNumber: 42,
  agentId: 'codex_developer_ci-bot',
  ttlMinutes: 60,
});
if (result.claimStatus === 'granted') {
  console.log('Claimed:', result.claimRef);  // refs/heads/openslack/claims/issue-42
}
```

### `releaseIssueClaim(issueNumber)`

Deletes claim ref and moves issue to done.

### `moveIssueToReview(issueNumber, prUrl)`

Updates issue labels to `openslack:review` and posts PR link comment.

## CLI Usage

```bash
# Agent discovers and claims issues
openslack agent tick --agent-id codex_developer --source github-issues

# Self-observe creates issues from EVOL tasks
openslack self triage --create-issues

# Task sync creates PR and links to issue
openslack task sync \
  --agent-id codex_developer \
  --task-id TASK-2026-000999 \
  --run-id RUN-2026-000001 \
  --paths "packages/core/src/fix.ts" \
  --issue-number 1
```

## Authentication

Uses the three-tier auth model from `docs/developer/github-automation.md`:

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

# 2. Create test issue
node --import tsx -e "
import { createTaskIssue } from './packages/github/src/issue-tasks.js';
const r = await createTaskIssue('E2E Smoke Test', '## Task', [
  'openslack:task', 'openslack:ready', 'risk:low', 'agent-type:codex'
]);
console.log('Issue #' + r.issueNumber);
"

# 3. Agent discovers and claims
openslack agent tick --agent-id anthropic_architect_aby --source github-issues
# → Action: claimed, Task: #<n>, Claim: refs/heads/openslack/claims/issue-<n>

# 4. Verify claim ref exists on GitHub
# → https://github.com/Negentropy-Laby/OpenSlack/tree/openslack/claims

# 5. Verify issue labels changed
# → openslack:ready removed, openslack:claimed added

# 6. Release claim
node --import tsx -e "
import { releaseIssueClaim } from './packages/github/src/claims.js';
await releaseIssueClaim(<n>);
console.log('Claim released');
"

# 7. Verify claim ref deleted and issue → done
```

## Phase 1.7 Additions

### Manifest Validation (`manifest.ts`)

```bash
node -e "parseIssueTaskManifest(body)"  # uses openslack-task code fence + JSON Schema
```

- Required fields: `task_id` (TASK-YYYY-NNNNNN), `agent_type`, `risk_level` (low/medium/high/critical)
- Red Zone detection: `allowed_paths` hitting `.github/`, `.openslack/policies/`, etc. requires `human_approval_required_for: [red_zone_change]`
- Path conflict detection: intersecting allowed/forbidden paths

### Heartbeat + Expiry (`claims.ts`)

```bash
heartbeatIssueClaim(42, 'agent-x', 60)  # extends lease by 60 min
expireIssueClaim(42)  # deletes ref, resets to ready
releaseIssueClaimWithOwner({ issueNumber: 42, agentId: 'agent-x' })  # ownership check
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
repairExpiredClaims()  # lists refs, checks expiry, deletes stale, resets labels
`
```
