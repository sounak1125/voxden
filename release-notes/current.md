## Voxden 1.0.21

The mouse no longer stutters when Voxden opens.

- 🖱️ The flow bar used to ask Windows to forward mouse movement to it while it was click-through. On Windows that installs a system-wide low-level mouse hook inside Voxden, so every mouse move on the PC waited on Voxden whenever it was busy: about a third of a second per move during start-up, and again during any heavy moment later, such as saving a long history or loading the engine. The bar now reads the cursor position itself, which it already did, and the hook is gone. Measured: worst mouse delay during launch went from 304 ms to under 3 ms.
- 🚀 Engine loading keeps the 1.0.20 changes: it waits for a pause in your input, reads the disk at low priority, and no longer spins idle threads.
