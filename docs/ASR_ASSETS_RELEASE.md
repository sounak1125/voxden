# Speech distribution and setup

The Windows installer now contains the complete speech runtime. A separate runtime release is no longer required for a packaged build. Whisper weights still use the existing `asr-model-v1` GitHub release. Qwen and Parakeet download from pinned Hugging Face revisions with per-file SHA-256 digests checked into `src/speech-model-catalog.json`.

## Build the runtime and app

On Windows x64 with Python 3.12 and the VC++ redistributable available on the build machine:

```powershell
npm run prepare:asr-runtime
npm test
npm run test:speech-ui
npm run test:media-ui
npm run test:packaged-startup
npm run dist
```

`dist-runtime-v3/` contains the runtime zip, manifest, and an unpacked copy for integration tests. The app bundles only the zip and manifest. Packaging fails if any of the three backends is absent from the manifest or the archive digest is wrong.

The tag-triggered GitHub Actions release workflow prepares this runtime on the Windows runner and runs the app, speech setup, media UI, flow bar, and packaged-startup checks before publishing. Runtime archives and model weights are build/download artifacts, not Git source files. Standalone ASR training experiments are not part of the desktop build.

The runtime uses Python 3.12.10, faster-whisper 1.2.1, onnx-asr 0.12.0, qwen-asr 0.0.6 (including its required Transformers version), CPU PyTorch 2.11.0, and ONNX Runtime DirectML. All dependency installation happens on the build machine. There is no pip installation on an end user's PC. The builder probes the engines and imports the real APIs with the isolated interpreter, then runs the sidecar self-test. Wheel metadata and license files remain in the archive.

