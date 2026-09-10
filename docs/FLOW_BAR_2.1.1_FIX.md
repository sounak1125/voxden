# Flow bar reliability investigation — 2.1.1

## Confirmed cause of the static bar and settings previews

In the follow-up report, Windows **Accessibility → Visual effects → Animation effects** was off on the affected PC. The user enabled it and confirmed that both the flow bar and the previews immediately worked correctly. This specific report was caused by Windows' reduced-motion preference, rather than the number of connected monitors.

The old renderer deliberately disabled CSS preview animations and froze the Orb's animation clock when Windows requested reduced motion. A page/frame recovery watchdog cannot fix this: the page is healthy and is drawing the static state that the code requests. The existing tests explicitly accepted that behavior.

The source adds **System → Flow bar animations** with **Follow Windows**, **On**, and **Reduced**. The default preserves Windows' accessibility preference and explains when Windows has disabled motion. **On** enables the flow bar and previews together without changing other app or Windows animations. The choice persists, updates during recording without replacing the capture, and follows subsequent Windows changes when set to Follow Windows. This work originally introduced the System page's build identifier as `flow-motion-1`. The current branch targets version **2.1.1**, build **`flowbar-polish-perf-1`**, including the later control polish and performance fixes. See [the current build procedure](RELEASE_2.1.1_BUILD.md) for packaging and verification.

Pure preference/persistence tests and real Electron CSS/Canvas tests cover Windows on/off, all three choices and all three styles. The affected user's installation worked after enabling Windows animation effects. The in-app setting is included in the current branch's rebuild target; it is absent from the historical installer recorded below.

## Follow-up: System switches and window movement

Neither **Launch at login** nor **Show flow bar at all times** being off inherently freezes the app. All four combinations were checked. Manual startup with both off opens the dashboard normally; turning off always-show hides the idle flow bar as intended. Preferences continue to save, previews animate when motion is enabled, and navigation, closing Settings and reopening the dashboard respond normally.

The follow-up did reproduce a window-movement defect: the Settings backdrop covered the native title bar with a `no-drag` region. Every Settings category was affected, regardless of the switch values. The backdrop now starts below the title bar, and the dialog fits the remaining height, including the minimum 640×440 window size and 125% page zoom. The notification bell is disabled while Settings is open so it cannot open an unseen panel behind the modal.

Two additional native overlay edge cases are fixed. Settings refreshes preserve input while the flow bar is dragged, edited or hovered. A delayed native surface recovery is cancelled once the bar is idle with always-show off; active dictation can still recover its visible surface with that preference off.

Changing an unrelated preference also replayed the current success/error mode without its original payload. In the real overlay renderer, this cleared the success entry ID and disabled editing, or replaced a specific error with “Transcription failed.” Settings updates now send preferences without replaying active state transitions. Idle updates still apply show/hide behavior.

The System regression command is `npm run test:system-settings`. It combines an isolated main-process harness, real Electron settings and overlay renderers, and a real main/preload/native-window integration test. Tests stub Windows login registration, updates and global shortcuts and use temporary profiles. They do not change the installed application's preferences or record from the user's microphone.

The System suite passed along with the existing flow-bar regression and motion suites. The result-preservation regression exercises held success edits and specific errors in Classic, Ribbon and Orb, plus arming, recording and transcription without restarting capture. Style changes remain deferred until idle, while motion preferences update immediately. Related notification-panel and JavaScript scope/syntax checks also passed.

Windows caption hit tests return `HTCAPTION` at the exposed title bar and `HTCLIENT` at the Settings close control for all four combinations. The native check also covers OFF/OFF cold startup, persisted switches, idle hide/show and dashboard reopening through production IPC. This verifies drag eligibility on the attached display configuration; it does not claim a physical drag test across every multi-monitor/GPU configuration. The native fixture uses software rendering, while separate renderer tests cover compact layouts and zoom.

These follow-up changes are included in the current `flowbar-polish-perf-1` rebuild target. The earlier local installer below predates both the motion preference and this System settings work. This investigation's historical installer evidence does not verify that current rebuild.

