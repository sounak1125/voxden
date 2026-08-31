# Speech setup repair — 2026-08-31

Introduced in Voxden 1.0.5 and included in the 1.0.6 build alongside the music-control fixes.

## Confirmed causes

- `renderSmartRewrite()` attached the speech setup click listeners on every render. Progress updates multiplied listeners, so one click could race many installs/removals and overwrite the live state with “already downloading.”
- Setup had locks per download, but none for the complete operation. Cancellation between components could still start the next download.
- Removal restarted the sidecar and let the packaged app find system Python. That reactivated cached Qwen on the developer PC and behaved differently on other PCs.
- A pending Python probe and queued restart timers could outlive removal. Windows can also refuse to delete a running interpreter.
- Normal startup created the main window hidden. Some CSS display rules also overrode the HTML `hidden` attribute on setup controls.
- The old runtime never supplied Qwen/PyTorch. Model loading could download weights outside explicit setup.

## Result

The installer includes a verified complete runtime. One explicit setup installs all three models and both Parakeet precisions, reusing verified existing caches. Managed transcription runs offline. Removing speech engines persists a disabled state, stops Python processes, and leaves history/settings available. Qwen remains selected across removal and reinstall. In this distribution Qwen uses CPU PyTorch; it does not gain CUDA support from the separate Whisper CUDA pack.

## Verification

- The full existing test suite passes, including new lifecycle, model-integrity, and corrupt-download retry checks.
- A real Electron renderer survives 200 refreshes with exactly one install/cancel/remove action per click; hidden controls are visually hidden.
- Real packaged startup opens the dashboard with an empty user-data directory and no managed interpreter.
- Whisper, Qwen3-ASR, and Parakeet each transcribed the same public English recording using the isolated bundled interpreter, a restricted PATH, empty Hub cache, and offline loading. No requested engine silently fell back to another.
- The installed 1.0.5 app was checked through its real preload/IPC path: Settings worked, all model receipts validated, and Qwen reported ready on the managed CPU runtime even with the saved NVIDIA preference. The temporary debugging connection was removed afterward.
- Installed source files were compared byte-for-byte with this checkout. Local history and dictionary matched the pre-repair backups. The engine selection was restored to Qwen; other settings were unchanged. Training audio was not modified.

The installer is unsigned. A fresh Windows VM and a wider set of GPU drivers have not been tested here. The full model setup is up to 11 GB, plus the approximately 527 MB app installer; Qwen CPU performance depends on RAM and processor speed.

The integration-test runtime, downloaded model fixtures, and user-data backups
stay in ignored local directories and are not included in Git or the installer.
