/*
 * Voxden voice stream: the light that pours from the top of the home page
 * and strikes the live app window below the hero.
 *
 * Hundreds of hairline strands fall from the top centre, narrow to a waist,
 * then flare out and hug the window's outline the way a jet hugs a wall it
 * strikes: below the waist every strand follows a stagnation-flow
 * streamline (distance out x height above the edge = constant), so it
 * bends out along the top edge, wraps the corners and runs down the sides.
 * Every position is worked out in the vertex shader from a few uniforms;
 * the only buffers are one strip template and a row of numbers per strand.
 * The voice level history travels down the stream as ripples and swells,
 * so a visitor's dictation visibly pours into the app, and fine glints
 * ride the strands and twinkle.
 *
 * Mount:  <div class="voice-stream" data-voice-stream aria-hidden="true">,
 *         first child of a positioned, isolated stage.
 * Target: [data-voxden-demo="app"]; its border box is the window's outer
 *         edge and --vx-window-radius its corner radius.
 * Events: voxden:dictation { state } and voxden:voice-level { level } on
 *         document.
 *
 * WebGL 2, else WebGL 1 with ANGLE_instanced_arrays; otherwise the
 * stylesheet's still gradient (.is-fallback). One IIFE, no globals.
 */
(function () {
  'use strict';

  const mount = document.querySelector('[data-voice-stream]');
  if (!mount || mount.hasAttribute('data-vs-on')) return;
  mount.setAttribute('data-vs-on', '');

  const TARGET = '[data-voxden-demo="app"]';

  // ---------------------------------------------------------------------------
  // Tuning knobs. Counts are for wide (1024 px and up), medium (640 px and
  // up) and narrow stages; devices with four cores or fewer draw 70 %.
  // data-intensity on the mount scales the brightness, data-strands sets
  // the strand count outright.
  const KNOBS = {
    strands: [400, 280, 150],
    glints: [96, 64, 36],     // twinkling glints; about a third are lit at once
    riders: [28, 20, 12],     // extra glints that ride the success pulse
    points: 180,              // vertices along each strand
    dprCap: 1.5,
    maxPixels: 4.6e6,         // backing-store cap for very large screens
    brightness: 1,
    haze: 0.08,               // the soft glow around the stream
    // The flow is a steady drift that depends on the dictation state only,
    // never on scrolling: light eases down the strands at flowRest, the
    // ripple folds at rippleRest, both integrated so no change of rate can
    // move anything. Recording hurries both toward flowLive.
    flowRest: 38,             // px/s light drifts down the strands at rest
    rippleRest: 13,           // px/s the ripple's folds travel at rest (one fold ~15 s)
    flowLive: 240,            // px/s while recording
    fpsCalm: 30,              // frame cap while nothing is happening
    pulseSpeed: 1500,         // px/s of the success pulse
    sceneBoost: 0.15,         // brighter once the app window has settled flat
  };
  const PALETTE = {
    hot: 0xdcfff1,  // the brightest core and the rim
    core: 0x6fe3b5, // mint
    mid: 0x25bfb2,  // teal
    edge: 0x3d7fd4, // blue
    deep: 0x7358e0, // indigo-violet, the far strands at the edges
  };

  const LV_N = 48;             // voice level samples along the stream
  const FRAME_MIN_MS = 12.5;   // at most ~80 fps while something moves

  // The app window may lie back in its scroll scene (assets/motion): the
  // same perspective(), rotateX() and scale() about its bottom centre that
  // CSS applies, so the landing, the rim and the side threads stay on its
  // edge. uTilt = origin x, origin y (canvas px), angle (rad), scale.
  const TILT_GLSL = [
    'uniform vec4 uTilt;',
    'uniform float uPersp;',
    'vec2 tiltPoint(vec2 p) {',
    '  vec2 q = p - uTilt.xy;',
    '  float k = uPersp / (uPersp - uTilt.w * q.y * sin(uTilt.z));',
    '  return uTilt.xy + vec2(uTilt.w * q.x, uTilt.w * q.y * cos(uTilt.z)) * k;',
    '}',
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Shaders. GLSL ES 1.00, which WebGL 2 also runs.
  const PATH_GLSL = [
    'precision highp float;',
    'uniform vec2 uRes;',     // canvas size, CSS px
    'uniform float uDpr;',
    'uniform vec4 uWin;',     // window x0, y0, x1, y1
    'uniform vec4 uGeo;',     // source x, start y, corner radius, px per level sample
    'uniform vec4 uShape;',   // top half-width, waist half-width, waist height, swell
    'uniform vec4 uPh;',      // wave A phase, wave B phase, streak phase, clock (s)
    'uniform vec4 uFx;',      // energy, pulse front (px), pulse strength, brightness
    'uniform vec4 uLv[12];',  // voice levels, newest (the top of the stream) first
    'uniform float uLvOff;',
    'float gCx, gHalfW, gR, gL1, gArc, gHf, gYn, gLu, gXn, gC, gSn, gDW, gDir, gH, gU, gSeed, gWall;',
    'void setupStrand(float u, float h, float seed) {',
    '  gU = u; gH = h; gSeed = seed;',
    '  gCx = 0.5 * (uWin.x + uWin.z);',
    '  gHalfW = 0.5 * (uWin.z - uWin.x);',
    '  gR = max(uGeo.z, 0.5);',
    '  gL1 = max(gHalfW - gR, 0.0);',
    '  gArc = 1.5707963 * gR;',
    '  gHf = uWin.y - uGeo.y;',
    '  gYn = min(uShape.z, gHf * 0.8);',
    '  gLu = gHf - gYn;',
    '  gDir = u < 0.0 ? -1.0 : 1.0;',
    '  gXn = max(abs(u), 0.02) * uShape.y;',
    '  float zn = max(gYn - h, 1.0);',
    '  gC = gXn * zn;',
    '  gSn = gXn - zn;',
    '  gDW = gLu - gSn;',
    // The longest strands carry on nearly to the foot of the sides.
    '  gWall = gL1 + gArc + 0.95 * max(uWin.w - uWin.y - 2.0 * gR, 0.0);',
    '}',
    'float lvAt(float i) {',
    '  float k = floor(i * 0.25);',
    '  float c = i - k * 4.0;',
    '  vec4 v = uLv[int(k)];',
    '  return dot(v, vec4(equal(vec4(c), vec4(0.0, 1.0, 2.0, 3.0))));',
    '}',
    'float level(float d) {',
    '  float p = clamp(d / uGeo.w - uLvOff, 0.0, ' + (LV_N - 1.001).toFixed(3) + ');',
    '  float i = floor(p);',
    '  float f = p - i;',
    '  return mix(lvAt(i), lvAt(i + 1.0), f * f * (3.0 - 2.0 * f));',
    '}',
    // The waist: a Hermite curve from the wide top down to the junction,
    // leaving it with the slope of the streamline below, so nothing kinks.
    'float waistWidth(float r, float h) {',
    '  float wN = uShape.y;',
    '  float m0 = -wN * gLu / max(gYn - h, 1.0);',
    '  float m1 = 0.45 * (uShape.x - wN);',
    '  float r2 = r * r;',
    '  float r3 = r2 * r;',
    '  float w = (2.0 * r3 - 3.0 * r2 + 1.0) * wN + (r3 - 2.0 * r2 + r) * m0',
    '          + (3.0 * r2 - 2.0 * r3) * uShape.x + (r3 - r2) * m1;',
    '  return max(w, 0.3 * wN);',
    '}',
    // Distance a along the window outline from the top centre, and height
    // e off it, to a point: the top edge, the rounded corner, the side.
    // Past the top edge every strand eases onto the outline itself, so what
    // rounds the corner and runs down the side is one sheen of light, not
    // rings of separate lines. A narrow window has short sides, so there the
    // strands close in sooner.
    'vec2 alongOutline(float a, float e) {',
    '  if (a <= gL1) return vec2(gCx + gDir * a, uWin.y - e);',
    '  float ee = mix(0.7, e, exp(-(a - gL1) / clamp(0.3 * gL1, 50.0, 140.0)));',
    '  if (a <= gL1 + gArc) {',
    '    float phi = (a - gL1) / gR;',
    '    return vec2(gCx + gDir * gL1, uWin.y + gR) + vec2(gDir * sin(phi), -cos(phi)) * (gR + ee);',
    '  }',
    '  return vec2(gCx + gDir * (gHalfW + ee), uWin.y + gR + (a - gL1 - gArc));',
    '}',
    // A point d px along the strand, before the ripple.
    'vec2 basePos(float d) {',
    '  if (d < gLu) {',
    '    float r = 1.0 - d / gLu;',
    '    float cl = mix(gCx, uGeo.x, smoothstep(0.0, 1.0, r));',
    '    float breathe = 1.0 + smoothstep(0.0, 0.45, r) * (uShape.w + 0.4 * level(d) - 0.08);',
    '    return vec2(cl + gU * waistWidth(r, gH) * breathe, uWin.y - gYn - r * gLu);',
    '  }',
    '  float s = gSn + (d - gLu);',
    '  float q = sqrt(s * s + 4.0 * gC);',
    '  float x = s >= 0.0 ? 0.5 * (s + q) : 2.0 * gC / (q - s);',
    '  return alongOutline(x, gH + gC / x);',
    '}',
    // The ripple across the strand: two travelling waves whose phase shifts
    // across the bundle, so neighbours cross and the stream twists; their
    // size follows the voice level at that point of the stream.
    'float waveAt(float d) {',
    '  float s = d / gDW;',
    '  float env = smoothstep(0.0, 0.42, s) * (1.0 - smoothstep(0.6, 0.97, s))',
    '            + 0.14 * smoothstep(0.92, 1.15, s) * exp(-max(d - gDW, 0.0) / 360.0);',
    '  float amp = (6.5 + 4.5 * uFx.x) * (0.55 + 0.9 * level(d));',
    '  float a = sin(d * 0.0331 - uPh.x + gU * 9.0 + gSeed * 1.7);',
    '  float b = sin(d * 0.0571 + uPh.y + gU * 14.0 + gSeed * 6.2832);',
    '  return env * amp * (a + 0.2 * b);',
    '}',
    'vec2 strandPoint(float d, float eps, out vec2 n) {',
    '  vec2 p0 = basePos(d - eps);',
    '  vec2 p1 = basePos(d);',
    '  vec2 p2 = basePos(d + eps);',
    '  vec2 tb = p2 - p0;',
    '  tb /= max(length(tb), 1e-4);',
    '  vec2 nb = vec2(-tb.y, tb.x);',
    '  vec2 q0 = p0 + nb * waveAt(d - eps);',
    '  vec2 q1 = p1 + nb * waveAt(d);',
    '  vec2 q2 = p2 + nb * waveAt(d + eps);',
    '  vec2 t = q2 - q0;',
    '  float tl = length(t);',
    '  t = tl > 1e-4 ? t / tl : tb;',
    '  n = vec2(-t.y, t.x);',
    '  return q1;',
    '}',
    'float strandLength(float reach) {',
    '  return reach < 1.0 ? reach * gDW : gDW + (reach - 1.0) * gWall;',
    '}',
    'vec4 clipAt(vec2 p) { return vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0); }',
    TILT_GLSL,
    // The light near the window rides its tilt; the fall high above stays.
    'vec2 landed(vec2 p) {',
    '  if (uTilt.z == 0.0 && uTilt.w == 1.0) return p;',
    '  return mix(p, tiltPoint(p), 1.0 - smoothstep(20.0, 240.0, uWin.y - p.y));',
    '}',
  ].join('\n');

  const PALETTE_GLSL = 'uniform vec3 uHot; uniform vec3 uCore; uniform vec3 uMid; uniform vec3 uEdge; uniform vec3 uDeep;';

  const STRAND_VS = [
    PATH_GLSL,
    PALETTE_GLSL,
    'attribute vec2 aVert;', // t along the strand, side of the strip
    'attribute vec4 aS0;',   // u, seed, depth, reach
    'attribute vec4 aS1;',   // height above the edge, halo, spare, spare
    'uniform float uFall;',  // brightness of the fall above the landing (lower on phones)
    'varying vec3 vCol;',
    'varying vec2 vProf;',
    'varying float vSide;',
    'void main() {',
    '  setupStrand(aS0.x, aS1.x, aS0.y);',
    '  float depth = aS0.z;',
    '  float total = strandLength(aS0.w);',
    '  float d = aVert.x * total;',
    '  vec2 n;',
    '  vec2 p = strandPoint(d, max(total * 0.0056, 1.0), n);',
    // How far along the outline from the top centre the strand has come (0
    // above the junction), as basePos works it out.
    '  float X = 0.0;',
    '  if (d >= gLu) {',
    '    float sb = gSn + (d - gLu);',
    '    float qb = sqrt(sb * sb + 4.0 * gC);',
    '    X = sb >= 0.0 ? 0.5 * (sb + qb) : 2.0 * gC / (qb - sb);',
    '  }',
    // Soft, feathered hairlines: near strands a little crisper than far
    // ones, and every strand widening as it nears the corner and runs down
    // the side, where neighbours melt into one sheen; on a narrow window
    // that happens over a shorter run. The peak scales so a strand carries
    // the same light however wide it is.
    '  float s = d / gDW;',
    '  float wallD = max(d - gDW, 0.0);',
    '  float sideways = smoothstep(-0.25 * gL1, gArc + min(260.0, 0.5 * gL1 + 60.0), X - gL1);',
    '  float sigma = mix(2.1, 0.85, depth) + 3.4 * sideways;',
    '  float halo = aS1.y * (1.0 - sideways);',
    '  float hw = sigma * (2.7 + 7.0 * step(0.001, halo)) + 0.5;',
    '  vec2 pos = p + n * aVert.y * (hw / uDpr);',
    '  float lv = level(d);',
    '  float b = mix(0.62, 1.0, smoothstep(0.0, 0.8, s));',
    '  b *= 1.0 + 0.22 * smoothstep(0.82, 1.0, s) * exp(-wallD / 200.0);',
    '  b *= mix(1.0, 0.22 + 0.78 * exp(-wallD / 560.0), smoothstep(0.98, 1.12, s));',
    '  b *= 1.0 - smoothstep(total - min(total * 0.5, 520.0), total, d);',
    // Broad bands of light drifting down the strands, and a slow shimmer.
    '  b *= 0.8 + 0.4 * pow(0.5 + 0.5 * sin(d * 0.0121 - uPh.z + gSeed * 41.0), 2.5);',
    '  b *= 0.88 + 0.12 * sin(uPh.w * (0.12 + 0.2 * gSeed) + gSeed * 29.0);',
    '  b *= (0.85 + 0.6 * lv) * (1.0 + 0.35 * uFx.x);',
    '  float pd = d - uFx.y;',
    // min() keeps exp() finite: 0 * inf would blank the strand.
    '  float pulse = uFx.z * (0.95 * exp(-pd * pd / 9000.0) + 0.22 * step(pd, 0.0) * exp(min(pd, 0.0) / 260.0));',
    '  float edge = smoothstep(0.05, 1.1, abs(gU));',
    '  b = (b + pulse) * mix(1.0, 0.55, edge) * mix(0.4, 1.0, depth) * uFx.w;',
    '  b *= mix(uFall, 1.0, smoothstep(0.75, 0.95, s));',
    // Every strand passes the waist, so there the bundle is dense: each
    // carries less light where the bundle is narrow, and the stream reads
    // evenly bright instead of burning to white in a knot.
    // Below the waist the bundle spreads as the streamlines do: a strand is
    // x / (its x at the waist) times wider there, so the two meet exactly.
    '  float bundle = d < gLu ? waistWidth(1.0 - d / gLu, gH) : uShape.y * X / gXn;',
    '  b *= clamp(bundle / (uShape.y * 1.8), 0.34, 1.0);',
    '  vec3 col = mix(uCore, uMid, smoothstep(0.0, 0.5, edge));',
    '  col = mix(col, uEdge, smoothstep(0.42, 0.9, edge));',
    '  col = mix(col, uDeep, (1.0 - depth) * 0.6 * smoothstep(0.25, 0.9, edge));',
    '  float hot = smoothstep(0.84, 1.0, s) * (1.0 - smoothstep(1.0, 1.0 + 220.0 / gDW, s)) * (1.0 - edge);',
    '  col = mix(col, uHot, clamp(0.25 * hot + 0.35 * uFx.z * exp(-pd * pd / 9000.0), 0.0, 1.0));',
    '  vCol = col * (0.34 * b * 0.6 / sigma);',
    '  vProf = vec2(hw / sigma, halo);',
    '  vSide = aVert.y;',
    '  gl_Position = clipAt(landed(pos));',
    '}',
  ].join('\n');

  const STRAND_FS = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'varying vec2 vProf;',
    'varying float vSide;',
    'void main() {',
    '  float x = vSide * vProf.x;',
    '  float x2 = x * x;',
    '  vec3 c = vCol * (exp(-0.5 * x2) + vProf.y * exp(-0.035 * x2));',
    '  gl_FragColor = vec4(c, max(max(c.r, c.g), c.b));',
    '}',
  ].join('\n');

  // Glints: points that ride the strands, twinkle, and gather at the core
  // and the impact; riders only show while a success pulse runs.
  const GLINT_VS = [
    PATH_GLSL,
    PALETTE_GLSL,
    'attribute vec4 aG0;',   // u, seed, depth, reach
    'attribute vec4 aG1;',   // height above the edge, offset, twinkle rate, rider
    'uniform float uTravel;',
    'uniform float uGlint;', // glint brightness
    'uniform float uStill;', // 1 for the reduced-motion still: every drawn glint lit
    'uniform float uFall;',
    'varying vec3 vCol;',
    'void main() {',
    '  setupStrand(aG0.x, aG1.x, aG0.y);',
    '  float total = strandLength(aG0.w);',
    '  float loopLen = total * 1.25 + 160.0;',
    '  float dd = mod(aG1.y * loopLen + uTravel * (0.85 + 0.3 * aG0.y), loopLen) - 80.0;',
    '  float rider = aG1.w;',
    '  dd = mix(dd, uFx.y - aG1.y * 170.0, rider);',
    '  float d = clamp(dd, 0.0, total);',
    '  vec2 n;',
    '  vec2 p = strandPoint(d, 2.0, n);',
    '  float s = d / gDW;',
    '  float tw = 0.5 + 0.5 * sin(uPh.w * aG1.z + aG0.y * 60.0);',
    '  tw = mix(tw, 0.82 + 0.18 * fract(aG0.y * 13.7), uStill);',
    '  float lv = level(d);',
    '  float ends = smoothstep(0.0, 70.0, dd) * (1.0 - smoothstep(total - 140.0, total, dd));',
    '  float b = pow(tw, mix(3.4, 2.0, uFx.x * (0.4 + 0.6 * lv)));',
    '  b *= mix(0.6, 1.0, smoothstep(0.15, 0.85, s)) * mix(uFall, 1.0, smoothstep(0.75, 0.95, s));',
    '  b *= 1.0 + 0.9 * smoothstep(0.84, 1.0, s) * exp(-max(d - gDW, 0.0) / 260.0);',
    '  b *= (0.8 + 1.2 * lv * uFx.x) * (1.0 + 0.4 * uFx.x);',
    '  b = mix(b, uFx.z * (0.55 + 0.45 * tw) * 1.5, rider) * ends;',
    '  b *= uFx.w * uGlint * mix(0.6, 1.0, aG0.z);',
    '  gl_PointSize = 16.0 * uDpr;',
    '  vCol = mix(uCore, uHot, 0.7) * b;',
    '  gl_Position = b < 0.003 ? vec4(2.0, 2.0, 2.0, 1.0) : clipAt(landed(p));',
    '}',
  ].join('\n');

  // A sharp core and a soft halo that has died out well inside the sprite.
  const GLINT_FS = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'void main() {',
    '  vec2 q = (gl_PointCoord - 0.5) * 16.0;',
    '  float r2 = dot(q, q);',
    '  vec3 c = vCol * (exp(-r2 * 0.8) + 0.34 * exp(-r2 * 0.075));',
    '  gl_FragColor = vec4(c, max(max(c.r, c.g), c.b));',
    '}',
  ].join('\n');

  // The haze under the strands and the rim light on the window's edge,
  // drawn over the stream's bounding box in one pass.
  const HAZE_VS = [
    'attribute vec2 aPos;',
    'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  const HAZE_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes;',
    'uniform float uDpr;',
    'uniform vec4 uWin;',
    'uniform vec4 uGeo;',
    'uniform vec4 uShape;',
    'uniform vec4 uFx;',
    'uniform vec4 uRim;', // rim strength, flare front along the outline, flare strength, haze
    'uniform float uLine;', // the crisp rim line, eased out while the tilt is moving
    PALETTE_GLSL,
    TILT_GLSL,
    // A point on screen back to the window's own plane (k: its scale there).
    'vec2 untiltPoint(vec2 p, out float k) {',
    '  vec2 d = p - uTilt.xy;',
    '  float sn = sin(uTilt.z);',
    '  float y = d.y * uPersp / (uTilt.w * (uPersp * cos(uTilt.z) + d.y * sn));',
    '  k = uPersp / (uPersp - uTilt.w * y * sn);',
    '  return uTilt.xy + vec2(d.x / (uTilt.w * k), y);',
    '}',
    'float sdRoundBox(vec2 p, vec2 b, float r) {',
    '  vec2 q = abs(p) - b + r;',
    '  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main() {',
    '  vec2 p = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;',
    '  float cx = 0.5 * (uWin.x + uWin.z);',
    '  float halfW = 0.5 * (uWin.z - uWin.x);',
    '  float halfH = 0.5 * (uWin.w - uWin.y);',
    '  float r = max(uGeo.z, 0.5);',
    '  bool tilted = uTilt.z != 0.0 || uTilt.w != 1.0;',
    '  float kz = 1.0;',
    '  vec2 lp = tilted ? untiltPoint(p, kz) : p;',
    '  vec2 q = lp - vec2(cx, uWin.y + halfH);',
    '  float dr = sdRoundBox(q, vec2(halfW, halfH), r) * uTilt.w * kz;',
    '  vec3 c = vec3(0.0);',
    '  float Y = (tilted ? tiltPoint(vec2(cx, uWin.y)).y : uWin.y) - p.y;',
    '  if (Y > -2.0 && dr > -3.0) {',
    '    float Hf = uWin.y - uGeo.y;',
    '    float Yn = min(uShape.z, Hf * 0.8);',
    '    float Lu = Hf - Yn;',
    '    float cl = cx;',
    '    float w;',
    '    if (Y >= Yn) {',
    '      float rr = clamp((Y - Yn) / Lu, 0.0, 1.0);',
    '      cl = mix(cx, uGeo.x, smoothstep(0.0, 1.0, rr));',
    '      float wN = uShape.y;',
    '      float m0 = -wN * Lu / max(Yn - 3.0, 1.0);',
    '      float m1 = 0.45 * (uShape.x - wN);',
    '      float r2 = rr * rr;',
    '      float r3 = r2 * rr;',
    '      w = (2.0 * r3 - 3.0 * r2 + 1.0) * wN + (r3 - 2.0 * r2 + rr) * m0 + (3.0 * r2 - 2.0 * r3) * uShape.x + (r3 - r2) * m1;',
    '      w = max(w, 0.3 * wN) * (1.0 + smoothstep(0.0, 0.45, rr) * uShape.w);',
    '    } else {',
    '      w = min(uShape.y * Yn / max(Y, 6.0), 0.55 * halfW);',
    '    }',
    '    float dx = p.x - cl;',
    '    float sg = 0.8 * w + 16.0;',
    '    float si = 0.35 * w + 5.0;',
    '    float along = mix(0.5, 1.0, smoothstep(Hf, Yn * 0.6, Y));',
    '    along *= 1.0 - smoothstep(halfW - 60.0, halfW + 40.0, abs(p.x - cx));',
    '    c += mix(uMid, uCore, exp(-dx * dx / (2.0 * si * si))) * (uRim.w * along * exp(-dx * dx / (2.0 * sg * sg)));',
    '    float ix = (p.x - cx) / (0.36 * halfW + 20.0);',
    '    float iy = max(Y, 0.0) / 46.0;',
    '    c += mix(uCore, uHot, 0.4) * ((0.2 + 0.25 * uFx.x) * exp(-ix * ix - iy * iy));',
    // The strike: a hot spot where the stream meets the edge.
    '    float hx = (p.x - cx) / 70.0;',
    '    float hy = max(Y, 0.0) / 34.0;',
    '    c += uHot * ((0.32 + 0.3 * uFx.x + 0.8 * uRim.z) * exp(-hx * hx - hy * hy));',
    '  }',
    '  if (dr > -2.5 && dr < 160.0) {',
    '    float ax = abs(q.x);',
    '    float L1 = max(halfW - r, 0.0);',
    '    float arc = 1.5707963 * r;',
    '    float cy = -halfH + r;',
    '    float a = q.y < cy ? (ax <= L1 ? ax : L1 + r * atan(ax - L1, cy - q.y)) : L1 + arc + (q.y - cy);',
    '    float side = max(a - L1 - arc, 0.0);',
    '    float sideLen = max(2.0 * halfH - 2.0 * r, 1.0);',
    '    float k = a / (0.52 * halfW + 30.0);',
    '    float fade = 1.0 - smoothstep(0.3 * sideLen, 0.95 * sideLen, side);',
    '    float ep = (0.2 + 0.8 * exp(-k * k)) * exp(-side / (0.5 * sideLen)) * fade;',
    '    float o = max(dr, 0.0);',
    // One clean line along the top edge that gives way to a soft sheen down
    // the sides, and a single smooth falloff outward: nothing reads as an
    // outline stacked on an outline, or as a band beside the window.
    '    float line = exp(-o / 0.8) * smoothstep(-2.5, -0.4, dr) * uLine * (1.0 - smoothstep(0.0, 200.0, side));',
    '    float glow = 0.2 * exp(-o / 11.0);',
    '    float fk = (a - uRim.y) / 130.0;',
    '    float fl = uRim.z * (exp(-fk * fk) + 0.3) * exp(-side / (0.45 * sideLen)) * fade;',
    '    float rim = (line * (1.2 + 1.2 * ep) + glow) * (ep * uRim.x + fl * (0.4 + 0.6 * ep));',
    '    c += mix(uCore, uHot, clamp(0.3 + 0.7 * ep * line + 0.5 * fl, 0.0, 1.0)) * rim;',
    '  }',
    '  c *= uFx.w;',
    '  float lit = min((c.r + c.g + c.b) * 60.0, 1.0);',
    '  c = max(c + (hash(gl_FragCoord.xy) - 0.5) * lit / 255.0, 0.0);',
    '  gl_FragColor = vec4(c, max(max(c.r, c.g), c.b));',
    '}',
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Small helpers.
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;
  function rgb(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // State.
  const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(reducedMQ && reducedMQ.matches);
  const stage = mount.parentElement || document.body;
  const userGain = parseFloat(mount.getAttribute('data-intensity'));
  const gain = KNOBS.brightness * (isFinite(userGain) && userGain > 0 ? userGain : 1);
  const userStrands = parseInt(mount.getAttribute('data-strands'), 10);
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;

  let canvas = null;
  let gl = null;
  let inst = null;          // instancing entry points
  let progs = null;
  let bufs = null;
  let lost = false;
  let ready = false;        // the shader programs have finished building
  let visible = true;
  let raf = 0;
  let stillRaf = 0;
  let live = false;         // first frame shown
  let target = null;
  let lay = null;           // measured layout
  let layStamp = 0;
  let dirty = true;
  let geoTier = -1;
  let quality = 1;          // lowered by the frame governor
  let counts = { strands: 0, glints: 0, riders: 0 };

  let clock = 0;
  let phA = 0;
  let phB = 0;
  let phS = 0;
  let travel = 0;
  let energy = 0;
  let energyTo = 0;
  let mode = 'idle';
  let voice = 0;
  let voiceTo = 0;
  let voiceAt = -1e9;
  const levels = new Float32Array(LV_N);
  let lvAcc = 0;
  let pulseFront = -1e5;
  let pulseT = -1;
  let pulseStrength = 0;
  let lastDraw = 0;
  let frames = 0;
  let slowFor = 0;
  let intervalEma = 16.7;

  // The app window's scroll scene, read from assets/motion each frame.
  let sceneEl = null;
  const tilt = { on: false, ox: 0, oy: 0, angle: 0, scale: 1, persp: 1400, progress: 1 };
  let sceneLast = -1;
  let sceneBoost = 0;
  let lineFade = 1;
  let landArmed = false;
  let landT = -1;
  let sceneMoving = false;
  let busy = false;         // anything beyond the calm drift: draw at full rate

  // ---------------------------------------------------------------------------
  // WebGL setup.
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  // Compile and link without asking for the result: asking makes the page
  // wait for the driver. With KHR_parallel_shader_compile the programs build
  // in the background and whenReady() only polls whether they are done.
  function program(vs, fs, attribs) {
    const p = gl.createProgram();
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    return { p, v, f, u: null, stamp: -1 };
  }

  function finishProgram(pr) {
    if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('voice-stream: ' + (gl.getShaderInfoLog(pr.v) || gl.getShaderInfoLog(pr.f) || gl.getProgramInfoLog(pr.p)));
    }
    const u = {};
    const n = gl.getProgramParameter(pr.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(pr.p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(pr.p, name);
    }
    pr.u = u;
  }

  function whenReady(done) {
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const poll = () => {
      if (!gl || lost) return;
      if (parallel) {
        for (const k in progs) {
          if (!gl.getProgramParameter(progs[k].p, parallel.COMPLETION_STATUS_KHR)) {
            requestAnimationFrame(poll);
            return;
          }
        }
      }
      try {
        for (const k in progs) finishProgram(progs[k]);
      } catch (_) {
        fallback();
        return;
      }
      ready = true;
      done();
    };
    poll();
  }

  function getContext() {
    const attrs = {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
    };
    let ctx = null;
    try { ctx = canvas.getContext('webgl2', attrs); } catch (_) { ctx = null; }
    if (ctx) {
      inst = {
        divisor: (loc, d) => ctx.vertexAttribDivisor(loc, d),
        draw: (mode_, first, count, n) => ctx.drawArraysInstanced(mode_, first, count, n),
      };
      return ctx;
    }
    try { ctx = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (_) { ctx = null; }
    if (!ctx) return null;
    const ext = ctx.getExtension('ANGLE_instanced_arrays');
    if (!ext) return null;
    inst = {
      divisor: (loc, d) => ext.vertexAttribDivisorANGLE(loc, d),
      draw: (mode_, first, count, n) => ext.drawArraysInstancedANGLE(mode_, first, count, n),
    };
    return ctx;
  }

  function buildResources() {
    ready = false;
    progs = {
      haze: program(HAZE_VS, HAZE_FS, ['aPos']),
      strand: program(STRAND_VS, STRAND_FS, ['aVert', 'aS0', 'aS1']),
      glint: program(GLINT_VS, GLINT_FS, ['aG0', 'aG1']),
    };
    const P = KNOBS.points;
    const strip = new Float32Array(P * 4);
    for (let i = 0; i < P; i++) {
      const t = i / (P - 1);
      strip.set([t, -1, t, 1], i * 4);
    }
    bufs = {
      tri: makeBuffer(new Float32Array([-1, -1, 3, -1, -1, 3])),
      strip: makeBuffer(strip),
      strands: gl.createBuffer(),
      glints: gl.createBuffer(),
    };
    geoTier = -1;
    for (const k in progs) progs[k].stamp = -1;
  }

  function makeBuffer(data) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  // One row of numbers per strand. The order is random, so drawing fewer
  // strands (the governor) keeps an even spread.
  function fillStrands(n) {
    const rnd = rng(0x5eed + n);
    const out = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const mist = rnd() < 0.2;
      const v = rnd() * 2 - 1;
      let u = mist ? Math.sign(v || 1) * (0.9 + Math.abs(v) * 0.9) : v * (0.5 + 0.5 * v * v);
      if (Math.abs(u) < 0.035) u = (u < 0 ? -1 : 1) * (0.035 + rnd() * 0.03);
      const depth = rnd();
      const reach = mist ? 0.3 + rnd() * 0.45 : 1 + Math.pow(rnd(), 1.8) * 0.95;
      const h = 0.6 + Math.pow(rnd(), 2.6) * 8;
      const halo = !mist && depth > 0.7 && Math.abs(u) < 0.45 && rnd() < 0.6 ? 0.1 + rnd() * 0.08 : 0;
      out.set([u, rnd(), depth, reach, h, halo, 0, 0], i * 8);
    }
    return out;
  }

  // Glints ride core strands; the riders sit at the end of the buffer and
  // are drawn only while a success pulse runs.
  function fillGlints(n, riders) {
    const rnd = rng(0x9117 + n);
    const out = new Float32Array((n + riders) * 8);
    for (let i = 0; i < n + riders; i++) {
      const rider = i >= n;
      const v = rnd() * 2 - 1;
      let u = v * (0.25 + 0.75 * v * v) * (rider ? 0.9 : 0.62);
      if (Math.abs(u) < 0.02) u = (rnd() < 0.5 ? -1 : 1) * 0.03;
      const reach = rider ? 1.25 + rnd() * 0.5 : 1.04 + Math.pow(rnd(), 1.6) * 0.26;
      // Twinkles are slow: each glint brightens and dims over 5 to 18 s.
      out.set([u, rnd(), 0.35 + 0.65 * rnd(), reach, 1 + rnd() * 5, rnd(), 0.35 + rnd() * 0.9, rider ? 1 : 0], i * 8);
    }
    return out;
  }

  function tierFor(width) {
    return width >= 1024 ? 0 : width >= 640 ? 1 : 2;
  }

  function ensureGeometry(width) {
    const tier = tierFor(width);
    if (tier === geoTier) return;
    geoTier = tier;
    const scale = lowEnd ? 0.7 : 1;
    const strands = userStrands > 0 ? userStrands : Math.round(KNOBS.strands[tier] * scale);
    counts = {
      strands,
      glints: Math.round(KNOBS.glints[tier] * scale),
      riders: KNOBS.riders[tier],
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.strands);
    gl.bufferData(gl.ARRAY_BUFFER, fillStrands(strands), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.glints);
    gl.bufferData(gl.ARRAY_BUFFER, fillGlints(counts.glints, counts.riders), gl.STATIC_DRAW);
  }

  // ---------------------------------------------------------------------------
  // Layout: where the stage and the window are, in canvas px. Nothing is
  // masked around the text: the strands keep the same light everywhere, so
  // no box or band can show; on narrow screens, where the hero's text sits
  // over the stream, the whole fall is simply quieter (lay.fall).
  function findTarget() {
    if (target && target.isConnected) return target;
    target = document.querySelector(TARGET);
    if (target && ro) ro.observe(target);
    return target;
  }

  function measure() {
    const sr = stage.getBoundingClientRect();
    const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    const lift = Math.max(0, Math.round(sr.top + scrollY));
    const ox = sr.left;
    const oy = sr.top - lift;               // the top of the page, in the viewport
    const W = Math.max(1, Math.round(sr.width));
    const full = Math.max(1, Math.round(sr.height + lift));

    const t = findTarget();
    let win = null;
    let sceneBox = null;
    let radius = 12;
    // The window's resting box: a scroll scene around it may have it tilted,
    // so its transform is lifted for the moment it takes to measure.
    sceneEl = t ? t.closest('[data-scene]') : null;
    const restore = sceneEl ? liftTransform(sceneEl) : null;
    if (t) {
      const r = restingRect(t);
      if (r.width > 40 && r.height > 24) {
        win = [r.left - ox, r.top - oy, r.right - ox, r.bottom - oy];
        const cs = getComputedStyle(t);
        const v = parseFloat(cs.getPropertyValue('--vx-window-radius'));
        radius = isFinite(v) ? v : parseFloat(cs.borderTopLeftRadius) || 12;
      }
    }
    if (sceneEl) {
      const r = restingRect(sceneEl);
      sceneBox = [r.left - ox, r.top - oy, r.right - ox, r.bottom - oy];
    }
    if (restore) restore();
    if (!win) {
      // No window yet: aim at where one would sit, centred below the hero.
      const w = Math.min(1180, W - 40);
      const y = Math.min(full * 0.62, 640);
      win = [(W - w) / 2, y, (W + w) / 2, y + w * 0.625];
    }
    radius = clamp(radius, 0, Math.min(win[2] - win[0], win[3] - win[1]) / 2);

    // The canvas ends just past where the light down the sides fades out
    // (the strands run 95 % of the way down, the rim sheen as far).
    const height = Math.round(clamp(win[1] + radius + (win[3] - win[1] - 2 * radius) * 0.97 + 30, 60, full));

    // How far the hero's text reaches toward the bright core of the fall.
    // Where it does (narrower screens), the whole fall is quieter: one number
    // for all of it, so there is never a shape around the text.
    let reach = 0;
    const words = stage.querySelectorAll('h1, h2, p, .btn');
    for (let i = 0; i < words.length; i++) {
      const el = words[i];
      if (el.closest('[data-voxden-demo]') || mount.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.bottom - oy < win[1]) reach = Math.max(reach, r.right - ox);
    }
    const core = W / 2 - clamp(0.04 * W, 22, 64) * 1.6;
    const over = clamp((reach - core) / 120, 0, 1);

    const Hf = win[1] + 12;
    lay = {
      lift, W, H: height, win, radius, scene: sceneBox,
      srcX: W / 2,
      startY: -12,
      topHalf: clamp(0.15 * W, 64, 280),
      waist: clamp(0.04 * W, 22, 64),
      waistY: clamp(0.4 * Hf, 120, 300),
      lvSpacing: Math.max(26, (Hf + 520) / (LV_N - 2)),
      fall: 1 - over * (tierFor(W) === 2 ? 0.64 : 0.55),
    };
    layStamp++;

    mount.style.setProperty('--vs-lift', lift + 'px');
    mount.style.setProperty('--vs-x', Math.round((win[0] + win[2]) / 2) + 'px');
    mount.style.setProperty('--vs-y', Math.round(win[1]) + 'px');
    mount.style.setProperty('--vs-w', Math.round(win[2] - win[0]) + 'px');
    layoutKey = keyNow();
  }

  // Lifts an element's transform (inline !important beats a CSS animation)
  // and returns the undo. Used only while measuring.
  function liftTransform(el) {
    const prev = el.style.getPropertyValue('transform');
    const prio = el.style.getPropertyPriority('transform');
    el.style.setProperty('transform', 'none', 'important');
    return () => {
      if (prev) el.style.setProperty('transform', prev, prio);
      else el.style.removeProperty('transform');
    };
  }

  // An element's box without the shift that a transition is still giving it
  // or an ancestor (a reveal rising into place under 720 px). A running
  // transition outranks even liftTransform's !important, so a plain shift
  // is read back and taken off; any other transform is measured again when
  // its transition ends (see init).
  const SHIFT = /^matrix\(1, 0, 0, 1, (-?[\d.e-]+), (-?[\d.e-]+)\)$/;
  function transitioning(n) {
    const list = n.getAnimations ? n.getAnimations() : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].transitionProperty === 'transform' && list[i].playState === 'running') return true;
    }
    return false;
  }
  function restingRect(el) {
    const r = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    for (let n = el; n && n !== stage && n !== document.body; n = n.parentElement) {
      if (!transitioning(n)) continue;
      const m = SHIFT.exec(getComputedStyle(n).transform);
      if (m) {
        dx += parseFloat(m[1]) || 0;
        dy += parseFloat(m[2]) || 0;
      }
    }
    return { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy, width: r.width, height: r.height };
  }

  // Is this transition one that moves the window: on it or an ancestor, and
  // of a property that shifts boxes?
  const MOVERS = { transform: 1, translate: 1, scale: 1, rotate: 1 };
  function movesWindow(e) {
    if (!e || !MOVERS[e.propertyName] || !e.target || !e.target.contains) return false;
    const t = document.querySelector(TARGET);
    return !!(t && e.target.contains(t));
  }

  // Layout offsets ignore transforms, so the tilting window cannot make the
  // layout look changed.
  function offsetPos(el) {
    let x = 0;
    let y = 0;
    for (let n = el; n; n = n.offsetParent) {
      x += n.offsetLeft + (n === el ? 0 : n.clientLeft);
      y += n.offsetTop + (n === el ? 0 : n.clientTop);
    }
    return [x, y];
  }

  let layoutKey = '';
  function keyNow() {
    const sr = stage.getBoundingClientRect();
    const t = target && target.isConnected ? target : null;
    const tp = t ? offsetPos(t) : [0, 0];
    const h1 = stage.querySelector('h1');
    const hr = h1 ? h1.getBoundingClientRect() : null;
    return [sr.width, sr.height, tp[0], tp[1], t ? t.offsetWidth : 0, t ? t.offsetHeight : 0,
      hr ? hr.bottom - sr.top : 0, hr ? hr.right : 0, (window.devicePixelRatio || 1) * 100].map(Math.round).join(',');
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, KNOBS.dprCap) * (quality < 1 ? 0.85 : 1);
    let bw = Math.max(1, Math.round(lay.W * dpr));
    let bh = Math.max(1, Math.round(lay.H * dpr));
    if (bw * bh > KNOBS.maxPixels) {
      const k = Math.sqrt(KNOBS.maxPixels / (bw * bh));
      bw = Math.floor(bw * k);
      bh = Math.floor(bh * k);
    }
    lay.dpr = bw / lay.W;
    lay.bw = bw;
    lay.bh = bh;
    canvas.style.width = lay.W + 'px';
    canvas.style.height = lay.H + 'px';
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    // The haze and rim need only the stream's box above the window and two
    // strips beside it; the window hides everything inside its edge.
    const w = lay.win;
    const x0 = Math.max(0, Math.min(w[0], lay.srcX - lay.topHalf * 1.9) - 170);
    const x1 = Math.min(lay.W, Math.max(w[2], lay.srcX + lay.topHalf * 1.9) + 170);
    const split = Math.min(lay.H, w[1] + lay.radius + 2);
    const rect = (ax, ay, bx, by) => {
      const sx = Math.max(0, Math.floor(ax * lay.dpr));
      const sy = Math.max(0, Math.floor((lay.H - by) * lay.dpr));
      return [sx, sy, Math.max(0, Math.ceil(bx * lay.dpr) - sx), Math.max(0, Math.ceil((lay.H - ay) * lay.dpr) - sy)];
    };
    lay.scissors = [rect(x0, 0, x1, split)];
    if (split < lay.H) {
      lay.scissors.push(rect(x0, split, Math.min(x1, w[0] + 3), lay.H));
      lay.scissors.push(rect(Math.max(x0, w[2] - 3), split, x1, lay.H));
    }
    // A tilted window's edges run inside its resting box: draw the lot.
    lay.scissorsTilted = [rect(x0, 0, x1, lay.H)];
  }

  // ---------------------------------------------------------------------------
  // Motion.
  function breath(t) {
    return 0.17 + 0.07 * Math.sin(t * 0.5) + 0.05 * Math.sin(t * 0.23 + 1.3) + 0.03 * Math.sin(t * 1.1 + 0.4);
  }

  function step(dt) {
    clock += dt;
    energy += (energyTo - energy) * (1 - Math.exp(-dt / (energyTo > energy ? 0.3 : 0.95)));
    const now = performance.now();
    if (mode !== 'recording' || now - voiceAt > 600) voiceTo *= Math.exp(-dt / 0.22);
    voice += (voiceTo - voice) * (1 - Math.exp(-dt / (voiceTo > voice ? 0.045 : 0.15)));
    const listening = mode === 'recording' ? 1 : 0;
    const sample = Math.max(breath(clock) * (1 - 0.8 * energy), voice * (0.35 + 0.65 * listening) + (mode === 'recording' ? 0.12 : 0));
    readScene(dt);
    // Light eases down the strands at a rate set by the dictation state
    // alone, and the ripple's folds travel slower still. Both are integrated,
    // so a change of rate never jumps anything, and scrolling plays no part.
    const live = KNOBS.flowLive - KNOBS.flowRest;
    const dist = (KNOBS.flowRest + live * energy) * dt;
    const fold = (KNOBS.rippleRest + live * energy) * dt;

    lvAcc += dist;
    const spacing = lay ? lay.lvSpacing : 26;
    let guard = 0;
    while (lvAcc >= spacing && guard++ < LV_N) {
      lvAcc -= spacing;
      levels.copyWithin(1, 0, LV_N - 1);
      levels[0] = sample;
    }
    if (lvAcc >= spacing) lvAcc = 0;
    // The newest sample tracks the live level, so the top reacts at once.
    levels[0] = levels[0] + (sample - levels[0]) * 0.5;

    phA = (phA + fold * 0.0331) % TAU;
    phB = (phB + fold * 0.0571 * 0.55) % TAU;
    phS = (phS + dist * 0.0121) % TAU;
    travel = (travel + dist * 0.9) % 1e6;

    if (pulseT >= 0) {
      pulseT += dt;
      pulseFront += KNOBS.pulseSpeed * dt;
      pulseStrength = Math.max(0, 1 - pulseT / 1.7);
      pulseStrength *= pulseStrength;
      if (pulseT > 1.7) {
        pulseT = -1;
        pulseFront = -1e5;
        pulseStrength = 0;
        if (mode === 'success') energyTo = 0;
      }
    }
  }

  function startPulse() {
    pulseT = 0;
    pulseFront = 0;
    pulseStrength = 1;
  }

  // The app window's scroll scene (assets/motion): how far it lies back,
  // read each frame as a plain scroll calculation, no layout.
  function readScene(dt) {
    const api = window.VoxdenMotion;
    const s = sceneEl && lay && lay.scene && api && typeof api.scene === 'function' ? api.scene() : null;
    if (!s || s.el !== sceneEl) {
      tilt.on = false;
      tilt.angle = 0;
      tilt.scale = 1;
      tilt.progress = 1;
    } else {
      tilt.on = s.angle > 1e-5 || s.scale < 0.99999;
      tilt.ox = (lay.scene[0] + lay.scene[2]) / 2;
      tilt.oy = lay.scene[3];
      tilt.angle = s.angle;
      tilt.scale = s.scale;
      tilt.persp = s.perspective;
      tilt.progress = s.progress;
    }
    const p = tilt.progress;
    const moving = sceneLast >= 0 && Math.abs(p - sceneLast) > 0.0005;
    sceneMoving = moving;
    sceneLast = p;
    // The crisp rim line steps aside while the tilt moves (the compositor
    // can run a frame ahead of this canvas) and returns as the window rests.
    const lineTo = tilt.on && moving ? 0 : 1;
    lineFade += (lineTo - lineFade) * (1 - Math.exp(-dt / (lineTo < lineFade ? 0.05 : 0.22)));
    const b = clamp((p - 0.72) / 0.28, 0, 1);
    sceneBoost = b * b * (3 - 2 * b);
    // The energy lands: the rim flares once as the window settles flat.
    if (p < 0.9) landArmed = true;
    if (landArmed && p >= 0.985) {
      landArmed = false;
      landT = 0;
    }
    if (landT >= 0) {
      landT += dt;
      if (landT > 1.4) landT = -1;
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing.
  const colors = {};
  for (const k in PALETTE) colors[k] = rgb(PALETTE[k]);

  function setLayoutUniforms(pr) {
    const u = pr.u;
    const L = lay;
    gl.uniform2f(u.uRes, L.W, L.H);
    gl.uniform1f(u.uDpr, L.dpr);
    gl.uniform4f(u.uWin, L.win[0], L.win[1], L.win[2], L.win[3]);
    gl.uniform4f(u.uGeo, L.srcX, L.startY, L.radius, L.lvSpacing);
    if (u.uFall) gl.uniform1f(u.uFall, L.fall);
    gl.uniform3fv(u.uHot, colors.hot);
    gl.uniform3fv(u.uCore, colors.core);
    gl.uniform3fv(u.uMid, colors.mid);
    gl.uniform3fv(u.uEdge, colors.edge);
    gl.uniform3fv(u.uDeep, colors.deep);
    pr.stamp = layStamp;
  }

  // The history as uploaded: smoothed along the stream ([1 4 6 4 1] / 16),
  // so a sudden syllable swells the strands instead of kinking them.
  const smoothLv = new Float32Array(LV_N);
  function lvAt(k) {
    return levels[k < 0 ? 0 : k >= LV_N ? LV_N - 1 : k];
  }
  function smoothLevels() {
    for (let i = 0; i < LV_N; i++) {
      smoothLv[i] = (lvAt(i - 2) + 4 * lvAt(i - 1) + 6 * levels[i] + 4 * lvAt(i + 1) + lvAt(i + 2)) / 16;
    }
  }

  function setFrameUniforms(pr) {
    const u = pr.u;
    if (pr.stamp !== layStamp) setLayoutUniforms(pr);
    gl.uniform4f(u.uShape, lay.topHalf, lay.waist, lay.waistY, 0.15 * energy);
    gl.uniform4f(u.uFx, energy, pulseFront, pulseStrength, gain * (1 + KNOBS.sceneBoost * sceneBoost));
    if (tilt.on) gl.uniform4f(u.uTilt, tilt.ox, tilt.oy, tilt.angle, tilt.scale);
    else gl.uniform4f(u.uTilt, 0, 0, 0, 1);
    gl.uniform1f(u.uPersp, tilt.persp);
    if (u.uPh) gl.uniform4f(u.uPh, phA, phB, phS, clock % 6283.185);
    if (u.uLv) {
      gl.uniform4fv(u.uLv, smoothLv);
      gl.uniform1f(u.uLvOff, lvAcc / lay.lvSpacing);
    }
  }

  function bindAttrib(loc, buf, size, stride, offset, divisor) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    inst.divisor(loc, divisor);
  }

  function resetAttribs(n) {
    for (let i = 0; i < n; i++) {
      inst.divisor(i, 0);
      gl.disableVertexAttribArray(i);
    }
  }

  function draw() {
    if (!gl || lost || !lay || !ready) return;
    smoothLevels();
    gl.viewport(0, 0, lay.bw, lay.bh);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Haze and rim: the first thing drawn, so it simply writes.
    const hz = progs.haze;
    gl.useProgram(hz.p);
    setFrameUniforms(hz);
    // A flare runs out along the rim: the success pulse arriving, or the
    // window settling flat in its scroll scene.
    let flareFront = pulseFront - (lay.win[1] - lay.startY);
    let flare = flareFront > -80 ? pulseStrength * 1.4 : 0;
    if (!flare && landT >= 0) {
      const k = 1 - landT / 1.4;
      flareFront = landT * 1400 - 60;
      flare = 1.1 * k * k;
    }
    gl.uniform4f(hz.u.uRim,
      (0.7 + 0.4 * energy + 0.3 * voice) * (1 + 0.35 * sceneBoost),
      flareFront,
      flare,
      KNOBS.haze * (1 + 0.8 * energy));
    gl.uniform1f(hz.u.uLine, lineFade);
    bindAttrib(0, bufs.tri, 2, 0, 0, 0);
    gl.enable(gl.SCISSOR_TEST);
    const scissors = tilt.on ? lay.scissorsTilted : lay.scissors;
    for (let i = 0; i < scissors.length; i++) {
      const s = scissors[i];
      if (s[2] < 1 || s[3] < 1) continue;
      gl.scissor(s[0], s[1], s[2], s[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
    resetAttribs(1);

    // Strands and glints add their light.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Strands.
    const st = progs.strand;
    gl.useProgram(st.p);
    setFrameUniforms(st);
    bindAttrib(0, bufs.strip, 2, 0, 0, 0);
    bindAttrib(1, bufs.strands, 4, 32, 0, 1);
    bindAttrib(2, bufs.strands, 4, 32, 16, 1);
    const n = Math.max(1, Math.round(counts.strands * quality));
    inst.draw(gl.TRIANGLE_STRIP, 0, KNOBS.points * 2, n);
    resetAttribs(3);

    // Glints.
    const gp = progs.glint;
    gl.useProgram(gp.p);
    setFrameUniforms(gp);
    gl.uniform1f(gp.u.uTravel, travel);
    gl.uniform1f(gp.u.uGlint, 1);
    bindAttrib(0, bufs.glints, 4, 32, 0, 0);
    bindAttrib(1, bufs.glints, 4, 32, 16, 0);
    gl.uniform1f(gp.u.uStill, reduced ? 1 : 0);
    // The riders sit after the regular glints and only ride a pulse.
    const g = reduced ? Math.min(counts.glints, 14)
      : counts.glints + (pulseStrength > 0.002 ? counts.riders : 0);
    gl.drawArrays(gl.POINTS, 0, g);
    resetAttribs(2);

    if (!live) {
      live = true;
      mount.classList.add('is-live');
    }
  }

  function applyLayout() {
    measure();
    ensureGeometry(lay.W);
    sizeCanvas();
    dirty = false;
  }

  // ---------------------------------------------------------------------------
  // The loop runs only while the stream is on screen, the tab is visible and
  // motion is welcome. Reduced motion gets single still frames.
  // The calm drift needs no more than 30 frames a second (the rate the
  // previous voxden.app wave ran at); recording, a pulse, a landing or a
  // window tilting with the scroll get the full rate.
  // The calm gap leaves 4 ms for timer jitter, so a 60 Hz screen draws every
  // second refresh evenly instead of now and then waiting for a third.
  function frameGap() {
    return busy ? FRAME_MIN_MS : 1000 / KNOBS.fpsCalm - 4;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const gap = frameGap();
    if (lastDraw && now - lastDraw < gap) return;
    const interval = lastDraw ? now - lastDraw : gap;
    const dt = Math.min(interval / 1000, 0.05);
    lastDraw = now;
    frames++;
    if (dirty || (frames % 30 === 0 && keyNow() !== layoutKey)) applyLayout();
    step(dt);
    draw();
    busy = energy > 0.01 || energyTo > 0 || pulseT >= 0 || landT >= 0 || sceneMoving;
    govern(interval, gap);
  }

  // If frames stay well behind the rate asked for, draw fewer strands at a
  // lower resolution, once.
  function govern(interval, gap) {
    if (frames < 90 || quality < 1) return;
    intervalEma += (interval - intervalEma) * 0.05;
    slowFor = intervalEma > Math.max(28, Math.max(gap, 16.7) * 1.5) ? slowFor + 1 : 0;
    if (slowFor > 120) {
      quality = 0.65;
      dirty = true;
    }
  }

  function shouldRun() {
    return !!gl && ready && !lost && visible && !document.hidden && !reduced;
  }

  function sync() {
    if (shouldRun()) {
      if (!raf) {
        lastDraw = 0;
        sceneLast = -1;
        raf = requestAnimationFrame(frame);
      }
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (reduced && gl && !lost) still();
    }
  }

  // One still frame, as a visitor asking for reduced motion sees it: a
  // calm moment of the flow with a handful of glints.
  function still() {
    if (stillRaf) return;
    stillRaf = requestAnimationFrame(() => {
      stillRaf = 0;
      if (!gl || lost || !ready) return;
      if (dirty || keyNow() !== layoutKey) applyLayout();
      const keep = [clock, phA, phB, phS, travel];
      clock = 7.3;
      phA = 2.1;
      phB = 4.4;
      phS = 1.2;
      travel = 5200;
      if (pulseT < 0) {
        levels.fill(0.2);
        energy = energyTo;
      }
      draw();
      [clock, phA, phB, phS, travel] = keep;
    });
  }

  // ---------------------------------------------------------------------------
  // Observers and events.
  let ro = null;

  function onScreen() {
    const r = mount.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return r.width > 0 && r.bottom > -80 && r.top < vh + 80;
  }

  function onLayoutChange() {
    dirty = true;
    if (!gl || lost || !ready) return;
    // The IntersectionObserver drives visibility; a layout change re-checks
    // it from geometry so a missed callback can never leave the loop off.
    visible = onScreen();
    sync();
    if (raf) {
      // Resize and redraw in this frame, so the canvas never shows stretched.
      applyLayout();
      draw();
    } else if (reduced) {
      still();
    }
  }

  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    const onChange = () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
      onLayoutChange();
      watchDpr();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function onDictation(e) {
    const state = e && e.detail && e.detail.state;
    if (state === 'recording') {
      energyTo = 1;
      if (mode !== 'recording') voiceTo = Math.max(voiceTo, 0.25);
    } else if (state === 'transcribing') {
      energyTo = 0.55;
    } else if (state === 'success') {
      energyTo = 0.35;
      if (!reduced) startPulse();
    } else if (state === 'idle') {
      energyTo = 0;
    } else {
      return;
    }
    mode = state;
    if (reduced) {
      energy = energyTo;
      still();
    }
  }

  function onLevel(e) {
    const v = e && e.detail ? Number(e.detail.level) : NaN;
    if (!isFinite(v)) return;
    voiceTo = clamp(v, 0, 1);
    voiceAt = performance.now();
  }

  // ---------------------------------------------------------------------------
  // Without WebGL: the stylesheet's still gradients (.is-fallback). Its two
  // drawn pieces are placed by transform only, and the pool of light on the
  // window's top edge follows the window while it tilts in its scene.
  let fb = null;
  let fbKey = '';
  let fbRaf = 0;
  let fbVisible = true;

  function fallback() {
    mount.classList.add('is-fallback');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    gl = null;
    try { measureFallback(); } catch (_) { /* the gradients have defaults */ }
    if (window.ResizeObserver) {
      const r = new ResizeObserver(() => measureFallback());
      r.observe(stage);
      const t = document.querySelector(TARGET);
      if (t) r.observe(t);
    }
    const onMoved = (e) => { if (movesWindow(e)) measureFallback(); };
    stage.addEventListener('transitionend', onMoved);
    stage.addEventListener('transitioncancel', onMoved);
    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => {
        fbVisible = entries[entries.length - 1].isIntersecting;
        fallbackTick();
      }).observe(mount);
    }
    document.addEventListener('visibilitychange', fallbackTick);
    fallbackTick();
  }

  function measureFallback() {
    const sr = stage.getBoundingClientRect();
    const scrollY = window.pageYOffset || 0;
    const lift = Math.max(0, Math.round(sr.top + scrollY));
    mount.style.setProperty('--vs-lift', lift + 'px');
    const t = document.querySelector(TARGET);
    if (!t) return;
    const scene = t.closest('[data-scene]');
    const restore = scene ? liftTransform(scene) : null;
    const r = restingRect(t);
    const s = scene ? restingRect(scene) : r;
    if (restore) restore();
    const top = r.top - sr.top + lift;
    fb = { cx: (r.left + r.right) / 2 - sr.left, top, w: r.width, h: s.bottom - r.top, scene };
    mount.style.setProperty('--vs-x', Math.round(fb.cx) + 'px');
    mount.style.setProperty('--vs-y', Math.round(top) + 'px');
    mount.style.setProperty('--vs-w', Math.round(r.width) + 'px');
    mount.style.setProperty('--vs-comb', (Math.max(top, 0) / 1000).toFixed(4));
    fbKey = '';
    placePool();
  }

  // The pool sits on the window's top edge as the scene projects it: the
  // same perspective, rotateX and scale about the window's bottom centre.
  function placePool() {
    if (!fb) return;
    let drop = 0;
    let sx = 1;
    const api = window.VoxdenMotion;
    const s = fb.scene && api && typeof api.scene === 'function' ? api.scene() : null;
    if (s && s.el === fb.scene) {
      const k = s.perspective / (s.perspective + s.scale * fb.h * Math.sin(s.angle));
      drop = fb.h - s.scale * Math.cos(s.angle) * fb.h * k;
      sx = s.scale * k;
    }
    const w = fb.w * sx;
    const lx = (fb.cx - w / 2).toFixed(1);
    const ly = (fb.top + drop - 90).toFixed(1);
    const ls = (w / 1000).toFixed(4);
    const key = lx + ' ' + ly + ' ' + ls;
    if (key === fbKey) return;
    fbKey = key;
    mount.style.setProperty('--vs-lx', lx + 'px');
    mount.style.setProperty('--vs-ly', ly + 'px');
    mount.style.setProperty('--vs-ls', ls);
  }

  function fallbackTick() {
    if (fbRaf) return;
    fbRaf = requestAnimationFrame(function loop() {
      fbRaf = 0;
      placePool();
      if (fbVisible && fb && fb.scene && !reduced && !document.hidden) fbRaf = requestAnimationFrame(loop);
    });
  }

  function init() {
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(canvas);
    gl = getContext();
    if (!gl) return fallback();
    try {
      buildResources();
    } catch (_) {
      return fallback();
    }

    // Once the programs have built: measure, then draw or start the loop.
    const start = () => {
      dirty = true;
      try {
        applyLayout();
      } catch (_) {
        fallback();
        return;
      }
      if (reduced) still();
      sync();
    };

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lost = true;
      ready = false;
      sync();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      lost = false;
      try {
        buildResources();
      } catch (_) {
        return fallback();
      }
      whenReady(start);
    });

    if (window.ResizeObserver) {
      ro = new ResizeObserver(onLayoutChange);
      ro.observe(stage);
      if (target) ro.observe(target);
    } else {
      window.addEventListener('resize', onLayoutChange);
    }
    watchDpr();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onLayoutChange).catch(() => {});
    window.addEventListener('load', onLayoutChange);
    // Transforms move no layout, so no observer sees a reveal carry the
    // window into place: measure again when such a transition ends.
    const onMoved = (e) => { if (movesWindow(e)) onLayoutChange(); };
    stage.addEventListener('transitionend', onMoved);
    stage.addEventListener('transitioncancel', onMoved);

    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        sync();
      }, { rootMargin: '80px 0px' }).observe(mount);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) visible = onScreen();
      sync();
    });
    if (reducedMQ) {
      const onMotion = () => {
        reduced = reducedMQ.matches;
        sync();
      };
      if (reducedMQ.addEventListener) reducedMQ.addEventListener('change', onMotion);
      else if (reducedMQ.addListener) reducedMQ.addListener(onMotion);
    }
    document.addEventListener('voxden:dictation', onDictation);
    document.addEventListener('voxden:voice-level', onLevel);

    levels.fill(0.18);
    whenReady(start);
  }

  init();
})();
