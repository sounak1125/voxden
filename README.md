# Voxden

Tiny dictation overlay for Windows. Press Ctrl+Shift+Space to pop it up; it hides when you are done. Transcripts paste into the previously focused app.

No accounts, no telemetry, no API keys.

## Run

From this folder:

    npm start

Uses the system Node install. Local engine: Python faster-whisper medium (multilingual, CPU int8). Web Speech is fallback only.

## Dictate

Hold Ctrl+Shift+Space. The pill pops in from the bottom. Press the shortcut again to transcribe and paste (Toggle, the default). In Settings you can switch to Push to talk: hold the shortcut and release to finish. Escape cancels without pasting.

## History

Open Voxden from the tray (Open Voxden), double-click the tray icon, or the small chevron on the overlay. Click a row to copy. Click the transcript text to edit it.

## Corrections

Edits in history teach a local dictionary (data/dictionary.json). Future transcripts apply those replacements before paste (case-insensitive, longest phrase first). Learned phrases are listed at the bottom of the window; delete one with x. Dictionary terms are also passed to Whisper as initial_prompt when the sidecar is running.

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
