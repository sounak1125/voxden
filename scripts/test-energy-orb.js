'use strict';

// The volume renderer is CPU-only and owns no event loop. A minimal Canvas2D
// sink lets us inspect every generated pixel and allocation deterministically.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');

const source = fs.readFileSync(path.join(__dirname, '../src/energy-orb.js'), 'utf8');
const runtime = {
  devicePixelRatio: 1.25,
  requestAnimationFrame: () => { throw new Error('The renderer must not own an animation loop'); },
  setTimeout: () => { throw new Error('The renderer must not own a timer'); },
  setInterval: () => { throw new Error('The renderer must not own a timer'); },
};
vm.createContext(runtime);
vm.runInContext(source, runtime, { filename: 'energy-orb.js' });

function canvas(width = 36, height = 36) {
  const calls = { contexts: [], allocations: 0, paints: 0, clears: 0 };
  let frame = new Uint8ClampedArray(0);
  const context = {
    createImageData(w, h) {
      calls.allocations++;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image) { calls.paints++; frame = image.data; },
    clearRect() { calls.clears++; frame.fill(0); },
  };
  const element = {
    width: 0, height: 0, clientWidth: width, clientHeight: height, style: {},
    getContext(kind) { calls.contexts.push(kind); assert.strictEqual(kind, '2d', 'rendering never requests a GPU context'); return context; },
  };
  return { element, calls, pixels: () => Uint8ClampedArray.from(frame) };
}
function difference(a, b) {
  assert.strictEqual(a.length, b.length);
  let changed = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); sum += delta; if (delta) changed++; }
  return { changed, mean: sum / a.length };
}
function meanLuminance(data) {
  let sum = 0, covered = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    sum += data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
    covered++;
  }
  return sum / covered;
}
function patternDifference(a, b) {
  const meanA = meanLuminance(a), meanB = meanLuminance(b);
  let sum = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 200 || b[i + 3] < 200) continue;
    const lightA = a[i] * .2126 + a[i + 1] * .7152 + a[i + 2] * .0722;
    const lightB = b[i] * .2126 + b[i + 1] * .7152 + b[i + 2] * .0722;
    sum += Math.abs(lightA / meanA - lightB / meanB);
    count++;
  }
  return sum / count;
}
function volumeStats(data) {
  let covered = 0, sum = 0, squares = 0;
  const shades = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const light = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
    covered++; sum += light; squares += light * light;
    shades.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
  }
  return { covered, shades: shades.size, contrast: Math.sqrt(Math.max(0, squares / covered - (sum / covered) ** 2)) };
}
function alphaDifference(a, b) {
  let changed = 0;
  for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 5) changed++;
  return changed;
}
function rayExtent(data, width, height, angle) {
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
    const left = Math.floor(x), top = Math.floor(y), right = Math.min(width - 1, left + 1), bottom = Math.min(height - 1, top + 1);
    const alpha = (px, py) => data[(py * width + px) * 4 + 3];
    const upper = alpha(left, top) * (1 - (x - left)) + alpha(right, top) * (x - left);
    const lower = alpha(left, bottom) * (1 - (x - left)) + alpha(right, bottom) * (x - left);
    return upper * (1 - (y - top)) + lower * (y - top);
  };
  let edge = 0;
  for (let radius = 0; radius < Math.hypot(width, height) / 2; radius += .05) {
    if (sample(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius) >= 128) edge = radius;
  }
  return edge;
}

