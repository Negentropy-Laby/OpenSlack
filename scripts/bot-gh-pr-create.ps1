<#
.SYNOPSIS
Create a GitHub Pull Request with bot authentication.

.DESCRIPTION
Creates a PR using the configured bot identity (openslack-agent-operator[bot])
instead of the human gh CLI OAuth identity.

Arguments are mapped to the package-backed `openslack delivery publish` command.

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

& node (Join-Path $PSScriptRoot 'bot-delivery-compat.js') @CreateArgs
exit $LASTEXITCODE
