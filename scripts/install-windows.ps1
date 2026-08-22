# Install acp-client VSIX into Cursor / VS Code / vscode-server extension dirs.
$ErrorActionPreference = 'Stop'
$Repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $Repo 'package.json'))) { $Repo = Split-Path $PSScriptRoot -Parent }
Set-Location $Repo

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$rel = "$($pkg.publisher).$($pkg.name)-$($pkg.version)"
$vsix = Join-Path $Repo "acp-client-$($pkg.version).vsix"
if (-not (Test-Path $vsix)) { throw "VSIX not found: $vsix" }

$targets = @(
    (Join-Path $env:USERPROFILE '.cursor\extensions'),
    (Join-Path $env:USERPROFILE '.vscode\extensions'),
    (Join-Path $env:USERPROFILE '.vscode-server\extensions')
)

$tmpBase = Join-Path $env:TEMP "acp-vsix-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpBase -Force | Out-Null
$registerScript = Join-Path $tmpBase 'register.py'
@'
import json, sys, time, uuid
from pathlib import Path
ext_root = Path(sys.argv[1])
ext_id, version, rel = sys.argv[2], sys.argv[3], sys.argv[4]
abs_path = str(ext_root / rel)
ext_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"vscode-ext:{ext_id}"))
ej_path = ext_root / "extensions.json"
entries = json.loads(ej_path.read_text(encoding="utf-8")) if ej_path.exists() else []
entries = [e for e in entries if e.get("identifier", {}).get("id") != ext_id]
entries.append({
    "identifier": {"id": ext_id, "uuid": ext_uuid},
    "version": version,
    "location": {"$mid": 1, "fsPath": abs_path, "external": Path(abs_path).as_uri(),
                 "path": abs_path, "scheme": "file"},
    "relativeLocation": rel,
    "metadata": {"installedTimestamp": int(time.time() * 1000), "pinned": False, "source": "vsix"},
})
ej_path.write_text(json.dumps(entries), encoding="utf-8")
print(f"Registered {ext_id}@{version}")
'@ | Set-Content -Path $registerScript -Encoding UTF8

$zipPath = Join-Path $tmpBase 'pkg.zip'
Copy-Item $vsix $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tmpBase -Force

$extId = "$($pkg.publisher).$($pkg.name)"
foreach ($extRoot in $targets) {
    New-Item -ItemType Directory -Path $extRoot -Force | Out-Null
    $extDir = Join-Path $extRoot $rel
    if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
    New-Item -ItemType Directory -Path $extDir -Force | Out-Null
    Copy-Item (Join-Path $tmpBase 'extension\*') $extDir -Recurse -Force
    python $registerScript $extRoot $extId $pkg.version $rel
    $js = Join-Path $extDir 'dist\extension.js'
    $size = if (Test-Path $js) { (Get-Item $js).Length } else { 0 }
    Write-Host "Installed $extDir (extension.js $size bytes)"
}

Remove-Item $tmpBase -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Done — $extId v$($pkg.version) on Windows."
