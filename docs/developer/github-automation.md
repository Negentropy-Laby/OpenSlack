# GitHub Auth Architecture

## Three-Tier Model

OpenSlack uses three distinct authentication mechanisms for different purposes:

| Tier                   | Method                             | Purpose                                                                    | Zero-Manual?               |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| **Runtime (Primary)**  | GitHub App installation token      | Agent creates issues, updates Project fields, pushes branches, creates PRs | Yes (jwt + api exchange)   |
| **Dev/Local Fallback** | Fine-grained PAT or `GITHUB_TOKEN` | Local development, debugging, single-human testing                         | No (manual token creation) |
| **Human Login**        | OAuth App / gh CLI OAuth           | Human identity verification, web console login, admin operations           | No (browser required)      |

**The runtime tier is the only path that can achieve "fully automated, zero manual steps."** OAuth device flow and PAT creation both require browser interaction and cannot serve as the primary agent automation credential.

## Runtime Auth: GitHub App Installation Token

### One-time setup (human admin)

1. Create a GitHub App named **OpenSlack Agent Operator** with these permissions:

| Permission    | Level        | Used for                                   |
| ------------- | ------------ | ------------------------------------------ |
| Contents      | Read & Write | Push agent branches, read repo             |
| Issues        | Read & Write | Create EVOL issues, write comments         |
| Pull requests | Read & Write | Create draft PRs, PR comments              |
| Projects      | Read & Write | Query Project v2, add items, update fields |
| Actions       | Read         | Read workflow status                       |
| Checks        | Read & Write | Future: write validation checks            |
| Metadata      | Read         | Required default                           |

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
`OPENSLACK_GITHUB_APP_PRIVATE_KEY` for the child `bun run openslack` process and
removes `GITHUB_TOKEN` from that child process so bot-auth runs cannot silently
fall back to a human PAT. If `OPENSLACK_GITHUB_APP_INSTALLATION_ID` is missing
or points to a different installation, the wrapper lists the GitHub App's
installations and uses the one matching `GITHUB_OWNER` (default:
`Negentropy-Laby`).

Direct `bun run openslack ...` commands do not read
`.openslack.local/github-app.pem` and do not reuse the human `gh` CLI keyring.
The PEM is intentionally loaded only by wrapper scripts or by an explicit
environment variable. For `pr doctor`, missing live credentials produce
`AUTH_REQUIRED`; use the wrapper for live bot evidence or pass `--dry-run` for
an explicit `NOT_EVALUATED` simulation report.

Use this runtime bot credential path for PR creation whenever the work is
OpenSlack-authored or delegated to an agent or automation. Do not create those
PRs with a human `gh` login or human PAT, even when the commits themselves are
bot-authored. GitHub PR authorship is the account that opens the PR.

Before creating an agent-delivered PR, confirm the child process that runs
`gh pr create` or the GitHub API request is authenticated as the configured
bot/agent identity. If a PR is accidentally opened by the human reviewer or
CODEOWNER, close or abandon it and recreate it through the bot credential path,
or require a different independent human approval.

### Agent PR Creation

Agents and automation must **never** call `gh pr create` directly. The `gh` CLI defaults to the human OAuth identity, which creates a self-review deadlock.

The canonical product path is now package-backed delivery:

```bash
openslack delivery publish --branch <branch> --base main \
  --title "runtime: deliver change" --body-file pr-body.md
```

`@openslack/delivery` obtains one installation token lease and uses it for both
Git push and Pull Request API calls. Git runs with `credential.helper=` and an
empty `core.hooksPath`; its child environment is allowlisted, global/system Git
configuration and trace output are disabled, and human token, SSH, and App-key
variables are excluded. The token exists only in the push and remote-verification
askpass children. Delivery rejects multiple or mismatched push URLs, binds the
Git target to the API owner/repository, verifies local/remote/PR head SHAs again
before querying checks by the synchronized SHA, and returns `AWAITING_GATES`;
PRMS remains the owner of review, approval, readiness, and merge.

The existing bot-authenticated wrapper scripts remain compatibility entrypoints
for operator environments. Their PR-create arguments are mapped directly to the
same package-backed command:

```bash
# Bash / Git Bash / WSL — create PR as bot
./scripts/bot-gh-pr-create.sh --title "feat: ..." --body "..." --base main --head feature-branch

# PowerShell — create PR as bot
powershell -ExecutionPolicy Bypass -File scripts\bot-gh-pr-create.ps1 --title "feat: ..." --body "..." --base main --head feature-branch
```

For other `gh` commands that need bot auth (e.g., `gh pr edit`, `gh pr comment`):

```bash
# Bash
./scripts/bot-gh.sh pr edit 117 --body "..."

# PowerShell
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr edit 117 --body "..."
```

#### How the wrappers work

