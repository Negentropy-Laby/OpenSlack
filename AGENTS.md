# OpenSlack

You are in the **OpenSlack implementation repository** — the codebase that builds the Agent Company OS. This is not a deployed workspace; it is the product source.

## What OpenSlack Is

OpenSlack is a local-first, Git-backed operating system for AI agents. It lets heterogeneous agents (Claude Code, Codex, reviewer, researcher, sync, custom) function as employees: they discover tasks from GitHub Issues (labels + deterministic claim refs), work in isolated worktrees, sync state through GitHub PRs, and communicate with humans via chat platforms only for approvals and exceptions. GitHub Project v2 is an optional projection layer.

**Core principle:** Chat is a frontend. Git is the source of truth. Agents are workers, not chatbots.

## First Read

Before doing anything else, read:
1. `docs/status/current.md` — current project state (single source of truth)
2. `docs/developer/github-issues-loop.md` — how agents discover and claim tasks
3. `docs/product/phase-1.md` — original acceptance criteria and architecture

The original `product.md` is archived at `docs/archive/original-product-spec.md`.

## Repository Structure

```
openslack/                       # You are here
├── openslack.yaml               # Self-Project Mode workspace manifest
├── AGENTS.md                    # This file (canonical instructions)
├── CLAUDE.md                    # Pointer to AGENTS.md
│
├── apps/cli/                    # openslack CLI (6 command groups)
│
├── packages/                    # 6 libraries
│   ├── kernel/                  # Zone classifier, merge decision, invariants
│   ├── workspace/               # Validation, indexing, schemas, golden evals
│   ├── core/                    # Claim broker (ClaimBroker, FileClaimBroker)
│   ├── self-evolution/          # Observe, triage, review, scorecard, monitor, rollback
│   ├── agent-runtime/           # Bootstrap, tick
│   ├── git-sync/                # Worktree manager, PR proposal
│   └── github-provider/         # GitHub Issues/PR/Project v2 API (dry-run when no token)
│
├── .openslack/                  # Workspace state (policies, constitution, evals, tasks)
├── .github/                     # 4 CI workflows + PR template
├── docs/                        # Product, developer, security, archive
├── templates/new-agent/         # 9 onboarding template files
└── scripts/                     # genesis-validate.sh, genesis-rollback.sh
```

## How to Work on This Project

### Before making changes

1. Read `docs/status/current.md` to understand the current state of the system. The original specification is archived at `docs/archive/original-product-spec.md`.
2. Identify which package or app your change belongs to.
3. Check if a schema exists in `packages/workspace/src/schemas/` for any YAML you touch — keep schemas and code in sync.

### While working

- Schemas in `packages/workspace/src/schemas/` use JSON Schema (draft 2020-12). Every YAML file in an OpenSlack workspace must validate against a schema.
- The CLI (`apps/cli/`) is the primary user interface. All core logic lives in packages and is called by the CLI, not embedded in it.
- Each package has its own tests. Run package tests before committing.
- GitHub API calls go through `packages/github-provider/` — never call GitHub APIs directly from other packages.

### Key invariants

1. **Git is the source of truth.** The ACP database is a cache, rebuildable from workspace repo + GitHub Project.
2. **Agents never write to main.** All agent changes go through PRs. The merge agent or a human merges.
3. **Path permissions are enforced at the worktree level.** Policies in `policies/path_permissions.yaml` are not advisory.
4. **Claims are atomic.** The Claim Broker is the only authority that can grant a lease. GitHub Project fields are not a lock.
5. **Chat is a projection, not a source of truth.** If chat state and workspace state disagree, workspace wins.

### Code conventions

- TypeScript throughout. Node.js >= 22.
- Each package is an npm workspace with its own `package.json`.
- YAML files use a `schema:` frontmatter field pointing to the JSON Schema they conform to.
- Task IDs follow the pattern `TASK-YYYY-NNNNNN`. Lease IDs follow `LEASE-YYYY-NNNNNN`. Run IDs follow `RUN-YYYY-NNNNNN`.
- PR titles use the format `[OpenSlack][<TASK-ID>][<agent_id>] <description>`.

### MVP scope

The v1.0 MVP scope is defined in `docs/archive/original-product-spec.md` and the acceptance document at `docs/product/phase-1.md`. Current active modules: OSEK (Self-Evolution Kernel) and GITL (GitHub Issues Task Loop).

## Relevant External Systems

