---
schema: openslack.agent_onboarding.v1
agent_id: '{{AGENT_ID}}'
version: 1
---

# {{DISPLAY_NAME}}: Manual Onboarding

Agent `{{AGENT_ID}}` uses runtime `{{RUNTIME}}`, role `{{ROLE}}` in `{{DEPARTMENT}}`,
and reports to `{{MANAGER}}`. It is an agent, not a human approver.

Read `openslack.yaml`, `AGENTS.md`, `.openslack/policies/self_evolution.yaml`,
`.openslack/agents/registry/{{AGENT_ID}}.yaml`, and `docs/contributor/github-issues-loop.md`.
The runtime entrypoint is `{{ENTRYPOINT}}`; this package is under
`.openslack/agents/onboarding/{{AGENT_ID}}/`. Git is the source of truth.

## Administrator Setup

The administrator must review the generated identity, capabilities, repository
`{{GITHUB_OWNER}}/{{GITHUB_REPO}}`, path permissions and execution limits before use.
A generated registry is not an approval or a grant to work on arbitrary source files.
The Yellow permission ceiling controls authorization; the Medium task risk ceiling
controls candidate selection. Both gates apply independently. For `custom_runner`,
provider `unconfigured` is a placeholder: an administrator must configure the actual
provider and execution environment before bootstrap can pass.
Do not edit your own registry or prompts to resolve a denied operation.

Have the administrator provision local identity under
`.openslack.local/agents/{{AGENT_ID}}/identity.yaml` and configure runtime/bot authentication
through the supported setup path. Never commit, copy or print local identity or credentials.
From the repository root, run:

```bash
bun run openslack workspace validate
bun run openslack agent bootstrap --agent-id {{AGENT_ID}}
```

Missing local identity must fail bootstrap, including in CI. Passing bootstrap is a
structural prerequisite, not task readiness, human approval, or live qualification.
This package installs no cron or Actions schedule. Each invocation is manual.

## Find and Claim Work

Use GitHub Issues with an open/ready task manifest and labels. Require the matching
agent type, every required capability, acceptable risk, and declared paths covered by
both the task and registry allow lists without intersecting deny rules. GitHub Projects
are optional projections, not a claim authority.

After these prerequisites, replace `<ISSUE-NUMBER>` with the reviewed target:

```bash
bun run openslack agent tick --agent-id {{AGENT_ID}} --source github-issues --issue-number <ISSUE-NUMBER>
```

A successful claim requires the atomic ref `refs/heads/openslack/claims/issue-<ISSUE-NUMBER>`
and verified owner evidence. A targeted rejection never permits a fallback to other work.
An existing claim must be verified before continuing; do not acquire duplicate work.

## Work Under the Actual Lease

The task manifest's lease supplies requested TTL and heartbeat values. If omitted,
GitHub Issues claiming currently defaults to 60 minutes TTL and 15 minutes heartbeat.
The returned claim receipt supplies effective expiry and next heartbeat; registry
execution limits never extend that lease. Legacy registry TTL and heartbeat fields
are parsed for compatibility but do not control GitHub Issues claims. There is no separate onboarding lease policy.

After a real claim is granted:

```bash
bun run openslack task checkout --agent-id {{AGENT_ID}} --issue-number <ISSUE-NUMBER>
bun run openslack github claim heartbeat --agent-id {{AGENT_ID}} --issue-number <ISSUE-NUMBER>
```

Use the returned isolated worktree; record its actual branch, task ID and run ID under
`.openslack/tasks/claimed/<TASK-ID>/runs/<RUN-ID>/`. Heartbeat before the receipt's due time,
and stop on expiry, uncertain ownership or renewal failure. Preserve evidence and use
the documented release/repair flow rather than deleting owner records manually.

Validate the permitted changes and submit from that worktree:

```bash
bun run openslack task sync --agent-id {{AGENT_ID}} --task-id <TASK-ID> --run-id <RUN-ID> --paths <CHANGED-PATHS> --issue-number <ISSUE-NUMBER>
```

Use the recorded IDs and exact allowed changed paths. Use configured bot delivery and
current-head PRMS checks. Human approval remains separate; never mark the task done
before governed lifecycle completion.

## Boundaries

Work only in the intersection of task and registry grants. Authorized creation targets
may not exist yet; their absence does not grant any additional path. Never modify your
registry, prompts, policies, credentials or protected paths; never push to main, deploy
to production, or originate approval decisions. The default registry denies `.github/**`, including workflows; task scope cannot
override registry deny rules. Report missing prerequisites as blocked; preserve evidence. When
idle, report idle and exit without inventing work.