For `pr create`, the wrapper launcher loads the configured App key, exchanges it
for one short-lived installation token, and delegates to `openslack delivery
publish` with only that token, its required expiry, installation ID, and
non-secret permission evidence. The child never receives the App key. Delivery
pushes through child-only askpass, creates or updates the exact-head draft PR
through the API, and verifies the synchronized head SHA. `GITHUB_TOKEN` and
`GH_TOKEN` are excluded, so the operation cannot silently fall back to a human
identity. Missing or expired forwarded-token evidence fails before Git mutation.

Before the first publication to a repository, use:

```bash
openslack delivery doctor --repo OWNER/REPO
openslack delivery probe --repo OWNER/REPO --apply
```

The doctor calls the installation-scoped repository-list endpoint and checks
`contents:write`, `pull_requests:write`, and `workflows:write`; public read access is not accepted
as evidence that a selected repository is installed. The probe uses the same
allowlisted askpass environment as delivery, pushes a unique
`openslack/probes/write-*` ref, verifies its SHA, and deletes it in cleanup. A
cleanup failure is a typed error with an exact `openslack delivery cleanup-ref`
command. That command is preview-first and rejects every ref outside the probe
namespace.

For other supported `gh` commands, the generic wrappers launch a narrow Node
adapter. It obtains the installation token in memory, removes human-token and App
key variables from the `gh` child, sets child-only `GH_TOKEN`, and forwards the
command. `scripts/bot-gh-token.js` is an internal exchange module; direct token
output is disabled so shell variables, xtrace, and transcripts cannot capture it.
The compatibility adapter permits only `pr edit`, `pr comment`, and `pr ready`,
rejects token display/auth/extension commands before credential loading, and
disables child pager, editor, browser, and interactive prompt processes.

`proposeWorkspacePR()` is also fail-closed: staging, commit, App delivery, and
exact-head verification are one required contract. A missing remote, missing App
credential, rejected push, or failed PR publication returns `success: false`; a
PR body without a synchronized branch and PR is never reported as a successful
proposal.

#### Troubleshooting

| Problem                                 | Cause                                  | Fix                                                                                       |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| "No GitHub App private key found"       | PEM missing                            | Place `.openslack.local/github-app.pem` or set `OPENSLACK_GITHUB_APP_PRIVATE_KEY`         |
| "Failed to generate installation token" | PEM invalid or App ID wrong            | Verify PEM content and `OPENSLACK_GITHUB_APP_ID` / `OPENSLACK_GITHUB_APP_INSTALLATION_ID` |
| PR created under human identity         | `GITHUB_TOKEN` was set and not removed | Use the wrapper — it removes `GITHUB_TOKEN` automatically                                 |

### PRMS bot merge pipeline

Use `scripts/openslack-pr-gate.ps1` for local bot-authenticated PR diagnosis
and PRMS-gated merge. The script is a narrow orchestration layer: it checks that
the local GitHub App PEM file exists, delegates credential loading to
`scripts/openslack-bot.ps1`, and delegates all readiness decisions to
`openslack pr doctor` and `openslack pr merge`.

```powershell
# Diagnose with GitHub App bot auth.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber 110

# Diagnose, then ask Merge Steward to merge if PRMS returns READY_TO_MERGE.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber 110 -Merge -Method merge
```

The default key path is `.openslack.local\github-app.pem`. Agents and LLMs must
not read, print, copy, summarize, or pass PEM contents. They may only reference
the fixed wrapper command or ask a human/operator to run it. The PEM is read by
the PowerShell wrapper, placed only in the child process environment variable
expected by `@openslack/github`, and removed when that process exits. The PEM
must never be passed as a command-line argument, log line, PR body, review body,
or chat message.

The merge command is intentionally not a direct GitHub merge shortcut.
`openslack pr merge` calls Merge Steward, which re-runs the PRMS diagnostic path
and blocks unless the decision is `READY_TO_MERGE`. If the GitHub App
installation cannot be auto-discovered, list installations without exposing the
key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 -ListInstallations
```

### Updating an existing PR branch

After a repair commit, force-push, or any bot-authored update to an existing PR,
GitHub must emit a PR synchronize event before the PR can be reviewed again. Do
not assume a successful `git push` means the PR has moved.

Use this check before posting "ready for re-review":

```powershell
$pr = 96
$branch = "feat/tui-dashboard-view"
$branchSha = (git ls-remote origin "refs/heads/$branch").Split()[0]
$prSha = gh pr view $pr --json headRefOid --jq ".headRefOid"

if ($branchSha -ne $prSha) {
  throw "PR #$pr is stale: branch=$branchSha pr=$prSha"
}

