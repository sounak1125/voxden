'use strict';

function createSidecarQueue() {
  const waiters = new Map();
  let seq = 0;

  function nextId() {
    seq += 1;
    return String(seq);
  }

  function register(id, onMessage, onError, timeoutMs) {
    const key = String(id == null || id === '' ? nextId() : id);
    const timer = setTimeout(() => {
      const waiter = waiters.get(key);
      if (!waiter) return;
      waiters.delete(key);
      waiter.onError(new Error('speech engine timeout'));
    }, Number(timeoutMs) || 60000);
    waiters.set(key, { onMessage, onError, timer });
    return key;
  }

  function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const key = msg.id == null || msg.id === '' ? '' : String(msg.id);
    if (!key || !waiters.has(key)) return false;
    const waiter = waiters.get(key);
    waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.onMessage(msg);
    return true;
  }

  function rejectAll(error) {
    const err = error instanceof Error ? error : new Error(String(error || 'sidecar exited'));
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.onError(err);
    }
    waiters.clear();
  }

  function size() {
    return waiters.size;
  }

  return { nextId, register, dispatch, rejectAll, size };
}

module.exports = { createSidecarQueue };
