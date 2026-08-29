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

## Screen marks

While recording, drag the mouse over what you are talking about. Voxden captures that region, draws a circle on it, and attaches the image to the clip. Hold Alt and drag to capture a specific rectangle. The overlay flashes marked. Focus stays on the app you were pointing at. Images land in data/marks/.

## Commands

new line, new paragraph, period, comma, question mark, scratch that.

Quit from the tray.
