## Voxden 1.0.21

The mouse no longer stutters when Voxden opens.

- 🖱️ The flow bar used to ask Windows to forward mouse movement to it while it was click-through. On Windows that installs a system-wide low-level mouse hook inside Voxden, so every mouse move on the PC waited on Voxden whenever it was busy: about a third of a second per move during start-up, and again during any heavy moment later, such as saving a long history or loading the engine. The bar now reads the cursor position itself, which it already did, and the hook is gone. Measured: worst mouse delay during launch went from 304 ms to under 3 ms.
- 🔔 Updates now show up under the bell: a progress bar while the new version downloads, then a **Restart now** button when it is ready. Restarting installs the update silently and brings Voxden straight back. Quitting with an update waiting still installs it on the way out, also silently, instead of opening the setup wizard.
- ✂️ Local sentence correction and its language packs are gone, along with the "rewrite selected text" commands and the context awareness toggle that only fed them. The pack's prompt was already forbidden from fixing grammar, and everything else it did (fillers, false starts, punctuation) the built-in cleanup does without a 1.4 GB download or a second model process. A pack downloaded earlier is removed from this PC on the next launch.
- 🚀 Engine loading keeps the 1.0.20 changes: it waits for a pause in your input, reads the disk at low priority, and no longer spins idle threads.