const fixture = canvas();
const renderer = runtime.VoxdenEnergyOrb.create(fixture.element);
// Captured from the approved speech shader before the processing material was
// added. These prevent an unrelated processing change from restyling speech.
const speechFrames = [
  [{ time: 1, energy: 0 }, '65601433b777f1dbec1686aa480bdebd5e0f159c4c1bce3aec85cf431b3326ce'],
  [{ time: 4, energy: .2, pulse: .65 }, 'b68a5d364ee02a2408da6b2ffef92c7f95dcd0d19221a8b0584004ee43079e05'],
  [{ time: 4, energy: .9, pulse: 1 }, '3df784b164865e406e43e2c8b98b8a110ce0db743108e229bb2d0665e92b2ed6'],
  [{ time: 1.25, energy: .04, hover: 1 }, 'c0ad3b43d72ae19f9a7af50897665db2d1224b358f71077c68408ba88a8a72e5'],
  [{ time: 100, energy: .7, pulse: 1, reducedMotion: true }, '27c2dc1c6cfafb92b7ebfe672943a2fc284d03a1cbf2963fb2428ef889fc83ae'],
];
for (const [options, expected] of speechFrames) {
  for (const input of [options, { ...options, processing: 0 }]) {
    renderer.draw(input);
    assert.strictEqual(createHash('sha256').update(fixture.pixels()).digest('hex'), expected,
      'processing changes preserve the exact approved speech frame: ' + JSON.stringify(input));
  }
}
renderer.draw({ time: 1, energy: .2, hover: 0 });
const first = fixture.pixels();
const { width, height } = fixture.element;
assert.strictEqual(width, 45, 'backing resolution follows the display scale');
assert.strictEqual(height, 45);
assert.strictEqual(first.length, width * height * 4);
const alphaAt = (x, y) => first[(y * width + x) * 4 + 3];
assert.ok(alphaAt(Math.floor(width / 2), Math.floor(height / 2)) > 240, 'the sphere has a solid visible body');
for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
  assert.strictEqual(alphaAt(x, y), 0, 'transparent corners preserve the circular silhouette');
}
let covered = 0, translucent = 0;
const shades = new Set();
for (let i = 0; i < first.length; i += 4) {
  if (first[i + 3] > 240) { covered++; shades.add(first[i] + ',' + first[i + 1] + ',' + first[i + 2]); }
  else if (first[i + 3] > 0) translucent++;
}
assert.ok(covered > width * height * .4 && covered < width * height * .7, 'opaque pixels form a round volume rather than a filled square');
assert.ok(translucent > 0 && shades.size > 150, 'the edge is feathered and the energy surface contains tonal detail');
renderer.draw({ time: 1, energy: .2, hover: 0 });
assert.deepStrictEqual(fixture.pixels(), first, 'equal time and input produce deterministic pixels');
renderer.draw({ time: 1.5, energy: .2, hover: 0 });
const later = fixture.pixels();
assert.ok(difference(first, later).changed > first.length * .2, 'flow changes inside the sphere over time');

renderer.draw({ time: 1, energy: 0, hover: 0 });
const quiet = fixture.pixels();
renderer.draw({ time: 1, energy: 1, hover: 0 });
const speaking = fixture.pixels();
assert.ok(meanLuminance(speaking) > meanLuminance(quiet) + 5, 'voice energy visibly brightens the material');
renderer.draw({ time: 1, energy: 0, hover: 1 });
assert.ok(meanLuminance(fixture.pixels()) > meanLuminance(quiet), 'hover adds restrained light');

renderer.draw({ time: 1, energy: .5, pulse: 0 });
const unpulsed = fixture.pixels();
renderer.draw({ time: 1, energy: .5, pulse: 1 });
const pulsed = fixture.pixels();
assert.ok(patternDifference(unpulsed, pulsed) > .03, 'a speech pulse deforms the energy pattern even at fixed time and intensity');
renderer.draw({ time: 1, energy: .5, pulse: 100 });
assert.deepStrictEqual(fixture.pixels(), pulsed, 'pulse input is bounded at one');
renderer.draw({ time: 1, energy: .5, pulse: -100 });
assert.deepStrictEqual(fixture.pixels(), unpulsed, 'negative pulse input cannot invert the material');

renderer.draw({ time: 0, energy: .35, reducedMotion: true });
const staticFirst = fixture.pixels();
renderer.draw({ time: 1000, energy: .35, reducedMotion: true });
assert.deepStrictEqual(fixture.pixels(), staticFirst, 'reduced motion freezes decorative flow at a stable frame');
renderer.draw({ time: 1000, energy: .35, pulse: 1, reducedMotion: true });
assert.deepStrictEqual(fixture.pixels(), staticFirst, 'reduced motion suppresses decorative speech deformation');
renderer.draw({ time: 1000, energy: .8, reducedMotion: true });
assert.ok(difference(fixture.pixels(), staticFirst).changed > 0, 'reduced motion still communicates input level');

