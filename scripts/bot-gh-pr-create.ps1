<#
.SYNOPSIS
Create a GitHub Pull Request with bot authentication.

.DESCRIPTION
Creates a PR using the configured bot identity (openslack-agent-operator[bot])
instead of the human gh CLI OAuth identity.

All arguments are forwarded to `gh pr create`.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\bot-gh-pr-create.ps1 --title "feat: add new feature" --body "..." --base main --head feature-branch

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\bot-gh-pr-create.ps1 --draft --title "WIP: refactoring" --body "..."
#>

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CreateArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'bot-gh.ps1') pr create @CreateArgs
$createExit = $LASTEXITCODE
if ($createExit -ne 0) { exit $createExit }

$prNumber = (& (Join-Path $PSScriptRoot 'bot-gh.ps1') pr view --json number --jq '.number') -join ''
if ([string]::IsNullOrWhiteSpace($prNumber)) {
    Write-Error 'Could not resolve the newly-created PR number for workflow governance.'
    exit 1
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error 'bun is required to prepare workflow governance evidence.'
    exit 1
}

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$token = (& node (Join-Path $repoRoot 'scripts/bot-gh-token.js')) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    Write-Error 'Could not create a short-lived GitHub App installation token for workflow governance.'
    exit 1
}
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
$env:OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN = $token
Push-Location $repoRoot
try {
    & bun run openslack pr workflow-governance $prNumber
    exit $LASTEXITCODE
} finally {
    Remove-Item Env:OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
}
