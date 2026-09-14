---
schema: openslack.document.v1
id: contributor-new-agent-onboarding
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-09-14
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# New Agent Onboarding Guide

## Administrator Registration

Run from a feature branch in the repository:

```bash
bun run openslack agent hire --agent-id codex_developer_ci-bot \
  --display-name "CI Bot" --department engineering --role developer \
  --runtime codex --github-owner Negentropy-Laby --github-repo OpenSlack
```

The command creates `.openslack/agents/registry/<agent_id>.yaml` and four Markdown
onboarding documents under `.openslack/agents/onboarding/<agent_id>/`: START_HERE,
first-day checklist, Codex prompt and Claude routine reference. The reported entrypoint
is the existing prompt for Codex/Claude, or START_HERE for a custom runtime. Codex
registrations use provider `openai`; other runtime defaults remain compatible and
must be reviewed for the intended provider. YAML values are serialized, not interpolated.
An existing registry or onboarding directory is rejected; hiring cannot rewrite an identity.

New packages are manual-only. No cron/Actions example or separate claim-policy/task-board
configuration is generated. The old `--project-number` option remains accepted for CLI
compatibility but is not an authority for GitHub Issues discovery or claiming. Existing
registries are not migrated or automatically regenerated.

## Before First Use

The administrator reviews provider, employment, capabilities, repository, allowed/denied
paths and execution limits through a governed PR. Agents cannot edit their own registry
or prompts. Nonexistent paths may be legitimate reviewed creation targets; validate
scope against the task, not merely whether a file already exists.

Local identity belongs under `.openslack.local/agents/<agent_id>/identity.yaml`, outside
the tracked package. Have the administrator provision it and configure runtime and bot
authentication through supported setup. Never copy credential material into onboarding
or repository evidence. Then run:

```bash
bun run openslack workspace validate
bun run openslack agent bootstrap --agent-id <agent_id>
```

Missing local identity is a failure on a fresh checkout, including CI. Bootstrap success
means structural checks passed, not that task authorization, human approval or external
qualification passed. Scheduled deployment requires separate configuration and review.

## Manual GitHub Issues Work

Follow the generated START_HERE and [GitHub Issues loop](github-issues-loop.md). Use
`agent tick --agent-id <id> --source github-issues --issue-number <n>` only after task
readiness and all required capabilities, risk and path checks pass. `--source` accepts
only `local` and `github-issues`; omission defaults to `local`, and invalid values fail
before runtime invocation. `--claim-one` is not supported.

Claims use `refs/heads/openslack/claims/issue-<n>` plus verified owner evidence. Only then
use `task checkout`, retain the returned worktree/task/run IDs, heartbeat before its due
time, and submit exact allowed paths through `task sync`. Do not fabricate claim history.

The Issue manifest supplies requested lease parameters. If omitted, the current GitHub
claim defaults remain 60 minutes TTL and 15 minutes heartbeat. The actual claim receipt
controls expiry and renewal. Legacy registry TTL/heartbeat fields remain parse-compatible
but do not override these values; new registrations omit them. Runtime limits do not
extend the lease. There is no separately consumed onboarding lease policy.

Keep bootstrap, task readiness, claim, source validation, hosted CI, human approval and
external qualification as separate evidence. Preserve blocked/unknown outcomes and use
the documented claim recovery flow. No local success implies release or live readiness.