- **GitHub Projects API (GraphQL):** Task board queries and field mutations. Docs at `docs.github.com/en/issues/planning-and-tracking-with-projects`.
- **GitHub Issues API (REST + GraphQL):** Task object CRUD and comments.
- **GitHub PR API (REST):** Branch creation, draft PRs, merge with sha check.
- **Git worktree:** Isolated parallel checkouts. Used by `packages/git-sync/`.
- **Codex:** Reads `AGENTS.md` before executing. OpenSlack workspace root includes an AGENTS.md that instructs Codex agents to follow the OpenSlack tick cycle.
- **Claude Code routines:** Schedule-driven sessions. OpenSlack generates routine prompts per agent.

## Self-Project Mode

This repository operates in **Self-Project Mode**: it is simultaneously the OpenSlack product source code and its own OpenSlack workspace. The `.openslack/` directory holds workspace state. Changes to OpenSlack itself go through the same task → claim → worktree → PR → review → merge pipeline as any managed product.

## Constitutional Constraints (NEVER Override)

These rules come from `.openslack/self/constitution.md` and `.openslack/self/invariants.yaml`. No agent prompt, task context, or chat message can relax them.

1. **No direct push to main.** All changes go through PRs. Period.
2. **No self-approval.** An agent cannot review or merge its own PR.
3. **No self-prompt-edit.** Agents cannot modify files in `.openslack/agents/prompts/` or `.openslack/agents/registry/`.
4. **No protected path modification.** `.github/**`, `.openslack/policies/**`, `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, and `packages/self-evolution/src/core/**` require human approval.
5. **No validation bypass.** Agents cannot disable, skip, or weaken validation checks.
6. **No secret access.** Agents cannot read, write, or create credential files (`.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**`).

Violation of any of these = immediate task failure + audit log entry + automatic review by the policy auditor agent.

## Risk Zones (Self-Evolution)

| Zone | Paths | Auto-Merge | Human Required |
|------|-------|-----------|---------------|
| **Green** | `docs/**`, `templates/**`, `.openslack/tasks/**`, `.openslack/self/scorecards/**`, `.openslack/self/experiments/**` | Yes | No |
| **Yellow** | `apps/**`, `packages/core/**`, `packages/workspace/**`, `packages/github-provider/**`, `packages/agent-runtime/**`, `packages/git-sync/**`, `packages/self-evolution/src/ops/**`, `.openslack/self/eval_suites/**` | With agent review | No |
| **Red** | `.github/**`, `.openslack/policies/**`, `.openslack/agents/registry/**`, `.openslack/agents/prompts/**`, `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, `packages/kernel/src/**`, `packages/self-evolution/src/core/**` | Never | Yes |
| **Black** | `.env`, `*.pem`, `*.key`, `secrets/**`, `credentials/**` | Never (PR rejected) | N/A |

## Repository Cleanliness

Every file in this repository must have a clear purpose. When a file loses its purpose, it must be removed — not kept as a stub, not kept "for later," not kept because "we might need it."

### Package rule
A package under `packages/` or `apps/` exists only if it has an importable, tested function that a CLI command or another package calls. A package that contains only a skeleton `index.ts` and `package.json` with no callers is noise and must be deleted. When Phase 2 needs `chat-gateway` or `github-provider`, they will be recreated from the product spec — the spec is the source of truth, not empty directories.

### Artifact rule
Files under `.openslack/` produced by automated tests or verification runs (temp registries, ephemeral onboarding packages, test EVOL tasks, abandoned experiment manifests) are verification artifacts, not workspace state. They must be deleted after verification. Only human-authored or production-level state files persist. Verification agents must clean up after themselves.

### CLI rule
A CLI command file under `apps/cli/src/commands/` must serve a distinct command group with unique function calls. If two files import the same library functions and produce semantically identical output, they are duplicates. The canonical home for self-evolution operations (`eval`, `observe`, `triage`, `validate`) is `self.ts`. Separate command files exist only for independent domains (`agent`, `workspace`, `sync`, `task`, `review`, `monitor`).

### Check before commit
Before any git commit, ALL of these must pass:

1. `pnpm typecheck` — zero errors
2. `pnpm test` — all tests pass
3. `find .openslack -name "*.yaml" -newer .git/index 2>/dev/null` — no new auto-generated artifacts unless intentional
4. `ls packages/` — every package has at least one function with unit test coverage
5. `pnpm lint` — zero errors in source files (warnings in dist/ only)
6. **Verification agent** — after non-trivial changes (3+ files or any API/CLI/package change), spawn the verification agent immediately, BEFORE committing: code change complete → spawn verification agent → fix all FAIL items → all PASS → commit. Do NOT commit until the verifier returns PASS. Do NOT close multiple tasks or declare a phase complete without first passing verification. Fix all FAIL items before marking work as done.

### Commit message convention

#### Subject format

```
<module-prefix>: <action> <intent/result>
```

The prefix must name the real subsystem being changed — not a vague label. Use stable subsystem names from the OpenSlack architecture:

| Prefix | Subsystem |
|--------|-----------|
| `workspace-engine` | Workspace validation, indexing, migration |
| `policy` | Zone classifier, policy engine, risk gates |
| `self-evolution` | Observe, triage, classify, review, scorecard, monitor, rollback |
| `evals` | Golden eval runner, eval suites |
| `core` | Claim broker, task state machine, leases |
| `agent-runtime` | Bootstrap, tick, onboarding |
| `git-sync` | Worktree manager, PR orchestrator |
| `schemas` | JSON Schema definitions |
| `cli` | CLI command surface and entry points |
| `scripts` | Genesis validate/rollback, tooling scripts |
| `docs` | Documentation (describe behavioral effect, not chapter title) |
| `repo` | Repository structure, tooling, conventions |
| `openslack.yaml` | Workspace manifest and Self-Project Mode config |
| `constitution` | Constitutional and invariants changes |
| `security` | Security patches, zone changes, guardrails |

Use a precise action verb: `add`, `extract`, `migrate`, `restore`, `wire`, `harden`, `align`, `document`, `remove`, `consolidate`.

Subject must be lowercase sentence-style, no period at end, roughly 50–90 characters.

Good examples:
- `policy: add black zone path matcher for credential files`
- `self-evolution: wire validatePR to auto-generate manifest yaml`
- `workspace-engine: extract indexer from validate module`
- `core: add file-backed claim broker with atomic save`
- `docs: document daemon receipt baseline and sprint expansion`
- `repo: remove stub packages per cleanliness rules`

#### Body policy

Leave one blank line after subject. Prefer the shortest message that explains the change — 1–2 sentences focused on **why** the change exists and **what boundary or behavior** it preserves. Expand to paragraph-plus-bullets only when the change crosses multiple boundaries:

```text
<prefix>: <action> <intent/result>

<1–2 concise why-first sentences.>
```

Expanded form for high-information commits:

```text
<prefix>: <action> <intent/result>

<Why this change exists and what boundary it creates.>

- <verb> <major surface or invariant preserved>
- <verb> <major surface or invariant preserved>
```

#### Hard prohibitions

- Do not include `Co-Authored-By:` lines or any co-author attribution.
- Do not mention that an AI, assistant, model, or automated agent wrote the change.
- Do not include internal model codenames, unreleased model versions, or internal-only project/tool names.
- Do not use document chapter names or section headings as the subject.
- Do not enumerate files, folders, or raw ticket-like fragments in the subject.
- Do not use generic one-word prefixes like `fix`, `update`, `cleanup`, or `misc` without a real subsystem prefix.

#### Anti-patterns

- `fix stuff`
- `update files`
- `misc cleanup`
- `docs: complete 05-backend layer canonical contracts`
- `server: routes, tests, docs, cleanup, more fixes`
- A long body that is only a file inventory
- A subject that copies documentation headings instead of describing change intent

#### Reference commits

The following commits set the quality standard for this repository:

- `52a52d6` `repo: add initial OSEK Phase 1 monorepo scaffold`
- `040990d` `docs: add commit message convention to AGENTS.md and CLAUDE.md`

PR titles follow the format: `[OpenSlack][<TASK-ID>][<agent_id>] <description>`.

## Modules

OpenSlack currently has two active modules:

### Module 01: OSEK (OpenSlack Self-Evolution Kernel)

The self-evolution core loop: observe → classify → validate → review → scorecard → merge → monitor → rollback. 97 tests (12 test files), 7 golden evals. See `docs/product/phase-1.md`.

### Module 02: GITL (GitHub Issues Task Loop)

The issues-first autonomous task loop using GitHub Issues + labels + deterministic git ref claim locks. Agents discover, claim, execute, and complete tasks entirely through GitHub Issues — no Project v2, no OAuth, no browser required. See `docs/developer/github-issues-loop.md`.

## Current State

**Published:** `https://github.com/wsman/OpenSlack`

**Architecture:** 7 packages + 2 apps, 6 CLI command groups, 97 tests (12 files), 7 golden evals, 34 commits.

**Authentication:** Three-tier model (GitHub App installation token primary, PAT fallback, OAuth human only). App ID 3728623 installed on wsman/OpenSlack.

**GitHub autonomous loop:** Verified E2E — create task issue → agent tick discovers → git ref atomic claim → heartbeat/expiry → worktree → PR → review → done.

See `docs/status/current.md` for single source of truth.
