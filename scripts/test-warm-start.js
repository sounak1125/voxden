'use strict';

const assert = require('assert');
const { decide, DEFAULTS } = require('../src/warm-start');

const gated = (state, options) => decide(Object.assign({ gateOnIdle: true }, state), options);

// The floor: nothing loads before the window has painted.
assert.deepStrictEqual(gated({ elapsedMs: 0, idleSeconds: 60 }), { start: false, delayMs: DEFAULTS.minDelayMs });
// Past the floor, an active user holds the load.
assert.deepStrictEqual(gated({ elapsedMs: 2000, idleSeconds: 0 }), { start: false, delayMs: DEFAULTS.pollMs });
assert.deepStrictEqual(gated({ elapsedMs: 2000, idleSeconds: 4 }), { start: false, delayMs: DEFAULTS.pollMs });
// A pause in input lets it go.
assert.deepStrictEqual(gated({ elapsedMs: 2000, idleSeconds: 5 }), { start: true });
// An idle time that could not be read does not hold the engine forever.
assert.deepStrictEqual(gated({ elapsedMs: 2000, idleSeconds: NaN }), { start: true });
assert.deepStrictEqual(gated({ elapsedMs: 2000 }), { start: true });
// The ceiling: a user who never pauses still gets an engine.
assert.deepStrictEqual(gated({ elapsedMs: DEFAULTS.maxWaitMs, idleSeconds: 0 }), { start: true });
// Login launch: a longer floor, then the same idle rule.
assert.deepStrictEqual(
  gated({ elapsedMs: 2000, idleSeconds: 60, loginLaunch: true }),
  { start: false, delayMs: DEFAULTS.loginDelayMs - 2000 }
);
assert.deepStrictEqual(gated({ elapsedMs: 31000, idleSeconds: 0, loginLaunch: true }), { start: false, delayMs: DEFAULTS.pollMs });
assert.deepStrictEqual(gated({ elapsedMs: 31000, idleSeconds: 6, loginLaunch: true }), { start: true });
// A restart the user asked for is not gated on idle: only the floor applies.
assert.deepStrictEqual(decide({ elapsedMs: 2000, idleSeconds: 0, gateOnIdle: false }), { start: true });
assert.deepStrictEqual(decide({ elapsedMs: 100, idleSeconds: 0, gateOnIdle: false }), { start: false, delayMs: DEFAULTS.minDelayMs - 100 });
// Options override the defaults.
assert.deepStrictEqual(gated({ elapsedMs: 500, idleSeconds: 9 }, { minDelayMs: 100 }), { start: true });

console.log('warm-start gating passed');
