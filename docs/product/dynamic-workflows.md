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

| Pattern | Purpose |
|---------|---------|
| classify-and-act | Classify each work item, then route to a branch or action |
| fanout-synthesize | Run independent workers, then merge results at a barrier |
| adversarial-verification | Verify candidates with independent verifier agents |
| generate-filter | Generate many candidates, filter/dedupe, return top results |
| tournament | Compare alternatives pairwise until a winner emerges |
| loop-until-done | Repeat bounded iterations until a stop condition is met |
| model-router | Choose model tier and worktree isolation by task purpose |

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
OpenSlack contributes workflow run summaries, phase transcripts, agent
attribution, and budget evidence; it does not mutate Negentropy-Lab
`AuthorityState` or obtain a writer handle.

Current workflow evidence is inspectable through the existing run commands
listed in this document. The slot contribution and export path is planned; it
is not yet an active integration.

## Security Boundary

Dynamic workflow generation never approves itself. Workflow trust changes,
side-effect execution, Red Zone changes, PRMS gates, and human approval remain
outside the workflow script's authority.
