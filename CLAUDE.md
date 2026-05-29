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
- Do not approve PRs.
- Do not bypass rulesets.
- Do not edit secrets or credential files.
- Do not hand-edit generated status without running `pnpm openslack status generate` and `pnpm openslack status verify`.
- Do not use `gh pr create` directly. The `gh` CLI defaults to the human OAuth identity. Always use the bot-auth wrapper:
  - Bash: `./scripts/bot-gh-pr-create.sh --title "..." --body "..." --base main --head <branch>`
  - PowerShell: `scripts\bot-gh-pr-create.ps1 --title "..." --body "..." --base main --head <branch>`
  - For other `gh` commands (edit, comment, etc.): `./scripts/bot-gh.sh ...` or `scripts\bot-gh.ps1 ...`
  - Pre-requisite: `.openslack.local/github-app.pem` must exist (gitignored).

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
