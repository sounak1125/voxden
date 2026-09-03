## Voxden 1.0.19

Simpler settings, saved recordings, and smoother startup. This update includes all improvements since 1.0.18.

- **Recordings in your history.** Each dictation keeps its recording for 14 days, up to 500 MB, on this PC. Open its ⋯ menu to play the recording, save it as a WAV, retry the transcript, or delete it. History menus stay visible without clipping or flickering.
- **WAV exports are easy to find.** Exported files use the time you save them, so they appear among the newest files in Downloads or your chosen folder.
- **Clear saved recordings.** Settings → Data and privacy now has a Delete button beside Keep recordings. It clears saved dictation audio while preserving transcripts, exported WAVs, and separately retained training clips.
- **A simpler General page.** Your name, shortcuts, dictation mode and speed, microphone, dictation language, and app language are together. Choose Shortcuts → Change to edit either shortcut in its own dialog.
- **Speech engines have their own category.** Engine and processor choices, acceleration, downloads, optional models, and the tuned-model toggle are grouped under Speech engines. Tray shortcuts, notifications, and setup links open the relevant settings. Existing preferences, downloads, and model files are preserved.
- **Smoother startup and engine loading.** The flow bar no longer installs the mouse hook that caused pointer stutter. Engine loading waits for a pause in your input and uses low-priority disk reads, without spinning idle worker threads. Dictation starts loading immediately when requested; the Parakeet fast engine loads when first needed.
- **Clearer engine setup.** Acceleration cards appear under the engine they support. Removing models cleans up their files and duplicate copies left by earlier setup.
- **Updates under the bell.** Download progress appears in the notifications panel, followed by Restart now when the update is ready. Restarting or quitting installs a waiting update silently.
- **Less to download and manage.** Local sentence correction, its language packs, and the related rewrite and context controls have been removed. Built-in cleanup still handles fillers, false starts, and punctuation; old correction packs are removed on the next launch.
