# MCP Tools

Use only the connected schema and these exact 12 read-only names.

## Start broad

| Tool                               | Use                                                                 |
| ---------------------------------- | ------------------------------------------------------------------- |
| `openslack_get_executive_overview` | Read current modules, work, PRs, workflows, approvals, and blockers |
| `openslack_list_scenarios`         | Select a scenario definition or instance for a complex goal         |
| `openslack_query_graph`            | Query bounded scenario nodes, edges, owners, and status             |
| `openslack_explain_graph`          | Explain authority, provenance, completeness, and evidence           |

Recommended complex-goal sequence:

```text
overview -> list scenarios -> query graph -> explain graph
```

## Narrow by object

| Tool                                | Use                                                                 |
| ----------------------------------- | ------------------------------------------------------------------- |
| `openslack_list_work_items`         | Filter bounded task/Issue projections                               |
| `openslack_get_work_room`           | Read one Issue, PR, workflow, handoff, or decision room             |
| `openslack_get_activity`            | Read bounded filtered collaboration activity                        |
| `openslack_get_workflow_progress`   | Read phases, agents, budget, gates, warnings, and evidence          |
| `openslack_get_pr_readiness`        | Read current-head PRMS readiness; never approve or merge            |
| `openslack_list_pending_approvals`  | Read separate confirmation, workflow-gate, and GitHub-review queues |
| `openslack_get_business_outcomes`   | Read basis-labelled outcome metrics for a bounded period/scenario   |
| `openslack_get_notification_status` | Read route state and separate acceptance/delivery observations      |

## Call discipline

- Inspect `tools/list` and require the exact 12-name catalog.
- Use the server-advertised closed input schema; reject unknown fields.
- Start with the fewest calls that can answer the question.
- Narrow scenario, time, object, depth, and item bounds before retrying a large query.
- Preserve server status and error codes.
- Cite bounded `evidenceRefs`.
- Do not call a tool absent from `tools/list`.
- Do not construct a generic command, shell, direct GitHub, or direct enterprise mutation.
- Do not mention or simulate unregistered mutation names.
