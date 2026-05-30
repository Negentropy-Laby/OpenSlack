# Core Workflows

Six workflows that cover day-to-day OpenSlack use. Each one is a quick reference: what you want, where to start, what you will see, the safe default, and what to do next.

For the full CLI reference, see [`user-guide.md`](../user-guide.md).

---

## 1. First Run

**Goal:** Set up a fresh checkout, verify GitHub connectivity, and confirm everything is healthy.

**Start here:**

```bash
bun run openslack setup
```

**What you will see:** A pass/fail report for workspace validation, golden evals, GitHub authentication, label inventory, and genesis integrity. Each section shows a status and recommended fix if something failed.

**Safe default:** `setup` is read-only. It diagnoses problems but does not change external state. Use `setup github --apply` only when you are ready to repair labels or configuration.

**Next action:** If all checks pass, run `bun run openslack status` to see the current module dashboard, or proceed to Workflow 2 to run a workflow. If something failed, follow the recommended fix in the report, then re-run `setup`.

---

## 2. Run a Workflow

**Goal:** Execute a typed workflow through the TUI workbench -- preview it, dry-run it, then confirm and run.

**Start here:**

```bash
bun run openslack collaboration workflow list
bun run openslack collaboration workflow preview <file> --input key=value
```

**What you will see:** The `list` command shows all available workflows from project-local, builtin, and template paths. The `preview` command displays phases, declared inputs, permissions, side effects, and estimated scope without executing anything.

**Safe default:** Always preview first. Then use `dry-run` to simulate execution with logged side effects and no real changes. Only proceed to `run` after confirming the preview output.

**Next action:**

```bash
bun run openslack collaboration workflow dry-run <name> --input key=value
bun run openslack collaboration workflow run <name> --input key=value
```

For interactive execution with a TUI, add `--format tui` where supported. To inspect a completed run, use `openslack collaboration inspect <runId>`.

---

## 3. Handle a Blocked PR

**Goal:** Find a PR that cannot merge, understand why, and resolve the blocker.

**Start here:**

```bash
bun run openslack pr queue
```

**What you will see:** All open PRs sorted by merge readiness and blocker owner. Blocked PRs show the blocker, the person or agent who owns the blocker, and a reason summary.

**Safe default:** `pr queue` and `pr doctor` are read-only diagnostics. They do not approve, merge, or modify anything.

**Next action:**

```bash
bun run openslack pr doctor <PR_NUMBER>
```

The doctor report runs 11 governance gates and tells you exactly which gate failed, who owns the fix, what evidence is needed, and the recommended next action. Follow the recommendation, then re-run `pr doctor` to confirm the blocker is resolved. For an interactive view, use `pr doctor <n> --format tui`.

---

## 4. Confirm a Governed Action

**Goal:** Review a workflow or PR action that requires human approval, then approve or reject it.

**Start here:**

```bash
bun run openslack collaboration dashboard
```

**What you will see:** The dashboard shows pending handoffs, open decisions, active PRs, and any actions awaiting human confirmation. Items are grouped by type and flagged with the person or agent responsible for the next step.

**Safe default:** The dashboard is projection-only. Viewing it creates no state and triggers no mutations. All governed actions require an explicit confirmation step before execution.

**Next action:** For a PR that is ready, review the PRMS report:

```bash
bun run openslack pr doctor <PR_NUMBER>
bun run openslack pr merge <PR_NUMBER>
```

For a workflow awaiting approval, confirm through the chat gateway card or run the merge with `--yes` only after verifying the preview. For a handoff or decision, use `collaboration handoff accept <id>` or `collaboration decision record ...` to record your response.

---

## 5. Review Team Activity

**Goal:** See what agents and humans have done recently, spot blockers, and get a summary digest.

**Start here:**

```bash
bun run openslack collaboration activity --since 24
bun run openslack collaboration digest --since 24
```

**What you will see:** The activity feed shows a chronological event stream from the last 24 hours: task claims, PR reviews, handoffs, decisions, and workflow executions. The digest groups events by category with counts and highlights.

**Safe default:** Both commands are read-only projections derived from events and YAML files. They do not create or modify any state.

**Next action:** Drill into a specific item:

```bash
bun run openslack collaboration room show pr:42
bun run openslack collaboration handoff show <id>
```

For an interactive view, use `--format tui` on the dashboard or room commands.

---

## 6. Record a Handoff or Decision

**Goal:** Transfer context between team members or record an auditable decision so nothing is lost.

**Start here:**

```bash
bun run openslack collaboration handoff create \
  --from claude --to codex \
  --context "Refactoring auth middleware, 3 files remain" \
  --steps "Complete auth refactor,Run tests,Open PR" \
  --pr 42
```

**What you will see:** A confirmation with the handoff ID, from/to agents, context, steps, and linked PR. The handoff appears in the dashboard and activity feed immediately.

**Safe default:** Handoffs and decisions create auditable collaboration objects stored in `.openslack/`. They do not modify GitHub state, merge PRs, or trigger external actions.

**Next action:** To record a decision:

```bash
bun run openslack collaboration decision record \
  --topic "Use SQLite for local cache" \
  --decision "Adopt SQLite with WAL mode" \
  --rationale "Simpler than rolling file-based cache, proven concurrency" \
  --by claude
```

To view or accept a handoff: `collaboration handoff show <id>` then `collaboration handoff accept <id>`.

---

## Core Loop

OpenSlack runs on one repeating cycle:

```
Workflow --> Agent Work --> PRMS Review --> Human Approval --> Merge --> Collaboration Memory
```

Preview the work, let agents execute it, review the PR, confirm governed actions, and keep the collaboration record.

Each step feeds the next: a workflow spawns agent work, the agent submits a PR, PRMS reviews it, a human approves and merges, and the collaboration layer records the outcome for the next cycle.
