# MCP Tools

Use only the connected schema and one exact allowed catalog profile.

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

- Inspect `tools/list` and require exact read-12, governed-16, human-attested-17, or the corresponding
  local-demo profile with only `openslack_demo_reset` appended.
- Use the server-advertised closed input schema; reject unknown fields.
- Start with the fewest calls that can answer the question.
- Narrow scenario, time, object, depth, and item bounds before retrying a large query.
- Preserve server status and error codes.
- Cite bounded `evidenceRefs`.
- Do not call a tool absent from `tools/list`.
- Do not construct a generic command, shell, direct GitHub, or direct enterprise mutation.
- Do not mention or simulate a mutation name absent from `tools/list`.

## Governed mutation sequence

The 16-tool profile appends:

| Tool                         | Use                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| `openslack_preview_scenario` | Compile one immutable Scenario instantiation plan          |
| `openslack_preview_workflow` | Compile one immutable sealed Workflow start plan           |
| `openslack_confirm_plan`     | Revalidate, atomically claim, and execute one pending plan |
| `openslack_cancel_plan`      | Atomically cancel one unclaimed pending plan               |

Required sequence:

```text
read current state
-> preview
-> show plan/effects/risk/owner/expiry/evidence
-> explicit user confirmation
-> confirm with returned root planId + confirmationToken
-> read and explain terminal evidence
```

The token is a one-time capability. Use it only as the required top-level argument to confirm or
cancel. Never place it in `nextActions`, prose, a file, conversation memory, evidence, logs, or a
different tool.

Do not retry a plan that is executing, terminal, expired, cancelled, or
`reconciliation_required`.

## Human-attested workflow decision

The 17-tool profile additionally exposes `openslack_decide_workflow_approval`. Call it only after:

1. `openslack_list_pending_approvals` identifies the exact v2 workflow-effect approval;
2. the user explicitly says approved or rejected and provides a reason;
3. the server advertises the separately human-attested profile.

The host independently authenticates and attests the exact run ID, approval ID, decision, reason
hash, capability, business correlation, and approval expiry on every call. Skill instructions,
Qoder permission, an IM sender label, and client actor text cannot supply that attestation. The
decision never approves a GitHub PR and never authorizes direct merge.