const period = 2 * Math.PI / .62;
renderer.draw({ time: period - .0001, energy: .5 });
const beforeWrap = fixture.pixels();
renderer.draw({ time: period + .0001, energy: .5 });
assert.ok(difference(beforeWrap, fixture.pixels()).mean < 1, 'the internal time wrap has no visible seam');
renderer.draw({});
const defaults = fixture.pixels();
renderer.draw({ time: NaN, energy: -100, hover: NaN });
assert.deepStrictEqual(fixture.pixels(), defaults, 'invalid input cannot poison the next frame');

renderer.draw({ time: 1, energy: .2, processing: 0 });
const beforeMorph = fixture.pixels();
renderer.draw({ time: 1, energy: .2, processing: .0001 });
assert.ok(difference(beforeMorph, fixture.pixels()).mean < 1, 'processing begins continuously from the approved sphere');
let previousMorph = beforeMorph;
for (let step = 1; step <= 40; step++) {
  renderer.draw({ time: 1, energy: .2, processing: step / 40 });
  const next = fixture.pixels();
  assert.ok(difference(previousMorph, next).mean < 12, 'the sphere-to-glass morph has no abrupt material or silhouette jump');
  previousMorph = next;
}
const glass = fixture.pixels(), glassStats = volumeStats(glass), sphereStats = volumeStats(beforeMorph);
assert.ok(glassStats.covered > width * height * .12 && glassStats.covered < sphereStats.covered * .8,
  'processing visibly reshapes the sphere instead of placing another icon over it');
assert.ok(glassStats.shades > 150 && glassStats.contrast > 15, 'glass processing retains volume, reflections and tonal depth');
for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
  assert.strictEqual(glass[(y * width + x) * 4 + 3], 0, 'processing has transparent corners without a backing rectangle');
}
renderer.draw({ time: 1, energy: .2, processing: true });
assert.deepStrictEqual(fixture.pixels(), glass, 'boolean processing selects the complete morph');
renderer.draw({ time: 1, energy: .2, processing: 100 });
assert.deepStrictEqual(fixture.pixels(), glass, 'processing is bounded at one');
renderer.draw({ time: 1, energy: .2, processing: -100 });
assert.deepStrictEqual(fixture.pixels(), beforeMorph, 'negative processing leaves the speech sphere intact');
renderer.draw({ time: 1, energy: .2, processing: NaN });
assert.deepStrictEqual(fixture.pixels(), beforeMorph, 'invalid processing cannot corrupt the sphere');
renderer.draw({ time: 0, energy: .5, processing: 1 });
const pointedStar = fixture.pixels();
const tips = [0, 1, 2, 3].map(quarter => rayExtent(pointedStar, width, height, quarter * Math.PI / 2));
assert.ok(Math.min(...tips) > width * .38 && Math.max(...tips) - Math.min(...tips) < .15,
  'the generation symbol has four equally long cardinal tips');
for (let quarter = 0; quarter < 4; quarter++) {
  const angle = quarter * Math.PI / 2;
  const shoulder = rayExtent(pointedStar, width, height, angle + Math.PI / 12);
  const waist = rayExtent(pointedStar, width, height, angle + Math.PI / 4);
  assert.ok(shoulder < tips[quarter] * .8, 'each arm tapers to a pointed tip instead of a rounded lobe');
  assert.ok(waist > tips[quarter] * .25 && waist < tips[quarter] * .62, 'each pair of arms has a clearly concave waist');
}
let symmetryError = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const alpha = pointedStar[(y * width + x) * 4 + 3];
  symmetryError = Math.max(symmetryError,
    Math.abs(alpha - pointedStar[(y * width + (width - 1 - x)) * 4 + 3]),
    Math.abs(alpha - pointedStar[(x * width + (height - 1 - y)) * 4 + 3]));
}
assert.ok(symmetryError <= 1, 'the actual star alpha is mirror- and quarter-turn symmetric');
renderer.draw({ time: 2, energy: .2, processing: 1 });
assert.ok(alphaDifference(glass, fixture.pixels()) > width * height * .08, 'the glass silhouette visibly turns with its reflections');
renderer.draw({ time: 1, energy: .5, processing: 1, pulse: 0 });
const calmGlass = fixture.pixels();
let coloredGlass = 0;
for (let i = 0; i < calmGlass.length; i += 4) {
  if (calmGlass[i + 3] > 200 && calmGlass[i + 1] > calmGlass[i] + 15 && calmGlass[i + 2] > calmGlass[i] + 15) coloredGlass++;
}
assert.ok(meanLuminance(calmGlass) > 65 && coloredGlass > volumeStats(calmGlass).covered * .6,
  'the processing star stays visibly bright and colored between its pearl pulses');
