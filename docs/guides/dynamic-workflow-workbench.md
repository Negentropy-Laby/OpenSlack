# Dynamic Workflow Workbench

Use this guide when a task is too broad, long-running, verification-heavy, or
worth reusing as a governed workflow. Dynamic Workflows keep the same OpenSlack
guardrails as normal agent work: preview first, explicit permissions, run
evidence, budget policy, approval pauses, and GitHub/PRMS governance.

## When to use workflow

Use a workflow when the task needs one or more of these:

- multiple phases with different agent roles
- fanout research followed by synthesis
- adversarial verification or tournament comparison
- repeatable project or user-level automation
- auditable progress evidence for phases, agents, tools, transcripts, and tokens
- budget/routing visibility before or during execution

For small one-step questions, `openslack ask "..."` or the relevant direct
module command is usually simpler.

## Generate a workflow

Start from natural language:

```bash
bun run openslack ask "use a workflow to audit every API endpoint"
bun run openslack ask --effort ultracode "verify this migration end to end"
```

Start from the workflow command surface:

```bash
bun run openslack collaboration workflow start --prompt "audit every API endpoint"
bun run openslack collaboration workflow start --pattern fanout-synthesize
bun run openslack collaboration workflow generate --prompt "compare three refactor strategies"
```

Drafts are written under `.openslack/workflows/drafts/`. Preview the draft
before trusting or saving it:

```bash
bun run openslack collaboration workflow preview-draft <draft-id-or-path>
```

The preview shows phases, permissions, side effects, trust requirement, and
budget estimate.

## Run a workflow

For saved workflows, keep the standard execution ladder:

```bash
bun run openslack collaboration workflow preview <file-or-name>
bun run openslack collaboration workflow dry-run <name>
bun run openslack collaboration workflow run <name>
```

`run` initializes `.openslack.local/workflows/runs/<runId>` and persists run
metadata, status, phase checkpoints, agent results, pending approvals, logs,
output, and replay input when available.

## Watch progress

Use the CLI:

```bash
bun run openslack collaboration workflow runs
bun run openslack collaboration workflow runs show <runId> --detail progress
```

Or use the TUI:

```bash
bun run openslack tui
```

From Home choose:

- `Start a workflow`
- `Watch running workflows`
- `Handle paused workflow approvals`
- `Save/share run`
- `Publish workflow to GitHub Issues`

The run view shows the run, phase, and agent tree with prompt summaries,
tool evidence, result summaries, transcript paths, token usage, replay
availability, live controls, budget state, and pending approvals.

Live agent stop/restart is scoped to the current OpenSlack process. Restart
requires persisted replay input and rejects completed terminal runs, missing
replay input, or replay input blocked by secret scanning.

## Save / export

Save a workflow draft or saved workflow:

```bash
bun run openslack collaboration workflow save <draft-or-name> --to project
bun run openslack collaboration workflow save <draft-or-name> --to user
bun run openslack collaboration workflow save <draft-or-name> --to claude-project
```

Save the workflow script associated with a run:

```bash
bun run openslack collaboration workflow save-run <runId> --to project
bun run openslack collaboration workflow save-run <runId> --to user
bun run openslack collaboration workflow save-run <runId> --to claude-project
```

Export as a skill:

```bash
bun run openslack collaboration workflow export-skill <workflow-name> --out skills/<name>
```

Save/export copies workflow source, not local transcripts, secrets, or
`.openslack.local` evidence.

## Publish to GitHub

Use workflow lifecycle commands to make work visible in GitHub Issues:

```bash
bun run openslack collaboration workflow publish <workflow-name>
bun run openslack collaboration workflow review-request <workflow-name>
bun run openslack collaboration workflow split <workflow-name> --issue <parentIssue>
```

The TUI Workflow Home and workflow detail screen expose these as visible
Publish actions so operators do not need to discover them through nested menus.

## Disable workflows

Disable generation and execution by policy:

```bash
bun run openslack collaboration workflow config disable --reason "maintenance"
```

Or by environment:

```powershell
$env:OPENSLACK_DISABLE_WORKFLOWS = "1"
```

Read-only list, show, and inspect paths remain available. Generation and
execution fail closed while workflows are disabled.

To re-enable:

```bash
bun run openslack collaboration workflow config enable
```
