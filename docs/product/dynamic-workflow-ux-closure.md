# Dynamic Workflow UX Closure

OpenSlack Dynamic Workflow Parity v1 made workflows a governed product surface:
recommendation, ultracode draft triggers, pattern registry, draft generation,
policy, run evidence, save/export-skill, and budget/model/isolation metadata.

UX Closure turns that foundation into the user path:

```text
Generate -> Preview -> Run -> Watch -> Approve -> Save / Share
```

This document is an acceptance matrix for the next product increment. It does
not claim full Claude Code `/workflows` parity until the live agent controller,
phase/agent drilldown, and per-agent budget evidence are implemented and tested.

## Acceptance Matrix

| Area | Status | Acceptance |
|------|--------|------------|
| Workflow Home | Active | TUI exposes Start, Watch, and Reuse workflow paths without adding a top-level CLI command. |
| Start UX | Active | `openslack collaboration workflow start --prompt`, `--pattern`, and `--saved` route users to draft or preview paths without executing runs. |
| Progress Drilldown | Active baseline | CLI and TUI show run -> phase -> agent evidence from `.openslack.local/workflows/runs`. Missing or corrupt evidence degrades to warnings. |
| Budget UX | Active baseline | Draft preview and run progress show token budget, tokens used, remaining budget, max agents, concurrency, and exceeded behavior when recorded. |
| Agent Controls | Partial | Run-level pause/resume/stop/save are actionable. Agent-level stop/restart remains recorded-only until the live runtime controller is enabled. |
| Save From Run | Active | `save-run` saves the workflow script associated with a run without copying transcripts, secrets, or local evidence paths. |
| Catalog | Active | Built-in catalog entries map common Dynamic Workflow use cases to reusable patterns. High-risk catalog entries default to report/proposal behavior, not direct merge. |
| Governance | Active baseline | Workflows remain constrained by OpenSlack trust, side-effect manifests, permission profiles, worktree isolation, transcripts, PRMS, and human approval. |

## Cost And Scope

Workflows may cost more tokens than direct operator actions because they can
spawn many agents and run verification or synthesis phases. OpenSlack surfaces
budget evidence before and during runs where it is available. Interactive flows
pause on budget exhaustion; non-interactive flows fail closed.

## Non-Goals

- Workflow scripts do not receive direct filesystem or shell authority.
- `ultracode` is not a permission bypass.
- Full long-lived agent team runtime is not part of UX Closure.
- OpenSlack does not claim 100% Claude Code `/workflows` parity until live
  agent-level control and live per-agent cost visibility are complete.
