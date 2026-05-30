---
schema: openslack.development_plan.v1
status: implemented
created: 2026-05-24
source_status: docs/status/current.md
implemented: 2026-05-24
---

# OpenSlack Unfinished Issues Development Plan

## Purpose

This document records the unfinished-work roadmap after reviewing the external
solution research for CODEOWNER deadlocks, Node 24 GitHub Actions migration,
LLM planning, workflow templates, and EVOL rollback backlog growth.

The research was useful, but the implementation below is calibrated to the
current OpenSlack repository and its constitutional constraints. The actionable
items in this document were implemented on 2026-05-24.

## Planning Constraints

These constraints are not optional:

- GitHub, Git, and `.openslack` remain the source of truth.
- Agents must not approve pull requests.
- Bot approvals are not valid human approvals.
- Chat confirmation must not satisfy GitHub CODEOWNER approval.
- PRMS gates must not be bypassed.
- Black Zone changes remain unmergeable.
- New workflow or LLM features must use typed, allowlisted actions rather than
  arbitrary shell command generation.

## Priority Summary

| Priority | Item | Decision | Target outcome |
|---|---|---|---|
| P0 | EVOL rollback backlog loop | Implemented. | Duplicate rollback proposals are deduplicated; `EXP-TEST*` artifacts are skipped; stale proposals use schema-valid `rejected`. |
| P0 | Author/CODEOWNER deadlock | Implemented without bot approval. | PRMS guidance and workspace PR preflight support bot/agent-authored Red Zone PRs with human CODEOWNER approval. |
| P1 | Node 24 Actions migration | Implemented. | All workflow actions are Node-24-capable and pinned to full SHAs. |
| P1 | LLM Planner | Implemented as optional fallback. | `openslack ask` can use typed LLM fallback without weakening execution controls. |
| P2 | Workflow Templates | Implemented. | Reusable templates instantiate registered actions, handoffs, decisions, waits, and gates. |

## P0-A: EVOL Rollback Backlog Loop

### Current Evidence

The workspace had 54 untracked rollback proposal files under
`.openslack/self/evolution_backlog/`. They alternated between `EXP-TEST` and
`EXP-TEST-ROLLBACK`, all in `rollback_proposed` state, and all were created by
`agent:post_merge_monitor`. They were local test artifacts and were removed
instead of committed as formal backlog.

The implementation root cause is that `createRollbackTask()` always allocates a
new EVOL ID and writes a new YAML file. It does not check for an existing
rollback proposal with the same experiment target.

`closed_stale` and `expired` are not valid statuses today. The current
`EvolutionStatus` enum and JSON Schema support `rejected`, `rollback_proposed`,
and `rolled_back`, but not those proposed cleanup states.

### Plan

1. Add rollback proposal deduplication.
   - Compute a stable rollback signature from `source.type` and
     `experimentId`.
   - Before writing a new rollback task, scan existing EVOL tasks for
     `status: rollback_proposed` with the same signature.
   - If one exists, update that task's evidence or last-seen metadata and
     return the existing task ID.
   - Add unit tests proving repeated calls for the same experiment do not create
     additional files.

2. Safely close current test artifacts.
   - Immediate cleanup must use a schema-valid status.
   - Preferred short-term status: `rejected`, with evidence noting
     `stale_test_artifact`.
   - If `closed_stale` or `expired` are desired, introduce a schema migration
     first and update TypeScript types, validation, indexer behavior, and tests.

3. Detect test experiments.
   - Treat experiment IDs matching `EXP-TEST*` as test artifacts unless an
     explicit override marks them production-relevant.
   - Do not create production rollback tasks for test artifacts.

4. Add TTL and rate limiting after deduplication.
   - TTL: unresolved rollback proposals older than 7 days become stale through a
     schema-valid lifecycle transition.
   - Rate limit: a single monitor source cannot create more than one rollback
     proposal per experiment per hour.

5. Separate detection from proposal creation.
   - `monitorPostMerge()` should continue returning regression observations.
   - A triage layer decides whether to create or update a rollback task.

