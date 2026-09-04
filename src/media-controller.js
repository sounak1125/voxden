'use strict';

// Own only sessions we successfully paused. Serialize Windows requests so a
// previous dictation's slow resume cannot overtake the next dictation's pause.
function createMediaController({ pause, resume, onError = () => {} }) {
  const owned = new Set();
  let queue = Promise.resolve();
  let active = false;
  let generation = 0;
  let closed = false;
  let closing = null;

  function enqueue(operation) {
    queue = queue.then(operation).catch(onError);
    return queue;
  }

  async function restore() {
    if (!owned.size) return;
    const ids = [...owned];
    // Do not keep retrying play commands after a failed restore. The user may
    // subsequently pause or stop the player themselves.
    owned.clear();
    await resume(ids);
  }

  function begin(enabled = true, preparation = null) {
    if (closed) return closing || queue;
    active = true;
    const token = ++generation;
    return enqueue(async () => {
      if (closed || !active || token !== generation || !enabled) return;
      if (preparation) await preparation;
      // Preparation is deliberately cancellable. The start cue may still be
      // playing when Escape arrives; its expired timer must not mute audio.
      if (closed || !active || token !== generation) return;
      const ids = await pause();
      for (const id of ids || []) {
        if (typeof id === 'string' && id && id !== '__toggle__') owned.add(id);
      }
    });
  }

  function end() {
    if (closed) return closing || queue;
    active = false;
    const token = ++generation;
    return enqueue(async () => {
      // A new dictation takes ownership of a still-pending pause. Its own end
      // will restore the player; this old end must not play anything.
      if (active || token !== generation) return;
      await restore();
    });
  }

  function close() {
    if (closing) return closing;
    closed = true;
    active = false;
    generation += 1;
    // Wait for an in-flight pause before restoring, even when quitting while
    // the microphone is still preparing.
    closing = enqueue(restore);
    return closing;
  }

  return { begin, end, close };
}

module.exports = { createMediaController };
