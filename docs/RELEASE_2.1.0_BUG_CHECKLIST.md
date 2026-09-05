# Voxden 2.1.0 bug-fix checklist

The audit findings below have code changes and automated regression coverage.
Checked items mean the implementation and automated checks are complete; they
do not replace the live Windows acceptance checks at the end of this document.

## Implemented

- [x] **B01 — Cancelled retry pastes later:** session tokens reject cancelled and superseded results before paste/history updates.
- [x] **B02 — Retry uses older audio after recognition failure:** the current complete recording becomes the retry source before recognition; starting another recording invalidates the previous source.
- [x] **B03 — Retention-off/deleted audio remains as retry:** retry copies follow retention settings and history deletion; startup removes retry files left by an earlier session. Failed privacy deletion is reported.
- [x] **B04 — Clipboard restoration loses data:** preserve supported rich formats, serialize pastes, and restore only when the clipboard still matches Voxden's payload. New user copies are preserved. Unsupported formats are left untouched.
- [x] **B05 — Invalid vocabulary rename deletes the original:** validate and save rename in one main-process operation; reject collisions and roll back memory on persistence failure.
- [x] **B06 — History retry overwrites a newer correction:** compare edit revisions and current entry ownership; preserve newer edits and reject deleted entries.
- [x] **B07 — Stale microphone request damages a newer capture:** retain each pending stream locally and guard success/failure by capture generation; stop stale streams without touching the active one.
- [x] **B08 — Interrupted save destroys history:** write a separate file, flush, and atomically replace the store; maintain a recovery copy. Vocabulary edits also use atomic storage.
- [x] **B09 — Failed paste shows success:** Windows paste/send operations acknowledge success and reject an unfocused target. Failed paste keeps the transcript in history and shows an error.
- [x] **B10 — Cancelled optional installation leaves dictation unavailable:** restart an existing enabled runtime after a failed or cancelled installation.
- [x] **B11 — Intentional GPU restart triggers CPU fallback:** handle deliberate restarts separately from unexpected accelerator exits.
- [x] **B12 — Training deletion reports success while files remain:** report partial failure and retain manifest records for surviving clips so deletion can be retried.
- [x] **B13 — English cleanup removes foreign-language words:** pass the dictation language through processing and bypass English-specific cleanup, number conversion, and writing-style transformations for other languages.
- [x] **B14 — Formatting corrupts addresses and numbers:** protect URL/domain, email, and formatted-number tokens during cleanup and writing-style processing.
- [x] **B15 — Paragraph/line commands flatten:** preserve newline separators during style whitespace cleanup.
- [x] **B16 — Verbatim deletes valid sign-offs:** preserve the speaker's text; silence detection remains in the audio gate.
- [x] **B17 — Formal style expands ambiguous contractions incorrectly:** preserve contractions with ambiguous had/would or has/is meanings.
- [x] **B18 — Long retries time out prematurely:** reuse the live transcription timeout calculation for history and flow-bar retries.
- [x] **B19 — All-time statistics shrink at 400 entries:** retain history beyond 400 entries; render in batches of 400 and search the full retained history.
- [x] **B20 — Concurrent playback leaves two recordings playing:** discard obsolete playback loads and cancel pending loads when playback stops.
- [x] **B21 — Default-device transition empties the microphone selector:** preserve the explicitly selected device option even when it is the system default.
- [x] **B22 — Failed update remains stuck restarting:** reset installation state after immediate or asynchronous errors; show the error with a usable restart button.
- [x] **B23 — Helper timeout loses media-pause receipts:** stream successful receipts from the persistent Windows helper and preserve partial output from one-shot invocations; restore only those recorded successes.

## Automated validation

- **`npm test` passed: all 53 scripts**, including `test-release-safety.js` and `test-win32-protocol.js`.
- The release safety suite includes 17 groups covering failure injection, cancellation races, persistence, retention, vocabulary edits, text processing, timeouts, statistics, clipboard behavior, and updater recovery.
- Windows protocol tests run the real PowerShell dispatch/server code with inert native methods. They check paste acknowledgements, rejected focus changes, and receipts arriving before a later media failure.
- **All ten Electron suites passed:** history, media, notifications, flow-bar UI, speech setup, refinement, waveform, release regressions, flow-bar main-process behavior, and startup without Python/models.
- The flow-bar main-process suite passed, but its pointer-drift assertions were skipped because the physical pointer moved during the run. Repeat those assertions with a stationary pointer before release.
- Python compile/self-tests use an isolated offline model/cache directory and the bundled interpreter. They do not perform actual GPU inference.
- Bundled speech-runtime integrity check passed: `asr-win-x64-v3`.
- A Windows x64 unpacked build was created with publishing and executable signing disabled at `temp/release-2.1.0-check/win-unpacked`.
- The packaged manifest reports **2.1.0**; the new modules are present in `app.asar`, and the packaged Windows helper matches the source hash.
- No installer or release was published.

## Behavior to review before release

- With both audio-retention options off, completed dictation audio is not retained for retry. Temporary audio still exists while local recognition is running and is removed afterward.
- When the clipboard contains a format Electron cannot safely restore, Voxden leaves the clipboard untouched and saves the transcript to history with a paste-failure message. Validate this recovery behavior with copied files and application-specific clipboard content.
- The history change preserves records going forward. It cannot reconstruct entries already discarded by earlier versions' 400-entry limit.
- Backup files mirror the latest successful save, including deletions. An unavailable backup write is reported in logs; the successfully committed primary store remains valid.

## Live Windows release gates

- [ ] Microphone permission denial, unplug/replug, system-default changes, and rapid cancel/restart with real devices.
- [ ] Actual CPU and GPU dictation, long clips, model switching, and recovery after an engine process exits.
- [ ] Paste and auto-send into browsers, editors, Office, and elevated windows; focus changes while recognition finishes.
- [ ] Clipboard restoration for text, HTML, RTF, images, copied files, and application-specific formats; rapid copying while dictation completes.
- [ ] Multiple real media players, a nonresponsive player, and endpoint mute/restore behavior.
- [ ] Locked recordings and manifest files during privacy deletion; successful retry after releasing the lock.
- [ ] Fresh Windows installation and upgrade from an existing profile, with retained history and vocabulary.
- [ ] Model download cancellation, interrupted downloads, and installation recovery on real installations.
- [ ] Downloaded app update installation, installer-launch failures, restart, and uninstall.
- [ ] Repeat flow-bar pointer-drift checks with the physical pointer stationary.

Run `npm test` for the Node suite and `npm run test:release-ui` for the additional
renderer regression checks. The existing `test:*ui`, `test:flow-bar-main`, and
`test:packaged-startup` commands remain available individually.
