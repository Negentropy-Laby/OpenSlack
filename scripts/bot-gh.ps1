<#
.SYNOPSIS
Run any `gh` command with GitHub App bot authentication.

.DESCRIPTION
Generates a GitHub App installation token and runs `gh` with bot authentication.
This prevents the gh CLI from using the human OAuth identity by default.

All arguments are forwarded to `gh`.

For `gh pr create`, this wrapper verifies the PR author is the bot after creation.
If the identity is wrong, it exits with an error.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr create --title "feat: add new feature" --body "..."

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr edit 117 --body "..."

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\bot-gh.ps1 pr comment 117 --body "..."
#>

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GhArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')

# --- Pre-flight checks ---

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is required but not installed."
    exit 1
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "gh CLI is required but not installed."
    exit 1
}

$pemPath = Join-Path $repoRoot '.openslack.local/github-app.pem'
$hasPemEnv = -not [string]::IsNullOrWhiteSpace($env:OPENSLACK_GITHUB_APP_PRIVATE_KEY)
$hasPemFile = Test-Path -LiteralPath $pemPath -PathType Leaf

if (-not $hasPemEnv -and -not $hasPemFile) {
    Write-Error @"
No GitHub App private key found.
  Set OPENSLACK_GITHUB_APP_PRIVATE_KEY environment variable, or
  Place PEM at: $pemPath
"@
    exit 1
}

# --- Generate bot token ---

$tokenOutput = (& node (Join-Path $repoRoot 'scripts/bot-gh-token.js')) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tokenOutput)) {
    Write-Error "Failed to generate GitHub App installation token."
    exit 1
}

# --- Prevent human PAT fallback ---
# Remove GITHUB_TOKEN so gh cannot silently fall back to a human PAT.
if (Test-Path Env:GITHUB_TOKEN) {
    Remove-Item Env:GITHUB_TOKEN
}

# --- Execute gh with bot auth ---

$env:GH_TOKEN = $tokenOutput
& gh @GhArgs
$ghExit = $LASTEXITCODE

# --- Post-creation guardrail for `gh pr create` ---
if ($ghExit -eq 0 -and $GhArgs.Count -ge 2 -and $GhArgs[0] -eq 'pr' -and $GhArgs[1] -eq 'create') {
    Start-Sleep -Seconds 2
    try {
        $prNumber = (& gh pr view --json number --jq '.number') 2>$null
        if ($prNumber) {
            $author = (& gh pr view $prNumber --json author --jq '.author.login') 2>$null
            if ($author -and $author -ne 'openslack-agent-operator' -and $author -ne 'openslack-agent-operator[bot]') {
                Write-Error @"
PR #$prNumber was created under identity '$author' instead of the bot.
  Close this PR and recreate it using the bot-auth wrapper.
  See AGENTS.md 'Bot-Authenticated PR Creation' for details.
"@
                exit 1
            }
        }
    } catch {
        # Verification failed non-fatally; the PR was still created.
    }
}

exit $ghExit