### Acceptance Criteria

- Running rollback creation repeatedly for the same experiment produces one
  active rollback proposal.
- The 54 existing test rollback artifacts are closed with schema-valid state.
- `bun run test` includes regression coverage for duplicate rollback prevention.
- `openslack workspace validate` accepts the resulting EVOL backlog.

## P0-B: Author/CODEOWNER Deadlock

### Current Evidence

OpenSlack currently uses GitHub CODEOWNERS for Red Zone paths. The only listed
CODEOWNER is `@wsman`, which means a Red Zone PR authored by `@wsman` can
deadlock because the author cannot satisfy the required CODEOWNER approval.

PRMS already detects this state through `BLOCKED_AUTHOR_IS_SOLE_CODEOWNER` and
`BLOCKED_SINGLE_MAINTAINER`.

### Rejected Direct Adoption

Do not directly adopt a bot-approval solution yet.

The Fullstory Bot-Only Teams pattern is a valid industry pattern, but applying
it directly would conflict with OpenSlack's current rules:

- `no_auto_approval` is enabled.
- Bot approvals are ignored by PRMS.
- Agents are forbidden from submitting `APPROVE` reviews.

Any bot-mediated CODEOWNER approval path must first be designed as a governance
exception with explicit human approval evidence and policy changes.

### Plan

1. Preserve the current no-agent-approval rule.
   - PRMS must continue ignoring bot approvals.
   - Merge Steward must continue requiring valid human approval for Red Zone
     changes.

2. Provide a supported deadlock resolution path.
   - Preferred: add at least one additional human CODEOWNER for Red Zone paths.
   - Alternative: require Red Zone PRs to be bot/agent-authored while a human
     CODEOWNER approves them.
   - Bootstrap-only: record an explicit bootstrap exception when neither option
     is available.

3. Improve PRMS recommendations.
   - `BLOCKED_AUTHOR_IS_SOLE_CODEOWNER` should name the concrete allowed
     remediations.
   - The report should distinguish "needs another human CODEOWNER" from "needs
     bot-authored PR with human approval."

4. Optional future RFC: Bot-Only CODEOWNER Team.
   - Define whether the approval identity is a service account, GitHub App, or
     human-governed bot user.
   - Define where human approvers are stored.
   - Define how PRMS verifies human approval before any service identity acts.
   - Update `no_auto_approval`, PRMS bot filtering, security docs, and tests
     before implementation.

### Acceptance Criteria

- PRMS never treats a bot approval as a human approval under current policy.
- A sole-author CODEOWNER PR produces actionable remediation instructions.
- Red Zone merge still requires valid human approval.
- Any future bot-mediated approval design is blocked until policy and tests are
  updated together.

## P1-A: Node 24 GitHub Actions Migration

### Current Evidence

The repository has five workflow files and currently uses:

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `oven-sh/setup-bun@v2`
- `actions/github-script@v7`

