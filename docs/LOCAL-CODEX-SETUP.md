# Using a Local Codex-ACP Build

By default the "Codex CLI" agent uses the npm-published binary via `npx @zed-industries/codex-acp@latest`. To use your own local build instead:

## 1. Build the Rust binary

```bash
cd /workspace/git/ezennin/codex-acp
cargo build --release
# Binary at target/release/codex-acp
```

## 2. Create a wrapper script

The binary needs OpenSSL libraries at runtime. Create a wrapper at `~/.local/bin/codex-acp`:

```bash
cat > ~/.local/bin/codex-acp << 'SCRIPT'
#!/bin/bash
export LD_LIBRARY_PATH="/workspace/git/ezennin/openssl-install/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec /workspace/git/ezennin/codex-acp/target/release/codex-acp "$@"
SCRIPT
chmod +x ~/.local/bin/codex-acp
```

> **Adjust paths** for your environment:
> - `openssl-install/lib64` — where your custom OpenSSL is installed (needed if the system OpenSSL is too old)
> - `codex-acp/target/release/codex-acp` — your compiled binary

Verify it works:

```bash
~/.local/bin/codex-acp --help
```

## 3. Configure the VSCode extension

In VSCode settings (`acp.agents`), update the "Codex CLI" entry:

```json
"Codex CLI": {
  "command": "/workspace/git/ezennin/.local/bin/codex-acp",
  "args": [],
  "env": {}
}
```

Or if the wrapper is on your `PATH`:

```json
"Codex CLI": {
  "command": "codex-acp",
  "args": [],
  "env": {}
}
```

## Architecture

```
┌─────────────────┐    ACP over stdin/stdout (NDJSON)    ┌──────────────┐
│  vscode-acp     │ ────────────────────────────────────▶ │  codex-acp   │
│  (ACP client)   │ ◀──────────────────────────────────── │  (ACP agent) │
│  VSCode ext     │                                      │  Rust binary  │
└─────────────────┘                                      └──────┬───────┘
                                                                │
                                                                ▼
                                                         OpenAI API
                                                         (Codex)
```

## Troubleshooting

### `No such file or directory` on launch

The wrapper script path is wrong. Check that the binary exists:

```bash
ls -la /workspace/git/ezennin/codex-acp/target/release/codex-acp
```

### OpenSSL / SSL errors

The binary was compiled against a newer OpenSSL than what's on the system. Make sure the wrapper sets `LD_LIBRARY_PATH` to your OpenSSL install.

### Orphaned processes after VSCode closes

If `codex-acp` processes survive after closing VSCode, kill them:

```bash
pkill -f codex-acp
```

This was a bug in earlier versions where the extension only killed the shell process, not the entire process group. It is fixed in v0.2.0+ — the extension now:
- Spawns agents in their own process group (`detached: true`)
- Kills the entire process group on disconnect
- Cleans up in `deactivate()` when VSCode closes
