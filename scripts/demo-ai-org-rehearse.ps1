$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& bun (Join-Path $ScriptDir 'demo-ai-org-rehearse.ts') @args
exit $LASTEXITCODE
