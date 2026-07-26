# AI organization commercial loop

## Product claim

Qoder Work is the manager-facing conversational entry point. OpenSlack owns workflow execution,
agent routing, governance, evidence, and projections. GitHub owns formal Issues, Pull Requests,
Reviews, and merge state. A read-only console may display projections but never becomes a second
write path or source of truth.

The first demo scenario is deliberately fixed:

> Design a 90-day AI transformation pilot for a traditional manufacturing company. Inventory
> processes and data, select one use case, and produce an ROI model, architecture, risk review, and
> implementation plan.

## Commercial loop

```text
Business objective
      |
      v
Six-phase OpenSlack workflow
      |
      +--> governed agent evidence
      +--> seven stable artifacts
      +--> blockers and human decision points
      |
      v
GitHub parent/child Issues + bot-authored draft PR
      |
      v
PRMS + independent human GitHub Review
      |
      v
Business outcome projection
```

## Stable contract

| Phase    | Role routing                                       | Required result                                    |
| -------- | -------------------------------------------------- | -------------------------------------------------- |
| Intake   | `business-discovery-agent`                         | Objective, constraints, success measures           |
| Discover | business discovery + data inventory, concurrency 2 | Process and data inventory                         |
| Select   | `roi-analyst-agent`                                | One bounded pilot and explicit assumptions         |
| Design   | `solution-architect-agent`                         | Reversible architecture and agent controls         |
| Validate | risk review + adversarial ROI, concurrency 2       | Risks and falsifiable value boundary               |
| Deliver  | `delivery-planner-agent`                           | Milestones, acceptance, metrics, rollback triggers |

The workflow always returns these filenames in this order:

1. `executive-summary.md`
2. `opportunity-matrix.md`
3. `data-system-map.md`
4. `roi-model.md`
5. `target-architecture.md`
6. `risk-register.md`
7. `90-day-plan.md`

Model prose may vary in live mode; phase, role, schema, filename, and governance shapes may not.
The checked-in outcome assumptions are versioned at
`examples/ai-organization-demo/input/outcome-assumptions.yaml`. The fixed annual-value and simple
ROI values are `configured_estimate`, and the recorded projection cites the exact assumption
version. They are not observed savings or revenue.

## Authority boundaries

| Surface            | Authority                                                                             |
| ------------------ | ------------------------------------------------------------------------------------- |
| Qoder Work         | Describe goals, invoke allowlisted tools, display results                             |
| OpenSlack Workflow | Call configured agents and return structured artifact data                            |
| Rehearsal adapter  | Materialize artifacts and, only in explicit live mode, request governed GitHub writes |
| GitHub             | Store formal tasks, review decisions, PR state, and adoption                          |
| Human reviewer     | Originate GitHub Approval when independently authorized                               |

The workflow declares no side effects and cannot approve, merge, or push to `main`. Live rehearsal
is a separate explicit adapter path. Its task writes require GitHub App installation identity, and
its draft PR uses OpenSlack governed delivery with exact-head evidence.

## Evidence vocabulary

- `LOCAL_PASS`: schemas, fixtures, workflow routing, and local rehearsal are verified.
- `QODER_VERIFIED`: a current Qoder installation has exercised the MCP and Skill path.
- `GITHUB_REHEARSED`: the named repository contains the bot-authored Issues and synchronized draft
  PR from a successful live rehearsal.
- `INTERVIEW_READY`: the current live and recorded fallback paths have both passed the checklist.

These levels are cumulative only when their own evidence is present. A fixture must not be
presented as `GITHUB_REHEARSED`.
