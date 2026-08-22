#!/usr/bin/env python3
"""Diagnose cursor L1 extraction vs memory UI (episodic vs instruction)."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request

import paramiko

HOST = os.environ.get("MAC_HOST", "192.168.124.5")
USER = os.environ.get("MAC_USER", "zaedinzeng")
PW = os.environ.get("MAC_PW", "")
GATEWAY = os.environ.get("MEMORY_ENDPOINT", "http://192.168.124.5:8420")
META_DB = os.path.expanduser("~/projects/TencentDB-Agent-Memory/MemoryCore/data/metadata.db")


def gw_post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{GATEWAY}{path}",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer local",
            "x-tdai-service-id": "default",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def run_ssh(c: paramiko.SSHClient, cmd: str) -> str:
    _, o, e = c.exec_command(cmd, timeout=90)
    return (o.read() + e.read()).decode("utf-8", "replace").strip()


def main() -> int:
    print("=== Gateway atomic types (zaedinzeng) ===")
    for agent in ("cursor", "claude", "codex"):
        count = gw_post("/v3/atomic/count", {"team_id": "default", "agent_id": agent, "user_id": "zaedinzeng"})
        conv = gw_post("/v3/conversation/count", {"team_id": "default", "agent_id": agent, "user_id": "zaedinzeng"})
        search = gw_post(
            "/v3/atomic/search",
            {"team_id": "default", "agent_id": agent, "user_id": "zaedinzeng", "query": "the", "limit": 100},
        )
        types: dict[str, int] = {}
        for item in search.get("data", {}).get("items", []):
            t = item.get("type", "?")
            types[t] = types.get(t, 0) + 1
        print(
            f"  {agent}: atomic={count['data']['total']} conv={conv['data']['total']} "
            f"search_types={types}"
        )

    if not PW:
        print("\n(set MAC_PW to check gateway logs + metadata.db on Mac)")
        return 0

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PW, timeout=20, allow_agent=False, look_for_keys=False)

    print("\n=== Recent L1 extraction log lines (cursor) ===")
    log = run_ssh(
        c,
        "tail -c 3000000 /private/tmp/tdai-gateway.log | "
        "grep -E 'l1-extraction|L1 extraction|agent_id=cursor|agent:cursor' | tail -25",
    )
    print(log or "(none)")

    print("\n=== extraction config (tdai-gateway.mac.yaml) ===")
    print(run_ssh(c, "grep -A15 'extraction:' ~/projects/TencentDB-Agent-Memory/MemoryCore/tdai-gateway.mac.yaml | head -18"))

    print("\n=== metadata.db agents (cursor) ===")
    print(
        run_ssh(
            c,
            f"sqlite3 {META_DB} \"SELECT agent_id, display_name, owner_user_id FROM agents "
            "WHERE agent_id='cursor' OR display_name LIKE '%Cursor%';\" 2>/dev/null || echo '(no metadata.db or table)'",
        )
    )

    print("\n=== atomic type breakdown in store (cursor, zaedinzeng) ===")
    print(
        run_ssh(
            c,
            "python3 - <<'PY'\n"
            "import json,urllib.request\n"
            "h={'Authorization':'Bearer local','x-tdai-service-id':'default','Content-Type':'application/json'}\n"
            "ids=set(); types={}\n"
            "for q in ['a','the','user','cursor','deploy','memory','fix','session','commit']:\n"
            "  b=json.dumps({'team_id':'default','agent_id':'cursor','user_id':'zaedinzeng','query':q,'limit':50}).encode()\n"
            "  d=json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8420/v3/atomic/search',data=b,headers=h,method='POST'),timeout=15).read())\n"
            "  for i in d.get('data',{}).get('items',[]):\n"
            "    if i['id'] in ids: continue\n"
            "    ids.add(i['id']); t=i.get('type','?'); types[t]=types.get(t,0)+1\n"
            "print('unique',len(ids),'types',types)\n"
            "PY",
        )
    )

    print("\n=== Find metadata.db + listening ports ===")
    print(run_ssh(c, "find ~/projects/TencentDB-Agent-Memory -name metadata.db 2>/dev/null | head -5"))
    print(run_ssh(c, 'find ~/projects/TencentDB-Agent-Memory -name "*.db" 2>/dev/null | head -25'))
    print(run_ssh(c, "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '8420|8421|3000|5173|8080' || true"))

    print("\n=== MemoryHub episodic references ===")
    repo = "~/projects/TencentDB-Agent-Memory"
    print(run_ssh(c, f"ls {repo}"))
    print(run_ssh(c, f"grep -rl episodic {repo}/MemoryHub 2>/dev/null | head -20"))
    print(run_ssh(c, f"grep -rl instruction {repo}/MemoryHub 2>/dev/null | head -10"))

    print("\n=== knowledge.db schema ===")
    print(run_ssh(c, "sqlite3 ~/projects/TencentDB-Agent-Memory/run/data/knowledge/knowledge.db '.tables'"))
    print(
        run_ssh(
            c,
            "sqlite3 ~/projects/TencentDB-Agent-Memory/run/data/knowledge/knowledge.db "
            "\"SELECT type, COUNT(*) FROM atomic_memories WHERE agent_id='cursor' AND user_id='zaedinzeng' GROUP BY type;\" "
            "2>/dev/null || echo '(no atomic_memories table)'",
        )
    )
    print(
        run_ssh(
            c,
            "sqlite3 ~/projects/TencentDB-Agent-Memory/run/data/knowledge/knowledge.db "
            "\"SELECT type, COUNT(*) FROM atomic_memories WHERE agent_id='claude' AND user_id='zaedinzeng' GROUP BY type;\" "
            "2>/dev/null || true",
        )
    )

    print("\n=== chat-memory.ts episodic grep ===")
    panel = f"{repo}/MemoryPanel"
    chat_mem = f"{panel}/src/panel/http/routes/chat-memory.ts"
    print(run_ssh(c, f"grep -n episodic {chat_mem} 2>/dev/null | head -25"))
    print(run_ssh(c, f"grep -n 'atomic/query\\|type.*episodic\\|chat memory' {chat_mem} 2>/dev/null | head -25"))
    print(run_ssh(c, f"sed -n '1,80p' {chat_mem} 2>/dev/null"))
    print(run_ssh(c, f"sed -n '1000,1090p' {chat_mem} 2>/dev/null"))

    print(run_ssh(c, f"grep -rn owner_user_id {panel}/src 2>/dev/null | head -20"))
    print(run_ssh(c, f"grep -rn 'chat.memory\\|chat_memory\\|ChatMemory' {panel}/src 2>/dev/null | head -25"))
    print(
        run_ssh(
            c,
            f"find {repo}/run -name '*.db' -o -name 'metadata*' 2>/dev/null | head -30",
        )
    )


    print(run_ssh(c, "sed -n '90,170p' ~/projects/TencentDB-Agent-Memory/MemoryPanel/src/panel/http/routes/agent-overview.ts"))
    print(run_ssh(c, "grep -rn episodic ~/projects/TencentDB-Agent-Memory/MemoryPanel/web/src 2>/dev/null | head -25"))
    panel_tsx = "~/projects/TencentDB-Agent-Memory/MemoryPanel/web/src/pages/memory/ChatMemoryPage/components/ChatMemoryPanel.tsx"
    print(run_ssh(c, f"grep -n 'L0\\|L1\\|L2\\|L3\\|episodic\\|instruction\\|原子' {panel_tsx} 2>/dev/null | head -35"))

    print(run_ssh(c, "grep -rn parseChatMemoryAssetId ~/projects/TencentDB-Agent-Memory/MemoryPanel/src/panel/http/routes/chat-memory.ts | head -5"))
    print(run_ssh(c, "grep -A25 'function parseChatMemoryAssetId' ~/projects/TencentDB-Agent-Memory/MemoryPanel/src/panel/http/routes/chat-memory.ts 2>/dev/null"))

    print(run_ssh(c, "grep -rn 'listen\\|PORT' ~/projects/TencentDB-Agent-Memory/MemoryPanel/src/panel/http 2>/dev/null | head -15"))
    print(run_ssh(c, "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E 'node|842' || true"))
    print(run_ssh(c, "grep -A30 'selfMemoryAgentIds\\|chat_memory' ~/projects/TencentDB-Agent-Memory/MemoryPanel/src/panel/http/routes/agent-overview.ts 2>/dev/null | head -40"))

    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
