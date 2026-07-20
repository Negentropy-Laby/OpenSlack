# Dynamic Workflow UX Closure

OpenSlack Dynamic Workflow Parity v1 made workflows a governed product surface:
recommendation, ultracode draft triggers, pattern registry, draft generation,
policy, run evidence, save/export-skill, budget/model/isolation metadata,
current-process live controls, replay input persistence, and configured cost
estimates.

UX Closure turns that foundation into the user path:

```text
Start -> Preview -> Run -> Watch -> Approve -> Save / Share -> Publish
```

This document is the acceptance matrix for Dynamic Workflow UX Closure. It
does not claim a background daemon or completed-run replay parity with Claude
Code `/workflows`; live agent control is scoped to the current OpenSlack
process and requires persisted replay input.

## Acceptance Matrix

| Area               | Status                    | Acceptance                                                                                                                                                                                                                                                |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Home      | Active                    | TUI exposes Start, Watch, Approve, Save/Share, and Publish workflow actions without adding a top-level CLI command.                                                                                                                                       |
| Start UX           | Active                    | `openslack collaboration workflow start --prompt`, `--pattern`, and `--saved` route users to draft or preview paths without executing runs.                                                                                                               |
| Progress Drilldown | Active                    | CLI and TUI show run -> phase -> agent evidence from `.openslack.local/workflows/runs`, including prompt summary, tool evidence, result summary, transcript path, token usage, and replay availability. Missing or corrupt evidence degrades to warnings. |
| Budget UX          | Active                    | Draft preview and run progress show token budget, tokens used, remaining budget, max agents, concurrency, configured cost estimate, budget percent, warning/exceeded status, and exceeded behavior when recorded.                                         |
| Agent Controls     | Active with scoped parity | Run-level pause/resume/stop/save are actionable. Agent-level live stop and restart work inside the current OpenSlack process. Restart requires persisted replay input and rejects terminal, missing, or secret-blocked replay.                            |
| Save From Run      | Active                    | `save-run` saves the workflow script associated with a run to project, user, or Claude project targets without copying transcripts, secrets, or local evidence paths.                                                                                     |
| Catalog            | Active                    | Built-in catalog entries map common Dynamic Workflow use cases to reusable patterns. High-risk catalog entries default to report/proposal behavior, not direct merge.                                                                                     |
| Governance         | Active                    | Workflows remain constrained by OpenSlack trust, side-effect manifests, permission profiles, worktree isolation, transcripts, PRMS, and human approval.                                                                                                   |

## Cost And Scope

Workflows may cost more tokens than direct operator actions because they can
spawn many agents and run verification or synthesis phases. OpenSlack loads
project-local cost rates from `.openslack/workflows/cost.yaml` with schema
`openslack.workflow_cost.v1`. Rates are keyed by provider and model and use
`total_per_1m_tokens_usd` because v1 usage evidence records total tokens, not
input/output token splits.

Missing config and unknown provider/model pairs show cost as unknown, not zero.
Local or fake providers may be configured explicitly as zero-cost. The default
budget warning threshold is 80%. Interactive flows can pause on budget
exhaustion and create a workflow-effect approval; fail-closed policies reject
execution once the budget is exhausted.

## Non-Goals

- Workflow scripts do not receive direct filesystem or shell authority.
- `ultracode` is not a permission bypass.
- Full long-lived background agent team runtime is not part of UX Closure.
- Restart does not rewrite completed run history. Completed terminal runs must
  be handled by starting a new run.
- OpenSlack does not claim 100% Claude Code `/workflows` parity for background
  daemon orchestration or completed-run replay.
