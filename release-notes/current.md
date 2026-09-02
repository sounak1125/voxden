## Voxden 1.0.19

Opening Voxden no longer slows the PC down.

- 🚀 The speech engine now loads at the first pause in your typing and mouse use instead of the moment the window appears, and it waits half a minute after a login launch while the desktop settles. Press the dictation shortcut and it loads right away regardless.
- 🧘 While it loads, the engine runs in Windows background mode, the same low disk and memory priority as a Defender scan, so the gigabytes of libraries and weights it reads no longer stall whatever you are doing.
- ⚡ The Parakeet fast engine loads the first time a Fast English dictation needs it, instead of alongside Qwen or Whisper at start. That first Fast clip takes about a second longer. Nothing else changes.
