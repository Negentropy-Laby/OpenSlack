---
schema: openslack.agent_onboarding.v1
agent_id: 'codex_qualification_rext'
version: 1
---

# R-EXT Qualification: Manual Onboarding

This is the administrator-provisioned Codex identity `codex_qualification_rext` for
[Issue #411](https://github.com/Negentropy-Laby/OpenSlack/issues/411).
Its registry is `.openslack/agents/registry/codex_qualification_rext.yaml`; its Codex
entrypoint is `.openslack/agents/onboarding/codex_qualification_rext/codex_automation_prompt.md`.
Read `AGENTS.md`, `.openslack/policies/self_evolution.yaml`, and
`docs/contributor/github-issues-loop.md` before work. Git is the source of truth.

## Administrator Prerequisites

Keep #411 blocked until the governed registry changes are merged and the administrator
has provisioned the local identity and configured runtime/bot authentication through the
supported setup path. Local identity belongs under
`.openslack.local/agents/codex_qualification_rext/identity.yaml`; it is never committed,
printed or copied into this package. Do not inspect credential contents.

From the repository root, validate the workspace and bootstrap:

```bash
bun run openslack workspace validate
bun run openslack agent bootstrap --agent-id codex_qualification_rext
```

A missing local identity must fail bootstrap, including in CI. Bootstrap success is a
structural prerequisite, not permission to claim, call a provider, approve an effect or
claim R-EXT qualification. There is no installed scheduler; invocation is manual only.

## Claim and Work

After administrator prerequisites and task readiness are independently verified, require
all literal capabilities from the Issue manifest: `go`, `typescript`, `postgresql`, and
`test_writing`. Verify open/ready state and labels, Codex agent type, medium/Yellow risk,
and that every declared path is covered by both the task and registry permissions.

The following commands are post-prerequisite operations, not bootstrap probes:

```bash
bun run openslack agent tick --agent-id codex_qualification_rext --source github-issues --issue-number 411
bun run openslack task checkout --agent-id codex_qualification_rext --issue-number 411
```

Proceed to checkout only after a real claim is granted. GitHub claiming uses
`refs/heads/openslack/claims/issue-411` and verified owner evidence. A targeted rejection
must not fall back to another Issue. Use the returned worktree and record its actual
branch, task ID and run ID; preserve the workspace run record under
`.openslack/tasks/claimed/<TASK-ID>/runs/<RUN-ID>/`.

The Issue manifest supplies requested lease parameters (currently 120 minutes TTL and
15 minutes heartbeat for #411). The returned claim receipt supplies the effective expiry,
heartbeat interval and next heartbeat time. Registry execution limits do not override it.
Use `bun run openslack github claim heartbeat --issue-number 411 --agent-id codex_qualification_rext`
before its due time; stop on expiry, uncertain ownership or renewal failure. The configured
240-minute execution ceiling never extends a lease. One concurrent task is permitted.

After preparing and validating the authorized files, submit from the returned worktree:

```bash
bun run openslack task sync --agent-id codex_qualification_rext --task-id <TASK-ID> --run-id <RUN-ID> --paths <CHANGED-PATHS> --issue-number 411
```

Replace placeholders with the recorded values and exact allowed changed paths. Use the
configured bot delivery path and preserve all returned claim/PR synchronization evidence.
Do not manually declare a task done before governed lifecycle completion.

## Scope and Stop Conditions

The three qualification paths in the registry are authorized creation targets from #411;
their current absence is expected. Only the task-scoped fixture, harness, focused tests,
task records and outbox are writable. Do not widen those grants or edit unrelated workflows.
Never modify your registry, prompts, policies, protected files or credentials; never push
to main, deploy to production, or originate approval decisions.

Preparation must be reviewed and merged before authenticated qualification. Provider
budgets, exact human-attested effect approval, restart/drain evidence and R-EXT acceptance
remain separate gates in #411. Report missing evidence as BLOCKED or NOT_RUN, not PASS.
When blocked, preserve evidence and use the documented claim repair/release flow rather
than deleting owner evidence manually. When idle, report idle and exit without inventing work.