gh pr checks $pr
```

For a deeper check, compare the pull-request ref and the actual branch ref:

```powershell
git ls-remote origin "refs/heads/$branch" "refs/pull/$pr/head" "refs/pull/$pr/merge"
gh pr view $pr --json headRepository,headRefName,headRefOid,statusCheckRollup,mergeStateStatus,reviewDecision
```

The PR is not ready for review when:

- `refs/heads/<branch>` points at the repair commit, but `headRefOid` or
  `refs/pull/<pr>/head` still points at an older commit;
- `gh pr checks <pr>` reports checks from the older head SHA;
- `reviewDecision`, `mergeStateStatus`, or check state is based on stale runs.

When this happens, wait briefly and retry the checks. If GitHub still does not
synchronize the PR, push a new bot-authored repair/no-op commit through the PR's
actual head repo/ref or recreate the PR from the current branch head. Never ask
for human approval against a stale PR head.

### Re-review and conversation resolution

After a review blocker is fixed, do not rely on the repair commit or a
re-review comment alone. GitHub review conversations remain unresolved until
they are explicitly resolved, and branch protection may block merge while those
threads are open even when CI is green and a human approval exists.

Use this pre-merge gate check:

```powershell
$pr = 98
$branch = "feat/example"

$branchSha = (git ls-remote origin "refs/heads/$branch").Split()[0]
$prSha = gh pr view $pr --json headRefOid --jq ".headRefOid"
if ($branchSha -ne $prSha) { throw "PR head is stale: branch=$branchSha pr=$prSha" }

gh pr checks $pr
gh pr view $pr --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews
```

Inspect unresolved review threads before requesting final approval or merge:

```powershell
gh api graphql `
  -f owner="Negentropy-Laby" `
  -f name="OpenSlack" `
  -F number=$pr `
  -f query='query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{
            id
            isResolved
            isOutdated
            comments(first:1){
              nodes{ author{login} path body }
            }
          }
        }
      }
    }
  }'
```

Resolve only threads whose blocker is fixed or explicitly waived by an
authorized human/reviewer:

```powershell
gh api graphql `
  -f threadId="<review-thread-id>" `
  -f query='mutation($threadId:ID!){
    resolveReviewThread(input:{threadId:$threadId}){
      thread{ id isResolved }
    }
  }'
```

If `gh pr merge` reports `base branch policy prohibits the merge`, inspect
these in order:

1. Unresolved review conversations.
2. Whether the latest human approval was dismissed by a repair commit, merge
   conflict fix, or force-push.
3. Required checks and whether they ran on the current `headRefOid`.
4. Merge conflicts or stale branch state.

Do not use `--admin` to bypass this policy during normal OpenSlack governance.
Use `--auto` only after all gates above are confirmed and the repository
requires auto-merge or a merge queue to finish the merge.

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

## GitHub App Manifest callback

`openslack github app create --org <organization> --apply` starts the packaged
App Manifest callback surface. It binds only to `127.0.0.1` (or explicit `::1`),
uses a cryptographic, expiring, single-use state, and exchanges GitHub's
temporary manifest code through a bounded request. The private key, webhook
secret, and client secret are written through `CredentialStore`; local config
contains references only. The backend must support atomic create-only writes;
preflight refuses unavailable or occupied destinations before showing the
external registration form. A rollback deletion failure writes a reference-only
reconciliation receipt under the gitignored local state root.

The callback does not implement human OAuth, does not accept an `access_token`
query, and never writes a PAT or installation token to a plaintext file.
`apps/auth-callback/` is the thin HTTP transport for this product flow.

`scripts/setup-gh.sh` installs `gh` CLI on any platform for developer convenience.

## Token Priority (getClient)

Repository target resolution uses: explicit command option, then
`GITHUB_OWNER`/`GITHUB_REPO`, then `git remote origin`, then
`openslack.yaml` canonical remote.

1. `OPENSLACK_GITHUB_APP_ID` + `OPENSLACK_GITHUB_APP_INSTALLATION_ID` + private key → **GitHub App installation token** (preferred)
2. `GITHUB_TOKEN` or `GH_TOKEN` → **PAT / Actions token** (fallback)
3. Neither → **dry-run mode** only for commands that explicitly allow dry-run

Governance commands that need real PR evidence, such as `pr doctor`, request
live credentials and fail closed instead of silently using dry-run placeholder
data.

## Environment Variables

| Variable                                | Required          | Default                                  |
| --------------------------------------- | ----------------- | ---------------------------------------- |
| `GITHUB_OWNER`                          | No                | `wsman`                                  |
| `GITHUB_REPO`                           | No                | `OpenSlack`                              |
| `GITHUB_TOKEN`                          | No (PAT fallback) | —                                        |
| `OPENSLACK_GITHUB_AUTH_MODE`            | No                | auto-detect                              |
| `OPENSLACK_GITHUB_APP_ID`               | No                | —                                        |
| `OPENSLACK_GITHUB_APP_INSTALLATION_ID`  | No                | —                                        |
| `OPENSLACK_GITHUB_APP_PRIVATE_KEY`      | No                | PEM content                              |
| `OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH` | No                | Used by `scripts/openslack-bot.ps1` only |

## Project v2 Configuration (one-time human admin)

1. Create Project v2 "OpenSlack Evolution Board" on `wsman/OpenSlack`
2. Add 14 standard fields (see `.openslack/integrations/github.yaml`)
3. Run `openslack github project-sync-fields --write` to populate field IDs
4. Verify: `openslack github doctor --strict`
