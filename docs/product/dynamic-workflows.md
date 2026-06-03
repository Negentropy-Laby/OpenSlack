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

Generated drafts are scaffolds. They are previewable and auditable, but they do
not become trusted high-permission workflows automatically.

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

## Security Boundary

Dynamic workflow generation never approves itself. Workflow trust changes,
side-effect execution, Red Zone changes, PRMS gates, and human approval remain
outside the workflow script's authority.
