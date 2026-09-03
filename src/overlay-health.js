'use strict';

// Whether the flow bar's page is still answering, decided in the main process.
//
// The window can be visible, on top and in the right place while the page
// inside it has stopped running -- a renderer that crashed, or one whose
// event loop is wedged. Nothing in Electron reports the second case quickly,
// and the visibility check that rescues a hidden bar cannot see either. So
// main sends the page a numbered ping on a slow clock and this module keeps
// the score: a page that has not answered several in a row is frozen.
//
// Pure bookkeeping. It never touches a window, so it can be tested with a
// fake clock, and main decides what to do with the verdict.

// A miss is a ping unanswered for this long. Generous on purpose: the page is
// allowed to be busy for a moment (a transcript landing, a morph) without the
// bar being torn down under it.
const DEFAULT_TIMEOUT_MS = 4000;
// Misses in a row before the page is called frozen.
const DEFAULT_MISSES = 3;

function createHealthMonitor(options) {
  const opts = options || {};
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const misses = Math.max(1, Number(opts.misses) || DEFAULT_MISSES);

  let seq = 0;
  // The ping still waiting for an answer, if any.
  let pending = null;
  let missed = 0;
  // -1 is "never": a clock that starts at zero is a real time here.
  let lastAnswerAt = -1;
  let lastSentAt = -1;

  // Called when main is about to send a ping. Returns the sequence number to
  // send, or null when the last one is still within its time -- at most one
  // ping is in flight, so a busy page is asked once, not flooded.
  function send(now) {
    if (pending && now - pending.at < timeoutMs) return null;
    if (pending) missed += 1;
    seq += 1;
    pending = { seq, at: now };
    lastSentAt = now;
    return seq;
  }

  // The page answered. Only the ping that is waiting counts; a late answer to
  // an older one is a page that is slow, not one that is back.
  function answer(n, now) {
    if (!pending || pending.seq !== n) return false;
    pending = null;
    missed = 0;
    lastAnswerAt = now;
    return true;
  }

  // The verdict as of `now`. A ping that has just gone out is 'waiting'; one
  // that has run past its time counts as a miss here as well as in send(), so
  // the verdict does not have to wait for the next ping to change.
  function check(now) {
    let count = missed;
    if (pending && now - pending.at >= timeoutMs) count += 1;
    return {
      status: count >= misses ? 'frozen' : (pending ? 'waiting' : 'ok'),
      missed: count,
      sinceAnswer: lastAnswerAt >= 0 ? now - lastAnswerAt : null,
      sinceSent: lastSentAt >= 0 ? now - lastSentAt : null,
    };
  }

  // Forget everything in flight. After a sleep, or after main itself stalled,
  // an unanswered ping says nothing about the page.
  function reset() {
    pending = null;
    missed = 0;
  }

  return { send, answer, check, reset };
}

// How late a repeating timer fired. A setInterval that was due every
// `intervalMs` and last ran at `lastAt` should run again by `lastAt +
// intervalMs`; anything past that is time the main thread was not turning
// its loop -- or time the machine was asleep, which the caller tells apart
// from the power events it also sees. Returns 0 for the first tick and for a
// tick that is on time.
function timerLateness(intervalMs, lastAt, now) {
  if (!lastAt) return 0;
  const late = now - lastAt - intervalMs;
  return late > 0 ? late : 0;
}

module.exports = {
  createHealthMonitor,
  timerLateness,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MISSES,
};