renderer.draw({ time: 1, energy: .5, processing: 1, pulse: .3 });
const brightGlass = fixture.pixels();
assert.ok(brightGlass.every((value, i) => i % 4 !== 3 || value === calmGlass[i]), 'the processing glint pulse preserves the glass silhouette');
assert.ok(patternDifference(calmGlass, brightGlass) > .01 && meanLuminance(brightGlass) > meanLuminance(calmGlass) + .5,
  'processing pulses illuminate local refractions instead of flashing a flat fill');
renderer.draw({ time: 0, energy: .2, processing: 1, reducedMotion: true });
const staticGlass = fixture.pixels();
renderer.draw({ time: 1000, energy: .2, processing: 1, pulse: 1, reducedMotion: true });
assert.deepStrictEqual(fixture.pixels(), staticGlass, 'reduced motion freezes processing shape, reflections and pulse');
renderer.draw({ time: period - .0001, energy: .2, processing: 1 });
const glassBeforeWrap = fixture.pixels();
renderer.draw({ time: period + .0001, energy: .2, processing: 1 });
assert.ok(difference(glassBeforeWrap, fixture.pixels()).mean < 1, 'rotating glass closes the phase loop without a seam');

const started = process.hrtime.bigint();
for (let frame = 0; frame < 120; frame++) renderer.draw({ time: frame / 60, energy: frame / 120, pulse: .5 + .5 * Math.sin(frame / 8) });
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
assert.strictEqual(fixture.calls.allocations, 1, 'speech, processing and a long sequence reuse one pixel buffer');
assert.deepStrictEqual(fixture.calls.contexts, ['2d'], 'one renderer owns exactly one CPU drawing context');
fixture.element.clientWidth = fixture.element.clientHeight = 48;
renderer.draw({ time: 2, energy: .5 });
assert.strictEqual(fixture.calls.allocations, 2, 'a size change reallocates the pixel buffer once');
assert.strictEqual(fixture.element.width, 60);

runtime.devicePixelRatio = 10;
const large = canvas(10000, 10000);
const largeRenderer = runtime.VoxdenEnergyOrb.create(large.element);
largeRenderer.draw({ time: Infinity, energy: Infinity, hover: Infinity });
assert.ok(large.element.width <= 256 && large.element.height <= 256, 'backing storage remains bounded at extreme size or scale');
largeRenderer.dispose();

renderer.dispose();
assert.strictEqual(fixture.calls.clears, 1, 'dispose clears the visible frame');
const paints = fixture.calls.paints;
renderer.draw({ time: 2, energy: 1 });
renderer.dispose();
assert.strictEqual(fixture.calls.paints, paints, 'disposed instances cannot paint again');
assert.strictEqual(fixture.calls.clears, 1, 'dispose is idempotent');
assert.ok(fixture.pixels().every(value => value === 0), 'disposed pixels stay clear');
const unavailable = runtime.VoxdenEnergyOrb.create({ getContext: () => null });
assert.doesNotThrow(() => { unavailable.draw({ time: 1 }); unavailable.dispose(); }, 'an unavailable Canvas2D context fails quietly');
console.log('Energy orb: deterministic CPU pixels, flowing volume, input and hover response, seamless wrap, reduced motion, bounded allocation and disposal passed (' + (elapsed / 120).toFixed(2) + 'ms/frame at45px).');
