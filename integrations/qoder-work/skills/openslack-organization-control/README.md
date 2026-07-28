# OpenSlack Organization Control Skill

This Qoder Work Skill turns exact OpenSlack MCP profiles into a governed organization-control
workflow. It reads and explains current state and, when a nominal mutation profile is present,
previews and confirms one immutable OpenSlack plan.

It is a presentation and tool-selection guide. OpenSlack remains the plan, governance, evidence,
and projection backend. GitHub and other enterprise systems remain authoritative for the records
they own.

## Current profiles

The default production profile uses exactly 12 read-only tools. Every advertised tool returns
`openslack.mcp_result.v2`.

The CLI selects the same 12 tools by default or with `--profile read-only`. An active Agent
registry/runtime binding with `scenario.instantiate` permission may explicitly select
`--profile agent-bound --principal-ref <agent-id>` for the exact 16-tool profile. The
human-attested 17-tool profile is not yet a CLI choice.

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

An opt-in governed profile appends exactly four tools:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

A separately human-attested profile appends `openslack_decide_workflow_approval`. Its host obtains
a fresh independently authenticated attestation for the exact run, approval, decision, and reason
hash. It decides one OpenSlack v2 workflow effect and is never a GitHub review. Exact production
counts are 12, 16, and 17.

An explicitly injected local demo composition may append only `openslack_demo_reset`; it never
touches live GitHub objects. A Qoder tool permission remains distinct from OpenSlack confirmation,
workflow-effect approval, GitHub review, and merge authority.

Every answer uses:

```text
Status
Owner
Blocker
Next
Evidence
```

## Install for Qoder Work desktop

The installers default to the Qoder Work desktop skills root:

```text
~/.qoderwork/skills/
```

They always install into the fixed child directory:

```text
openslack-organization-control/
```

Unix, Linux, or WSL:

```bash
./install/install.sh
./install/install.sh --target-root /absolute/test/skills
```

PowerShell:

```powershell
.\install\install.ps1
.\install\install.ps1 -TargetRoot C:\absolute\test\skills
```

An override must be an absolute, non-filesystem-root directory. The scripts stage a complete copy
beside the target and then replace only the named Skill directory. Reinstalling identical content
is a no-op. They do not read credentials, follow a target symlink/reparse point, or delete
unrelated files.

Restart the Qoder Work desktop conversation after installing or updating the Skill. Confirm it in
the Skills page or `/` chooser.

## Install for qodercli

qodercli uses different discovery roots:

```text
User:    ~/.qoder/skills/openslack-organization-control/SKILL.md
Project: <project>/.qoder/skills/openslack-organization-control/SKILL.md
```

Install with an explicit override:

```bash
./install/install.sh --target-root "$HOME/.qoder/skills"
./install/install.sh --target-root "/absolute/project/.qoder/skills"
```

```powershell
.\install\install.ps1 -TargetRoot "$env:USERPROFILE\.qoder\skills"
.\install\install.ps1 -TargetRoot "C:\absolute\project\.qoder\skills"
```

Start a new qodercli session, or run `/skills reload` and then `/skills`. Project scope overrides
a same-named user Skill. qodercli discovery does not configure the Qoder Work desktop connector
and cannot prove desktop qualification.

## Use

Invoke explicitly:

```text
/openslack-organization-control
```

Or ask a status-oriented question such as:

```text
Explain the current delivery status, owner, blocker, next action, and evidence.
```

For a complex goal, the Skill reads the executive overview, lists scenarios, queries the selected
graph, and explains provenance before presenting conclusions.

When the connected profile includes mutations, the Skill reads first, calls a preview tool, shows
the immutable effects and risk, waits for explicit confirmation, and passes the returned root
`planId` and one-time root `confirmationToken` to `openslack_confirm_plan`. It never persists or
echoes the token. An uncertain execution is reconciled, not retried.

Missing or stale current graph evidence fails closed as `SOURCE_EVIDENCE_UNAVAILABLE` or
`SOURCE_EVIDENCE_STALE`; it is not rendered as an empty authoritative graph.

## Evidence limits

- A demo fixture is not live authority.
- A configured estimate is not an observed outcome.
- A green check is not GitHub approval.
- Notification `accepted` is not vendor `delivered`.
- Skill UI, HTML artifacts, conversation memory, and Workbench state are not authority.
- Documentation and local tests do not by themselves prove Qoder desktop qualification.

See [SKILL.md](SKILL.md) for the operating workflow, `references/` for detailed boundaries, and
the [MCP developer guide](../../../../docs/developer/qoder-mcp.md) for connector setup, exact
profile rules, and the current-build acceptance record. No `QODER_VERIFIED` claim is made
here.
