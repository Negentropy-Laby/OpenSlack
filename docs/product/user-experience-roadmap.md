---
schema: openslack.product_plan.v1
status: draft
created: 2026-05-24
updated: 2026-05-24
source_status: docs/status/current.md
---

# OpenSlack User Experience Roadmap

## Purpose

This document turns the current product assessment into a concrete user
experience plan.

OpenSlack already has a working CLI-first foundation for agent-native work:
GitHub Issues provide task discovery, deterministic Git refs provide task
claims, worktrees isolate execution, pull requests carry deliverables, and PRMS
governs merge readiness.

The next product goal is to make that foundation usable by teams that do not
want to reason about every underlying GitHub, Git, and YAML primitive.

Implementation status: the first productization pass is active in the CLI and
package APIs. Setup reports, task creation preview/create, PRMS queue and
decision summaries, Operator pending plans, Chat actor mapping, collaboration
dashboard projection, and dry-run-first repair flows are implemented.

## Current Functional Modules

The current product surface has five active modules.

| Module | User-facing value | Current UX maturity |
|---|---|---|
| Self-Evolution Kernel | Keeps OpenSlack safe while it changes itself through risk classification, validation, golden evals, self-observe, triage, scorecards, and rollback paths. | Strong for maintainers; still technical for non-maintainers. |
| GitHub Issues Task Loop | Lets agents discover, claim, work, and complete tasks through GitHub Issues and deterministic claim refs. | Core loop plus typed task creation and dry-run repair UX are active. |
| Operator Interface | Provides `setup`, `status`, `doctor`, and `ask` as safer human entrypoints over lower-level CLI commands. | Typed planner, optional LLM fallback, setup report, and 24h pending plan memory are active. |
| PR Review & Merge Steward | Diagnoses PR readiness, checks governance gates, filters invalid approvals, detects deadlocks, and merges only after all gates pass. | Mature governance flow with action-oriented summaries and PR queue active. |
| Collaboration Layer | Records collaboration events and renders activity, digest, handoff, decision, room, workflow, and dashboard views. | Projection-only observability substrate with CLI team dashboard active. |

Supporting surfaces:

- Chat Gateway: webhook and Slack projection layer for routing messages to the
  Operator and PRMS confirmation flows.
- Auth Callback: local OAuth callback for human login; agent runtime still
  prefers GitHub App installation tokens or PAT fallback.

## UX Assessment

OpenSlack is currently usable for repository maintainers and agent operators
who understand GitHub Issues, branch protection, CODEOWNERS, worktrees, and PR
governance.

It is not yet a complete product experience for a general team member who wants
to assign work to agents the way they would use Slack, Linear, Jira, or GitHub
Projects. The core execution and governance loops are in place, but many
actions still expose implementation details directly.

The product should therefore treat the current system as a reliable substrate
and improve the user journey around it, not replace the substrate.

## Main UX Gaps

1. Setup is still technical, but now guided by a read-only report.
   Users need to understand GitHub App credentials, environment variables,
   labels, branch protection, CODEOWNERS, and dry-run behavior.

2. Task creation is now productized for CLI users.
   Further work should focus on chat cards and dashboard entrypoints.

3. Operator planning is still early for long conversations.
   `openslack ask` now has a typed tool registry and optional LLM fallback, but
   it does not yet support robust multi-turn memory or goal refinement.

4. Chat is a projection, not a complete collaboration experience.
   Slack and webhook adapters can route commands and confirmations, but actor
   mapping, permissions, audit visibility, and error recovery need more
   product polish.

5. PRMS has an action-oriented CLI surface.
   It can diagnose blockers accurately, but the ideal UX should emphasize the
   next required action, owner, evidence, and expected unblock path.

6. Collaboration observability has a CLI dashboard projection.
   A browser dashboard remains future work.

7. Recovery flows now default to dry-run.
   Claim expiry, auth failure, stale labels, branch protection drift, and
   CODEOWNER deadlocks are diagnosable, but remediation still assumes GitHub
   and Git expertise.

## Roadmap

### P0: Setup And First-Run Experience

Goal: A new maintainer can reach a healthy OpenSlack workspace without manually
debugging credentials and repository state.

Planned work:

- Add a guided setup flow that checks GitHub owner/repo, auth mode, labels,
  CODEOWNERS, branch protection, and required local directories.
- Turn `openslack setup github` from a mostly instructional command into an
  interactive verifier with clear remediation steps.
- Make `openslack doctor` output classify each failure as `fixable by command`,
  `requires GitHub admin`, `requires human approval`, or `informational`.
- Add a read-only setup dry run that explains exactly which external changes
  would be made before any mutation.

Status: implemented for CLI/package v1.

Acceptance criteria:

- A clean checkout can run one setup command and receive an actionable report.
- Missing labels can be repaired idempotently.
- Missing or invalid credentials produce a concrete next step, not only a
  generic auth failure.
- Dry-run mode never mutates GitHub or local state.

### P0: Task Creation UX

Goal: Users can create valid agent tasks without hand-writing task YAML.

Planned work:

- Add a guided task creation command that generates an `openslack-task`
  manifest from prompts or structured flags.
- Provide task templates for common workflows: bug fix, docs update, test fix,
  refactor, PR review, and investigation.
- Validate allowed paths, forbidden paths, risk level, required capabilities,
  and output contract before creating the GitHub Issue.
- Add a preview mode that renders the issue title, labels, manifest, and
  expected agent matching result.

