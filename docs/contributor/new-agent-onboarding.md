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

## Generation validation and recovery

Agent IDs are case-preserving portable names of 1–128 characters: start with a letter
or digit, then use letters, digits, dot, underscore or hyphen. Trailing dots, path
separators and Windows device names (including extensions) are rejected. Existing
identities are not renamed. Runtime must be `claude_code`, `codex` or `custom_runner`;
the latter uses provider `unconfigured` until an administrator configures it.
Missing values use documented defaults; an empty display name derives from the ID.
Other explicit empty fields are rejected with the field name before any publication.

Generation requires the complete source workspace's reviewed Markdown template inventory.
Packaged installations without those templates receive `AGENT_HIRE_TEMPLATES_UNAVAILABLE`;
run hire from a complete source checkout. Unknown templates are rejected, not silently omitted.
The generator creates the required prompts directory but writes no local identity or secrets.

Generation stages complete files on the destination filesystem and publishes the registry
last as its commit marker. It never overwrites an existing identity. An interrupted original
writer can be recovered by repeating the same command on the same host after that process
exits, provided its journal, staged files and any published files still match their hashes.
This is recoverable publication, not a cross-directory atomic transaction.

`AGENT_HIRE_BUSY` means an owner may still be running or belongs to another host. `AGENT_HIRE_RECOVERY_REQUIRED`
means evidence is missing, changed, or a recovery itself was interrupted.
An administrator must inspect `.openslack/agents/onboarding/.hire-<agent-id>`, preserve
its evidence, and remove only verified incomplete generation artifacts before retrying.
Do not delete a deployed registry or manually changed onboarding documents to force a retry.
`AGENT_HIRE_IO_FAILED` reports storage failure without printing machine-specific paths.

Task manifests control requested claim TTL and heartbeat; returned receipts control actual
expiry. Legacy registry lease fields remain readable but do not control GitHub Issues claims.
New identities explicitly declare Yellow authorization and Medium candidate-selection ceilings;
these are independent gates, not interchangeable risk labels. Default workflow denial remains
in force even when a task declares a workflow path.

`AGENT_HIRE_CLEANUP_REQUIRED` preserves a failed cleanup for administrator inspection.
If its message says registry publication completed, the identity already exists: do not
recreate it. Clean only the verified transaction evidence after inspecting the deployed files.
