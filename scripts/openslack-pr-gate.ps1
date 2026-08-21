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

  [string]$PrivateKeyPath,

  [string]$AppId,

  [string]$InstallationId,

  [string]$AppSlug,

  [string]$Owner,

  [string]$Repo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$botScript = Join-Path $repoRoot 'scripts/openslack-bot.ps1'

if (-not (Test-Path -LiteralPath $botScript -PathType Leaf)) {
  Write-Error "OpenSlack bot wrapper not found at '$botScript'."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($Owner) -ne [string]::IsNullOrWhiteSpace($Repo)) {
  Write-Error 'Owner and Repo must be provided together.'
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
    '-File', $botScript
  )

  foreach ($binding in @(
    @('PrivateKeyPath', $PrivateKeyPath),
    @('AppId', $AppId),
    @('InstallationId', $InstallationId),
    @('AppSlug', $AppSlug),
    @('Owner', $Owner),
    @('Repo', $Repo)
  )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$binding[1])) {
      $botArgs += @("-$($binding[0])", [string]$binding[1])
    }
  }

  $botArgs += $OpenSlackArgs

  & powershell @botArgs
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    exit $exitCode
  }
}

Write-Host "Running PRMS doctor for PR #$PrNumber with dynamically selected GitHub App bot auth."
Invoke-OpenSlackBot -OpenSlackArgs @('pr', 'doctor', [string]$PrNumber)

if ($Merge) {
  Write-Host "Running Merge Steward for PR #$PrNumber with method '$Method'."
  Invoke-OpenSlackBot -OpenSlackArgs @('pr', 'merge', [string]$PrNumber, '--method', $Method)
}