Status: implemented for CLI/package v1.

Acceptance criteria:

- A user can create a ready GitHub task without editing YAML manually.
- Invalid Red Zone tasks explain the required human approval field.
- Black Zone paths are rejected before the issue is created.
- Generated tasks can be claimed by `openslack agent tick --source github-issues`.

### P1: Action-Oriented PRMS

Goal: PRMS reports should read like an operational decision, not only a status
dump.

Planned work:

- Add compact PRMS summaries with: decision, blocker, owner, next action,
  evidence, and command to rerun.
- Add grouped blocker categories: checks, approvals, risk zone, CODEOWNERS,
  mergeability, branch policy, and deadlock.
- Add a PR queue view for all open PRs, sorted by readiness and blocker owner.
- Make chat PR cards mirror the same decision model as CLI doctor output.

Status: implemented for CLI/package v1.

Acceptance criteria:

- A blocked PR always names the specific owner of the next action when known.
- A ready PR has a short confirmation path and still re-runs doctor before
  merge.
- Bot approvals and author approvals remain visibly ignored.
- Red Zone PRs clearly distinguish human approval from chat confirmation.

### P1: Operator Conversation And Plan Memory

Goal: `openslack ask` becomes a reliable work router rather than a keyword
shortcut.

Planned work:

- Add multi-turn clarification for missing PR numbers, issue numbers, agent
  IDs, changed paths, and risk confirmations.
- Persist pending plans locally so users can inspect, approve, cancel, or
  resume them.
- Add plan summaries that show side effects before execution.
- Keep all mutation intents allowlisted and confirmation-gated.

Status: implemented for CLI/package v1.

Acceptance criteria:

- Ambiguous requests do not fail with a generic unknown-intent response when a
  safe clarification is possible.
- High-risk operations require explicit confirmation after showing the exact
  command sequence.
- Pending plans expire and are auditable.

### P1: Chat And Slack Productization

Goal: Chat becomes a useful team entrypoint while GitHub and Git remain the
source of truth.

Planned work:

- Implement actor mapping from Slack/webhook users to OpenSlack roles.
- Make read-only-by-default behavior visible in chat responses.
- Add confirmed action cards for PR doctor, PR watch, merge request, task
  creation preview, and task handoff.
- Record chat-originated plan and confirmation events in the Collaboration
  Layer.

Status: implemented for actor mapping and confirmation events. Broader task
handoff/decision chat cards remain iterative follow-up work.

Acceptance criteria:

- Unmapped users can inspect status but cannot perform side effects.
- Mapped write users can request side-effect actions only through confirmation.
- Chat confirmation never bypasses GitHub approval, CODEOWNERS, or PRMS gates.

### P2: Team Workspace Dashboard

Goal: Teams can scan OpenSlack work without reading CLI output.

Planned work:

- Build a dashboard over existing projections: tasks, claims, PRs, blockers,
  handoffs, decisions, and activity.
- Show room views for `issue:<id>` and `pr:<id>` with source links, recent
  events, blockers, owners, next actions, handoffs, and decisions.
- Add filters by owner, module, risk, blocker type, and time window.
- Keep the dashboard projection-only; GitHub, Git, and `.openslack` remain the
  source of truth.

Status: implemented as `openslack collaboration dashboard`. Browser UI remains
future work.

Acceptance criteria:

- Dashboard data can be reconstructed from existing GitHub and collaboration
  state.
- No dashboard-only approval or merge state is introduced.
- A user can identify blocked work and the next owner from the first screen.

### P2: Recovery And Repair Flows

Goal: Common operational failures have guided repair paths.

Planned work:

- Add repair commands and explanations for stale claims, orphaned worktrees,
  missing labels, auth mode mismatch, branch protection drift, and CODEOWNER
  deadlocks.
- Provide safe dry-run previews for each repair.
- Emit collaboration events for repair actions and unresolved failures.

Status: implemented for GitHub repair dry-runs/apply paths and local worktree
repair. Additional repair cases can be added as observed failures appear.

Acceptance criteria:

- Each repair command states what it will mutate before it mutates.
- Failed repairs produce a next action and owner.
- No repair path weakens constitutional constraints or bypasses PRMS.

## Non-Goals

- Do not make chat the source of truth.
- Do not allow agents to approve PRs.
- Do not bypass GitHub branch protection or CODEOWNERS.
- Do not store secrets in workspace state or collaboration events.
- Do not replace the deterministic Git ref claim model with chat-only claims.
- Do not add dashboard-only state that can drift from GitHub, Git, or
  `.openslack`.

## Suggested Sequence

1. Finish setup and task creation UX first; these determine whether new users
   can start.
2. Improve PRMS summaries and queue views; these determine whether humans can
   safely approve and merge.
3. Add Operator plan memory and multi-turn clarification; this reduces command
   memorization.
4. Productize chat permissions and action cards; this makes the system useful
   in team channels.
5. Build the dashboard as a projection layer once the underlying events and
   decision model are stable.
6. Expand recovery flows continuously as operational failures are observed.

## Measurement

Track these product indicators before moving beyond Developer Preview:

- Time from clean checkout to healthy `openslack doctor`.
- Time from natural-language task request to valid GitHub Issue.
- Percentage of blocked PRs with a clear owner and next action.
- Percentage of chat requests resolved without falling back to manual CLI use.
- Number of unresolved stale claims, orphaned worktrees, and auth failures.
- Number of cases where docs/status, module registry, and CLI behavior drift.
