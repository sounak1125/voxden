## Voxden 2.1.0

A more polished workspace, expressive flow bars, screenshot dictation and local dictionary learning. Includes all changes since 1.0.22.

### What's new

- **A refreshed Voxden workspace** — Dictation, Dictionary, Writing style and Insights have cleaner layouts, subtle green accents and smoother transitions. Settings has polished icons, and the home robot floats, blinks and responds to your pointer.
- **Classic, Ribbon and Orb flow bars** — Choose your flow bar in Settings. Orb reacts to your voice with energy pulses and glow, then becomes a rotating generation star while transcribing. Smoother microphone transitions and compact finish and discard controls keep the interaction calm.
- **Capture a screenshot and dictate** — Select a screen region, mark it with Circle, Arrow, Pen or Hide, and speak while annotating. Voxden pastes your words and marked screenshot into an app that accepts images. Capture never sends the message automatically.
- **Corrections can teach your dictionary** — Correct a recently dictated word in a supported Windows text field and Voxden can learn its spelling locally. The flow bar offers Undo. Auto-add to dictionary can be turned off in General settings.
- **Smaller Qwen GPU downloads** — Qwen CUDA acceleration downloads are now 1.88–2.10 GB, depending on reusable support files. The complete runtime is preserved, with no manual Python or pip setup. Verified GPU installations can also reclaim eligible leftover download files.
- **More reliable dictation and recovery** — Cancelled retries cannot paste later or overwrite newer edits. History saves have recovery copies, clipboard handling preserves newer copies, and retention settings also cover retry audio. Cleanup better preserves other languages, addresses, numbers and line breaks.
- **A properly branded Windows installer** — Setup uses the approved Voxden logo, sharp text that scales with Windows display settings, and a Made by Sounak credit on the finish page. The app title bar uses the same logo with a larger wordmark.

### More improvements

- The bell now includes the 2.1.0 highlights above, including on the first launch of this rebuilt installer if you already tried an earlier local 2.1.0 build. Read and dismissed announcements stay that way across restarts.
- Microphone startup rejects stale requests, history retains entries beyond the former 400-entry limit, and playback cancels obsolete loads.
- Failed paste and privacy-deletion operations report errors instead of silently claiming success. Failed updates offer a usable restart action again.
- Cancelled speech setup can restore the previous engine, deliberate GPU restarts avoid unnecessary CPU fallback, and long retries use the same timeout calculation as live dictation.
- Verbatim mode preserves valid sign-offs, formal style keeps ambiguous contractions, and media restoration uses only confirmed pause and mute operations.

### Qwen GPU download details

- Qwen CUDA acceleration now downloads 1.88–2.10 GB, depending on which installed support files can be reused. The Qwen model and complete Python, PyTorch and CUDA runtime are preserved. Users need no manual Python or pip installation.
- The acceleration card checks the available release to display its download size. Compression reduces the download; the installed GPU runtime remains about 5.34 GB.
- Existing GPU installations continue working. After Qwen GPU verification succeeds, Voxden automatically cleans eligible leftover archives and obsolete installation files while preserving the active runtime, models, history and settings.
- GPU setup verifies PyTorch, GPU execution and Qwen speech recognition. If the Qwen model has not been downloaded yet, speech verification finishes after model setup.

### Installation

Download **Voxden-Setup-2.1.0.exe** below. Existing 1.0.22 installations can receive this release through Voxden's updater. If you already installed an earlier local 2.1.0 build, run this installer manually: the updater only offers a higher version number.
