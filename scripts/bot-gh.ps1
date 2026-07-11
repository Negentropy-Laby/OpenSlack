<#
.SYNOPSIS
Run any `gh` command with GitHub App bot authentication.

.DESCRIPTION
Generates a GitHub App installation token and runs `gh` with bot authentication.
This prevents the gh CLI from using the human OAuth identity by default.

`pr create` delegates to the package-backed delivery command so branch push and
PR creation use one installation identity. Other arguments are forwarded to
bot-authenticated `gh`.

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

if ($GhArgs.Count -ge 2 -and $GhArgs[0] -eq 'pr' -and $GhArgs[1] -eq 'create') {
    $deliveryArgs = if ($GhArgs.Count -gt 2) { $GhArgs[2..($GhArgs.Count - 1)] } else { @() }
    & node (Join-Path $PSScriptRoot 'bot-delivery-compat.js') @deliveryArgs
    exit $LASTEXITCODE
}

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

# The Node launcher keeps the installation token in memory and injects it only
# into the gh child environment. PowerShell variables never receive it.
& node (Join-Path $PSScriptRoot 'bot-gh-command.js') @GhArgs
exit $LASTEXITCODE
