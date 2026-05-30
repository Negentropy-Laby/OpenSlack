# Claude Code Entry Point

Read `AGENTS.md` first. It is the canonical instruction file for this repository.

## Immediate Startup Checklist

1. Read `docs/status/current.md` for generated current state.
2. Read `.openslack/modules.yaml` for the product module registry.
3. Read `README.md` for the user-facing product overview.
4. Read `docs/user-guide.md` only when you need the full CLI reference.
5. Follow every constraint in `AGENTS.md` before making changes.

## Working Rule

Do not infer current status from old phase documents. Treat archived specs and old acceptance documents as historical context only.

## Safe Default Commands

```bash
pnpm openslack status
pnpm openslack doctor
pnpm openslack status verify
pnpm openslack pr doctor <PR_NUMBER>
```

## Never Do These

- Do not push directly to `main`.
- Do not approve PRs. (Agents may merge PRs that already have valid human approval.)
- Do not bypass rulesets.
- Do not edit secrets or credential files.
- Do not hand-edit generated status without running `pnpm openslack status generate` and `pnpm openslack status verify`.
- Do not use `gh pr create` directly. The `gh` CLI defaults to the human OAuth identity. Always use the bot-auth wrapper:
  - Bash: `./scripts/bot-gh-pr-create.sh --title "..." --body "..." --base main --head <branch>`
  - PowerShell: `scripts\bot-gh-pr-create.ps1 --title "..." --body "..." --base main --head <branch>`
  - For other `gh` commands (edit, comment, etc.): `./scripts/bot-gh.sh ...` or `scripts\bot-gh.ps1 ...`
  - Pre-requisite: `.openslack.local/github-app.pem` must exist (gitignored).

## Approval Gate — Explicit Communication Required

When an agent completes code review and the PR is technically ready, the agent **must explicitly communicate** that human approval is required. Do not assume the user knows this gate exists, and do not wait for the user to infer it from review status.

### Required statement

After review completion, say something like:

> "PR #N is ready for merge but requires **your human approval** before I can merge it. Please run:
> ```bash
> gh pr review N --approve --body 'Approved after agent review'
> ```
> After you approve, I will merge it with the bot identity."

### Why the agent cannot approve

- `gh pr review` uses your personal GitHub OAuth identity.
- `./scripts/bot-gh.sh` uses the bot identity (`openslack-agent-operator[bot]`).
- `AGENTS.md` Constitutional Constraint #3: **No auto-approval** — agents must never submit `APPROVE` reviews under bot identity.
- `AGENTS.md` Constitutional Constraint #4: **Merge after human approval** — agents may merge only after valid human approval is recorded.

### PR status check before requesting approval

```bash
gh pr view N --json reviewDecision,mergeStateStatus
```

Only request approval when `reviewDecision` is `REVIEW_REQUIRED` and `mergeStateStatus` is `BLOCKED` due to missing approval (not due to failing checks). Do not say "ready to merge" while checks are failing or while the PR head is not synchronized.

For everything else, follow `AGENTS.md`.

## Bot-Authenticated PR Creation

<!--
MIRRORED: The body of this section must remain byte-identical to the
"### Bot-Authenticated PR Creation" section in AGENTS.md.
If you edit one, you must edit the other with the exact same text.
The sync test in apps/cli/src/__tests__/agent-docs-sync.test.ts enforces this.
-->

All PRs created by agents or automation must use the bot-authenticated wrapper scripts. Never use `gh pr create` directly — the `gh` CLI defaults to the human OAuth identity.

**Bash / Git Bash / WSL:**

```bash
./scripts/bot-gh-pr-create.sh --title "..." --body "..." --base main --head <branch>
```

**PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bot-gh-pr-create.ps1 --title "..." --body "..." --base main --head <branch>
```

**For other `gh` commands (e.g., `gh pr edit`, `gh pr comment`):**

```bash
./scripts/bot-gh.sh pr edit 117 --body "..."
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr edit 117 --body "..."
```

**Pre-requisites:**

- `.openslack.local/github-app.pem` must exist (repo root, gitignored), or
- `OPENSLACK_GITHUB_APP_PRIVATE_KEY` environment variable must be set.

The wrapper:
1. Generates a GitHub App installation token via `scripts/bot-gh-token.js`
2. Removes `GITHUB_TOKEN` from the environment to prevent silent fallback to a human PAT
3. Sets `GH_TOKEN` so the `gh` CLI authenticates as the bot
4. Forwards all arguments to `gh`

If the PEM is missing, the wrapper fails with a clear error. Do not fall back to `GITHUB_TOKEN` or human `gh auth`.

---
