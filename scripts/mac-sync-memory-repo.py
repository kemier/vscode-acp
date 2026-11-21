#!/usr/bin/env python3
"""Pull latest TencentDB-Agent-Memory on Mac, restart gateway, verify L1 model."""
import json
import os
import sys
import urllib.request

import paramiko

HOST = os.environ.get("MAC_HOST", "")
USER = os.environ.get("MAC_USER", "")
PW = os.environ.get("MAC_PW", "")
# Checkout of TencentDB-Agent-Memory on the Mac, e.g. /Users/<you>/projects/TencentDB-Agent-Memory
REPO = os.environ.get("MAC_MEMORY_REPO", "")
MEMORY_USER_ID = os.environ.get("MEMORY_USER_ID", "")
MEMORY_API_KEY = os.environ.get("MEMORY_API_KEY", "")
CORE = f"{REPO}/MemoryCore"


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 180) -> str:
    _, o, e = c.exec_command(cmd, timeout=timeout)
    return (o.read() + e.read()).decode("utf-8", "replace").strip()


def main() -> int:
    missing = [name for name, value in (("MAC_HOST", HOST), ("MAC_USER", USER), ("MAC_PW", PW),
               ("MAC_MEMORY_REPO", REPO), ("MEMORY_USER_ID", MEMORY_USER_ID),
               ("MEMORY_API_KEY", MEMORY_API_KEY)) if not value]
    if missing:
        print("Set " + ", ".join(missing), file=sys.stderr)
        return 1

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PW, timeout=20, allow_agent=False, look_for_keys=False)

    print("=== git pull (kemier/local/dev) ===")
    print(
        run(
            c,
            f"cd {REPO} && git stash push -m 'pre-sync' -- "
            f"MemoryCore/src/core/tdai-core.ts MemoryCore/tdai-gateway.mac.yaml 2>/dev/null; "
            f"git fetch kemier local/dev && git merge --ff-only kemier/local/dev",
        )
    )

    print("=== verify commit + modelRef ===")
    print(run(c, f"cd {REPO} && git log -1 --oneline"))
    print(run(c, f"grep -n 'modelRef: this.cfg.extraction.model' {CORE}/src/core/tdai-core.ts"))

    print("=== restart memory stack ===")
    print(run(c, f"bash {REPO}/scripts/start-all.sh restart", timeout=120))

    print("=== extraction model in yaml ===")
    print(run(c, f"grep -A6 'extraction:' {CORE}/tdai-gateway.mac.yaml | head -8"))

    print(f"=== cursor L1 count ({MEMORY_USER_ID}) ===")
    body = json.dumps({"team_id": "default", "agent_id": "cursor", "user_id": MEMORY_USER_ID}).encode()
    req = urllib.request.Request(
        f"http://{HOST}:8420/v3/atomic/count",
        data=body,
        headers={
            "Authorization": f"Bearer {MEMORY_API_KEY}",
            "x-tdai-service-id": "default",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())

    print("=== recent L1 runner lines ===")
    log = run(
        c,
        "tail -c 5000000 /private/tmp/tdai-gateway.log | "
        "grep -E 'Creating StandaloneLLMRunner: model=qwen2|run\\(\\) start: taskId=l1-extraction' | tail -6",
    )
    print(log or "(no recent l1 lines — trigger a conversation batch to verify)")

    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