CPU PyTorch is the stable foundation: Qwen3-ASR 1.7B runs as CPU Qwen with no extra download. Optional **Qwen CUDA acceleration** and **Qwen ROCm acceleration** are separate GitHub prereleases (`qwen-cuda-pack-v1`, `qwen-rocm-pack-v1`). They are isolated Python+PyTorch trees. They are never copied into the CPU runtime and they are not `extraResources` in the main installer. The Whisper cuBLAS pack (`cuda-pack-v1`) still accelerates faster-whisper only. DirectML still accelerates Parakeet only. Native Windows ROCm PyTorch covers only the GPUs on [AMD’s PyTorch on Windows Edition 7.2.1 notes](https://www.amd.com/en/resources/support-articles/release-notes/RN-AMDGPU-WINDOWS-PYTORCH-7-2-1.html). Unsupported AMD and Intel stay on CPU Qwen.

```powershell
npm run prepare:qwen-cuda-pack
npm run prepare:qwen-rocm-pack
```

GitHub refuses a single file over 2 GiB, so each pack is published as `*.zip.partNN` pieces plus `voxden-qwen-*-pack.json`. The app concatenates the parts and checks the SHA-256 of the assembled zip before extracting. Upload every part file and the JSON from `dist-qwen-cuda-pack/` and `dist-qwen-rocm-pack/` after the hashes in `src/qwen-accel-catalog.json` match. Keep those tags as prereleases so they do not replace the desktop app in GitHub’s latest-release API. Do not attach the GPU zips to the main installer.

## Compact GPU downloads

The compact builder repackages an existing pinned GPU ZIP with lossless 7z compression. It preserves every runtime file and the exact Qwen, Python, PyTorch and dependency versions. It does not download, quantize or modify model weights, run pip, or prune optional packages. The installed GPU runtime remains an independent, complete Python environment.

```powershell
node scripts/prepare-qwen-compact.js --kind cuda --level 3
npm run test:qwen-compact
node scripts/smoke-qwen-compact.js
```

The builder requires the original GPU ZIP and manifest in `dist-qwen-cuda-pack/`, plus the CPU ZIP and manifest in `dist-runtime-v3/`. It checks the original hashes before repackaging. Each original file is recorded with its size and SHA-256 in `voxden-pack-files.json`. Core and shared archives are then extracted and every reconstructed file is checked against that inventory. `compact-report.json` is written only after verification succeeds. The opt-in smoke test requires a built app, local Qwen weights and a supported GPU; it installs into a new `temp/` profile using local assets and runs the packaged sidecar with offline settings and a restricted PATH. It never uses pip or modifies user profiles.

The CUDA artifact measured on September 5, 2026 contains all 33,463 original files:

| Download | Bytes | Decimal GB |
| --- | ---: | ---: |
| Original ZIP | 3,094,557,586 | 3.095 |
| Compact core, when CPU files match | 1,881,694,951 | 1.882 |
| Shared fallback | 219,716,400 | 0.220 |
| Complete compact download | 2,101,411,351 | 2.101 |

That saves 39.2% of the GPU download with matching CPU files, or 32.1% without them. Installed GPU files still occupy 5,338,681,856 bytes before generated caches; this reduces transfer size, not installed size. Qwen's existing approximately 4.703 GB of model files is unchanged, so model plus GPU downloads are approximately 6.59–6.80 GB, excluding the app installer. The original full GPU archive remains a compatibility fallback.

During installation the app downloads the core and copies only hash-matching shared files from its managed CPU runtime. These are ordinary independent copies, not hard links or shared import paths. If the base is absent, damaged or different, the shared archive supplies the complete original files automatically. The final tree is checked for missing, damaged or unexpected files before Python runs. The app bundles `7za.exe` and its licenses; users need no archive utility, Python installation or pip commands.

Importing PyTorch and executing a GPU tensor are required. When Qwen weights are present, real transcription of bundled synthetic speech must also pass before verification succeeds. If the model is not downloaded yet, the receipt explicitly records a pending speech check. GPU startup performs that check before reporting readiness, including for older receipts, and falls back to CPU Qwen if it fails. Retry revalidates existing installations and automatically reconstructs damaged ones. Install and removal share the speech-operation lock and stop the sidecar before changing runtime files.

Retry checks an installed runtime locally before contacting the release server, so a working installation can be revalidated while offline. A repair download requires a connection. The measured CUDA smoke test used the packaged extractor and sidecar, fetched only the 1,881,694,951-byte core from local release fixtures, successfully imported all three speech backends, and recognized the bundled sentence on an RTX 4070 and with CPU Qwen forced. All ten Qwen model files separately matched their existing pinned hashes. This is local hardware validation, not a fresh Windows VM or a test of every supported GPU driver.

### Existing-user cleanup on update

After the packaged app's normal GPU startup completes real Qwen recognition, it performs a one-time cleanup for that installed CUDA or ROCm runtime. It uses the current managed interpreter's readiness report; it does not start another Python process, contact a server, reinstall the pack, or change the model. If a user is using CPU Qwen or another engine, cleanup waits until that GPU pack is actually verified in use.

Only recognised archives/parts in that GPU pack's `downloads/` directory and obsolete `runtime.pending`/`runtime.previous` trees are candidates. Every candidate must predate the successful installation, including creation/change timestamps because extraction can preserve old modification dates. A partial file, range map, newer file, unknown download, symlink/junction or pending repair journal keeps the group intact. Invalid receipts, missing models and failed GPU checks also defer cleanup. Active `runtime/`, Python/PyTorch dependencies, model weights, history and preferences are outside the cleanup targets. No user Downloads folder is scanned.

`legacy-cleanup-v1.json` records completion, removed file count and bytes for that installation. A failure or cancellation leaves no success marker and can retry after a later verified startup. User install/remove actions cancel maintenance and wait for an in-flight deletion before proceeding; they are never discarded. Future repairs record `install-state.json` before downloading and keep a pending journal after interruption. Revalidation preserves the original installation timestamp, so retrying a working old runtime cannot make a newer unfinished repair look obsolete. Disk savings depend on existing leftovers and can be zero; the active runtime's installed size remains unchanged.

`node scripts/test-qwen-cleanup.js` covers old installations, one-time completion, runtime/data preservation, partial and newer downloads, failed repair journals, links, locked files, cancellation and main-process coordination.

### Publishing the compact assets

The generated manifest retains all existing `pack.asset`, `pack.parts`, sizes and hashes, adding only `pack.optimized`. Keep the existing ZIP parts available for old app versions. Upload every file named in `pack.optimized.core.parts` and `pack.optimized.shared.parts`, then replace the manifest last. For the measured CUDA build this means the two `*-core.7z.partNN` files and the single `*-shared.7z` file. Do not upload `compact-work/`, the unsplit core, or the report as required runtime assets. Keep the pack release a prerelease. No publishing is performed by the compact builder or smoke test.

New clients use compact assets only when the extractor and all declared release parts are available. A partially uploaded compact release or a release with only the legacy format continues to use the original ZIP. The acceleration card checks the release listing and manifest to display the size of the available format. While checking or offline it omits the number instead of advertising a stale catalog estimate. Results are cached for five minutes, with a 30-second retry delay after failure. For compact CUDA it shows **1.88–2.10 GB** when a CPU runtime is present (reuse is verified during installation), or **2.10 GB** without one. Active download progress uses the actual component size.

The measured CUDA core parts, shared fallback and additive manifest were published to `qwen-cuda-pack-v1` on September 5, 2026. GitHub's sizes and SHA-256 digests matched the local verified artifacts. Anonymous public manifest retrieval, compact selection and ranged downloads from all three asset URLs were checked after publishing. Both original ZIP parts remain available for older clients.

### ROCm validation finding

The current pinned ROCm ZIP cannot be reproduced through the Windows filesystem: it contains names such as `Lib/site-packages/torch/lib/aotriton.images/amd-gfx120x/flash/debug_simulate_encoded_softmax/FONLY__*bf16@16___gfx120x.aks2`. The `*` is not a valid Win32 filename. This was present in the input archive, before compacting. The builder now checks paths up front and refuses to rename or drop files silently. No compact ROCm manifest was produced or published. Rebuild and validate that original pack on supported AMD hardware before using `--kind rocm`; the generic compact installer is covered by ROCm fixture tests, but these do not certify the real ROCm artifact or AMD GPU execution.

## Refresh model assets

`npm run prepare:speech-catalog` resolves and pins Qwen/Parakeet model revisions, byte sizes, and SHA-256 hashes. Review the generated JSON before shipping it. No remote model code is executed. Existing receipts remain usable across app updates when the pinned revision is unchanged.

Whisper release preparation remains:

```powershell
node scripts/prepare-asr-model.js --python dist-runtime-v3/runtime/python.exe
```

Upload all files from `dist-model/` to the `asr-model-v1` prerelease only after validating the artifacts. Keep asset releases as prereleases so they do not replace the desktop app in GitHub's latest-release API.

## End-to-end verification

`npm run test:speech-install` installs real assets into `temp/speech-smoke/`, reuses matching existing Voxden caches, and downloads missing files. **It can download up to 11 GB.** It transcribes a public speech sample through each actual backend using the bundled interpreter, an empty Hub cache, offline mode, and a restricted PATH. It fails if any requested engine silently falls back to Whisper. This is an isolated runtime test, not a substitute for testing a fresh Windows VM and multiple GPU drivers.

The standard tests cover duplicate clicks, cancellation between setup stages, removal during pending startup, restart suppression, interrupted setup recovery, model corruption, corrupt segmented downloads, and reinstall. The Electron renderer test refreshes the real page 200 times before clicking the setup controls. The packaged-startup test exercises the real main process with an empty user-data directory and no managed Python.

## Lifecycle guarantees

One main-process operation owns install/remove at a time. Cancel applies to the whole setup, including boundaries between runtime and models. Removed state is persisted before deleting files. Probes, the sidecar, and the screen-mark process stop before Windows file removal; queued restart timers are cleared. Removal keeps user history, preferences, training audio, and older caches intact, but none of those caches can reactivate dictation without setup.

Downloads are verified before receipts commit. Partial files are retained for Resume. The bundled runtime is verified and unpacked locally; startup and engine switching run offline. All three engines stay visible in the picker, and the user's selection survives removal and reinstall.
