# GitHub Auth Architecture

## Three-Tier Model

OpenSlack uses three distinct authentication mechanisms for different purposes:

| Tier | Method | Purpose | Zero-Manual? |
|------|--------|---------|-------------|
| **Runtime (Primary)** | GitHub App installation token | Agent creates issues, updates Project fields, pushes branches, creates PRs | Yes (jwt + api exchange) |
| **Dev/Local Fallback** | Fine-grained PAT or `GITHUB_TOKEN` | Local development, debugging, single-human testing | No (manual token creation) |
| **Human Login** | OAuth App / gh CLI OAuth | Human identity verification, web console login, admin operations | No (browser required) |

**The runtime tier is the only path that can achieve "fully automated, zero manual steps."** OAuth device flow and PAT creation both require browser interaction and cannot serve as the primary agent automation credential.

## Runtime Auth: GitHub App Installation Token

### One-time setup (human admin)

1. Create a GitHub App named **OpenSlack Agent Operator** with these permissions:

| Permission | Level | Used for |
|-----------|-------|----------|
| Contents | Read & Write | Push agent branches, read repo |
| Issues | Read & Write | Create EVOL issues, write comments |
| Pull requests | Read & Write | Create draft PRs, PR comments |
| Projects | Read & Write | Query Project v2, add items, update fields |
| Actions | Read | Read workflow status |
| Checks | Read & Write | Future: write validation checks |
| Metadata | Read | Required default |

Do **not** grant: Administration, Secrets, Members, Workflows write.

2. Install on `wsman/OpenSlack` (selected repository only).

3. Store these values as environment variables / GitHub Actions secrets:

```bash
OPENSLACK_GITHUB_AUTH_MODE=app
OPENSLACK_GITHUB_APP_ID=<app-id>
OPENSLACK_GITHUB_APP_INSTALLATION_ID=<installation-id>
OPENSLACK_GITHUB_APP_PRIVATE_KEY=<pem-key-content>
GITHUB_OWNER=Negentropy-Laby
GITHUB_REPO=OpenSlack
```

4. The `@openslack/github` `getClient()` function auto-detects `OPENSLACK_GITHUB_APP_ID` and uses the App installation token. No further manual steps required. Tokens are generated and refreshed automatically.

### Windows local bot wrapper

Do not commit GitHub App private keys. Keep the PEM in the gitignored local
state directory:

```powershell
New-Item -ItemType Directory -Force .openslack.local
# Human action: copy the downloaded GitHub App PEM to:
# .openslack.local\github-app.pem
```

Then run OpenSlack through the wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 setup github
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 pr doctor 71
```

The wrapper loads `.openslack.local/github-app.pem` into
`OPENSLACK_GITHUB_APP_PRIVATE_KEY` for the child `pnpm openslack` process and
removes `GITHUB_TOKEN` from that child process so bot-auth runs cannot silently
fall back to a human PAT. If `OPENSLACK_GITHUB_APP_INSTALLATION_ID` is missing
or points to a different installation, the wrapper lists the GitHub App's
installations and uses the one matching `GITHUB_OWNER` (default:
`Negentropy-Laby`).

To inspect available installations without running OpenSlack:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 -ListInstallations
```

### How it works (zero manual)

```
OPENSLACK_GITHUB_APP_PRIVATE_KEY
  → sign JWT (RS256)
  → POST /app/installations/{id}/access_tokens
  → receive short-lived installation token (1 hour)
  → use for all API calls
  → auto-refresh on expiry
```

## Dev/Local Fallback: PAT

For local development where setting up a full GitHub App is impractical:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
```

The provider falls back to this when `OPENSLACK_GITHUB_APP_ID` is not set.

## Human Login: OAuth / gh CLI

`apps/auth-callback/` provides a local OAuth callback server (`http://127.0.0.1:8200/callback`) for human login. This is **not** used by the agent runtime.

`scripts/setup-gh.sh` installs `gh` CLI on any platform for developer convenience.

## Token Priority (getClient)

1. `OPENSLACK_GITHUB_APP_ID` + `OPENSLACK_GITHUB_APP_INSTALLATION_ID` + private key → **GitHub App installation token** (preferred)
2. `GITHUB_TOKEN` → **PAT / Actions token** (fallback)
3. Neither → **dry-run mode** (log intent, no API calls)

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `GITHUB_OWNER` | No | `wsman` |
| `GITHUB_REPO` | No | `OpenSlack` |
| `GITHUB_TOKEN` | No (PAT fallback) | — |
| `OPENSLACK_GITHUB_AUTH_MODE` | No | auto-detect |
| `OPENSLACK_GITHUB_APP_ID` | No | — |
| `OPENSLACK_GITHUB_APP_INSTALLATION_ID` | No | — |
| `OPENSLACK_GITHUB_APP_PRIVATE_KEY` | No | PEM content |
| `OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH` | No | Used by `scripts/openslack-bot.ps1` only |

## Project v2 Configuration (one-time human admin)

1. Create Project v2 "OpenSlack Evolution Board" on `wsman/OpenSlack`
2. Add 14 standard fields (see `.openslack/integrations/github.yaml`)
3. Run `openslack github project-sync-fields --write` to populate field IDs
4. Verify: `openslack github doctor --strict`
