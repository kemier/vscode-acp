# Install ~/.cursor/hooks.json + preCompact logger for vscode-acp memory re-inject.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SrcHook = Join-Path $RepoRoot 'scripts\hooks\pre-compact-log.mjs'
$CursorDir = Join-Path $env:USERPROFILE '.cursor'
$HooksDir = Join-Path $CursorDir 'hooks'
$DestHook = Join-Path $HooksDir 'pre-compact-log.mjs'
$HooksJson = Join-Path $CursorDir 'hooks.json'

if (-not (Test-Path $SrcHook)) {
  Write-Error "Source hook not found: $SrcHook"
}

New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
Copy-Item -Force $SrcHook $DestHook

$entry = @{
  command = 'node ./hooks/pre-compact-log.mjs'
  timeout = 5
}

$config = @{ version = 1; hooks = @{ preCompact = @($entry) } }

if (Test-Path $HooksJson) {
  $existing = Get-Content $HooksJson -Raw | ConvertFrom-Json
  if (-not $existing.hooks) {
    $existing | Add-Member -NotePropertyName hooks -NotePropertyValue (@{})
  }
  $pre = @($existing.hooks.preCompact)
  $already = $pre | Where-Object { $_.command -eq $entry.command }
  if (-not $already) {
    $pre += $entry
  }
  $existing.hooks.preCompact = $pre
  $config = $existing
}

$config | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $HooksJson

Write-Host "Installed preCompact hook:"
Write-Host "  script: $DestHook"
Write-Host "  config: $HooksJson"
Write-Host "  log:    $env:USERPROFILE\.cursor\acp-debug\compaction-events.jsonl"
Write-Host ""
Write-Host "Reload Cursor / restart cursor-agent sessions. Optional: set ACP_PRECOMPACT_NOTIFY=1 for a user toast."
