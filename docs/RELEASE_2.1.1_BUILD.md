# Voxden 2.1.1 build procedure

The current branch targets version **2.1.1**, build **`flowbar-polish-perf-1`**. It combines flow bar reliability and motion settings, polished controls, System settings fixes and performance improvements. This document records the reproducible procedure; it does not claim the build or verification has finished.

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

The expected installer path is `dist/2.1.1-flowbar-polish-performance/Voxden-Setup-2.1.1.exe`. Record completed checks and the resulting hash when verification finishes. Keep the earlier `dist/flowbar-fix/` artifact's size and hash in [the historical recovery report](FLOW_BAR_2.1.1_FIX.md); they do not identify this rebuild.
