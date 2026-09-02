## Voxden 1.0.18

Push to talk learns to tap, removing a model now really removes it, and a fix for the dictation shortcut.

- 👆 Tap the push-to-talk shortcut and Voxden keeps listening until you press it again. Holding it works as before. A hold too short to carry a word now says so, instead of "No speech".
- 🖼️ Screen marks are gone for now. Any mouse drag while recording used to attach a screenshot of the screen to the transcript, which surprised people who had never asked for one. Old thumbnails are no longer shown.
- 🟢 The flow bar can be dragged again after turning "Show flow bar at all times" off and on. It used to need a restart.
- ⌨️ Changing the dictation shortcut no longer answers the next press with "No speech". The keys you held to pick the new chord were being read as a dictation of nothing.
- 🧹 Removing a model, engine or GPU pack now takes it off the disk cleanly. Every installed model in Settings has its own Remove button, the speech process is stopped before its files go so nothing is left half-deleted or hanging, and the duplicate copies that earlier versions left behind in the cache are cleaned up on the first launch.
