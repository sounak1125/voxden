# Voxden

Tiny dictation overlay for Windows. Press Ctrl+Shift+Space to pop it up; it hides when you are done. Transcripts paste into the previously focused app.

No accounts, no telemetry, no API keys.

## Run

From this folder:

    npm start

Uses the system Node install. The default local engine is Python faster-whisper with Whisper large-v3. It uses CUDA float16 when available and CPU int8 otherwise. Web Speech is the final fallback.

### Transcription engines

Settings → General can switch between three local engines. Switching restarts the sidecar and releases the previous model before loading the next one.

- **Whisper large-v3** — installed through `faster-whisper`; the mature default and automatic fallback.
- **Qwen3-ASR 1.7B** — stronger accented and multilingual recognition through the official `qwen-asr` Transformers backend.
- **Parakeet TDT 0.6B v2** — lightweight English model (~0.6 GB). Select it to skip Whisper and Qwen. When Whisper or Qwen is selected, Dictation speed Fast (and Auto in chat apps such as Slack, Discord, WhatsApp) still uses Parakeet for lower latency and skips sentence correction. If Parakeet is missing, Fast uses the selected engine with a cheaper decode.

Qwen3-ASR and Parakeet are optional because their runtimes and model downloads are large. Install a CUDA-enabled PyTorch build and the optional dependencies before selecting Qwen or Parakeet:

```powershell
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r sidecar/requirements-asr.txt
pip install onnxruntime-gpu
```

Install `onnxruntime` instead of `onnxruntime-gpu` for CPU-only Parakeet. Do not install both. Their model weights download on first use into Voxden's persistent model directory. If an optional dependency or model cannot load, Voxden reports the reason and runs Whisper instead. Set the transcription processor to **CPU only** to avoid VRAM use; Qwen3-ASR will be slower there. `VOXDEN_PYTHON` can point Voxden at an isolated Python environment, and `VOXDEN_DEVICE=cpu|cuda|auto` still overrides the UI selection.

## Dictate

Hold Ctrl+Shift+Space. The pill pops in from the bottom. Press the shortcut again to transcribe and paste (Toggle, the default). In Settings you can switch to Push to talk: hold the shortcut and release to finish. Escape cancels without pasting.

## History

Open Voxden from the tray (Open Voxden), double-click the tray icon, or the small chevron on the overlay. Click a row to copy. Click the transcript text to edit it.

## Corrections

Edits in history teach a local dictionary (data/dictionary.json). Future transcripts apply those replacements before paste (case-insensitive, longest phrase first). Learned phrases are listed at the bottom of the window; delete one with x. Dictionary terms are also passed to Whisper as `initial_prompt` when that backend is running; all engines still receive the same post-transcription dictionary corrections.

Formal writing removes only unambiguous vocal fillers and punctuation-delimited asides. Ambiguous phrases such as "you know", "like", and "kind of" are preserved when they may carry meaning, so sentences such as "Do you know the answer?" and "I like this design" are never damaged by the deterministic fallback.

## Local sentence correction

For context-aware filler removal and grammar repair, open **Writing style** and download either the **Standard** pack (faster, 1.4 GB) or the **Enhanced** pack (better quality, 2.5 GB). Voxden downloads the pack once from its dedicated GitHub Release, verifies it with SHA-256, and stores it under the app's persistent user-data directory. App updates reuse that installation instead of downloading it again.

Voxden manages and starts the `llama.cpp` runtime from the same verified language-pack release, listening only on loopback. Users do not install Ollama, create an API key, or pay a per-use subscription. The local model is told to preserve meaning, names, numbers, URLs, email addresses, dictionary terms, negations, and the selected tone. Voxden validates those invariants and rejects unsafe rewrites. A failed, unavailable, invalid, or slow model automatically falls back to the deterministic cleanup instead of blocking dictation.

Maintainer instructions for preparing the immutable GitHub Release assets are in [docs/LANGUAGE_PACK_RELEASE.md](docs/LANGUAGE_PACK_RELEASE.md).

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

## Commands

new line, new paragraph, period, comma, question mark, scratch that.

Quit from the tray.
