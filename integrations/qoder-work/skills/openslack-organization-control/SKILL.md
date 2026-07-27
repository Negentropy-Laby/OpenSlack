---
name: openslack-organization-control
description: Read, preview, confirm, and explain governed OpenSlack organization work through an exact MCP profile. Use for executive status, owner/blocker/next-action summaries, Contract-to-Delivery scenario exploration, Organization Graph provenance, immutable scenario or workflow previews, bound OpenSlack confirmation, workflow-effect decisions when separately authorized, PR readiness, outcomes, and recovery from stale or uncertain evidence.
---

# OpenSlack Organization Control

Use OpenSlack as the workflow, governance, evidence, and projection backend. Treat Qoder as the
natural-language workbench, not as an authority or mutation path.

## Core workflow

1. Read current state before recommending work.
   - Start broad requests with `openslack_get_executive_overview`.
   - For a complex business goal, follow with `openslack_list_scenarios`.
   - Use `openslack_query_graph` to locate relevant scenario objects and relationships.
   - Use `openslack_explain_graph` before asserting authority, provenance, acceptance, or outcome.
2. Narrow the evidence.
   - Use work, room, activity, workflow, PR, approval, outcome, or notification tools only as
     needed.
   - Follow the input schema returned by the connected MCP server; never add unknown fields.
3. Preserve source truth.
   - Keep OpenSlack status tokens unchanged.
   - Label `demo_fixture`, `configured_estimate`, incomplete, stale, and unknown evidence.
   - Distinguish notification `accepted` from vendor `delivered`.
   - Never turn a green check, chat confirmation, fixture, or stale review into approval.
4. If the connected catalog includes governed mutation tools:
   - Read current state before previewing.
   - Call `openslack_preview_scenario` or `openslack_preview_workflow`; never construct effects
     yourself.
   - Show plan ID, effects, risk, owner, expiry, and evidence.
   - Wait for explicit user confirmation of that preview.
   - Call `openslack_confirm_plan` with the returned root `planId` and one-time root
     `confirmationToken`. Never persist, repeat, log, or move the token into another field.
   - Use `openslack_cancel_plan` only when the user explicitly cancels that pending plan.
5. Answer with these headings in this order:

```text
Status
Owner
Blocker
Next
Evidence
```

Use `unknown` when the connected evidence cannot support a value. Do not fill gaps with
conversation memory.

## Authority boundary

The default catalog is read-only. Mutation tools are optional and must be present in `tools/list`.
Never invent, simulate, or route around an absent mutation tool.

Never call GitHub, DingTalk, CRM, ERP, HR, shell, or generic command mutation around OpenSlack.
Never claim that Qoder permission is OpenSlack confirmation or GitHub human review.

`openslack_decide_workflow_approval` is usable only when the server advertises the separately
human-attested 17-tool profile and the user explicitly names the one approval and decision. The
host must independently authenticate and attest that exact run, approval, decision, and reason
hash for this call. User wording, a Qoder permission prompt, or a client actor label is never that
attestation. The tool decides one OpenSlack workflow effect; it never creates a GitHub review.

Skill UI, generated HTML, and a formal Workbench are presentation surfaces only. They cannot
authenticate a user, grant capability, establish approval, mutate authority, or become persistent
truth.

## Exact tool profiles

The foundation profile contains exactly these 12 read tools:

```text
openslack_get_executive_overview
openslack_list_work_items
openslack_get_work_room
openslack_get_activity
openslack_get_workflow_progress
openslack_get_pr_readiness
openslack_list_pending_approvals
openslack_get_business_outcomes
openslack_get_notification_status
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

The governed agent profile appends exactly:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

The separately human-attested profile appends one more tool:

```text
openslack_decide_workflow_approval
```

Local demo profiles may append only `openslack_demo_reset`. Accept only the exact 12, 16, or 17
production profiles, or their exact one-tool local-demo variants. Any other catalog is a blocker.

Read [references/mcp-tools.md](references/mcp-tools.md) before composing a multi-tool call
sequence.

## Evidence and governance

- Read [references/governance-boundaries.md](references/governance-boundaries.md) for any approval,
  trust, PR, merge, actor, or external-write question.
- Read [references/graph-and-evidence.md](references/graph-and-evidence.md) before explaining graph
  authority, completeness, hashes, truncation, or evidence quality.
- Read [references/business-language.md](references/business-language.md) when translating
  technical state for managers.
- Read [references/demo-scenario.md](references/demo-scenario.md) for Contract-to-Delivery Lite or
  interview-demo questions.

## Response resources

Select one template:

- General state: [templates/status-owner-blocker-next-evidence.md](templates/status-owner-blocker-next-evidence.md)
- Pending governance: [templates/approval-brief.md](templates/approval-brief.md)
- Business result: [templates/outcome-report.md](templates/outcome-report.md)

Use the examples only as structure, never as live evidence:

- [examples/contract-to-delivery-input.md](examples/contract-to-delivery-input.md)
- [examples/graph-explanation.md](examples/graph-explanation.md)
- [examples/recovery-conversation.md](examples/recovery-conversation.md)

## Fail closed

If a tool is absent from `tools/list`, do not call it. If the catalog is not an exact allowed
profile, state the catalog mismatch under Blocker and report the observed names under Evidence.

If a tool returns `blocked`, `failed`, incomplete, stale, truncated, or unknown evidence:

1. preserve the exact status and error code;
2. name the evidence owner when returned;
3. suggest one read-only narrowing or recovery check;
4. avoid stronger business, approval, delivery, or completion claims.

If a confirmed execution returns `reconciliation_required`, do not retry confirmation. Explain
that an effect may have occurred, read the stored plan/run state, and require reconciliation before
another mutation.
