#!/usr/bin/env python3
"""Pull latest TencentDB-Agent-Memory on Mac, restart gateway, verify L1 model."""
import json
import os
import sys
import urllib.request

import paramiko

PW = os.environ.get("MAC_PW", "")
REPO = "/Users/zaedinzeng/projects/TencentDB-Agent-Memory"
CORE = f"{REPO}/MemoryCore"


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 180) -> str:
    _, o, e = c.exec_command(cmd, timeout=timeout)
    return (o.read() + e.read()).decode("utf-8", "replace").strip()


def main() -> int:
    if not PW:
        print("Set MAC_PW", file=sys.stderr)
        return 1

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("192.168.124.5", username="zaedinzeng", password=PW, timeout=20, allow_agent=False, look_for_keys=False)

    print("=== git pull (kemier/local/dev) ===")
    print(
        run(
            c,
            f"cd {REPO} && git stash push -m 'pre-sync' -- "
            f"MemoryCore/src/core/tdai-core.ts MemoryCore/tdai-gateway.mac.yaml scripts/start-memory-mac.sh 2>/dev/null; "
            f"git fetch kemier local/dev && git merge --ff-only kemier/local/dev",
        )
    )

    print("=== verify commit + modelRef ===")
    print(run(c, f"cd {REPO} && git log -1 --oneline"))
    print(run(c, f"grep -n 'modelRef: this.cfg.extraction.model' {CORE}/src/core/tdai-core.ts"))

    print("=== restart gateway ===")
    restart = f"""python3 <<'PY'
import os, signal, subprocess, time, urllib.request
CORE = os.path.expanduser("{CORE}")
env = os.environ.copy()
env["TDAI_GATEWAY_CONFIG"] = os.path.join(CORE, "tdai-gateway.mac.yaml")
env["TDAI_GATEWAY_API_KEY"] = env.get("TDAI_GATEWAY_API_KEY", "local")
env["TDAI_LLM_API_KEY"] = env.get("TDAI_LLM_API_KEY", "local")
try:
    out = subprocess.check_output(["lsof", "-nP", "-iTCP:8420", "-sTCP:LISTEN", "-t"], text=True).strip()
    for pid in out.splitlines():
        os.kill(int(pid), signal.SIGTERM)
        print("killed", pid)
except subprocess.CalledProcessError:
    print("no listener")
time.sleep(2)
logf = open("/private/tmp/tdai-gateway.log", "a")
subprocess.Popen(
    ["/opt/homebrew/bin/node", "--import", "tsx", "src/gateway/server.ts"],
    cwd=CORE, env=env, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True,
)
for _ in range(40):
    try:
        urllib.request.urlopen("http://127.0.0.1:8420/health", timeout=2)
        print("health ok")
        break
    except Exception:
        time.sleep(1)
else:
    print("health FAILED")
PY"""
    print(run(c, restart, timeout=60))

    print("=== extraction model in yaml ===")
    print(run(c, f"grep -A6 'extraction:' {CORE}/tdai-gateway.mac.yaml | head -8"))

    print("=== cursor L1 count (zaedinzeng) ===")
    body = json.dumps({"team_id": "default", "agent_id": "cursor", "user_id": "zaedinzeng"}).encode()
    req = urllib.request.Request(
        "http://192.168.124.5:8420/v3/atomic/count",
        data=body,
        headers={
            "Authorization": "Bearer local",
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
