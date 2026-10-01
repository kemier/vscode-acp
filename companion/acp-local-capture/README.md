# ACP Local Capture (Mic + Screen)

Companion extension for **ACP Client**. It records your microphone and your
screen on the machine where the VS Code window is running (the *UI* side) and
hands the takes to the ACP Client extension for transcription / analysis.

> Renamed from `acp-voice-local` (mic only) when screen recording was added.
> The extension id and every command id changed — uninstall the old
> "ACP Voice (Local Mic)" companion, it is no longer probed.

## Why it is needed

In a Remote SSH / WSL / Dev Container window, ACP Client runs in the **remote**
extension host — it has to, because it spawns agent processes next to your code.
A recorder started there captures the *server's* sound card and framebuffer,
which usually do not exist. Webviews cannot help: VS Code creates the webview
iframe without `microphone` or `display-capture` in its `allow` list, so
`getUserMedia` / `getDisplayMedia` are blocked by Permissions Policy.

This extension declares `"extensionKind": ["ui"]`, so VS Code installs and runs
it on your local machine. It exposes the commands the remote ACP Client calls
over the shared command registry:

| Command | Purpose |
|---|---|
| `acpLocalCapture.probe` | protocol/version + resolved recorder binary |
| `acpLocalCapture.start` / `.stop` / `.cancel` | mic take (WAV base64 on stop) |
| `acpLocalCapture.listCaptureTargets` | client displays + windows |
| `acpLocalCapture.startScreenRecord` / `.stopScreenRecord` / `.cancelScreenRecord` | screen take (MP4 base64 on stop) |
| `ACP Local Capture: Test Local Microphone` | record 3s and report the byte count |

Audio and video only ever travel from your machine to your own remote host;
transcription and vision analysis stay where ACP Client is configured to send
them (`acp.voice.stt.endpoint`, `acp.vision.endpoint`), so no STT or vision
credentials are needed locally.

## Requirements

**Microphone — Windows: none.** Capture falls back to MCI (`winmm.dll`), which
is part of Windows. Trade-off: no silence auto-stop, and PowerShell must permit
`Add-Type`. Optional and preferred (enables silence auto-stop): SoX on macOS /
Linux / Windows.

**Screen — ffmpeg on the client.** macOS uses `avfoundation` (+ `screencapture
-l` for the window list), Windows `gdigrab`, Linux `x11grab`. Set
`acp.vision.ffmpegPath` in ACP Client when ffmpeg is not on the client's PATH.

## Install

Built from the ACP Client repo:

```bash
npm run package:companion   # builds + packages companion/acp-local-capture/*.vsix
```

Then in the remote window: Extensions view → `…` → **Install from VSIX…** and
pick the file. VS Code installs UI-kind extensions on the local machine
automatically. Reload the window afterwards.
