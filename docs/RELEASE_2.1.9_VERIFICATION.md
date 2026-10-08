# Voxden 2.1.9 release verification

Published 2026-10-08 at 07:23 UTC from tag `v2.1.9` at `58377d9`.

## Before the tag

- Four audits (dependencies, code security, dead code on Windows and shared
  code, Mac), each finding re-checked against the code before any change.
  Fixes are in `1e0b6be` (account service) and `6ab0a55` (app); the service
  fixes were deployed to the droplet before the tag and confirmed live: a
  signed-out `text/plain` POST to `/v1/transcribe` and `/v1/corrections` now
  answers 401 (the session is checked before the body), while
  `/v1/auth/code` still answers 415.
- Electron 43.7.5 to 43.7.9.
- A local run of the release job's Windows steps passed all 25 steps:
  `npm test`, every UI step, `npm run dist`, `verify-built-app.js`, and the
  packaged startup test on a fresh and an existing profile (version 2.1.9).
- Account service CI run 37729991134 green (tests and image).

## Release run

- Run 37740987581: `release`, `mac` and `mac-release` all succeeded. The new
  step that checks the tag against package.json passed in both build jobs.

## Published release

- `gh api .../releases/latest` returns `v2.1.9` with 6 assets:
  `Voxden-Setup-2.1.9.exe` (547,128,981 bytes) and its blockmap,
  `Voxden-2.1.9-mac-arm64.dmg` (508,885,277), `.zip` (514,428,308),
  `latest.yml`, `latest-mac.yml`.
- Both feeds served from `releases/latest/download/` say `version: 2.1.9`,
  and their sizes match the uploaded files.
- The installer download through `releases/latest/download/` answers 200
  with the full length.
- The release body is `release-notes/current.md` without its Version and
  Released lines.

## Not verified

- The installer's sha512 against a local download.
- The 2.1.8 to 2.1.9 auto-update on a real install.
- Any Mac behaviour on a real Mac (Gatekeeper, microphone, paste, hotkey,
  whether key-state polling needs Input Monitoring).
