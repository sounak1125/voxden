# Voxden 2.1.2 rebuild

Version **2.1.2** includes automatic cleanup of older dictation history and the existing flow bar input fix. Cleanup keeps the latest 1,000 complete transcripts and preserves compact analytics facts so lifetime totals and every Insights view remain unchanged. Dictionary entries, automatic learning and saved training data are preserved. Existing history migrates on startup; subsequent saves enforce the same limit.

The notification bell adds **Lighter dictation history** with the same wording as `release-notes/current.md`. User-facing copy does not disclose the numeric limit. The existing flow bar notification keeps its original id. Tests confirm that an existing 2.1.2 profile receives the new notice once without restoring cleared notices.

The version remains 2.1.2 as requested. The updater does not automatically select another build with the same version, so users already on 2.1.2 must manually install this rebuilt installer to receive the change and its notification. Building does not publish or distribute it.

## Build and verification procedure

Run the complete application regression matrix and the isolated training fixtures before packaging. The completed matrix and individual logs are included with this build in `dist/test-results/`.

Build into a temporary candidate directory using `npm.cmd run dist -- --config.directories.output=<candidate>`. This runs the speech bundle check, generates the installer artwork from existing assets, and invokes electron-builder with `--publish never`. Verify the candidate before replacing the previous `dist/` output:

```powershell
node scripts/verify-built-app.js <candidate>
$env:VOXDEN_BUILD_OUTPUT = '<candidate>'
$env:VOXDEN_PYTHON = (Resolve-Path dist-runtime-v3/runtime/python.exe).Path
npm.cmd test
Remove-Item Env:\VOXDEN_BUILD_OUTPUT
npm.cmd run test:packaged-startup -- --resources=<candidate>/win-unpacked/resources
npm.cmd run test:packaged-startup -- --resources=<candidate>/win-unpacked/resources --existing-profile
```

Strict verification compares all packaged source files, the Python sidecar and native helper resources against the checkout, checks the version and bundled runtime hash, and writes `verification.json`. Startup tests use isolated temporary profiles with updates, login registration and global shortcuts stubbed. The existing-profile case exercises real startup migration and IPC, including full Insights equivalence, lifetime totals, dictionary preservation and same-version announcement delivery.

Also check `latest.yml` against the installer size and SHA-512, compare its release notes to the source, and compare the installer payload with `win-unpacked`. Replace the old output only after the candidate passes. No existing user profile is installed over or cleared during these checks.

## Completed local rebuild — 2026-09-10

- Installer: `dist/Voxden-Setup-2.1.2.exe`.
- Installer size: **528,874,173 bytes**.
- Installer SHA-256: `4074622d7c83f2a6bf2b549acf4c2aaa009b25b9b9471a9a1d48300f4a9cb7bf`.
- `app.asar` SHA-256: `c23a3e50807155dd1416dd019c806a54424f5319996331e7f255a403afcbe6be`.
- All **97 distinct application JavaScript test entrypoints** passed before the build: 71 Node suites and 26 Electron suites. The 82-file tested source snapshot matched the checkout before packaging.
- **67 training fixture tests** passed: 38 recorder tests and 29 pipeline tests. The application suite also ran the bundled Python Qwen probes and sidecar performance tests.
- Strict package verification passed for **70 source files**, **five sidecar files**, native helpers and the bundled `asr-win-x64-v3` speech runtime. Both intended 2.1.2 release highlights are packaged.
- The full `npm test` suite passed again with the candidate selected for packaged-content checks.
- Fresh-profile and existing-profile startup from the built `app.asar` passed without renderer exceptions. The migration fixture retained 1,000 transcripts and archived five analytics facts while preserving all 1,005 dictations, 5,025 words, every Insight and the learned dictionary.
- `latest.yml` matches the installer version, filename, size and SHA-512; release notes match the source exactly.
- Extracting the installer without executing it verified that all **90 payload files** match `win-unpacked` by SHA-256. All **12 packaged assets** and the package metadata match source.
- The verified candidate replaced the previous `dist/` output. The old build was sent to the Windows Recycle Bin after final verification; no previous build folder remains in the workspace. Reports and test logs are in `dist/test-results/`, with final output reports in `dist/`.

Two test harness issues found in the first run were corrected before packaging: the General settings expectation now includes the existing Auto-add to dictionary setting, and the waveform test waits for Chromium to apply reduced-motion emulation. Their final runs passed; first-attempt logs are retained for transparency.

Retention regression tests cover migration, new dictations, edits/retries, restarts, backup failures and recovery, unchanged learning/training files, and recording cleanup boundaries. Compact JSON and immutable analytics caches avoid repeated archive validation; explicit audio opt-out remains effective when backup cleanup is pending.

The completed tests do not cover every physical GPU or monitor configuration. Optional full-model download/transcription smoke tests, real CUDA/ROCm model runs, and the three PEFT/model contract tests were not run; the bundled test runtime lacks PEFT. The 67 training fixtures use isolated test doubles. Build logs and machine-readable verification reports accompany the installer. No Git tag or public release was created.

## Publication preparation

The release upload set is `dist/Voxden-Setup-2.1.2.exe`, its `.blockmap`, and `dist/latest.yml`. Use `release-notes/current.md` as the release body. The installer hash above identifies the verified build; build output and local test logs remain outside Git.

On 2026-09-10, the remote annotated tag `v2.1.2` already resolved to the previous source commit `b644f0c365ab424886cc511d4977d9e18fb71043`. GitHub returned no release for that tag. Before publishing this rebuild, the existing tag must be deliberately updated to the commit containing these changes; pushing `main` alone does not change it. This preparation does not rewrite the tag or publish a release.
