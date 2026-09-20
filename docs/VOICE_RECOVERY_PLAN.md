# Voice recovery — implementation plan

> **Status, 2026-09-20: A, B and C are implemented.**
>
> What shipped differs from the plan below, all deliberate:
>
> - **The card is smaller than this plan drew it.** One name ("Recover voice"),
>   one quiet line (`2 min · 6:13 PM · Voxden Cloud timed out`), and one small
>   outlined button carrying the cost (`Recover · 2 credits`). Playing, saving
>   and deleting are in the card menu; the group sits under the feed's own
>   small day label, "Not transcribed". The earlier version -- status chip,
>   reason row, facts row, a filled primary button and a separate play button
>   -- was four competing elements for one decision.
> - **Recovery does not take over the flow bar.** It reports progress on its
>   own card ("Recovering…"), the way the existing per-entry retry does. Two
>   page-initiated re-transcriptions behaving differently would have been the
>   odd thing.
> - **The "recovery is off" notice lives on the setting, not the page.** With
>   "Keep recordings" off there are no clips and therefore no section, so there
>   is nothing on the Dictation page to caption. The toggle's own hint now says
>   that turning it off means a failed dictation cannot be recovered.
> - **The error bar says so.** A failure that kept its clip reads
>   "No speech · saved to recover", because the bar is gone in 1.8 seconds and
>   it is the only signal the user gets at the moment it happens.
> - **The storage figure counts the shelf.** `corpus.recordingStats()` includes
>   shelved clips and the Settings Delete button removes them, since they are
>   kept by the same toggle. A figure that left them out could not be acted on.
> - **C writes one live clip, not one per session.** `recovery/_live.wav`, with
>   an underscore so the shelf listing skips it. There is only ever one
>   recording in flight, and a fixed name means a crash cannot leave a pile of
>   half-written files behind.
>
> `PRIVACY.md` also had a pre-existing error: it said "Keep recordings" was off
> by default when it has been on. That is corrected along with the new wording.

## Ground rules

1. **Everything is gated on `keepingClips()`** ([main.js:4570](../src/main.js)).
   "Keep recordings" off means no recovery, by design. The UI has to say so
   rather than showing an empty list.
2. **Recovery never pastes.** The target app from the failed dictation is long
   gone. Recovered text lands in history and on the clipboard.
3. **Recovery routes through the user's own engine.** `transcribeSavedFile`
   ([main.js:5425](../src/main.js)) already does this: cloud on → Voxden Cloud,
   cloud off → the local model. No new engine logic.
4. **Recovery is metered like a dictation.** Routing the result through
   `addHistoryEntry` charges the free-word meter ([main.js:3272](../src/main.js)),
   and a cloud recovery is a real billed request — a credit is a minute of audio
   ([credits.js:3](../src/credits.js)). The card states the cost before the user
   spends it.

## Storage model

Failed clips get their own folder, **not** a history entry.

```
<audio root>/
  recordings/        existing: <entryId>.wav, claimed by a history entry
  corpus/            existing: promoted training pairs
  recovery/          NEW: <id>.wav — clips with no entry
  recovery/_live.wav NEW: the dictation being spoken right now (phase C)
  recovery.jsonl     NEW: one record per clip
  retry.wav          existing: the live single-slot retry
```

A synthetic history entry would have been less UI work, but it pollutes word
counts, search, stats, exports and `recordingPolicy().keepIds`
([main.js:4577](../src/main.js)), which is derived from history. A separate
folder keeps the blast radius at zero.

Manifest record, mirroring the `pairs.jsonl` read/rewrite pattern already in
`corpus.js` ([corpus.js:119](../src/corpus.js)):

```json
{ "id": "r8x2…", "ts": 1758… , "seconds": 42.3, "bytes": 1353644,
  "reason": "Voxden Cloud timed out — try again",
  "source": "failure" | "crash",
  "engine": "qwen" | "cloud", "exe": "chrome.exe", "title": "Gmail" }
```

