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

The tag-triggered GitHub Actions release workflow prepares this runtime on the Windows runner and runs the app, speech setup, media UI, and packaged-startup checks before publishing. Runtime archives and model weights are build/download artifacts, not Git source files. Standalone ASR training experiments are not part of the desktop build.

The runtime uses Python 3.12.10, faster-whisper 1.2.1, onnx-asr 0.12.0, qwen-asr 0.0.6 (including its required Transformers version), CPU PyTorch 2.11.0, and ONNX Runtime DirectML. All dependency installation happens on the build machine. There is no pip installation on an end user's PC. The builder probes the engines and imports the real APIs with the isolated interpreter, then runs the sidecar self-test. Wheel metadata and license files remain in the archive.

CPU PyTorch is intentional: Qwen runs on CPU in this distribution. An explicitly configured developer Python can still run Qwen on CUDA. Do not describe the optional CUDA pack as adding CUDA PyTorch; it accelerates Whisper only in the bundled runtime. Parakeet has DirectML for AMD, Intel, and supported DirectX 12 devices.

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
