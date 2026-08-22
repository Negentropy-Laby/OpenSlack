<#
.SYNOPSIS
Run OpenSlack with dynamically selected GitHub App bot authentication.

.DESCRIPTION
Uses the shared Node installation resolver to combine explicit/environment
configuration, supported local metadata, verified Git origin, and checked-in
public metadata. It never sources an arbitrary .env file and never exposes an
installation token to PowerShell.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 setup github

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 pr doctor 71

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 -ListInstallations
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$PrivateKeyPath,
  [string]$AppId,
  [string]$InstallationId,
  [string]$AppSlug,
  [string]$Owner,
  [string]$Repo,
  [switch]$ListInstallations,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$OpenSlackArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node is required but not installed.'
  exit 1
}

if ([string]::IsNullOrWhiteSpace($Owner) -ne [string]::IsNullOrWhiteSpace($Repo)) {
  Write-Error 'Owner and Repo must be provided together.'
  exit 1
}

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$managed = @(
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH',
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_SLUG',
  'GITHUB_OWNER',
  'GITHUB_REPO'
)
$previous = @{}
foreach ($name in $managed) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$exitCode = 1
try {
  if (-not [string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
    $resolvedPrivateKeyPath = if ([System.IO.Path]::IsPathRooted($PrivateKeyPath)) {
      $PrivateKeyPath
    } else {
      Join-Path $repoRoot $PrivateKeyPath
    }
    $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH = $resolvedPrivateKeyPath
  }
  if (-not [string]::IsNullOrWhiteSpace($AppId)) {
    $env:OPENSLACK_GITHUB_APP_ID = $AppId
  }
  if (-not [string]::IsNullOrWhiteSpace($InstallationId)) {
    $env:OPENSLACK_GITHUB_APP_INSTALLATION_ID = $InstallationId
  }
  if (-not [string]::IsNullOrWhiteSpace($AppSlug)) {
    $env:OPENSLACK_GITHUB_APP_SLUG = $AppSlug
  }
  if (-not [string]::IsNullOrWhiteSpace($Owner)) {
    $env:GITHUB_OWNER = $Owner
    $env:GITHUB_REPO = $Repo
  }
  if ($ListInstallations) {
    $raw = & node (Join-Path $PSScriptRoot 'bot-list-installations.js')
    if ($LASTEXITCODE -ne 0) {
      $exitCode = $LASTEXITCODE
    } else {
      $envelope = $raw | ConvertFrom-Json
      $hasInstallations = $null -ne $envelope -and
        @($envelope.PSObject.Properties.Name) -contains 'installations'
      if ($null -eq $envelope -or
          $envelope.schema -ne 'openslack.github_app_installation_list.v1' -or
          -not $hasInstallations) {
        Write-Error 'GitHub App installation list response is invalid.'
        $exitCode = 1
      } else {
        $installations = @($envelope.installations)
        foreach ($installation in $installations) {
          Write-Output ("{0}`t{1}`t{2}" -f $installation.id, $installation.account, $installation.repositorySelection)
        }
        $exitCode = 0
      }
    }
  } else {
    if (-not $OpenSlackArgs -or $OpenSlackArgs.Count -eq 0) {
      $OpenSlackArgs = @('setup', 'github')
    }
    & node (Join-Path $PSScriptRoot 'bot-openslack-command.js') @OpenSlackArgs
    $exitCode = $LASTEXITCODE
  }
} finally {
  foreach ($name in $managed) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
  }
}

exit $exitCode
