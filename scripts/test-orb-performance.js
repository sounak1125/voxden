'use strict';

// Scheduling and layout-read budgets are deterministic; elapsed CPU time is
// measured separately because hardware/CI speed is not a correctness contract.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/energy-orb.js'), 'utf8');
const previewSource = fs.readFileSync(path.join(__dirname, '../src/energy-orb-preview.js'), 'utf8');

let measuredWidth = 40, measuredHeight = 40, reads = 0, allocations = 0, resizeCallback, disconnected = false;
const canvas = {
  style: {},
  get clientWidth() { reads++; return measuredWidth; },
  get clientHeight() { reads++; return measuredHeight; },
  getContext() { return {
    createImageData(width, height) { allocations++; return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {}, clearRect() {},
  }; },
};
const runtime = { devicePixelRatio: 1.25,
  ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() { disconnected = true; } },
};
vm.createContext(runtime); vm.runInContext(source, runtime);
const renderer = runtime.VoxdenEnergyOrb.create(canvas);
renderer.draw({ time: 1 });
assert.strictEqual(reads, 2);
for (let i = 0; i < 40; i++) renderer.draw({ time: i / 30, processing: i % 2 });
assert.strictEqual(reads, 2, 'fixed-size animation does not force layout reads per draw');
assert.strictEqual(allocations, 1, 'fixed-size draws reuse pixel storage');
measuredWidth = measuredHeight = 44; resizeCallback(); renderer.draw({ time: 2 });
assert.strictEqual(reads, 4, 'an actual resize remeasures the canvas once');
assert.strictEqual(canvas.width, 55);
runtime.devicePixelRatio = 2; renderer.draw({ time: 3 });
assert.strictEqual(canvas.width, 88, 'changing monitor scale refreshes backing resolution without a CSS resize');
assert.strictEqual(reads, 4, 'DPR changes do not force another CSS layout read');
renderer.dispose(); assert.strictEqual(disconnected, true, 'disposing releases the size observer');

function target(extra = {}) {
  const listeners = new Map();
  return Object.assign({ addEventListener(name, fn) { (listeners.get(name) || (listeners.set(name, []), listeners.get(name))).push(fn); },
    removeEventListener() {}, fire(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); } }, extra);
}
function preview() {
  let intersection, pending = new Map(), sequence = 0, draws = 0, disposed = 0;
  const card = target({ contains: value => value === card });
  const canvas = { closest: () => card };
  const document = target({ visibilityState: 'visible', getElementById: () => canvas });
  const motion = target({ matches: false });
  const window = target({ VoxdenFlowMotion: motion, VoxdenEnergyOrb: { create: () => ({ draw() { draws++; }, dispose() { disposed++; } }) } });
  const context = { document, window, AbortController,
    IntersectionObserver: class { constructor(fn) { intersection = fn; } observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(fn) { pending.set(++sequence, fn); return sequence; },
    cancelAnimationFrame(id) { pending.delete(id); },
  };
  vm.createContext(context); vm.runInContext(previewSource, context);
  const visible = state => intersection([{ target: canvas, isIntersecting: state }]);
  const tick = time => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn(time)); };
  return { card, document, motion, window, visible, tick, draws: () => draws, pending: () => pending.size, disposed: () => disposed };
}

const cadence = [];
for (const hz of [60, 144, 240]) {
  const p = preview(); p.visible(true); p.card.fire('pointerenter');
  const before = p.draws();
  for (let i = 0; i <= hz; i++) p.tick(100 + i * 1000 / hz);
  const count = p.draws() - before;
  assert.ok(count >= 28 && count <= 31, 'preview stays near 30 texture draws/sec at ' + hz + 'Hz: ' + count);
  assert.strictEqual(p.pending(), 1, 'only one preview clock is queued');
  cadence.push({ hz, draws: count });
  p.card.fire('pointerleave'); const stopped = p.draws(); p.tick(2000);
  assert.strictEqual(p.pending(), 0); assert.strictEqual(p.draws(), stopped, 'unhovered/unfocused preview is static');
  p.card.fire('focusin'); assert.strictEqual(p.pending(), 1, 'keyboard focus animates the preview');
  p.visible(false); assert.strictEqual(p.pending(), 0, 'scrolled-out/closed preview stops');
  p.visible(true); p.document.visibilityState = 'hidden'; p.document.fire('visibilitychange');
  assert.strictEqual(p.pending(), 0, 'hidden dashboard stops preview work');
  p.document.visibilityState = 'visible'; p.document.fire('visibilitychange');
  p.motion.matches = true; p.motion.fire('change'); assert.strictEqual(p.pending(), 0, 'reduced motion keeps a static preview');
  p.window.fire('pagehide'); assert.strictEqual(p.disposed(), 1, 'closed pages release the renderer');
}
console.log('Orb performance: no per-frame layout reads, resize/DPR refresh, disposal, hidden/reduced preview lifecycle and bounded texture cadence passed ' + JSON.stringify(cadence));
