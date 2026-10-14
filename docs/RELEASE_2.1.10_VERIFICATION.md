# Voxden 2.1.10 release verification

Published 2026-10-14 at 04:31 UTC from tag `v2.1.10` at `12e49d8`.

## Before the tag

- Three audits (app bugs and dead code, server bugs and dead code, security
  and dependencies), each finding re-checked against the code before any
  change. Fixes are in `a485e41`, with the 18-language cloud menu.
- The account service carrying the language refusal and the audit fixes was
  deployed to the droplet before the tag and confirmed live: the container
  runs the image built from `12e49d8`, its start line reads
  `cloud=assemblyai/universal-3-5-pro rescue=openai/gpt-4o-mini-transcribe
  warmup=off`, and `/healthz` answers 200.
- Electron 43.7.9 to 43.7.11. `npm audit --omit=dev` reports 0
  vulnerabilities.
- A local run of the release job's Windows steps passed all 25 steps:
  `npm test`, every UI step, `npm run dist`, `verify-built-app.js`, and the
  packaged startup test on a fresh and an existing profile (version 2.1.10).
- Account service CI run 38509204689 green (tests and image).

## Release run

- Run 38509505664: `mac` succeeded on the first attempt. `release` failed on
  the first attempt in `test-app-theme-native.js`: a recording-HUD colour
  read mid-transition under the runner's reduced motion, which passed three
  times locally with reduced motion emulated. A rerun of the failed job on
  the same tag passed, and `mac-release` followed. The test now finishes
  transitions before reading, on main after the tag.

## Published release

- `gh api .../releases/latest` returns `v2.1.10` with 6 assets:
  `Voxden-Setup-2.1.10.exe` (547,235,478 bytes) and its blockmap,
  `Voxden-2.1.10-mac-arm64.dmg` (508,430,141), `.zip` (513,794,803),
  `latest.yml`, `latest-mac.yml`.
- Both feeds served from `releases/latest/download/` say `version: 2.1.10`,
  and their sizes match the uploaded files.
- The installer download through `releases/latest/download/` answers 200.
- The release body is `release-notes/current.md` without its Version and
  Released lines.

## Not verified

- The installer's sha512 against a local download.
- The 2.1.9 to 2.1.10 auto-update on a real install.
- Any Mac behaviour on a real Mac.
- The Android beta still offers Korean, which the relay now refuses.
