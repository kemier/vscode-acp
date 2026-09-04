#!/usr/bin/env python3
"""Copy L0 conversations from one MemoryCore user_id to another, then delete source.

Use when Windows captured under OS username (e.g. zengn) but the canonical
identity is zaedinzeng. Re-posts messages via /v3/conversation/add so L1
extraction can run on the destination profile.

Usage:
  python scripts/migrate-memory-user-id.py --from zengn --to zaedinzeng
  MEMORY_ENDPOINT=http://192.168.124.5:8420 python scripts/migrate-memory-user-id.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_ENDPOINT = os.environ.get("MEMORY_ENDPOINT", "http://192.168.124.5:8420")
API_KEY = os.environ.get("MEMORY_API_KEY", "local")
SERVICE_ID = os.environ.get("MEMORY_SERVICE_ID", "default")
TEAM_ID = os.environ.get("MEMORY_TEAM_ID", "default")

AGENTS = (
    "cursor",
    "claude",
    "codex",
    "kiro",
    "gemini",
    "hermes",
    "qwen",
    "opencode",
    "copilot",
)


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{DEFAULT_ENDPOINT.rstrip('/')}{path}",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "x-tdai-service-id": SERVICE_ID,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def count(agent: str, user_id: str) -> tuple[int, int]:
    iso = {"team_id": TEAM_ID, "agent_id": agent, "user_id": user_id}
    l0 = post("/v3/conversation/count", iso)["data"]["total"]
    l1 = post("/v3/atomic/count", iso)["data"]["total"]
    return l0, l1


def fetch_all_messages(agent: str, user_id: str) -> list[dict]:
    messages: list[dict] = []
    offset = 0
    page = 50
    while True:
        body = {
            "team_id": TEAM_ID,
            "agent_id": agent,
            "user_id": user_id,
            "limit": page,
            "offset": offset,
        }
        data = post("/v3/conversation/query", body)["data"]
        batch = data.get("messages") or []
        messages.extend(batch)
        total = int(data.get("total") or 0)
        offset += len(batch)
        if not batch or offset >= total:
            break
    return messages


def migrate_agent(agent: str, src: str, dst: str, dry_run: bool) -> int:
    l0, l1 = count(agent, src)
    if l0 == 0 and l1 == 0:
        return 0
    print(f"  {agent}: source L0={l0} L1={l1}")

    messages = fetch_all_messages(agent, src)
    if not messages:
        return 0

    by_session: dict[str, list[dict]] = {}
    for m in messages:
        sid = str(m.get("session_id") or "migrated")
        by_session.setdefault(sid, []).append(m)

    migrated = 0
    for session_id, sess_msgs in by_session.items():
        payload_msgs = []
        for m in sess_msgs:
            content = m.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            payload_msgs.append(
                {
                    "role": role,
                    "content": content,
                    "timestamp": m.get("timestamp") or m.get("created_at"),
                }
            )
        if not payload_msgs:
            continue
        migrated += len(payload_msgs)
        target_session = f"migrated-from-{src}-{session_id}"[:128]
        print(f"    session {session_id} → {target_session}: {len(payload_msgs)} msg(s)")
        if dry_run:
            continue
        post(
            "/v3/conversation/add",
            {
                "team_id": TEAM_ID,
                "agent_id": agent,
                "user_id": dst,
                "session_id": target_session,
                "messages": payload_msgs,
            },
        )
        post(
            "/v3/conversation/delete",
            {
                "team_id": TEAM_ID,
                "agent_id": agent,
                "user_id": src,
                "session_id": session_id,
            },
        )

    return migrated


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate MemoryCore L0 between user_ids")
    parser.add_argument("--from", dest="src", default="zengn", help="Source user_id")
    parser.add_argument("--to", dest="dst", default="zaedinzeng", help="Destination user_id")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.src == args.dst:
        print("Source and destination user_id are the same.", file=sys.stderr)
        return 1

    print(f"Gateway: {DEFAULT_ENDPOINT}")
    print(f"Migrating {args.src} → {args.dst} (team={TEAM_ID})")
    if args.dry_run:
        print("(dry-run — no writes)")

    total = 0
    for agent in AGENTS:
        try:
            total += migrate_agent(agent, args.src, args.dst, args.dry_run)
        except urllib.error.HTTPError as e:
            print(f"  {agent}: HTTP {e.code} {e.read()[:120]!r}", file=sys.stderr)

    print(f"\nDone. Migrated {total} message(s).")
    print(f"Destination totals ({args.dst}):")
    for agent in ("cursor", "claude", "codex"):
        l0, l1 = count(agent, args.dst)
        print(f"  {agent}: L0={l0} L1={l1}")
    print(f"Source remainder ({args.src}):")
    for agent in ("cursor", "claude", "codex"):
        l0, l1 = count(agent, args.src)
        if l0 or l1:
            print(f"  {agent}: L0={l0} L1={l1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
