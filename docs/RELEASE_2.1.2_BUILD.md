# Voxden 2.1.2 build procedure

The current branch targets version **2.1.2**. Build identifiers are no longer shown or packaged; the version alone names a build. It is a one-fix release: the flow bar keeps taking clicks and drags after the display sleeps, after another window covers it, and after Windows minimizes and restores it. The cause and evidence are in [the flow bar investigation](FLOW_BAR_2.1.1_FIX.md) under "clicks and drags lost after occlusion".

Only the development branch is intended to be pushed. Building with `npm.cmd run dist` disables publishing. These steps do not create a Git tag or public GitHub release. Keep `demo-video/` outside the app commit.

The notification bell and `release-notes/current.md` describe one change, with the same words in both: The flow bar stays clickable. The 2.1.1 highlights keep their ids, so a user who cleared them does not see them again.

## Build and verify

Run in PowerShell from the repository root with dependencies and the verified `dist-runtime-v3` runtime bundle available. Each command must finish successfully before its result is treated as verified.

```powershell
npm.cmd run dist
node scripts/verify-built-app.js dist
$env:VOXDEN_BUILD_OUTPUT = 'dist'
npm.cmd test
Remove-Item Env:\VOXDEN_BUILD_OUTPUT
npm.cmd run test:packaged-startup -- --resources=dist/win-unpacked/resources
npm.cmd run test:flow-bar-input
```

`verify-built-app.js` compares packaged source files, the Python sidecar and native helper resources with the checkout, checks the version and bundled runtime hash, then writes `verification.json` in the output directory. `VOXDEN_BUILD_OUTPUT` selects this build for packaged-content unit checks. The packaged startup test loads the built `app.asar` in an isolated temporary profile with updates, login registration and global shortcuts stubbed. `test:flow-bar-input` runs the real main process with genuine OS mouse clicks after an external cover, a hide/show and a minimize/restore; it needs a desktop and moves the cursor for a few seconds.

Every build goes to `dist/` and replaces what was there; the installer path is `dist/Voxden-Setup-2.1.2.exe`. Older builds are deleted rather than kept in side folders.

## Completed local build — 2026-09-10

Built with publishing disabled into `dist/` from the working tree on top of app-source commit `ff946b8` (the 2.1.1 verification commit) plus the uncommitted 2.1.2 changes: the flow bar input fix in `src/main.js`, the 2.1.2 highlight in `src/announcements.js`, the rewritten release notes, the version bump, removal of the build identifier from the app and its tests, and the new tests. Strict verification compares every packaged file with the checkout byte for byte, so committing those same files afterwards does not alter the packaged app. All earlier installers and side folders under `dist/` were deleted.

- Installer: `dist/Voxden-Setup-2.1.2.exe`
- Installer size: **528,867,824 bytes**.
- Installer SHA-256: `e03bae42ad7791b1b1c90bd47a7228ea82136fd18aac8277011b8976df4edf8e`.
- `app.asar` SHA-256: `ddce8587edc1ba2b71ebe17e9929f2bb69ef5c228a07b3f6b9ff121795671c01`.
- Strict verification passed for all **68 source files**, **five sidecar files**, native helpers and the bundled `asr-win-x64-v3` runtime. Version 2.1.2 matches the checkout; the report lists exactly one release highlight.
- The full `npm test` suite passed with `VOXDEN_BUILD_OUTPUT=dist` (`dist/unit-tests.log`). One source-shape check in `scripts/test-flow-bar.js` was rewritten first: it pinned the old "nudge only after our own show" layout and now pins the new contract (nudge after every show and on pointer entry, upward, never under a held grip, occlusion tracking off).
- Startup from the built `app.asar` passed in an isolated profile, reporting version 2.1.2 and one release highlight without renderer exceptions. The App version panel shows only the version and update status.
- `latest.yml` matches the installer size and SHA-512 and carries the same release-note bullet, emoji intact, as the source.
- `npm run test:flow-bar-input` passed against the same `src/main.js` the installer packages; it sends real OS clicks after an external cover, a hide/show and a minimize/restore. A switch-only variant of the fix fails it, so the check covers the rearm half. The flow bar regression, System settings and release-safety suites also passed before the bump.

These checks do not establish behavior on every user's GPU or multi-monitor configuration. The per-transition evidence behind the fix is recorded in [the flow bar investigation](FLOW_BAR_2.1.1_FIX.md).