## Scope and evidence

Reported symptoms: the bar remains stuck after speaking, animations stop on other PCs, and Classic's Stop / Transcribe action appears unresponsive.

The flow bar renderer, styles and placement code are unchanged between the `v2.1.0` tag and the original 2.1.1 checkout (`e736169`). The 2.1.1 Auto cleanup feature did not introduce these flow bar paths. No diagnostic log from an affected user's PC was available, so the fixes below address reproduced failure conditions rather than claiming that every remote report has one cause.

## Defects and fixes

1. **A late ready message overwrote the displayed state.** `hud-ready` sent an unconditional idle state, even if a hotkey had already started microphone preparation. Main and the renderer could disagree about whether recording was active. The handshake now accepts only the current overlay and replays the actual mode and media-preparation state. A reload of an already active page explicitly abandons its lost capture instead of reopening the microphone or replaying a spinner whose promise disappeared.

2. **Delayed hover IPC could disable recording buttons at the Windows level.** An idle `hud-ignore-mouse: true` message could arrive after main enabled active controls and make the entire window click-through. Main now enforces active input and current hover state. Failed native input calls are not cached as successes; the cursor poll retries without requiring another mouse movement. Chromium hit-tested mouse tests confirm that all three styles' Stop/Cancel buttons, and the retry action, emit the correct IPC.

3. **Page liveness did not prove drawing liveness.** A forced Chromium freeze/resume reproduced stopped animation frames in both offscreen and native windows while timers and IPC continued. Resizing and invalidating the window did not restore frames; hiding and re-showing the native surface did. Each existing slow health ping now requests one animation-frame acknowledgement. Repeated missed frames with healthy IPC trigger a bounded native surface refresh, preserving the renderer and recording. The check is separate from a frozen-page timeout and does not override reduced-motion preferences.

4. **Busy or never-ready pages could escape recovery.** The old watchdog refused to replace a frozen renderer in every non-idle state. A recording, transcription or held result could therefore stay stuck indefinitely. A page that never sent ready was not monitored at all. Persistent busy freezes now have a grace period before recovery; initial load/readiness failures and repeated crashes are retried with a cooldown. A responsive page may keep transcribing for as long as the speech pipeline permits. Sleep, lock and main-process stalls reset the evidence used by these checks.

5. **Microphone graph creation was treated as successful capture.** AudioContext construction, resumption and node setup could fail after obtaining the microphone. The UI also announced recording before receiving any audio. Setup is now guarded; recording readiness follows the first PCM callback. Device disconnection and a ten-second gap in PCM delivery end the failed capture and release the microphone, audio nodes and timers. The existing arming timeout covers a graph that never produces a first sample. Generation checks prevent late old callbacks or microphone/resume promises from touching a newer recording.

Terminal capture IPC from replaced windows is ignored. Capture failures also record a short diagnostic event without recording spoken content.

## Verification

`npm run test:flow-bar-regression` runs the focused main-state/lifecycle checks and the real Electron control, capture, animation and window tests.

Final result: the aggregate flow bar regression passed. The lifecycle suite was then extended to 21 passing checks, including native show failures and drag protection. All 13 renderer/frame-health unit checks and five state/input checks passed. Related waveform, flow-style, media, capture, release-UI and packaged-startup tests passed.

The audio test uses simulated faults plus Chromium's synthetic microphone with actual Web Audio nodes. It exercises Classic Stop through native mouse input, real preload IPC, the unmodified speech gate, 16 kHz WAV encoding, a stub speech-engine response, success, and return to idle. It does not use the user's microphone or test the accuracy of an installed ASR model.

Animation coverage exercises actual requestAnimationFrame callbacks across repeated recording, transcribing, success, error, cancel, hide/show and suspend/resume cycles for Classic, Ribbon and Orb, with and without reduced motion. The software-rendering path is covered; remote GPU/driver combinations still require checking the fixed installer on an affected machine.