Retention: same clock as recordings (14 days), with its own caps — **25 clips /
200 MB** — so a broken engine or a bad mic cannot quietly fill a disk. Pruned on
launch next to `pruneRecordings()` ([main.js:6340](../src/main.js)).

---

## Phase A — failed clips become recoverable

### A1. `corpus.js` — a recovery store

New exports, all following the existing `recordings()` / `prune()` shape:

| Function | Does |
| --- | --- |
| `keepFailure(file \| buffer, meta)` | Moves `retry.wav` into `recovery/<id>.wav`, appends the manifest record, returns the id |
| `recoveries()` | Manifest joined with what's actually on disk, newest first, memoised like `recordings()` |
| `recoveryPath(id)` | Absolute path, or null |
| `dropRecovery(id)` | Deletes clip + record |
| `pruneRecoveries(policy)` | Same policy shape as `prune()`: `maxDays`, `maxBytes`, `maxClips` |
| `clearRecoveries()` | For the Delete button and for "Keep recordings" being switched off |

`keepFailure` **moves** the retry clip rather than copying it — same bytes, one
`renameSync`, and the retry slot is correctly empty afterwards.

Invalidate the memo on every mutation, as `invalidate()` already does.

### A2. `main.js` — capture the failure

**`flashError`** ([main.js:3748](../src/main.js)) currently drops the parked clip
and leaves `retry.wav` to be wiped by the next dictation. New behaviour, before
`corpus.dropParked()`:

```
keep the clip when:  keepingClips()
                  && corpus.hasRetry()
                  && !retryEntryOwner     // no entry was created for this text
```

The `retryEntryOwner` test is what separates a real failure from the paste
failure at [main.js:3604](../src/main.js), which already created an entry and
claimed the clip — that one must not also become a recovery.

`flashError` takes the reason string it is already given, so the manifest gets
"Voxden Cloud timed out — try again" rather than a generic label. The messages
come from `friendlyEngineError` ([main.js:4538](../src/main.js)) and are already
user-facing.

**Launch** ([main.js:6337](../src/main.js)) currently deletes `retry.wav`
unconditionally. Change it to promote first: a retry clip present at launch means
the app did not quit cleanly, so it becomes a recovery with
`source: "crash"`. This buys part of C for two lines — any crash *after* the clip
reached main is now recoverable.

**Quit** ([main.js:6505](../src/main.js)) and **next dictation**
([main.js:2954](../src/main.js)) stay as they are: by then a failure has already
been promoted.

**"Keep recordings" switched off** ([main.js:6092](../src/main.js)) must clear
recoveries along with everything else, through `pruneRecordings()`
([main.js:4587](../src/main.js)).

### A3. `main.js` — IPC surface

| Channel | Behaviour |
| --- | --- |
| `recovery-audio` | Bytes + seconds for playback. Mirrors `history-audio` ([main.js:6286](../src/main.js)) |
| `recovery-save` | Save-as WAV dialog. Mirrors `history-audio-save` ([main.js:6296](../src/main.js)) |
| `recovery-transcribe` | **The Recover button.** See below |
| `recovery-delete` | One clip |
| `recovery-clear` | All of them, same guard as `recordings-clear` ([main.js:6267](../src/main.js)) |

`snapshot()` ([main.js:1110](../src/main.js)) gains `recoveries: corpus.recoveries()`
next to the existing `recordings:` line.

`recovery-transcribe(id)`:

1. Refuse while a dictation or another retry is in flight — same guard as
   `retryEntry` ([main.js:3673](../src/main.js)). One engine, one queue.
2. Put the flow bar in `transcribing` so the user sees the work happening.
3. `transcribeSavedFile(file)` — **wrapped in `cloudAsr.cloudThenLocal`**, which
   it is not today ([main.js:5428](../src/main.js)). Without that wrapper a Pro
   user whose cloud is down cannot recover the clip their cloud outage created.
   Reuse `startLocalForBusyCloud` ([main.js:5445](../src/main.js)) for the
   "Cloud busy. Using this PC…" message.
4. `composeTranscript(raw, tone, currentDictationQuality())` with the tone for
   the stored `exe`/`title` when there is one, the default tone otherwise.
