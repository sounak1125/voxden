## Voxden 1.0.20

Opening Voxden no longer slows the PC down, and the engine loads in seconds again.

- 🧠 The engine's worker threads no longer spin at full speed while the model loads. On a GPU they were burning most of a dozen cores doing nothing, for every start and after every dictation. That was the lag.
- 🚀 The speech engine loads at the first pause in your typing and mouse use instead of the moment the window appears, and waits half a minute after a login launch. Press the dictation shortcut and it loads right away regardless.
- 💽 While it loads, its disk reads run at low priority so they yield to whatever you are doing. 1.0.19 used Windows' background mode for this, which starved the load on a busy PC and left "Starting…" on screen for minutes. That is gone.
- ⚡ The Parakeet fast engine loads the first time a Fast English dictation needs it, instead of alongside Qwen or Whisper at start. That first Fast clip takes about a second longer.
- 📋 The engine log now records how long each start took and how much CPU it used.
