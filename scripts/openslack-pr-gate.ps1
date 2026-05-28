<#
.SYNOPSIS
Run PRMS doctor and optional Merge Steward with GitHub App bot auth.

.DESCRIPTION
This is a local orchestration wrapper. It does not implement GitHub API calls
and does not expose GitHub App private key contents. Authentication is delegated
to scripts/openslack-bot.ps1, and merge readiness is delegated to OpenSlack
PRMS commands.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber 110

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openslack-pr-gate.ps1 -PrNumber 110 -Merge -Method merge
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$PrNumber,

  [switch]$Merge,

  [ValidateSet('merge', 'squash', 'rebase')]
  [string]$Method = 'merge',

  [string]$PrivateKeyPath = $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH,

  [string]$AppId = $(if ($env:OPENSLACK_GITHUB_APP_ID) { $env:OPENSLACK_GITHUB_APP_ID } else { '3728623' }),

  [string]$InstallationId = $env:OPENSLACK_GITHUB_APP_INSTALLATION_ID,

  [string]$AppSlug = $(if ($env:OPENSLACK_GITHUB_APP_SLUG) { $env:OPENSLACK_GITHUB_APP_SLUG } else { 'openslack-agent-operator' }),

  [string]$Owner = $(if ($env:GITHUB_OWNER) { $env:GITHUB_OWNER } else { 'Negentropy-Laby' }),

  [string]$Repo = $(if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { 'OpenSlack' }),

  [switch]$NoAutoDiscover
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$botScript = Join-Path $repoRoot 'scripts/openslack-bot.ps1'

if (-not (Test-Path -LiteralPath $botScript -PathType Leaf)) {
  Write-Error "OpenSlack bot wrapper not found at '$botScript'."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
  $PrivateKeyPath = Join-Path $repoRoot '.openslack.local/github-app.pem'
} elseif (-not [System.IO.Path]::IsPathRooted($PrivateKeyPath)) {
  $PrivateKeyPath = Join-Path $repoRoot $PrivateKeyPath
}

$resolvedKeyPath = $PrivateKeyPath
if (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf) {
  $resolvedKeyPath = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
} else {
  Write-Error "GitHub App private key not found at '$PrivateKeyPath'. Place the PEM there yourself; do not commit it."
  exit 1
}

$firstLine = Get-Content -LiteralPath $resolvedKeyPath -TotalCount 1
if ($firstLine -notmatch '^-----BEGIN [A-Z ]*PRIVATE KEY-----$') {
  Write-Error "File at '$resolvedKeyPath' does not look like a PEM private key."
  exit 1
}

function Invoke-OpenSlackBot {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$OpenSlackArgs
  )

  $botArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $botScript,
    '-PrivateKeyPath', $resolvedKeyPath,
    '-AppId', $AppId,
    '-AppSlug', $AppSlug,
    '-Owner', $Owner,
    '-Repo', $Repo
  )

  if (-not [string]::IsNullOrWhiteSpace($InstallationId)) {
    $botArgs += @('-InstallationId', $InstallationId)
  }

  if ($NoAutoDiscover) {
    $botArgs += @('-NoAutoDiscover')
  }

  $botArgs += $OpenSlackArgs

  & powershell @botArgs
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    exit $exitCode
  }
}

Write-Host "Running PRMS doctor for ${Owner}/${Repo} PR #$PrNumber with GitHub App bot auth."
Invoke-OpenSlackBot -OpenSlackArgs @('pr', 'doctor', [string]$PrNumber)

if ($Merge) {
  Write-Host "Running Merge Steward for ${Owner}/${Repo} PR #$PrNumber with method '$Method'."
  Invoke-OpenSlackBot -OpenSlackArgs @('pr', 'merge', [string]$PrNumber, '--method', $Method)
}
