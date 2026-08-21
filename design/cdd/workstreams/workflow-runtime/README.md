---
schema: openslack.document.v1
id: cdd-workstream-workflow-runtime
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-08-20
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Dynamic Workflows

OpenSlack Dynamic Workflows adapt the harness ideas from Anthropic Dynamic
Workflows into OpenSlack's Git-backed collaboration model. The goal is not to
replace OpenSlack governance. The goal is to make complex tasks easier to plan,
run, resume, inspect, budget, and reuse.

## Capability Model

Dynamic Workflow Parity v1 adds these user-facing capabilities:

- `openslack ask "use a workflow to ..."` recommends a workflow when the task
  is broad, long-running, or verification-heavy.
- `openslack ask --effort ultracode "..."` treats the request as a workflow
  draft trigger when project policy allows ultracode.
- `openslack collaboration workflow generate --prompt "..."` creates a safe
  workflow draft under `.openslack/workflows/drafts/`.
- `openslack collaboration workflow patterns list` shows reusable orchestration
  patterns.
- `openslack collaboration workflow preview-draft <draftId>` shows phases,
  permissions, side effects, trust requirement, and budget estimate.
- `openslack collaboration workflow config show|enable|disable` controls
  project workflow availability.

Dynamic Workflow UX Closure adds the first workflow-first loop:

- `openslack collaboration workflow start --prompt "..."` evaluates a prompt,
  creates a draft, and shows the preview path without executing.
- `openslack collaboration workflow start --pattern <id>` starts from a known
  orchestration pattern.
- `openslack collaboration workflow start --saved <name>` shows preview,
  dry-run, and run commands for an existing workflow.
- `openslack collaboration workflow runs show <runId> --detail progress` shows
  run, phase, agent, transcript, and budget evidence.
- `openslack collaboration workflow save-run <runId> --to project|user|claude-project`
  saves the workflow script associated with a run.
- `openslack collaboration workflow catalog list|show|preview` exposes common
  Dynamic Workflow use cases as reusable catalog entries.

Generated drafts are scaffolds. They are previewable and auditable, but they do
not become trusted high-permission workflows automatically.

UX Closure does not claim full Claude Code `/workflows` parity. Agent-level
stop/restart is still recorded as control evidence until the live runtime
controller is enabled.

## Built-In Patterns

OpenSlack tracks these Dynamic Workflow patterns:

| Pattern                  | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| classify-and-act         | Classify each work item, then route to a branch or action   |
| fanout-synthesize        | Run independent workers, then merge results at a barrier    |
| adversarial-verification | Verify candidates with independent verifier agents          |
| generate-filter          | Generate many candidates, filter/dedupe, return top results |
| tournament               | Compare alternatives pairwise until a winner emerges        |
| loop-until-done          | Repeat bounded iterations until a stop condition is met     |
| model-router             | Choose model tier and worktree isolation by task purpose    |

These patterns are available as registry entries and workflow helper APIs. They
are evidence-producing helpers, not hidden background automation.

## Budgets And Cost

Workflows can use more tokens than direct actions because they may spawn many
agents. Dynamic drafts include default budget evidence:

- token budget
- maximum agents
- maximum concurrency
- budget-exceeded behavior

OpenSlack treats budget exhaustion as a control condition. Interactive flows
pause; non-interactive flows fail closed.

## Disable Policy

Workflows can be disabled for a project or process:

```powershell
openslack collaboration workflow config disable
$env:OPENSLACK_DISABLE_WORKFLOWS="1"
```

When disabled, OpenSlack still allows read-only list, show, and inspect
commands, but blocks generation and execution.

## Negentropy-Lab Slot Use

OpenSlack dynamic workflow runs can be exported to Negentropy-Lab as
evidence-bearing `scenario-pack.extension` slot contributions. In that mode,
OpenSlack contributes bounded run counts, status distributions, timestamps, and
canonical evidence hashes; it does not export phase transcripts or agent
attribution and does not mutate Negentropy-Lab
`AuthorityState` or obtain a writer handle.

