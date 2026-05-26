<#
.SYNOPSIS
Run OpenSlack with GitHub App bot authentication.

.DESCRIPTION
Loads a GitHub App private key from a local, gitignored PEM file into
OPENSLACK_GITHUB_APP_PRIVATE_KEY, then runs `pnpm openslack`.

The default key path is `.openslack.local/github-app.pem` at the repository
root. The script intentionally removes GITHUB_TOKEN from the child process so
bot-auth runs cannot silently fall back to a human PAT.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 setup github

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 pr doctor 71

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/openslack-bot.ps1 -ListInstallations
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$PrivateKeyPath = $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH,
  [string]$AppId = $(if ($env:OPENSLACK_GITHUB_APP_ID) { $env:OPENSLACK_GITHUB_APP_ID } else { '3728623' }),
  [string]$InstallationId = $env:OPENSLACK_GITHUB_APP_INSTALLATION_ID,
  [string]$AppSlug = $(if ($env:OPENSLACK_GITHUB_APP_SLUG) { $env:OPENSLACK_GITHUB_APP_SLUG } else { 'openslack-agent-operator' }),
  [string]$Owner = $(if ($env:GITHUB_OWNER) { $env:GITHUB_OWNER } else { 'Negentropy-Laby' }),
  [string]$Repo = $(if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { 'OpenSlack' }),
  [switch]$ListInstallations,
  [switch]$NoAutoDiscover,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$OpenSlackArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
  $PrivateKeyPath = Join-Path $repoRoot '.openslack.local/github-app.pem'
}

if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
  Write-Error "GitHub App private key not found at '$PrivateKeyPath'. Place the PEM there yourself; do not commit it."
  exit 1
}

$privateKey = Get-Content -Raw -LiteralPath $PrivateKeyPath
if ($privateKey -notmatch '-----BEGIN [A-Z ]*PRIVATE KEY-----') {
  Write-Error "File at '$PrivateKeyPath' does not look like a PEM private key."
  exit 1
}

function Get-GitHubAppInstallations {
  param(
    [Parameter(Mandatory = $true)][string]$GitHubAppId,
    [Parameter(Mandatory = $true)][string]$GitHubPrivateKey
  )

  $previousAppId = $env:OPENSLACK_GITHUB_APP_ID
  $previousPrivateKey = $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY
  try {
    $env:OPENSLACK_GITHUB_APP_ID = $GitHubAppId
    $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY = $GitHubPrivateKey

    $nodeCode = @'
const { createSign } = require("node:crypto");
const https = require("node:https");

function b64url(input) {
  return Buffer.from(input).toString("base64url").replace(/=+$/, "");
}

function jwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString("base64url").replace(/=+$/, "");
  return `${header}.${payload}.${signature}`;
}

const token = jwt(process.env.OPENSLACK_GITHUB_APP_ID, process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY);
const req = https.request({
  hostname: "api.github.com",
  path: "/app/installations",
  method: "GET",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openslack-bot-wrapper"
  }
}, (res) => {
  let body = "";
  res.on("data", (chunk) => { body += chunk.toString(); });
  res.on("end", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error(body);
      process.exit(1);
    }
    console.log(body);
  });
});
req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.end();
'@

    $raw = ($nodeCode | node -) -join "`n"
    if ($LASTEXITCODE -ne 0) {
      throw "Could not list GitHub App installations. Check OPENSLACK_GITHUB_APP_ID and the PEM key."
    }
    return @($raw | ConvertFrom-Json)
  } finally {
    if ($null -eq $previousAppId) { Remove-Item Env:OPENSLACK_GITHUB_APP_ID -ErrorAction SilentlyContinue } else { $env:OPENSLACK_GITHUB_APP_ID = $previousAppId }
    if ($null -eq $previousPrivateKey) { Remove-Item Env:OPENSLACK_GITHUB_APP_PRIVATE_KEY -ErrorAction SilentlyContinue } else { $env:OPENSLACK_GITHUB_APP_PRIVATE_KEY = $previousPrivateKey }
  }
}

if ($ListInstallations -or -not $NoAutoDiscover) {
  $installations = Get-GitHubAppInstallations -GitHubAppId $AppId -GitHubPrivateKey $privateKey

  if ($ListInstallations) {
    foreach ($installation in $installations) {
      $account = $installation.account.login
      $selection = $installation.repository_selection
      Write-Output ("{0}`t{1}`t{2}" -f $installation.id, $account, $selection)
    }
    exit 0
  }

  $matchingInstallations = @($installations | Where-Object { $_.account.login -eq $Owner })
  if ($matchingInstallations.Count -eq 1) {
    $detectedId = [string]$matchingInstallations[0].id
    if ([string]::IsNullOrWhiteSpace($InstallationId)) {
      Write-Host "Detected GitHub App installation for ${Owner}: $detectedId"
      $InstallationId = $detectedId
    } elseif ($InstallationId -ne $detectedId) {
      Write-Warning "OPENSLACK_GITHUB_APP_INSTALLATION_ID=$InstallationId does not match $Owner. Using detected installation $detectedId."
      $InstallationId = $detectedId
    }
  } elseif ([string]::IsNullOrWhiteSpace($InstallationId)) {
    Write-Error "Could not auto-detect a unique installation for owner '$Owner'. Run with -ListInstallations and set OPENSLACK_GITHUB_APP_INSTALLATION_ID."
    exit 1
  }
}

if ([string]::IsNullOrWhiteSpace($InstallationId)) {
  Write-Error 'Missing OPENSLACK_GITHUB_APP_INSTALLATION_ID. Set it, pass -InstallationId <id>, or allow auto-discovery.'
  exit 1
}

$env:OPENSLACK_GITHUB_AUTH_MODE = 'app'
$env:OPENSLACK_GITHUB_APP_ID = $AppId
$env:OPENSLACK_GITHUB_APP_INSTALLATION_ID = $InstallationId
$env:OPENSLACK_GITHUB_APP_PRIVATE_KEY = $privateKey
$env:OPENSLACK_GITHUB_APP_SLUG = $AppSlug
$env:GITHUB_OWNER = $Owner
$env:GITHUB_REPO = $Repo

# Prevent silent fallback to a human PAT in bot-auth runs.
if (Test-Path Env:GITHUB_TOKEN) {
  Remove-Item Env:GITHUB_TOKEN
}

if (-not $OpenSlackArgs -or $OpenSlackArgs.Count -eq 0) {
  $OpenSlackArgs = @('setup', 'github')
}

& pnpm openslack @OpenSlackArgs
exit $LASTEXITCODE
