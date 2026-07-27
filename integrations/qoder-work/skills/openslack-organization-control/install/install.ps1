[CmdletBinding()]
param(
  [Parameter()]
  [string]$TargetRoot
)

$ErrorActionPreference = "Stop"
$SkillName = "openslack-organization-control"

function Get-CanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $PathRoot = [System.IO.Path]::GetPathRoot($FullPath)
  if ([string]::Equals($FullPath, $PathRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return $PathRoot
  }
  return $FullPath.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Assert-NoReparseComponent {
  param([Parameter(Mandatory = $true)][string]$Path)

  $CanonicalPath = Get-CanonicalPath -Path $Path
  $PathRoot = [System.IO.Path]::GetPathRoot($CanonicalPath)
  $RelativePath = $CanonicalPath.Substring($PathRoot.Length)
  $CurrentPath = $PathRoot
  $Separators = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  foreach (
    $Component in $RelativePath.Split(
      $Separators,
      [System.StringSplitOptions]::RemoveEmptyEntries
    )
  ) {
    $CurrentPath = Join-Path $CurrentPath $Component
    if (Test-Path -LiteralPath $CurrentPath) {
      $Item = Get-Item -LiteralPath $CurrentPath -Force
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "install.ps1: refusing a reparse-point component in target root"
      }
    }
  }
}

$SourceDirectory = Get-CanonicalPath -Path (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:QODER_SKILLS_ROOT)) {
    $TargetRoot = $env:QODER_SKILLS_ROOT
  } else {
    $UserProfile = [Environment]::GetFolderPath("UserProfile")
    if ([string]::IsNullOrWhiteSpace($UserProfile)) {
      throw "install.ps1: cannot resolve the current user profile"
    }
    $TargetRoot = Join-Path $UserProfile ".qoderwork\skills"
  }
}

if (-not [System.IO.Path]::IsPathRooted($TargetRoot)) {
  throw "install.ps1: target root must be an absolute path"
}

$RequestedTargetRoot = $TargetRoot
$TargetRoot = Get-CanonicalPath -Path $RequestedTargetRoot
$FilesystemRoot = Get-CanonicalPath -Path ([System.IO.Path]::GetPathRoot($TargetRoot))
$CurrentUserProfileValue = [Environment]::GetFolderPath("UserProfile")
$CurrentUserProfile = if ([string]::IsNullOrWhiteSpace($CurrentUserProfileValue)) {
  $null
} else {
  Get-CanonicalPath -Path $CurrentUserProfileValue
}
$RelativeFromFilesystemRoot = $TargetRoot.Substring($FilesystemRoot.Length)
$PathSegments = @(
  $RelativeFromFilesystemRoot.Split(
    [char[]]@(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    ),
    [System.StringSplitOptions]::RemoveEmptyEntries
  )
)

if (
  [string]::Equals($TargetRoot, $FilesystemRoot, [StringComparison]::OrdinalIgnoreCase) -or
  $PathSegments.Count -lt 2 -or
  (
    $null -ne $CurrentUserProfile -and
    [string]::Equals($TargetRoot, $CurrentUserProfile, [StringComparison]::OrdinalIgnoreCase)
  )
) {
  throw "install.ps1: refusing filesystem, user-profile, or broad directory as target root"
}

Assert-NoReparseComponent -Path $TargetRoot
if (Test-Path -LiteralPath $TargetRoot) {
  $RootItem = Get-Item -LiteralPath $TargetRoot -Force
  if (($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "install.ps1: refusing a reparse-point target root"
  }
} else {
  New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}
Assert-NoReparseComponent -Path $TargetRoot

$TargetDirectory = Join-Path $TargetRoot $SkillName
$SourcePrefix = $SourceDirectory.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
$TargetPrefix = $TargetDirectory.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
if ($TargetPrefix.StartsWith($SourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "install.ps1: refusing a target nested inside the source Skill"
}

if (Test-Path -LiteralPath $TargetDirectory) {
  $TargetItem = Get-Item -LiteralPath $TargetDirectory -Force
  if (-not $TargetItem.PSIsContainer) {
    throw "install.ps1: target Skill exists and is not a directory"
  }
  if (($TargetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "install.ps1: refusing a reparse-point target Skill"
  }
}

function Get-TreeManifest {
  param([Parameter(Mandatory = $true)][string]$Root)

  $Prefix = $Root.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  @(
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
      Sort-Object FullName |
      ForEach-Object {
        $Relative = $_.FullName.Substring($Prefix.Length).Replace("\", "/")
        $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "${Relative}`t${Hash}"
      }
  )
}

$Nonce = [Guid]::NewGuid().ToString("N")
$StageDirectory = Join-Path $TargetRoot ".${SkillName}.tmp.${Nonce}"
$BackupDirectory = Join-Path $TargetRoot ".${SkillName}.backup.${Nonce}"
$StagePublished = $false
$TargetBackedUp = $false

try {
  New-Item -ItemType Directory -Path $StageDirectory | Out-Null
  Get-ChildItem -LiteralPath $SourceDirectory -Force |
    Copy-Item -Destination $StageDirectory -Recurse -Force

  if (Test-Path -LiteralPath $TargetDirectory) {
    $SourceManifest = @(Get-TreeManifest -Root $StageDirectory)
    $TargetManifest = @(Get-TreeManifest -Root $TargetDirectory)
    $Difference = @(Compare-Object -ReferenceObject $SourceManifest -DifferenceObject $TargetManifest)
    if ($Difference.Count -eq 0) {
      Write-Output "${SkillName} is already up to date at ${TargetDirectory}"
      return
    }

    Move-Item -LiteralPath $TargetDirectory -Destination $BackupDirectory
    $TargetBackedUp = $true
  }

  Move-Item -LiteralPath $StageDirectory -Destination $TargetDirectory
  $StagePublished = $true

  if ($TargetBackedUp) {
    Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
    $TargetBackedUp = $false
  }

  Write-Output "Installed ${SkillName} at ${TargetDirectory}"
} catch {
  if ($TargetBackedUp -and -not (Test-Path -LiteralPath $TargetDirectory)) {
    Move-Item -LiteralPath $BackupDirectory -Destination $TargetDirectory
    $TargetBackedUp = $false
  }
  throw
} finally {
  if (-not $StagePublished -and (Test-Path -LiteralPath $StageDirectory)) {
    Remove-Item -LiteralPath $StageDirectory -Recurse -Force
  }
}
