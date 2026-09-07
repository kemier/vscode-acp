# ACP Voice (Local Mic)

Companion extension for **ACP Client**. It records your microphone on the machine
where the VS Code window is running (the *UI* side) and hands the audio to the
ACP Client extension for transcription.

## Why it is needed

In a Remote SSH / WSL / Dev Container window, ACP Client runs in the **remote**
extension host — it has to, because it spawns agent processes next to your code.
A recorder started there captures the *server's* sound card, which usually does
not exist. Webviews cannot help: VS Code creates the webview iframe without
`microphone` in its `allow` list, so `getUserMedia({ audio: true })` is blocked
by Permissions Policy.

This extension declares `"extensionKind": ["ui"]`, so VS Code installs and runs
it on your local machine. It exposes four commands that the remote ACP Client
calls over the shared command registry:

| Command | Purpose |
|---|---|
| `acpVoiceLocal.probe` | protocol/version + resolved recorder binary |
| `acpVoiceLocal.start` | start a take (returns `takeId`) |
| `acpVoiceLocal.stop` | stop and return the WAV as base64 |
| `acpVoiceLocal.cancel` | abort and delete the take |
| `ACP Voice: Test Local Microphone` | record 3s and report the byte count |

Audio only ever travels from your machine to your own remote host; transcription
stays where ACP Client is configured to send it (`acp.voice.stt.endpoint`), so no
STT credentials are needed locally.

## Requirements

**Windows: none.** Capture falls back to MCI (`winmm.dll`), which is part of
Windows — the same engine the old Sound Recorder used. Useful on managed laptops
where third-party software cannot be installed. Trade-off: no silence auto-stop
(end the take with the mic button), and PowerShell must permit `Add-Type` (the
script is passed with `-EncodedCommand`, so execution policy is not involved).

Optional, and preferred when available because it enables silence auto-stop:

- macOS: `brew install sox`
- Linux: `sudo apt install sox` (or `alsa-utils` for `arecord`)
- Windows: SoX on `PATH`

Override the command with `acp.voice.recordCommand`, or pin the Windows backend
with `acp.voice.windowsRecorder` (`auto` / `mci` / `binary`), in ACP Client's
settings; both are forwarded to this extension.

## Install

Built from the ACP Client repo:

```bash
npm run package:companion   # builds + packages companion/acp-voice-local/*.vsix
```

Then in the remote window: Extensions view → `…` → **Install from VSIX…** and
pick the file. VS Code installs UI-kind extensions on the local machine
automatically. Reload the window afterwards.
