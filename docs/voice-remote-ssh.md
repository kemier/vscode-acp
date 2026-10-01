# Voice dictation over Remote SSH / WSL / Dev Containers

## The problem

The mic button records with a recorder binary (`rec`/`arecord`) spawned by the
extension host. In a remote window the ACP Client extension runs in the **remote**
extension host — it must, since it spawns agent processes next to your code — so
that recorder listens to the *server's* sound card. On a headless workstation
there is none:

```
$ ls /dev/snd 2>&1
ls: cannot access '/dev/snd': No such file or directory
```

The webview cannot substitute for it. VS Code builds the webview iframe as:

```ts
// src/vs/workbench/contrib/webview/browser/webviewElement.ts
const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];
if (!isFirefox) { allowRules.push('clipboard-read', 'clipboard-write'); }
element.setAttribute('allow', allowRules.join('; '));
```

No `microphone` → `getUserMedia({ audio: true })` is rejected by Permissions
Policy, no matter what the extension does.

## The fix: a UI-kind companion extension

`companion/acp-local-capture` declares `"extensionKind": ["ui"]`, so VS Code runs
it in the **local** extension host, on the machine with the microphone. Commands
registered by any extension host land in the same main-thread `CommandsRegistry`,
so the remote ACP Client can drive the local recorder by command id:

```
remote host  ──  acpLocalCapture.start / .stop / .cancel / .probe  ──▶  client
client       ──  acp.capture.localRecorderEvent (audioFlowing / naturalExit) ──▶  remote
```

`stop` returns the WAV as base64; the remote host writes it to its temp dir and
runs the existing STT + Voice Memory pipeline. **Capture is local, transcription
stays remote** — the STT endpoint and any API key never leave the remote host.

Two capture backends run on the client, both shared with the main extension:
`src/voice/AudioRecorder.ts` (SoX/`arecord`/ffmpeg — silence auto-stop, the
"audio flowing" Bluetooth probe, Windows WAV-header repair) and
`src/voice/MciRecorder.ts` (Windows MCI via `winmm.dll`, **nothing to install**).

## Setup

1. **Build the companion VSIX** (on the remote workspace is fine):

   ```bash
   npm run package:companion
   # → companion/acp-local-capture/acp-local-capture-0.2.0.vsix
   ```

2. **Install it from the remote window**: Extensions view → `…` →
   *Install from VSIX…* → pick that file. VS Code routes `extensionKind: ["ui"]`
   installs to the local extension management server, i.e. your laptop
   (`getServersToInstall` → `prefersExecuteOnUI` → local). If you prefer, copy
   the VSIX to the laptop and run `code --install-extension` there.

3. **Recorder on the laptop — nothing to install on Windows.** The companion
   chooses a backend automatically:

   | Client OS | Backend | Install needed |
   |---|---|---|
   | Windows | MCI (`winmm.dll` driven by PowerShell) when SoX is absent | **none** — part of Windows |
   | Windows | SoX `rec` when it happens to be on `PATH` | optional; adds silence auto-stop |
   | macOS | SoX `rec` | `brew install sox` |
   | Linux | SoX `rec` / `arecord` | `apt install sox` / `alsa-utils` |

   Force the choice with `acp.voice.windowsRecorder` (`auto` / `mci` / `binary`);
   `acp.voice.recordCommand` still wins and is resolved against the **client's**
   PATH.

   MCI is what makes dictation work on a managed laptop where third-party
   software cannot be installed. Two constraints come with it:

   - **No silence auto-stop** — MCI exposes no level metering, so a take ends on
     the second mic click or at the `acp.voice.maxDurationSec` cap.
   - **PowerShell must allow `Add-Type`** — the script compiles a 6-line
     P/Invoke wrapper for `mciSendString`. It is passed with `-EncodedCommand`,
     so the execution policy (which governs script *files*) does not apply; if
     the machine enforces Constrained Language Mode through AppLocker/WDAC,
     `Add-Type` is blocked and the error message says exactly that.

4. **Reload Window**, then run `ACP: Voice Input Diagnostics` from the Command
   Palette. Expected on a locked-down Windows 11 laptop:

   ```
   remote:            ssh-remote+seroiuts00847
   captureMode:       auto
   effective capture: local companion (client machine)
   companion:         installed & activated
   companion detail:  v0.1.0 on win32, backend=mci (no recorder binary on PATH;
                      using built-in Windows MCI), recorder=none - ...
   stt.endpoint:      http://127.0.0.1:8317/v1/audio/transcriptions
   ```

   The dialog offers *Test Local Microphone*: it records 3 s on the client and
   reports the captured byte count, isolating mic problems from ACP. Details land
   in the client-side output channel **ACP Local Capture**.

   Windows mic permission lives in Settings → Privacy & security → Microphone →
   *Let desktop apps access your microphone* (VS Code is a desktop app).

## Settings

| Setting | Effect |
|---|---|
| `acp.voice.captureMode: auto` | companion in remote windows when installed, extension host otherwise (default) |
| `acp.voice.captureMode: localCompanion` | always use the companion; hard error if missing |
| `acp.voice.captureMode: extensionHost` | always record where the extension host runs (local windows, or a remote box that really has a mic) |
| `acp.voice.recordCommand` | forwarded verbatim to the companion and resolved against the **client's** binaries |
| `acp.voice.windowsRecorder: auto` | MCI when no recorder binary is on the client's PATH, SoX when there is (default) |
| `acp.voice.windowsRecorder: mci` | always the built-in Windows recorder |
| `acp.voice.windowsRecorder: binary` | always SoX/ffmpeg; errors with an install hint when missing |

macOS clients: the mic permission belongs to the VS Code app itself
(System Settings → Privacy & Security → Microphone); grant it there, not to a
terminal.

## Alternatives (and why they were rejected)

- **PulseAudio/PipeWire over SSH** (`module-native-protocol-tcp` + reverse
  tunnel, remote `PULSE_SERVER`): works on Linux↔Linux only, needs per-machine
  daemon config, and is unusable from a Windows client.
- **Patching the local VS Code** to add `microphone` to the webview `allow`
  list: modifies `workbench.desktop.main.js`, reverts on every update.
- **Local browser page via `asExternalUri`**: works (the browser has mic
  access), but forces the user out of the editor for every take.
