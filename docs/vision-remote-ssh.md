# Screen recording over Remote SSH / WSL / Dev Containers

## The problem

The screen-record button captures with ffmpeg spawned by the extension host.
In a remote window the ACP Client extension runs in the **remote** extension
host — it must, since it spawns agent processes next to your code — so ffmpeg
there records the *server's* framebuffer. On a headless workstation there is
none, or it is not the desktop you are looking at:

```
$ echo $DISPLAY

# (empty on a typical headless remote)
```

The webview cannot substitute for it. VS Code builds the webview iframe with
`allow="cross-origin-isolated; autoplay; local-network-access; clipboard-*"`;
there is no `display-capture`, so `getDisplayMedia()` is rejected by
Permissions Policy no matter what the extension does.

## The fix: the same UI-kind companion as voice

[`companion/acp-local-capture`](../companion/acp-local-capture/) declares
`"extensionKind": ["ui"]`, so VS Code runs it in the **local** extension host,
on the machine with the monitors. Commands registered by any extension host
land in the same main-thread `CommandsRegistry`, so the remote ACP Client can
drive the local recorder by command id:

```
remote host  ──  acpLocalCapture.listCaptureTargets / .startScreenRecord / .stopScreenRecord / .cancelScreenRecord  ──▶  client
client       ──  (MP4 returned as base64 on stop) ──▶  remote
```

`stopScreenRecord` returns the MP4 as base64; the remote host writes it to its
temp dir and runs the existing `VideoVisionClient` (or frame extraction)
pipeline. **Capture is local, analysis stays on the remote host** — the vision
endpoint and any API key never leave the remote side.

The host-side bridge lives in `src/vision/CompanionScreenRecorder.ts`.
`WindowRecordManager.startWithPicker()` picks the path: in a remote window it
probes `acpLocalCapture.listCaptureTargets`; when the companion answers, the
picker shows the **client's** displays/windows and a
`CompanionScreenRecorder` drives the take over command RPC. When the companion
is absent the manager throws `COMPANION_SCREEN_INSTALL_HINT` (no silent
fallback to the headless server framebuffer). Base64 over the command bridge is
practical for short clips (a 30 s 1080p take is ~5–15 MB → ~7–20 MB base64);
chunked transfer is deliberately not implemented — keep takes short or lower
`acp.vision.maxDurationSec`.

The recorder implementation is shared verbatim with the main extension
(`src/vision/WindowRecorder.ts`), so display/window enumeration, extended
screens, and the duration/size caps behave identically here.

## Setup

1. **Build the companion VSIX** (on the remote workspace is fine):

   ```bash
   npm run package:companion
   # → companion/acp-local-capture/acp-local-capture-0.2.0.vsix
   ```

2. **Install it from the remote window**: Extensions view → `…` →
   *Install from VSIX…* → pick that file. VS Code routes
   `extensionKind: ["ui"]` installs to the local extension management server,
   i.e. your laptop.

3. **Recorder on the laptop needs ffmpeg.** The companion uses the same
   resolution as the main extension:

   | Client OS | Backend | Install needed |
   |---|---|---|
   | macOS | ffmpeg `avfoundation` (+ `screencapture -l` for window list) | `brew install ffmpeg` |
   | Windows | ffmpeg `gdigrab` | install ffmpeg |
   | Linux | ffmpeg `x11grab` | `apt install ffmpeg` |

   Set `acp.vision.ffmpegPath` when ffmpeg is not on the client's PATH.

## Using it

- Click **🖥** in the chat composer. In a remote window the target list comes
  from the companion (your laptop's displays and windows, including extended
  screens).
- Stop with the same button; the take shows as a 🎬 chip.
- Send: the remote host analyzes via `acp.vision.endpoint` (StepFun-style
  `video_url`) or extracts frames when no endpoint is configured and the agent
  supports images.

## Troubleshooting

- **"This is a remote window (Remote SSH/WSL/Container)…"** — the companion is
  not installed or not activated on the client. Install the VSIX above and
  reload the window.
- **Empty target list** — ffmpeg missing on the client, or screen-recording
  permission denied (macOS: System Settings → Privacy & Security → Screen
  Recording for your editor).
- **Window target fails on macOS** — the editor also needs Accessibility
  permission to read window bounds; pick a Display target instead.