Current workflow evidence is inspectable through the existing run commands
listed in this document. The schema-pinned preview is exported through
`openslack collaboration integration negentropy export-slot`; it remains
SHADOW, projection-only, and `NOT_REGISTERABLE`.

## Security Boundary

Dynamic workflow generation never approves itself. Workflow trust changes,
side-effect execution, Red Zone changes, PRMS gates, and human approval remain
outside the workflow script's authority.

## Overview

Workflow Runtime discovers, previews, runs, resumes, and inspects typed
multi-phase workflows and governed dynamic drafts.

## User Promise

Users see phases, agents, trust, isolation, budget, permissions, and side
effects before execution and can resume from durable evidence.

## Data Model

Workflow definition, pattern, draft, plan, run, phase, agent task, budget,
effect, approval record, artifact, and progress evidence.

## Edge Cases

Unknown pattern, untrusted draft, exceeded budget, missing agent, stale effect,
or unauthorized side effect blocks the affected transition.

## Dependencies

`@openslack/workflows`, agent runtime, collaboration evidence, PRMS, and the
workspace policy boundary.

## Configuration

Project workflow availability, trust, model routing, budget, and isolation are
explicit. Generated drafts do not gain trust automatically.

## Acceptance Criteria

- Identical inputs produce inspectable deterministic plans where specified.
- Resume rehydrates and revalidates the current bindings.
- Workflow code cannot approve itself or bypass repository governance.

## GS8-B Runner Lifecycle Boundary

The optional Go runner-server is a separate, default-off execution host for the existing
TypeScript workflow runner. Go owns runner job admission, attempt identity, lease, fencing token,
cancellation control, child-process supervision, and protocol receipts. TypeScript continues to
own workflow code, agent/provider calls, confirmation and effect execution, RunStore, checkpoint,
resume, and budget state.

The host accepts only hash-bound job and descriptor identities. A sealed deployment manifest fixes
the executable, one self-contained JavaScript entrypoint, argv, environment, working directory,
and artifact hashes; its closed bundle root rejects extra paths and no job or API request can choose
them. The worker treats an accepted workflow source file as the full workflow-code closure and
rejects runtime imports without changing the legacy CLI loader. JavaScript import begins only after
descriptor/source validation and a durable lease-accept receipt. An unprovable effect outcome
enters reconciliation and cannot be replayed automatically. Existing CLI/TUI run and resume
commands remain on their TypeScript route until the separately reviewed GS9 cutover.

## GS9-F1 Runner V2 Foundation Boundary

GS9-F1 may use the frozen runner-v2 vocabulary only through an explicit, default-off foundation
profile. Admission binds protocol, route/build/epoch, run revision, resume generation, and
capabilities; exact negotiation cannot downgrade to v1. The transport persists the current event
and exact runner receipt before a later domain-decision adapter may advance.

F1 contains no real checkpoint, TypeScript effect, budget, or resume adapter. Complete runtime
delivery, their decision ordering, and crash-after-authority recovery remain GS9-F2b exit gates
after the F2a contract freeze.
Runner-v1 bytes remain unchanged. Production v2 submission and new-record routing remain disabled;
TypeScript remains production Workflow, checkpoint/resume, approval, effect, budget, provider,
RunStore, and read authority.

## GS9-F2a Authority-Binding Contract Boundary

GS9-F2a is contract-only; GS9-F2b owns durable adapters, recovery, and runtime delivery. The
generated [authority-binding manifest](../../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative source for the six operations, coordinator and source-authority deltas, protocol
ordering, source locks, exact framing, and the closed `notDelivered`, `notActivated`, `notClaimed`,
and `separateGates` inventories. This CDD does not restate those inventories.

TypeScript remains the production Workflow authority, and the Go package remains a pure validator
with no durable authority. The active profile and service source manifest remain GS9-F1 until F2b
implements and independently qualifies the runtime composition described by the manifest boundary.