One canary workflow uses `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, but the
canonical migration should be action-version upgrades, not reliance on the
force flag.

### Plan

1. Audit all workflow action versions.
   - Include `actions/github-script`, not only checkout/setup-node/bun run setup.
   - Verify whether any local or composite actions exist before migration.

2. Upgrade all JavaScript actions in one PR.
   - Use the current Node-24-capable major versions at implementation time.
   - Pin actions to full-length commit SHAs for supply-chain hardening.
   - Keep comments mapping each SHA to the source tag for maintainability.

3. Make package-manager caching explicit.
   - Decide between no setup-node cache and explicit bun run cache.
   - Do not rely on implicit cache behavior from `packageManager`.
   - If disabling implicit cache, set that explicitly in the workflow.

4. Verify runner compatibility.
   - Hosted runners should be compatible automatically.
   - Any self-hosted runner must be at or above the runner version that supports
     JavaScript actions running on Node 24.

5. Keep the canary workflow during migration.
   - Use it as a compatibility signal.
   - Do not use the force flag as the long-term fix.

### Acceptance Criteria

- All five workflows use Node-24-capable action versions.
- All external actions are pinned to full-length SHAs.
- `bun run typecheck`, `bun run test`, `bun run -w run build`, and OpenSlack validation
  workflows pass in CI.
- The migration PR documents any setup-node cache behavior changes.

## P1-B: LLM Planner

### Current Evidence

The Operator currently routes known requests through keyword intent parsing and
static planning. This is safe and cheap, but it cannot handle robust multi-turn
clarification, compound requests, or fuzzy queries.

### Plan

Adopt a three-layer planner without weakening execution safety.

1. Layer 1: keep the existing keyword router.
   - Known intents continue to route through `parseIntent()` and `planActions()`.
   - This remains the zero-LLM-cost path.

2. Layer 2: LLM intent classification for unknown requests.
   - Only call the LLM when the existing router returns `unknown` or low
     confidence.
   - The LLM returns a typed `IntentKind` and slots, not arbitrary commands.
   - The result re-enters the existing planner, risk assessment, missing-param
     handling, and confirmation gates.

3. Layer 3: typed multi-step planning for compound requests.
   - Add `tool-registry.ts` with typed action schemas for OpenSlack operations.
   - The LLM may select registered actions and fill typed arguments.
   - The executor rejects any action not present in the registry.
   - Add a recursion and retry limit for any observe-plan-execute loop.

4. Add verification.
   - Each mutating plan must include a verification step.
   - Verification failure blocks follow-up mutation.

### Acceptance Criteria

- The LLM cannot emit raw shell commands.
- All LLM-produced plans pass through the same allowlist, risk, and confirmation
  gates as static plans.
- Ambiguous requests produce clarification questions where possible.
- High-risk actions still require explicit confirmation.
- Unit tests cover unknown-intent fallback, invalid tool rejection, and compound
  plan verification.

## P2-A: Workflow Templates

### Current Evidence

The Collaboration Layer has events, activity, digest, handoff, decision, and
room views. Workflow templates are now implemented as typed preview/execute
support under `openslack collaboration workflow`.

### Plan

Use typed workflow templates that instantiate OpenSlack actions and
collaboration objects. Do not implement raw string command templates.

1. Define `openslack.workflow_template.v1`.
   - Inputs have names, types, defaults, and required flags.
   - Phases contain typed steps.
   - Steps reference registered OpenSlack actions, not arbitrary commands.

2. Supported initial step types:
   - `action`: execute a typed OpenSlack operation such as `pr.doctor`.
   - `decision-gate`: require a human or role-owned decision.
   - `handoff`: create a Collaboration Layer handoff.
   - `record-decision`: create a decision record.
   - `wait`: pause until an event or PRMS state appears.

3. Use correlation IDs.
   - Every workflow run gets a `correlationId`.
   - Events, handoffs, decisions, and room summaries use that ID to reconstruct
     the run.

4. Add preview before execution.
   - Show planned steps, side effects, required roles, and confirmation gates.
   - Reject templates with invalid input types or unsupported actions.

### Acceptance Criteria

- A template run can be reconstructed from events and workspace objects.
- No template can execute an unregistered command.
- Handoff and decision steps create the existing first-class workspace objects.
- Room views can show the workflow run's blockers and next action.

## Implementation Sequence

Completed order:

1. Fixed EVOL rollback deduplication and test-artifact cleanup.
2. Updated PRMS deadlock recommendations and Red Zone author-risk preflight.
3. Migrated GitHub Actions to Node-24-capable pinned actions.
4. Added the typed tool registry reused by LLM Planner and Workflow Templates.
5. Implemented LLM classification fallback for unknown/low-confidence intents.
6. Implemented typed Workflow Templates after the tool registry was stable.
7. Left Bot-Only CODEOWNER Teams as a separate future governance RFC.

## Validation Checklist

Before closing this plan:

- `bun run typecheck`
- `bun run test`
- `bun run -w run build`
- `bun run openslack workspace validate`
- `bun run openslack self eval --suite golden --clean`
- `bun run openslack status verify`
- `bash scripts/genesis-validate.sh`
