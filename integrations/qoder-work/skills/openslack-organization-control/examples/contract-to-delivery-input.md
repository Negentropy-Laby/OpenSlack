# Contract-to-Delivery Input

This is a structural example, not live evidence.

## User

> A company has signed an AI workflow transformation contract. Show the delivery project,
> security-review milestone, GitHub integration work, demo-material deliverable, current owner,
> blockers, next action, and evidence.

## Foundation read sequence

```text
openslack_get_executive_overview
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
openslack_get_workflow_progress   # only when a run ID is returned
openslack_get_pr_readiness        # only when a PR is returned
openslack_get_business_outcomes
openslack_get_notification_status
```

## Response shape

### Status

`<exact returned status>` — Contract-to-Delivery Lite is <business interpretation>.

### Owner

`<returned owner or unknown>`

### Blocker

`<returned blocker, incomplete source, or none observed>`

### Next

`<one returned human/external action or bounded read-only check>`

### Evidence

- `<scenario/graph evidenceRef>`
- `<workflow/PRMS evidenceRef>`
- `<outcome/notification evidenceRef>`

If the scenario instance does not exist and the current profile is read-only, report that boundary.
Do not pretend to instantiate it.

If `tools/list` is the exact governed profile and the user asks to create it:

```text
openslack_get_executive_overview
openslack_list_scenarios
openslack_preview_scenario
show immutable plan/effects/risk/owner/expiry/evidence
wait for explicit confirmation
openslack_confirm_plan with returned root planId + confirmationToken
openslack_query_graph
openslack_explain_graph
```

Never include the one-time token in the response or example output.
