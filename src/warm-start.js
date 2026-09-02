'use strict';

// When the speech engine may start loading after launch.
//
// Loading it reads several gigabytes -- the CUDA libraries, the model
// weights -- and that is disk and memory traffic no process priority can
// soften. Started a fixed 1.5 s after the window painted, it landed on the
// moment the user was reaching for the app, and on a login launch it landed
// on a desktop still bringing itself up. So the load waits for a pause in
// keyboard and mouse input, with a ceiling so an engine is always loaded
// eventually, and a longer floor when the app was opened at login. A
// dictation asks for the engine directly and never waits on this.
//
// Only the cold launch is gated. An engine restarted because the user changed
// a setting loads after the short floor: they are at the settings pane
// watching for it.

const DEFAULTS = Object.freeze({
  // After the window paints on a launch the user started.
  minDelayMs: 1500,
  // After a login launch (--hidden): the desktop is still settling.
  loginDelayMs: 30000,
  // No keyboard or mouse input for this long counts as a pause.
  idleSeconds: 5,
  // Load regardless once this much time has passed since standby.
  maxWaitMs: 90000,
  pollMs: 2000,
});

// state: { elapsedMs, idleSeconds, loginLaunch, gateOnIdle }
// -> { start: true } or { start: false, delayMs }
function decide(state, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const s = state || {};
  const elapsed = Number(s.elapsedMs) || 0;
  const idle = Number(s.idleSeconds);
  const floor = s.loginLaunch ? opts.loginDelayMs : opts.minDelayMs;
  if (elapsed < floor) return { start: false, delayMs: floor - elapsed };
  if (!s.gateOnIdle) return { start: true };
  if (elapsed >= opts.maxWaitMs) return { start: true };
  // An idle time that could not be read is not a reason to hold the engine.
  if (!Number.isFinite(idle) || idle >= opts.idleSeconds) return { start: true };
  return { start: false, delayMs: opts.pollMs };
}

module.exports = { DEFAULTS, decide };
