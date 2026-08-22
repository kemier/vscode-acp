#!/usr/bin/env python3
"""Upload VSIX to Mac and install into Cursor / VS Code extension dirs."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import paramiko

HOST = os.environ.get("MAC_HOST", "192.168.124.5")
USER = os.environ.get("MAC_USER", "zaedinzeng")
PW = os.environ.get("MAC_PW", "")
REPO = Path(__file__).resolve().parents[1]

REGISTER_PY = r'''
import json, sys, time, uuid
from pathlib import Path
ext_root = Path(sys.argv[1])
ext_id, version, rel = sys.argv[2], sys.argv[3], sys.argv[4]
abs_path = str(ext_root / rel)
ext_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"vscode-ext:{ext_id}"))
ej_path = ext_root / "extensions.json"
entries = json.loads(ej_path.read_text()) if ej_path.exists() else []
entries = [e for e in entries if e.get("identifier", {}).get("id") != ext_id]
entries.append({
    "identifier": {"id": ext_id, "uuid": ext_uuid},
    "version": version,
    "location": {"$mid": 1, "fsPath": abs_path, "external": Path(abs_path).as_uri(),
                 "path": abs_path, "scheme": "file"},
    "relativeLocation": rel,
    "metadata": {"installedTimestamp": int(time.time() * 1000), "pinned": False, "source": "vsix"},
})
ej_path.write_text(json.dumps(entries))
print(f"Registered {ext_id}@{version}")
'''


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 300) -> str:
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = (o.read() + e.read()).decode("utf-8", "replace").strip()
    return out


def main() -> int:
    if not PW:
        print("Set MAC_PW environment variable", file=sys.stderr)
        return 1

    pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    version = pkg["version"]
    publisher = pkg["publisher"]
    name = pkg["name"]
    ext_id = f"{publisher}.{name}"
    rel = f"{ext_id}-{version}"
    vsix = REPO / f"{name}-{version}.vsix"
    if not vsix.is_file():
        print(f"VSIX not found: {vsix}", file=sys.stderr)
        return 1

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST}...")
    c.connect(HOST, username=USER, password=PW, timeout=20, allow_agent=False, look_for_keys=False)

    remote_vsix = f"/tmp/{name}-{version}.vsix"
    print(f"Uploading {vsix.name} ({vsix.stat().st_size // 1024} KB)...")
    with c.open_sftp() as sftp:
        sftp.put(str(vsix), remote_vsix)

    targets_out = run(
        c,
        'for d in "$HOME/.cursor/extensions" "$HOME/.vscode/extensions" "$HOME/.vscode-server/extensions"; do '
        '[ -d "$d" ] && echo "$d"; done',
    )
    targets = [ln.strip() for ln in targets_out.splitlines() if ln.strip()]
    if not targets:
        targets = [run(c, 'echo "$HOME/.cursor/extensions"').strip()]
        run(c, f'mkdir -p "{targets[0]}"')

    register_b64 = __import__("base64").b64encode(REGISTER_PY.encode()).decode()
    for ext_root in targets:
        cmd = f"""
set -euo pipefail
EXT_ROOT="{ext_root}"
EXT_DIR="$EXT_ROOT/{rel}"
TMP=$(mktemp -d)
unzip -qo "{remote_vsix}" -d "$TMP"
mkdir -p "$EXT_ROOT"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -R "$TMP/extension/"* "$EXT_DIR/"
rm -rf "$TMP"
python3 -c "import base64; exec(base64.b64decode('{register_b64}').decode())" "$EXT_ROOT" "{ext_id}" "{version}" "{rel}"
echo "Installed to $EXT_DIR"
"""
        print(run(c, cmd))

    run(c, f'rm -f "{remote_vsix}"')
    c.close()
    print(f"\nDone — {ext_id} v{version} on Mac ({', '.join(targets)}).")
    print("Reload: Cmd+Shift+P → Reload Window")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
