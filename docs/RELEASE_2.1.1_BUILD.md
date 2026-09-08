# Voxden 2.1.1 build procedure

The current branch targets version **2.1.1**, build **`flowbar-polish-perf-1`**. It combines flow bar reliability and motion settings, polished controls, System settings fixes and performance improvements. The reproducible procedure and completed local build verification are recorded below.

Only the development branch is intended to be pushed. Building with `npm.cmd run dist` disables publishing. These steps do not create a Git tag or public GitHub release. Keep `demo-video/` outside the app commit.

The notification bell and `release-notes/current.md` describe five major changes: Lightweight Auto cleanup; Polished flow bar controls; More reliable recording and settings; Choose how the flow bar animates; and Less background work. Notification IDs remain stable so previously delivered highlights do not reappear after dismissal.

## Build and verify

Run in PowerShell from the repository root with dependencies and the verified `dist-runtime-v3` runtime bundle available. Each command must finish successfully before its result is treated as verified.

```powershell
npm.cmd run dist -- --config.directories.output=dist/2.1.1-flowbar-polish-performance
node scripts/verify-built-app.js dist/2.1.1-flowbar-polish-performance
$env:VOXDEN_BUILD_OUTPUT = 'dist/2.1.1-flowbar-polish-performance'
npm.cmd test
Remove-Item Env:\VOXDEN_BUILD_OUTPUT
npm.cmd run test:packaged-startup -- --resources=dist/2.1.1-flowbar-polish-performance/win-unpacked/resources
```

`verify-built-app.js` compares packaged source files, the Python sidecar and native helper resources with the checkout, checks the version/build identifier and bundled runtime hash, then writes `verification.json` in the output directory. That report records the installer size, SHA-256, archive SHA-256 and release highlights. `VOXDEN_BUILD_OUTPUT` selects this build for packaged-content unit checks. The final startup test loads the built `app.asar` and external resources in an isolated temporary profile with updates, login registration and global shortcuts stubbed.

The installer path is `dist/2.1.1-flowbar-polish-performance/Voxden-Setup-2.1.1.exe`. Keep the earlier `dist/flowbar-fix/` artifact's size and hash in [the historical recovery report](FLOW_BAR_2.1.1_FIX.md); they do not identify this rebuild.

## Completed local build — 2026-09-08

The installer was built from app-source commit `17d0acbbb6869be3334457cc8277a2f6ad1c2579` with publishing disabled. The subsequent tray-test correction and this verification record do not alter the packaged app.

- Installer size: **528,866,930 bytes**.
- Installer SHA-256: `9b39461111b052019dfe12fd35fa37a8e4fc4ab4ebf5d5f773de13ab620cb5c3`.
- `app.asar` SHA-256: `180504f709c27e114ced164524d8079e7e732566dc7ae3e9feaa3e40b6a4ead3`.
- Strict verification passed for all **68 source files**, **five sidecar files**, native helpers and the bundled `asr-win-x64-v3` runtime. Version and build identifier match the checkout.
- The full `npm test` suite passed with `VOXDEN_BUILD_OUTPUT` set to this output directory. The aggregate performance suite also passed.
- Startup from the actual built `app.asar` passed in an isolated profile, reporting version 2.1.1, build `flowbar-polish-perf-1` and exactly five release highlights without renderer exceptions.
- `latest.yml` matches the installer size and SHA-512 and contains the same five release-note bullets as the source.

The output directory retains `verification.json` and `unit-tests.log`. These checks do not establish performance on every user's GPU or multi-monitor configuration; the scope of the performance measurements remains documented in [the performance audit](PERFORMANCE_2.1.1_AUDIT.md).
