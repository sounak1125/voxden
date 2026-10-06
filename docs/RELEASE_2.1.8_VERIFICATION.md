# Voxden 2.1.8 verification — 6 October 2026

2.1.8 fixes the Windows taskbar's window list, which 2.1.7 closed as soon as it opened. It also changes game typing:
- the game shortcut starts off;
- game dictation leaves the game's focus, Escape and clicks alone;
- the flow bar hides only for a fullscreen app on its own screen;
- the "runs as administrator" notes are fewer.

The app ships one new notification, which is the first line of `release-notes/current.md`. The 2.1.7 notes are kept in `release-notes/2.1.7.md`.

Spoken corrections are in the source but stay off in release builds (`spokenCorrectionsAvailable()` in `src/main.js`, commit `cef2cb1`). A packaged build hides the Writing style row, changes no text and never calls `/v1/corrections`.

## Tested builds

- App source: tag `v2.1.8`, commit `9614b69`.
- Local Windows validation:
  - the full `npm test` suite passed;
  - so did the 15 UI suites the release workflow runs: game shortcut, administrator settings, in-app dictation, native theme, speech setup, media, sounds, flow bar UI and placement, capture reuse, changelog, release UI, notifications, packaged startup, and the Writing style page.
- The first tag run (37349702657, at `b568ede`) was cancelled by the Windows job's one-hour limit:
  - "Validate packaged startup without installed models" printed its success line and then never quit;
  - the same step took 2 s on 2.1.7, and the test quits in 5 ms locally.
- Commit `9614b69` makes that test fail fast and say why:
  - an uncaught exception during quit is printed;
  - after 15 s it names the quit events and open windows;
  - `scripts/quit-watchdog.ps1` reads any error box from outside the app;
  - both startup steps stop at 5 minutes.
- The tag was moved there; no release or draft existed for it.
- [Release run 37407965421](https://github.com/sounak1125/voxden/actions/runs/37407965421) passed:
  - the Windows build and smoke tests (the startup step took 2 s);
  - the Mac build;
  - the Mac upload to the draft.
- The first hang did not recur, and its cause is unknown.

## Download verification

- Published 2026-10-06 03:27 UTC as the latest release, titled "Voxden 2.1.8".
- The body is `release-notes/current.md` without its Version and Released lines.
- `releases/latest/download/latest.yml` and `latest-mac.yml` both name version 2.1.8.
- The Windows installer download returns 200 with the size its manifest gives.
- Windows installer: 547,048,942 bytes. Mac DMG: 508,608,909 bytes. Mac ZIP: 514,048,678 bytes.
- Installer hashes were not checked against a local download.

Windows remains unsigned. Mac builds remain Apple Silicon, signed ad hoc, with manual updates. The 2.1.7 to 2.1.8 auto-update has not been watched on a real install.
