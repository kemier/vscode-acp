#!/usr/bin/env python3
"""Write acp.memory.* userId (and peers) into Mac editor settings for shared memory."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import paramiko

HOST = os.environ.get("MAC_HOST", "")
USER = os.environ.get("MAC_USER", "")
# The memory gateway runs on the Mac itself unless MEMORY_ENDPOINT says otherwise.
ENDPOINT = os.environ.get("MEMORY_ENDPOINT", f"http://{HOST}:8420" if HOST else "")
MEMORY_USER_ID = os.environ.get("MEMORY_USER_ID", "")
MEMORY_API_KEY = os.environ.get("MEMORY_API_KEY", "")
PW = os.environ.get("MAC_PW", "")

MEMORY_BLOCK = {
    "acp.memory.enabled": True,
    "acp.memory.endpoint": ENDPOINT,
    "acp.memory.apiKey": MEMORY_API_KEY,
    "acp.memory.serviceId": "default",
    "acp.memory.teamId": "default",
    "acp.memory.userId": MEMORY_USER_ID,
    "acp.memory.captureEnabled": True,
    "acp.memory.agentIdMap": {
        "Pi Agent": "pi-agent",
    },
}

TARGETS = [
    "~/Library/Application Support/Cursor/User/settings.json",
    "~/Library/Application Support/Code/User/settings.json",
    "~/.vscode-server/data/Machine/settings.json",
]


def run(c: paramiko.SSHClient, cmd: str) -> str:
    _, o, e = c.exec_command(cmd, timeout=60)
    return (o.read() + e.read()).decode("utf-8", "replace").strip()


def merge_settings_py() -> str:
    block = json.dumps(MEMORY_BLOCK)
    return f"""
import json, os
from pathlib import Path
block = json.loads({block!r})
targets = {TARGETS!r}
for t in targets:
    p = Path(os.path.expanduser(t))
    p.parent.mkdir(parents=True, exist_ok=True)
    data = {{}}
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            data = {{}}
    data.update(block)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\\n", encoding='utf-8')
    print('updated', p)
"""


def main() -> int:
    missing = [name for name, value in (("MAC_HOST", HOST), ("MAC_USER", USER), ("MAC_PW", PW),
               ("MEMORY_USER_ID", MEMORY_USER_ID), ("MEMORY_API_KEY", MEMORY_API_KEY)) if not value]
    if missing:
        print("Set " + ", ".join(missing), file=sys.stderr)
        return 1
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PW, timeout=20, allow_agent=False, look_for_keys=False)
    script = merge_settings_py()
    run(c, f"python3 - <<'PY'\n{script}\nPY")
    for t in TARGETS:
        print(run(c, f"grep -E 'acp.memory.userId|agentIdMap' \"{t}\" 2>/dev/null || echo '{t}: (missing)'"))
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
