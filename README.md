# Voxden

Tiny dictation overlay for Windows. Press Ctrl+Shift+Space to pop it up; it hides when you are done. Transcripts paste into the previously focused app.

No accounts, no telemetry, no API keys.

## Install

Download the installer from the [latest release](https://github.com/sounak1125/voxden/releases/latest) and run it. Windows 10 or 11, 64-bit.

The Windows installer includes a self-contained speech runtime with Whisper, Qwen3-ASR, Parakeet, CPU PyTorch, and DirectML. End users do not install Python, run pip, or need a Hugging Face account.

On first launch, **Set up all models** downloads up to **11 GB** once: Whisper large-v3 (~3.1 GB), Qwen3-ASR 1.7B (~4.7 GB), and Parakeet CPU/GPU weights (~0.7/2.5 GB). Existing app model caches are verified and reused where possible. Setup checks SHA-256, resumes interrupted downloads, and keeps completed models across updates.

Starting the app, switching engines, and dictation never download models in the managed runtime. Removing speech engines stops their processes and disables dictation; the window, history, and settings still work. Download again to reinstall. A normal launch opens the dashboard; launching with Windows stays in the tray.

On launch, Voxden probes the speech runtime (a cheap import check) and then loads the selected model in the background a moment later, at below-normal process priority and with its CPU threads capped to half the logical processors, so the first dictation does not wait for a multi-gigabyte load and the desktop stays responsive while it happens. The engine also runs a short silent clip through itself before reporting ready, so the first real dictation is answered at full speed. Set `VOXDEN_LAZY_ASR=1` to defer the load until the first dictation instead.

The Windows helper that reads the foreground window, pastes, and pauses music runs as a small pool of long-lived PowerShell processes. Earlier builds started a new process for every call, and each one compiled the helper before answering, which cost about a quarter of a CPU second twice a second for the life of the app and put the paste a full second behind the transcript.

## Run from source

From this folder:

    npm start

Uses the system Node install. A source checkout picks up, in order: `VOXDEN_PYTHON`, the downloaded speech engine if you installed one, `.venv/Scripts/python.exe`, then the system Python. The default engine is Qwen3-ASR 1.7B. Whisper large-v3 runs through faster-whisper, CUDA float16 where available and CPU int8 otherwise. The CPU path runs on half the logical processors, capped at 16 — CTranslate2 uses four on its own whatever the machine has, which on a 12-core part measured 1.5x realtime against 4.2x with the cores it actually had. `VOXDEN_CPU_THREADS` overrides the count.

### Transcription engines

Settings → General can switch between three local engines. Switching restarts the sidecar and releases the previous model before loading the next one.

- **Qwen3-ASR 1.7B** — the recommended default; stronger accented and multilingual recognition through the official `qwen-asr` Transformers backend.
- **Whisper large-v3** — installed through `faster-whisper`; the mature alternative with word timings and confidence scores.
- **Parakeet TDT 0.6B v2** — lightweight English model (~0.6 GB). Select it to skip Whisper and Qwen. When Whisper or Qwen is selected, Dictation speed Fast (and Auto in chat apps such as ChatGPT, Claude, Slack, Discord, WhatsApp) still uses Parakeet for lower latency and skips sentence correction. If Parakeet is missing, Fast uses the selected engine with a cheaper decode.

All three engines are supported by the bundled runtime. This build includes **CPU PyTorch**, so Qwen works without extra downloads. Optional **Qwen CUDA acceleration** (NVIDIA) and **Qwen ROCm acceleration** (only AMD GPUs on AMD’s Windows PyTorch list) are separate downloads. The Whisper cuBLAS pack does not accelerate Qwen. DirectML still accelerates Parakeet only. The processor shown in Settings reflects the backend the sidecar actually verified, not the dropdown alone.

### AMD and Intel graphics

Settings → General → **Transcription processor** offers **AMD or Intel GPU**, which runs Parakeet on ONNX Runtime's DirectML provider. DirectML targets DirectX 12 rather than a vendor, so one option covers Radeon, Intel integrated graphics and Arc.

**Auto does not pick it** — it stays CUDA-or-CPU. Nearly every PC has a DirectX 12 card, so ranking DirectML above the CPU would move most users onto a 2.5 GB download in place of a 0.7 GB one for a gain they may not have: on a 24-thread CPU the two measured 15.9x against 17.0x realtime. DirectML earns its place where the CPU is the weak part, which is a thing the person at the machine knows and `auto` does not.

Only Parakeet has that DirectML path. CTranslate2 has exactly one GPU backend and it is CUDA. **Qwen3-ASR on AMD uses CPU PyTorch unless the GPU is on AMD’s Windows ROCm PyTorch list and the separate Qwen ROCm pack is installed and verified.** That list is short: it is not every Radeon. Whisper on a Radeon stays on the CPU. Voxden says so in Settings rather than leaving it to be inferred from a device line reading "CPU". For a machine with no NVIDIA card and no listed AMD GPU, the combination that matters is Parakeet plus the CPU thread count above.

The GPU path drops quantization: DirectML gets the float32 weights (2.5 GB) rather than the int8 ones (0.7 GB), because the int8 build is a QDQ graph whose quantize/dequantize pairs cost a GPU more than they save. Measured on one DirectX 12 card, int8 on DirectML ran at 6.9x realtime against 15.9x for float32 and 17x for int8 on a 24-thread CPU — a strong CPU is a real competitor here, and the GPU is worth the most where the CPU is weakest. Each precision keeps its own directory under the model folder, so moving the setting between the CPU and a GPU does not throw the other download away.

DirectML arrived in speech engine `asr-win-x64-v2`. An older install has no DirectML provider, and Voxden says so and asks for a reinstall from Settings. On your own Python, `pip install onnxruntime-directml` instead of `onnxruntime` or `onnxruntime-gpu` — one ONNX Runtime build per environment, never two.

For development only, `VOXDEN_PYTHON` can point to a Python environment you maintain yourself, including a CUDA-enabled PyTorch environment. Packaged builds never search system Python or PATH automatically. `VOXDEN_DEVICE=cpu|cuda|directml|auto` overrides the UI setting; unsupported GPU backends fall back to CPU.

## Dictate

Hold Ctrl+Shift+Space. The pill pops in from the bottom. Press the shortcut again to transcribe and paste (Toggle, the default). In Settings you can switch to Push to talk: hold the shortcut and release to finish. Escape cancels without pasting.

**Pause music while dictating** pauses supported Windows media sessions before recording starts and resumes only music Voxden paused. Already paused music stays paused. Rapid dictations, cancellation, and errors share the same ordered pause/resume flow; unsupported or ambiguous media sessions are left alone.

## The flow bar

**Show flow bar at all times** (Settings, on by default) keeps a small glowing bar at the bottom of the screen. Hover it and it opens into a microphone with a settings button on the left and a drag handle on the right. Click the bar to dictate, the gear to open Voxden, or drag the handle to move the bar — anywhere on any monitor. Where you drop it is remembered.

The bar keeps its position across restarts. If the monitor it was on goes away, it moves to the nearest one that is still there and returns when that screen comes back. **Reset position** in Settings puts it back at the bottom of your main display. Wherever the bar sits, dictation still pastes into the window that had focus, not into the screen the bar happens to be on.

## Notifications

The bell at the right of the title bar, just left of minimise, carries what is new: a new engine, a new language model, a feature that did not exist before, and an update that has finished downloading. A count under the bell says how many you have not looked at; opening the panel clears it. Rows stay until you dismiss one with x or use **Clear all**, and an empty panel says so.

Bug fixes are deliberately not announced. A fresh install is told only what shipped in the version it installed — everything older is the app, not news — and updating tells you what landed in every version you skipped.

Announcements ship inside the app, in the catalog at the top of `src/announcements.js`. Add an entry with `since` set to the version it ships in; the id is permanent, because a dismissed id is remembered so it cannot come back.

## History

Open Voxden from the tray (Open Voxden), double-click the tray icon, or the small chevron on the overlay. Click a row to copy. Click the transcript text to edit it.

## Corrections

Edits in history teach a local dictionary (data/dictionary.json). Future transcripts apply those replacements before paste (case-insensitive, longest phrase first, in any script). Learned phrases are listed at the bottom of the window; delete one with x.

Dictionary terms are also given to the speech engine before it decodes, through whatever input that engine actually has: Whisper takes them as `initial_prompt`, Qwen3-ASR as its `context` system message. Parakeet has no such input at all, so on that engine the dictionary is applied to the transcript afterwards and Voxden says so rather than pretending otherwise. Terms are ranked by how recently they were added and used and packed into each engine's own token budget, so a word you add now is in the very next dictation even if your dictionary is far larger than any prompt window.

An "accurate" dictation keeps its dictionary. Voxden will still switch to the faster engine on a CPU when there is nothing to lose, but not when that would mean dropping the terms you taught it.

Full detail, including how any of this is measured, is in [docs/VOCABULARY_AND_ACCURACY.md](docs/VOCABULARY_AND_ACCURACY.md).

Formal writing removes only unambiguous vocal fillers and punctuation-delimited asides. Ambiguous phrases such as "you know", "like", and "kind of" are preserved when they may carry meaning, so sentences such as "Do you know the answer?" and "I like this design" are never damaged by the deterministic fallback.

## Local sentence correction

For context-aware filler removal and grammar repair, open **Writing style** and download either the **Standard** pack (faster, 1.4 GB) or the **Enhanced** pack (better quality, 2.5 GB). Voxden downloads the pack once from its dedicated GitHub Release, verifies it with SHA-256, and stores it under the app's persistent user-data directory. App updates reuse that installation instead of downloading it again.

Voxden manages and starts the `llama.cpp` runtime from the same verified language-pack release, listening only on loopback. Users do not install Ollama, create an API key, or pay a per-use subscription. The local model is told to preserve meaning, names, numbers, URLs, email addresses, dictionary terms, negations, and the selected tone. Voxden validates those invariants and rejects unsafe rewrites. A failed, unavailable, invalid, or slow model automatically falls back to the deterministic cleanup instead of blocking dictation.

Maintainer instructions for preparing the immutable GitHub Release assets are in [docs/LANGUAGE_PACK_RELEASE.md](docs/LANGUAGE_PACK_RELEASE.md), and for the speech engine and its model in [docs/ASR_ASSETS_RELEASE.md](docs/ASR_ASSETS_RELEASE.md).

## Training data

Off by default. Turn on Settings -> Data and privacy -> "Keep audio for training" and Voxden keeps the recording behind any dictation you correct, paired with your corrected text. That pair is the only ground truth this app ever gets, and it is normally deleted the moment transcription returns.

Clips you never correct age out of a small pending window. Corrected ones land in `data/audio/corpus/` with a `data/audio/pairs.jsonl` manifest. Deleting a dictation deletes its recording; turning the setting off deletes all of them. Nothing is uploaded.

To see what has accumulated:

    node scripts/export-training-data.js

Add `--write` to emit `train.jsonl` and `eval.jsonl` with absolute paths and a `sentence` key, ready for a Whisper fine-tune.

## Training on your own voice

Once enough clips have accumulated, `training/` holds a LoRA fine-tune of Whisper on them, a CTranslate2 conversion step, and an evaluation that compares the result against stock large-v3 on held-out clips. See [training/README.md](training/README.md).

A finished model lands in `models/voxden-tuned/` and the app picks it up on its own; Settings -> General gets a **Use your tuned model** toggle. `VOXDEN_MODEL` overrides both.

## Screen marks

While recording, drag the mouse over what you are talking about. Voxden captures that region, draws a circle on it, and attaches the image to the clip. Hold Alt and drag to capture a specific rectangle. The overlay flashes marked. Focus stays on the app you were pointing at. Images land in data/marks/.

## Numbers

Spoken numbers are written as figures: "one point zero point sixteen" becomes 1.0.16, "twenty five percent" becomes 25%, "twenty twenty six" becomes 2026, "the twenty fifth" becomes the 25th, and "five five five one two three four" becomes 5551234. A bare "one" to "nine" stays a word ("one of them", "two cats") unless a unit or a label makes it a figure ("five percent", "page three", "version two"), which is what style guides ask for. **Write numbers as digits** in Settings → Writing style turns this off. Verbatim mode never rewrites numbers.

## Commands

new line, new paragraph, period, comma, question mark, scratch that.

Quit from the tray.