The production-window test checks both actual CDP suspension and persistent frame starvation. On this fixture, the new per-ping frame requests can restore delivery after actual suspension without needing a native re-show. A separate injected frame gate then verifies that sustained healthy IPC with missing frames triggers the production native-recovery path, preserving recorded sample objects, capture generation, mode, position and focus. This distinguishes the observed Chromium failure from the deterministic recovery test.

Related media preparation, screenshot capture and clean packaged-startup tests were also run. At the time of this recovery investigation, the default unit suite had two pre-existing failures outside these fixes: the vocabulary source scanner rejected the existing public author credit in `src/announcements.js`, and the Qwen packaging test expected old finish-page wording in `build/installer.nsh`. All other existing default unit-test scripts passed when run independently of those failures. These are historical results; the current rebuild procedure requires fresh checks against its selected build output.

## Earlier local recovery build and diagnostics

The earlier recovery installer was built separately under `dist/flowbar-fix/` with publishing disabled. Its version was 2.1.1. Preserve this artifact's evidence separately from the current branch's `dist/2.1.1-flowbar-polish-performance/` rebuild target.

- Installer: `dist/flowbar-fix/Voxden-Setup-2.1.1.exe`
- Size: 528,862,760 bytes
- SHA-256: `3af36bb7b53bee22b1e325ecf356da148f35ae074d58f4e6ddc45c1ae767665b`
- Packaging verification at the time of this earlier build: all 67 files under its packaged `src` directory matched the then-current working tree byte for byte. It predates the motion preference added above.

If an affected PC still reproduces a freeze, the installed application's `%APPDATA%\Voxden\data\flow-bar.log` distinguishes microphone failure, page freeze, initial-load failure, frame recovery, main-process stall and power events. It contains short diagnostic events rather than dictated text.

## Follow-up: clicks and drags lost after occlusion (post-2.1.1)

A bar that expands on hover but ignores every click and drag had no log signature: pings, frames and the on-screen picture all stay healthy. Measured on 2026-09-10 with real `mouse_event` clicks against a window built with the overlay's exact flags on Electron 36.9.5 (Chromium 136), and confirmed on the running installed app, whose overlay had its `Chrome_RenderWidgetHostHWND` child hidden.

Cause: the overlay uses `backgroundThrottling: false`. Electron implements that with its `disable_hidden` patch, which makes `RenderWidgetHostImpl::WasHidden` a no-op, so the widget host never counts as hidden. `RenderWidgetHostViewAura::HideImpl` still runs whenever Chromium hides or occludes the window and hides the child window that takes the page's mouse input, but the matching show path (`WasUnOccluded` → `ShowImpl` → `UpdateLegacyWin`) is skipped because the host is not hidden. Only `InternalSetBounds`, a size change, calls `UpdateLegacyWin` again. Same report upstream: electron/electron#29646.

| Transition | `backgroundThrottling: false` | Chromium default |
|---|---|---|
| `hide()` then `showInactive()` | dead | works |
| minimize then `showInactive()` | dead | works |
| covered 4 s by another process's topmost window | dead | works |
| display power off, then on | dead | not run |
| after a one-pixel size change | works | works |

Toggling `setIgnoreMouseEvents`, `setAlwaysOnTop`, a same-size `setBounds` and position-only moves did not revive input. Windows 11 25H2 Show Desktop did not touch the bar at all. Triggers on users' machines are the display's idle power-off, any topmost window covering the bar, and Windows minimizing and restoring it; the bar stayed dead until an edit or learned state resized the window, a resume/unlock event, or a restart.

Fix: `CalculateNativeWinOcclusion` is disabled on the command line (merged into the existing `--disable-features` value; a second `appendSwitch` for the same key replaces the first), which in the same probe left input intact after both the cover and the display cycle. `rearmOverlayInput` now runs on every `showOverlay`, on pointer entry to the resting bar, and skips a held drag; it grows the window one pixel upward into the transparent headroom so a bar the user is looking at does not hop. `npm run test:flow-bar-input` sends real clicks after an external cover, a hide/show and a minimize/restore that main did not perform; the state suite checks the hover-entry rearm happens once and in place.