5. Empty result → leave the clip in place, return
   `"The engine heard no speech in this recording."` A recovery that finds
   nothing must not destroy the evidence.
6. Text → `addHistoryEntry(text, meta)` (this charges the meter), copy the clip
   to `recordings/<entryId>.wav` so the new entry behaves like any other
   (play / save / retry / correct-into-a-training-pair), then `dropRecovery(id)`.
7. Write the transcript to the clipboard and return `{ ok: true, text }`.

### A4. `app.js` / `app.html` — the Dictation page

A recovery has no text, so it needs its own card rather than a branch inside
`buildCard` ([app.js:4854](../src/app.js)). Add `buildRecoveryCard(item)` beside
it, reusing `makeIconBtn`, `menuItem`, the audio player block, `cardStatus` and
`openCardMenuFor`.

Card contents:

```
⚠  Not transcribed · 42s · today 14:06
   Voxden Cloud timed out — try again
   [▸ play ————————————— 0:00 / 0:42]
   [ Recover transcript ]   ⋯ (Save as WAV… · Delete)
```

- Primary button is **Recover transcript**, labelled with the cost when cloud is
  the selected engine: `Recover transcript · ~1 credit`.
- Rendered by `renderRecoveries(data)` into its own container **above**
  `groupsEl`, called from `render()` where `renderFeed` is called for the
  dictation view ([app.js:6294](../src/app.js)). Keeping it out of `renderFeed`
  leaves the feed's signature diff ([app.js:6210](../src/app.js)) untouched —
  that diff is a deliberate performance fix and should not learn about
  recoveries.
- On success: the section removes the card, the feed shows the new entry, and a
  toast says "Recovered — copied to clipboard".
- **Keep recordings off** → the section renders one line: "Recovery is off —
  turn on Keep recordings in Settings", linking to that setting. Silence here is
  how a user concludes the feature is broken.

`app.html`: the section container above the feed, and an amended recordings hint
at [app.html:1454](../src/app.html) that names recovery as something the toggle
controls.

### A5. Settings and privacy

- `PRIVACY.md` currently says audio is kept only for "Keep recordings" and
  training. Add that a failed dictation's audio is kept under the same toggle,
  with the same 14-day clock, and that a recovery sends audio to Voxden Cloud
  only when cloud dictation is the selected engine.
- The recordings hint text lives in both `app.html` and `app.js:3765` — update
  both.

---

## Phase B — stop discarding audio in the renderer

Three exits in `finishCapture` ([overlay.js:1703](../src/overlay.js)) fail without
ever sending the audio to main, so there is no `retry.wav` for A to promote.

| Site | Today | Change |
| --- | --- | --- |
| [overlay.js:1742](../src/overlay.js) | Clip under 0.3 s → fail | **No change.** Nothing there to recover |
| [overlay.js:1755](../src/overlay.js) | Speech gate says silence → fail | **Park first.** This is the big one |
| [overlay.js:1828](../src/overlay.js) | Engine not set up → fail | **Park first.** The PCM is a whole paragraph |
| [overlay.js:1833](../src/overlay.js) | Generic "No speech" tail | **Park first** when `hasPcm` |

The gate case matters most. `analyseSpeech` calls it silence below 0.004 RMS for
three consecutive 30 ms frames ([speech-gate.js:31](../src/speech-gate.js)) — a
quiet mic, a low input level, or someone sitting back from the desk can fall
under that, and today the app discards their paragraph and says "No speech".
After this change the audio is kept and the message can be honest: **"Nothing
heard — recording saved for recovery"**.

Two details:

- `chunks` and `dsPcmChunks` are still in scope at the tail exits, so the same
  `dsPcmChunks.length ? mergePcm(…) : downsample(mergePcm(chunks), …)` that the
  main path uses ([overlay.js:1739](../src/overlay.js)) builds the PCM there.
- **Await the park.** `parkAudio` is `invoke` and `captureFailed` is `send`
  ([preload.js:40,45](../src/preload.js)) — firing them in the wrong order lets
  `flashError` run before the clip lands on disk, and A's promotion finds
  nothing. `await window.voxden.parkAudio(...)` then `captureFailed(...)`.

---

## Phase C — crash and power-cut insurance

A and B cover every failure where the clip reached main. They do **not** cover a
power cut or a crash while the user is still talking: the PCM lives only in
renderer memory until stop ([overlay.js:1712](../src/overlay.js)). That is the
worst case — a long dictation, completely gone — so it needs its own mechanism.

### C1. Flush while recording

- Renderer accumulates PCM as it already does, and every **3 seconds** sends the
  accumulated slice to main on a new `capture-flush` channel (`send`, not
  `invoke` — no round trip on the recording path).
- **Start flushing only after 5 seconds of recording.** Short dictations, which
  are most of them, never touch the disk.
- Only when `keepingClips()`; main tells the renderer at capture start, so the
  renderer does no work when recovery is off.
- No new timer or animation frame — hang the flush off the existing audio
  callback path. The flow bar's CPU budget is tight and a continuous loop there
  is measurable.

At 16 kHz mono 16-bit a 3-second flush is ~96 KB: negligible I/O, and the flow
bar is not on the write path.

### C2. Main appends

- `recovery/live-<session>.wav`: write a 44-byte RIFF header on first flush with
  placeholder sizes, then append raw frames.
- Clean stop, cancel, success or failure → delete the live file. The finished
  clip goes through the normal `retry.wav` path, so there is exactly one copy of
  any given dictation.

### C3. Recover on launch

- Any `live-*.wav` found at startup is a session that never ended. **Patch the
  header** — `RIFF` and `data` sizes from the actual file length — then move it
  into `recovery/` with `source: "crash"` and the reason "Voxden closed while
  you were dictating".
- Header repair belongs in `corpus.js` next to `wavSeconds`
  ([corpus.js:90](../src/corpus.js)), which already parses RIFF headers.
- Discard anything under 2 seconds: debris, not a dictation.

---

## Tests

`scripts/asr-test-harness` loads main with an isolated data dir and exposes the
IPC handlers, which is how `test-recordings-clear.js` drives real files. Same
approach here.

| File | Covers |
| --- | --- |
| `test-recovery-store.js` | `corpus` recovery API: keep, list, path, drop, prune caps, clear, manifest survives a rewrite |
| `test-recovery-main.js` | `flashError` promotes a clip; the paste-failure path does **not**; launch promotes a crashed `retry.wav`; "Keep recordings" off clears everything |
| `test-recovery-transcribe.js` | Routing: cloud on → cloud, cloud off → sidecar, cloud busy → local fallback; empty result keeps the clip; success creates an entry, copies the clip into `recordings/`, charges the meter, drops the recovery |
| `test-capture.js` (extend) | The three B exits park before failing, and in that order |
| `test-recovery-ui.js` | Electron: the section renders, the off-state message, the Recover button disables while a dictation is running |
| `test-flow-bar-audio-ui.js` (extend) | C: flush starts after 5 s, stops on cancel, leaves no live file on a clean finish |

Add the new files to the `test` script in `package.json`, and the UI one beside
the other `electron scripts/test-*-ui.js` entries.

## Risks and calls to make

1. **Disk.** Worst case under the proposed caps is 200 MB of recoveries on top of
   the existing 500 MB of recordings. Both are user-clearable; the Settings
   storage line should count recoveries too.
2. **A recovery is not free.** Cloud recovery of a 3-minute clip is 3 credits.
   The button states the cost; a Pro user near their cap should see the same
   warning path the live cloud path uses ([cloud.js:39](../src/cloud.js)).
3. **Duplicate audio.** Only C can create two copies of one dictation (live file
   plus finished clip). The live file is deleted on every terminal state —
   success, failure and cancel — which is the invariant C's tests should assert.
4. **Open call:** should a recovered transcript try to paste into the app that
   was focused at the time if it is still running? Plan says no. Cheap to add
   later; wrong to guess at now.
