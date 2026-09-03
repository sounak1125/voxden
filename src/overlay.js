'use strict';

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const btnCancel = document.getElementById('btn-cancel');
const btnConfirm = document.getElementById('btn-confirm');
const dragHandle = document.getElementById('flow-drag');
const settingsBtn = document.getElementById('flow-settings');
const waveBars = Array.from(document.querySelectorAll('#wave i'));

let capturing = false;
let mediaStream = null;
let audioCtx = null;
let analyser = null;
let processor = null;
let captureSink = null;
let sourceNode = null;
let pcmChunks = [];
let inputSampleRate = 48000;
let raf = 0;
let recognition = null;
let webText = '';
let webResultIndex = 0;
let engine = 'webspeech';
let engineStatus = 'starting';
let stopRequested = false;
let hideToken = 0;
let hideFallback = 0;
let alwaysShowFlowBar = false;
let hudMode = 'idle';
let overInteractive = false;
let ignoreMouse = null;
let enterTimer = 0;
let soundsEnabled = true;
let shortcutLabel = 'Ctrl+Shift+Space';
// Push to talk that was tapped rather than held stays on until the next press.
let pttLocked = false;

function recordingTitle(dictateMode) {
  return dictateMode === 'ptt' && !pttLocked
    ? 'Release ' + shortcutLabel + ' to finish'
    : 'Press ' + shortcutLabel + ' again to finish';
}
let micDeviceId = 'default';
let sfxCtx = null;
let dragging = false;
let dragPointerId = null;
let idleFaceTimer = 0;
let idleFaceSteps = [];
let idleFacePlaying = false;
// Lead with the new variation after launch so it is discoverable without
// waiting through two complete idle cycles. Later appearances alternate.
let nextIdleFaceVariant = 'listen';

// Idle easter egg. IDLE_FACE_MORPH_MS must match --morph in overlay.css.
const IDLE_FACE_DELAY_MS = 22000;
const IDLE_FACE_MORPH_MS = 340;
const IDLE_FACE_HOLD_MS = 3600;
const IDLE_LISTEN_HOLD_MS = 4400;

// Hover target, in window coordinates. Fixed rects rather than the pill's own
// box: the pill resizes when it expands, and measuring it would move the edge of
// the hot zone under the cursor and flicker.
//
// Two rects, because one cannot be both tight and stable. The enter rect hugs
// the resting bar so the mic only appears when you are actually on it; the stay
// rect covers everything the bar opens into -- the 32px circle plus the gear
// and the grip either side of it -- so the cursor cannot fall out of its own
// hover target by moving towards a button that only exists once it is inside.
//
// The stay rect strictly contains the enter rect, which is what keeps this from
// oscillating: crossing an edge can only ever be entering the larger one or
// leaving it, never both in the same frame.
const HOVER_ENTER_W = 62;    // bar is 52 wide, plus 5px of slack each side
const HOVER_STAY_W = 120;    // must reach past the gear and the grip either side
const HOVER_ENTER_H = 26;    // bar is 6 tall, sitting HOVER_BOTTOM off the floor
const HOVER_STAY_H = 46;     // must cover the expanded 32px circle
const HOVER_BOTTOM = 10;     // gap from the zone's floor to the window edge

let canRetry = false;
let dictationQuality = 'auto';
let successEntryId = '';
let lastSuccessText = '';
let editingSuccess = false;
let cancelSuccessEdit = false;
const OUT_RATE = 16000;
const MIN_SLICE_SEC = 0.3;
const MIN_SLICE_SAMPLES = Math.round(MIN_SLICE_SEC * OUT_RATE);

let captureGen = 0;
let dsPcmChunks = [];
let chunker = null;
let chunkJobs = [];
// The audio of each committed slice, kept so a boundary that could not be
// stitched from text alone can be re-recognised from the recording that
// crosses it. Dropped with the rest of the chunk state at the end of every
// dictation; nothing here outlives the utterance.
let chunkSlices = [];

// The cue's output device is opened once, while nothing is happening, rather
// than on the first dictation -- where it used to sit between the microphone
// coming up and the waveform appearing.
function ensureSfxContext() {
  if (sfxCtx) return sfxCtx;
  try {
    sfxCtx = new AudioContext();
  } catch (_) {
    sfxCtx = null;
  }
  return sfxCtx;
}

function playCue(kind) {
  if (!soundsEnabled) return;
  try {
    const ctx = ensureSfxContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const freqs = { start: 520, success: 740, error: 220 };
    osc.frequency.value = freqs[kind] || 440;
    osc.type = kind === 'error' ? 'square' : 'sine';
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.07, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'success' ? 0.12 : 0.08));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  } catch (_) {}
}

function isActiveHud(mode) {
  const m = mode || hudMode;
  return m === 'arming' || m === 'recording' || m === 'transcribing' || m === 'success' || m === 'error'
    || m === 'cancel' || editingSuccess;
}

function inHoverZone(x, y) {
  const width = overInteractive ? HOVER_STAY_W : HOVER_ENTER_W;
  const left = (window.innerWidth - width) / 2;
  if (x < left || x > left + width) return false;
  const bottom = window.innerHeight - HOVER_BOTTOM;
  const height = overInteractive ? HOVER_STAY_H : HOVER_ENTER_H;
  return y >= bottom - height && y <= bottom;
}

function setIgnoreMouse(ignore) {
  if (!window.voxden || typeof window.voxden.setIgnoreMouse !== 'function') return;
  if (ignoreMouse === ignore) return;
  ignoreMouse = ignore;
  window.voxden.setIgnoreMouse(ignore);
}

function syncFlowVisual() {
  document.body.classList.toggle('always-flow', alwaysShowFlowBar);
  // Gates the gear and the grip: they share the space every other pill state
  // grows into, so they only exist alongside the resting bar.
  document.body.classList.toggle('flow-idle', hudMode === 'idle');
  const expanded = !alwaysShowFlowBar || hudMode !== 'idle' || overInteractive || dragging;
  document.body.classList.toggle('flow-expanded', expanded);
  const capture = overInteractive || dragging || isActiveHud();
  setIgnoreMouse(!capture);
}

function canPlayIdleFace() {
  return alwaysShowFlowBar
    && hudMode === 'idle'
    && !overInteractive
    && !dragging
    && !idleFacePlaying
    && document.body.classList.contains('shown')
    && !document.body.classList.contains('hiding');
}

function clearIdleFaceSteps() {
  for (const t of idleFaceSteps) clearTimeout(t);
  idleFaceSteps = [];
}

function stepIdleFace(fn, ms) {
  idleFaceSteps.push(setTimeout(fn, ms));
}

function startIdleFace() {
  if (!canPlayIdleFace()) {
    scheduleIdleFace();
    return;
  }
  idleFacePlaying = true;
  const listening = nextIdleFaceVariant === 'listen';
  const holdMs = listening ? IDLE_LISTEN_HOLD_MS : IDLE_FACE_HOLD_MS;
  nextIdleFaceVariant = listening ? 'look' : 'listen';
  // Each beat is its own class swap so CSS transitions carry the motion:
  // puff up into the face, open the eyes (and optionally the headphones), close
  // them, then settle back to the bar. Variations alternate so both are seen.
  document.body.classList.toggle('flow-listening', listening);
  document.body.classList.add('flow-face');
  stepIdleFace(() => document.body.classList.add('flow-face-open'), IDLE_FACE_MORPH_MS);
  stepIdleFace(() => document.body.classList.remove('flow-face-open'), IDLE_FACE_MORPH_MS + holdMs);
  stepIdleFace(finishIdleFace, IDLE_FACE_MORPH_MS + holdMs + 240);
}

function finishIdleFace() {
  clearIdleFaceSteps();
  idleFacePlaying = false;
  document.body.classList.remove('flow-face', 'flow-face-open', 'flow-listening');
  scheduleIdleFace();
}

function abortIdleFace() {
  clearIdleFaceSteps();
  idleFacePlaying = false;
  document.body.classList.remove('flow-face', 'flow-face-open', 'flow-listening');
}

function scheduleIdleFace() {
  if (idleFaceTimer || idleFacePlaying) return;
  if (!canPlayIdleFace()) return;
  idleFaceTimer = setTimeout(() => {
    idleFaceTimer = 0;
    startIdleFace();
  }, IDLE_FACE_DELAY_MS);
}

function resetIdleFace() {
  abortIdleFace();
  if (idleFaceTimer) {
    clearTimeout(idleFaceTimer);
    idleFaceTimer = 0;
  }
}

// Hover comes from the main process polling the OS cursor. DOM mouse events are
// not usable here: the overlay sits in setIgnoreMouseEvents(true, {forward:true})
// most of the time, which forwards mousemove but never delivers mouseleave, so
// any hover flag set from mousemove would latch on forever.
function onCursor(pos) {
  // While the bar is being carried the window is chasing the cursor, so its
  // own idea of where the pointer sits inside it is a frame stale. Acting on
  // that would collapse the bar back to a 6px line mid-drag.
  if (dragging) return;
  // Main decides hover now, with the same rects, and only reports a change.
  // The local test stays as the fallback for an older main process.
  const next = (pos && typeof pos.hover === 'boolean')
    ? pos.hover
    : !!(pos && pos.inside) && inHoverZone(pos.x, pos.y);
  if (next === overInteractive) return;
  overInteractive = next;
  if (next) resetIdleFace();
  else {
    scheduleIdleFace();
    if (hudMode === 'idle') pulseGlow();
  }
  syncFlowVisual();
}

// The resting bar's glow breathes a few times, then holds still: an endless
// pulse cost a fifth of a core between the renderer and the GPU process for
// as long as the app ran. It plays when the bar appears and when a hover
// ends, and the class comes off when the animation says it is done.
function pulseGlow() {
  if (!alwaysShowFlowBar) return;
  document.body.classList.remove('flow-pulse');
  void pill.offsetWidth;
  document.body.classList.add('flow-pulse');
}

pill.addEventListener('animationend', (ev) => {
  if (ev.animationName === 'glowPulse') document.body.classList.remove('flow-pulse');
});

function popIn() {
  if (hideFallback) {
    clearTimeout(hideFallback);
    hideFallback = 0;
  }
  document.body.classList.remove('hiding');
  if (document.body.classList.contains('shown')) {
    syncFlowVisual();
    scheduleIdleFace();
    return;
  }
  pulseGlow();
  // Bump the token only when we actually start an entrance. Bumping it on the
  // already-shown path invalidated the pending `done` of the entrance still in
  // flight, so `entering` stuck and left popIn's forwards-fill pinning the
  // pill's opacity/transform. State updates arrive in pairs (reveal + mode),
  // so that path is hit on every single reveal.
  hideToken += 1;
  void pill.offsetWidth;
  document.body.classList.add('shown', 'entering');
  const token = hideToken;
  function done(ev) {
    if (ev && ev.target !== pill) return;
    if (ev && ev.animationName && ev.animationName !== 'popIn') return;
    // A superseded entrance still has to let go of the pill: returning
    // without removing the listener left one dead closure attached per
    // show/hide, and every later animation end ran all of them.
    pill.removeEventListener('animationend', done);
    if (token !== hideToken) return;
    if (enterTimer) {
      clearTimeout(enterTimer);
      enterTimer = 0;
    }
    document.body.classList.remove('entering');
  }
  pill.addEventListener('animationend', done);
  if (enterTimer) clearTimeout(enterTimer);
  enterTimer = setTimeout(() => done(), 420);
  syncFlowVisual();
  scheduleIdleFace();
}

function popOut() {
  // A bar on its way off screen is not being carried any more, whatever the
  // pointer is still doing.
  endFlowDrag();
  resetIdleFace();
  if (!document.body.classList.contains('shown')) {
    document.body.classList.remove('hiding', 'entering');
    window.voxden.hudHidden();
    return;
  }
  const token = ++hideToken;
  if (enterTimer) {
    clearTimeout(enterTimer);
    enterTimer = 0;
  }
  document.body.classList.remove('shown', 'entering', 'flow-expanded', 'flow-face', 'flow-face-open', 'flow-listening', 'flow-dragging', 'flow-pulse');
  document.body.classList.add('hiding');
  function finish(ev) {
    if (ev && ev.target !== pill) return;
    pill.removeEventListener('animationend', finish);
    if (token !== hideToken) return;
    if (hideFallback) {
      clearTimeout(hideFallback);
      hideFallback = 0;
    }
    document.body.classList.remove('hiding');
    window.voxden.hudHidden();
  }
  pill.addEventListener('animationend', finish);
  hideFallback = setTimeout(() => finish(), 360);
}

// --- Dragging ---------------------------------------------------------------
// The renderer only reports the two edges of the gesture. Every frame between
// them is the main process following the OS cursor, because that is the only
// coordinate space that stays right as the bar crosses onto another monitor --
// and because this window spends most of its life click-through, where DOM
// mouse events cannot be trusted to arrive at all.
function beginFlowDrag(e) {
  if (dragging || e.button !== 0) return;
  if (!window.voxden || typeof window.voxden.overlayDragStart !== 'function') return;
  e.preventDefault();
  e.stopPropagation();
  dragging = true;
  dragPointerId = e.pointerId;
  resetIdleFace();
  document.body.classList.add('flow-dragging');
  // Capture keeps the release coming back here on the frames where the pointer
  // outruns the window it is dragging.
  try {
    if (dragHandle && e.pointerId !== undefined) dragHandle.setPointerCapture(e.pointerId);
  } catch (_) {}
  syncFlowVisual();
  window.voxden.overlayDragStart();
}

function endFlowDrag() {
  if (!dragging) return;
  dragging = false;
  if (dragPointerId !== null) {
    const id = dragPointerId;
    dragPointerId = null;
    try {
      if (dragHandle && dragHandle.hasPointerCapture && dragHandle.hasPointerCapture(id)) {
        dragHandle.releasePointerCapture(id);
      }
    } catch (_) {}
  }
  document.body.classList.remove('flow-dragging');
  syncFlowVisual();
  if (window.voxden && typeof window.voxden.overlayDragEnd === 'function') {
    window.voxden.overlayDragEnd();
  }
  scheduleIdleFace();
}

function releaseOverlayHold() {
  if (window.voxden && typeof window.voxden.overlayRelease === 'function') {
    window.voxden.overlayRelease();
  }
}

function setSuccessEditable(on) {
  if (!label) return;
  if (!on && editingSuccess) commitSuccessEdit();
  label.contentEditable = on ? 'true' : 'false';
  label.spellcheck = false;
  if (!on && document.activeElement === label) label.blur();
}

function beginSuccessEdit() {
  if (hudMode !== 'success' || !successEntryId || editingSuccess) return;
  editingSuccess = true;
  cancelSuccessEdit = false;
  if (window.voxden && typeof window.voxden.overlayHold === 'function') {
    window.voxden.overlayHold();
  }
  setIgnoreMouse(false);
  syncFlowVisual();
}

function commitSuccessEdit() {
  if (!editingSuccess) return;
  const cancelled = cancelSuccessEdit;
  cancelSuccessEdit = false;
  editingSuccess = false;
  if (cancelled) {
    if (label) label.textContent = lastSuccessText;
    releaseOverlayHold();
    return;
  }
  const next = (label.textContent || '').replace(/\s+/g, ' ').trim();
  if (!next || next === lastSuccessText) {
    if (label) label.textContent = lastSuccessText;
    releaseOverlayHold();
    return;
  }
  lastSuccessText = next;
  if (label) label.textContent = next;
  const id = successEntryId;
  if (window.voxden && id && typeof window.voxden.editEntry === 'function') {
    window.voxden.editEntry(id, next).finally(releaseOverlayHold);
  } else {
    releaseOverlayHold();
  }
}

function setHud(mode, text) {
  const next = mode || 'idle';
  // Leaving idle takes the grip away, so anything still holding it has to let
  // go -- otherwise the bar keeps following the cursor with no way to drop it.
  if (next !== 'idle') {
    endFlowDrag();
    resetIdleFace();
  }
  if (next !== 'success') setSuccessEditable(false);
  hudMode = next;
  // The line's text is settled before the class is written, because the class
  // is what shows it. It used to be an inline display:none/block, which took
  // the line out of the capsule's content in a single frame -- the one thing
  // the capsule cannot follow, since its width is that content.
  if (text) {
    label.textContent = text;
    if (hudMode === 'success') lastSuccessText = text;
  } else if (hudMode !== 'success' && hudMode !== 'error' && hudMode !== 'recording' && hudMode !== 'transcribing') {
    label.textContent = '';
  }
  pill.className = 'pill ' + hudMode
    + (label.textContent ? ' has-line' : '')
    + ((hudMode === 'success' || hudMode === 'error') && canRetry ? ' can-retry' : '');
  if (hudMode !== 'recording') {
    pill.style.setProperty('--mic', '#ffffff');
    stopWaveLoop();
  } else {
    startWaveLoop();
  }
  setSuccessEditable(hudMode === 'success' && !!successEntryId);
  syncFlowVisual();
  if (btnConfirm) {
    const retry = (hudMode === 'success' || hudMode === 'error') && canRetry;
    btnConfirm.title = retry ? 'Retry last dictation' : 'Done';
    btnConfirm.setAttribute('aria-label', retry ? 'Retry last dictation' : 'Finish recording');
  }
  if (hudMode === 'idle') scheduleIdleFace();
}

// The content-sized states -- recording, success, error -- used to have their
// width measured here and pinned in pixels, because `width: auto` could not be
// transitioned. `interpolate-size: allow-keywords` in overlay.css does that
// natively now, so the capsule grows into its content instead of being told a
// number one frame after the content that decides it has changed. That
// one-frame gap is what the morph looked like from the outside.

function resetChunkState() {
  dsPcmChunks = [];
  chunkJobs = [];
  chunkSlices = [];
  if (chunker && typeof chunker.reset === 'function') chunker.reset();
  chunker = null;
}

function chunkingApi() {
  return globalThis.voxdenChunking || null;
}

function wantsLocalAsr() {
  if (engineStatus === 'unavailable') return false;
  return engine === 'whisper'
    || engineStatus === 'standby'
    || engineStatus === 'starting'
    || engineStatus === 'loading'
    || engineStatus === 'ready';
}

function enqueueSlice(pcm, gen) {
  if (!pcm || !pcm.length) return;
  if (pcm.length < MIN_SLICE_SAMPLES) return;
  if (!window.voxden || typeof window.voxden.transcribeLocal !== 'function') return;
  const wav = encodeWav(pcm, OUT_RATE);
  const index = chunkJobs.length;
  chunkSlices.push(pcm);
  const job = window.voxden.transcribeLocal(wav, { park: false, vad: false })
    .then((text) => ({ gen, ok: true, index, text: String(text || '') }))
    .catch((err) => ({ gen, ok: false, index, error: err }));
  chunkJobs.push(job);
}

// --- Wave rendering ---------------------------------------------------------
// Bars are scaled, never resized. Writing 13 heights per frame relaid out the
// pill sixty times a second, and that relayout is what read as stutter; the
// loop now only touches transform, colour and class state, none of which are on
// the layout path.
//
// Nothing is painted raw either. A single microphone frame is noisy enough that
// drawing it straight looks like jitter rather than speech, so every value
// chases its target with a fast attack and a slow release -- the same asymmetry
// a compressor uses, and for the same reason.

const WAVE_MIN_SCALE = 3 / 20;      // bars rest as a 3px line inside a 20px box
const WAVE_REST = [255, 255, 255];  // silence is white
const WAVE_LIVE = [125, 204, 122];  // --mint, the app accent, is full voice
const WAVE_STEPS = 64;
const BAND_COUNT = Math.max(1, Math.ceil(waveBars.length / 2));
const SPEECH_START_LEVEL = 0.14;
const SPEECH_SUSTAIN_LEVEL = 0.055;
const SPEECH_HOLD_SEC = 0.34;

// Colours are looked up, not built: the loop would otherwise allocate fourteen
// rgb() strings a frame for a ramp with only sixty-four visible stops.
const WAVE_PALETTE = [];
for (let i = 0; i <= WAVE_STEPS; i++) {
  const t = i / WAVE_STEPS;
  const r = Math.round(WAVE_REST[0] + (WAVE_LIVE[0] - WAVE_REST[0]) * t);
  const g = Math.round(WAVE_REST[1] + (WAVE_LIVE[1] - WAVE_REST[1]) * t);
  const b = Math.round(WAVE_REST[2] + (WAVE_LIVE[2] - WAVE_REST[2]) * t);
  WAVE_PALETTE.push('rgb(' + r + ',' + g + ',' + b + ')');
}

const barLevel = new Float32Array(waveBars.length);
const barTint = new Float32Array(waveBars.length);
const barStep = new Int16Array(waveBars.length);
const bands = new Float32Array(BAND_COUNT);
let levelSmooth = 0;
let voiceSmooth = 0;
let pillStep = -1;
let speaking = false;
let speechHold = 0;
let waveClock = 0;
let waveLast = 0;
let timeBuf = null;
let freqBuf = null;
let bandEdges = null;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Frame-rate independent exponential smoothing. `tau` is a time constant in
// seconds, so a dropped frame eases by exactly as much as it should have over
// two -- a plain `cur += (target - cur) * k` speeds up whenever the frame does.
function approach(cur, target, tau, dt) {
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

// Log-spaced voice bands over 90Hz..5.2kHz, centre bar lowest and mirrored
// outward, so the arc the bars already formed becomes the spectrum instead of a
// decoration sitting on top of it.
function buildBands(sampleRate, bins, count) {
  const edges = new Int32Array(count + 1);
  const nyquist = sampleRate / 2;
  for (let k = 0; k <= count; k++) {
    const hz = 90 * Math.pow(5200 / 90, k / count);
    edges[k] = Math.max(1, Math.min(bins - 1, Math.round((hz / nyquist) * bins)));
  }
  // A low capture rate can collapse neighbouring edges onto the same bin.
  for (let k = 1; k <= count; k++) {
    if (edges[k] <= edges[k - 1]) edges[k] = edges[k - 1] + 1;
  }
  return edges;
}

function readBands(freq, edges, out) {
  let total = 0;
  for (let k = 0; k < out.length; k++) {
    const from = Math.min(freq.length - 1, edges[k]);
    const to = Math.max(from + 1, Math.min(freq.length, edges[k + 1]));
    let sum = 0;
    for (let i = from; i < to; i++) sum += freq[i];
    out[k] = sum / (to - from) / 255;
    total += out[k];
  }
  return total / out.length;
}

function updateWave(dt, level, freq) {
  const n = waveBars.length;
  if (!n) return;
  const mid = (n - 1) / 2;

  // Keep the response close to the syllable being spoken. The analyser already
  // removes the harshest frame-to-frame noise, so these filters only need to
  // soften the edge rather than visibly lag behind the microphone.
  levelSmooth = approach(levelSmooth, level, level > levelSmooth ? 0.018 : 0.075, dt);
  // One drive value behind every reaction, so colour, glow and height can never
  // disagree about whether you are talking.
  const voice = clamp01((levelSmooth - 0.007) / 0.05);
  voiceSmooth = approach(voiceSmooth, voice, voice > voiceSmooth ? 0.03 : 0.11, dt);

  // Starting still requires a clear voice signal, but once an utterance begins
  // a lower sustain threshold and short hold bridge quiet consonants and the
  // natural gaps between syllables. This prevents mint/white flicker mid-sentence
  // without leaving the glow on after the user actually stops.
  const voicePresent = voiceSmooth > (speaking ? SPEECH_SUSTAIN_LEVEL : SPEECH_START_LEVEL);
  if (voicePresent) speechHold = SPEECH_HOLD_SEC;
  else speechHold = Math.max(0, speechHold - dt);
  const next = voicePresent || (speaking && speechHold > 0);
  if (next !== speaking) {
    speaking = next;
    pill.classList.toggle('speaking', speaking);
  }
  const speechMix = speaking ? clamp01((voiceSmooth - 0.08) / 0.26) : 0;
  const accentTarget = speaking ? 1 : 0;

  // A complete travelling cycle takes about 0.6s while speaking (and 0.84s at
  // rest), making the strip feel lively without outrunning requestAnimationFrame.
  waveClock += dt * (speaking ? 10.5 : 7.5);

  const avg = freq && bandEdges ? readBands(freq, bandEdges, bands) : 0;

  for (let i = 0; i < n; i++) {
    const d = mid === 0 ? 0 : Math.abs(i - mid);
    const envelope = 0.34 + 0.66 * (1 - (mid === 0 ? 0 : d / mid));
    // Bands shape the voice, they never gate it: a flat or missing spectrum
    // lands `detail` on 1 and the arc falls back to plain loudness.
    const band = bands[Math.min(BAND_COUNT - 1, Math.round(d))];
    const rel = avg > 0.002 ? band / avg : 1;
    const detail = Math.max(0.35, Math.min(1.8, 0.4 + 0.6 * rel));
    // The travelling swell remains underneath the microphone response so the
    // waveform visibly moves between syllable peaks instead of freezing there.
    const breath = 0.5 + 0.5 * Math.sin(waveClock + i * 0.72);
    const rest = (0.15 + 0.16 * breath) * (1 - 0.65 * speechMix);
    const target = Math.min(1, rest + levelSmooth * 4.2 * detail);
    barLevel[i] = approach(barLevel[i], target, target > barLevel[i] ? 0.022 : 0.08, dt);

    const scale = WAVE_MIN_SCALE + (1 - WAVE_MIN_SCALE) * envelope * barLevel[i];
    waveBars[i].style.transform = 'scaleY(' + scale.toFixed(3) + ')';

    // All bars arrive at the app accent during speech. Keeping a separate eased
    // tint per bar makes the white-to-mint handoff smooth without colouring
    // silence or room noise.
    barTint[i] = approach(barTint[i], accentTarget, accentTarget > barTint[i] ? 0.04 : 0.12, dt);
    const step = Math.round(barTint[i] * WAVE_STEPS);
    if (step !== barStep[i]) {
      barStep[i] = step;
      waveBars[i].style.color = WAVE_PALETTE[step];
    }
  }

  const pStep = Math.round((barTint[Math.floor(n / 2)] || 0) * WAVE_STEPS);
  if (pStep !== pillStep) {
    pillStep = pStep;
    pill.style.setProperty('--mic', WAVE_PALETTE[pStep]);
  }

}

function resetWave() {
  levelSmooth = 0;
  voiceSmooth = 0;
  waveClock = 0;
  pillStep = -1;
  speaking = false;
  speechHold = 0;
  barLevel.fill(0);
  barTint.fill(0);
  barStep.fill(-1);
  pill.classList.remove('speaking');
  for (const el of waveBars) {
    el.style.transform = 'scaleY(' + WAVE_MIN_SCALE.toFixed(3) + ')';
    el.style.color = WAVE_PALETTE[0];
  }
}

function startWaveLoop() {
  if (raf) return;
  resetWave();
  waveLast = performance.now();
  function frame(now) {
    if (!pill.classList.contains('recording')) {
      raf = 0;
      return;
    }
    // Clamped: a backgrounded window resumes with a huge gap, and an unclamped
    // dt would snap every bar to its target in a single frame.
    const dt = Math.min(0.05, Math.max(0.001, (now - waveLast) / 1000));
    waveLast = now;
    let level = 0;
    let freq = null;
    if (analyser) {
      // Buffers are kept, not reallocated: the old loop threw away a kilobyte
      // of Uint8Array every frame for the garbage collector to chase.
      if (!timeBuf || timeBuf.length !== analyser.fftSize) {
        timeBuf = new Uint8Array(analyser.fftSize);
      }
      if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
        freqBuf = new Uint8Array(analyser.frequencyBinCount);
        bandEdges = buildBands(analyser.context.sampleRate, analyser.frequencyBinCount, BAND_COUNT);
      }
      analyser.getByteTimeDomainData(timeBuf);
      analyser.getByteFrequencyData(freqBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128;
        sum += v * v;
      }
      level = Math.sqrt(sum / timeBuf.length);
      freq = freqBuf;
    }
    updateWave(dt, level, freq);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}

function stopWaveLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  resetWave();
}

function mergePcm(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.round(i * ratio);
    const end = Math.round((i + 1) * ratio);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < input.length; j++) {
      sum += input[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  function str(offset, s) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

function stopWebSpeech() {
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    recognition = null;
  }
}

async function startCapture(useEngine) {
  if (capturing) return;
  capturing = true;
  stopRequested = false;
  webText = '';
  webResultIndex = 0;
  pcmChunks = [];
  captureGen += 1;
  const gen = captureGen;
  resetChunkState();
  engine = useEngine || 'webspeech';
  // Auto needs the finished clip length before it can choose Fast or Accurate.
  // Keep the full recording intact in that mode so long dictations are not
  // prematurely sent through the fast model one chunk at a time.
  if (dictationQuality !== 'auto' && wantsLocalAsr() && engineStatus === 'ready' && chunkingApi()) {
    chunker = chunkingApi().createChunker();
  }
  setHud('arming');

  try {
    const audio = {
      echoCancellation: false,
      noiseSuppression: true,
      channelCount: 1,
    };
    if (micDeviceId && micDeviceId !== 'default') {
      audio.deviceId = { ideal: micDeviceId };
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: false,
    });
  } catch (err) {
    capturing = false;
    window.voxden.captureFailed('Mic blocked — allow microphone access');
    return;
  }

  if (!capturing || gen !== captureGen) {
    teardownAudio();
    return;
  }

  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) {}
  }
  inputSampleRate = audioCtx.sampleRate;
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  // The analyser's own smoothing runs before ours and costs nothing. Slightly
  // below the 0.8 default so the spectrum still moves with a syllable; the
  // per-bar filter in updateWave takes the rest of the noise out.
  analyser.smoothingTimeConstant = 0.55;
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!capturing) return;
    const raw = new Float32Array(e.inputBuffer.getChannelData(0));
    if (wantsLocalAsr()) {
      // The local engine only ever reads the 16 kHz copy. Keeping the 48 kHz
      // original as well tripled the memory a long dictation held for nothing.
      const ds = downsample(raw, inputSampleRate, OUT_RATE);
      dsPcmChunks.push(ds);
      if (chunker) {
        const slices = chunker.push(ds);
        for (const slice of slices) enqueueSlice(slice, gen);
      }
    } else {
      pcmChunks.push(raw);
    }
  };
  sourceNode.connect(analyser);
  sourceNode.connect(processor);
  captureSink = audioCtx.createMediaStreamDestination();
  processor.connect(captureSink);
  if (!capturing || gen !== captureGen) {
    teardownAudio();
    return;
  }
  setHud('recording');
  startWaveLoop();
  playCue('start');
  if (window.voxden && typeof window.voxden.captureReady === 'function') {
    window.voxden.captureReady();
  }

  // Chromium SpeechRecognition uploads mic chunks to Google's speech service.
  // Electron does not ship that service, so each chunk fails with
  // OnSizeReceived Error: -2 in the terminal and returns no text. Skip it
  // whenever the local sidecar will transcribe the recording.
  if (!wantsLocalAsr() && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (ev) => {
      for (let i = webResultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript.trim();
        if (!t) continue;
        if (ev.results[i].isFinal) {
          webText = webText ? webText + ' ' + t : t;
          webResultIndex = i + 1;
        }
      }
    };
    recognition.onend = () => {
      if (capturing && !wantsLocalAsr() && recognition) {
        try { recognition.start(); } catch (_) {}
      }
    };
    recognition.onerror = (ev) => {
      if (ev.error === 'not-allowed') {
        window.voxden.captureFailed('Mic blocked — allow microphone access');
      }
    };
    try { recognition.start(); } catch (_) {}
  }
}

function teardownAudio() {
  try { processor && processor.disconnect(); } catch (_) {}
  try { captureSink && captureSink.disconnect(); } catch (_) {}
  try { sourceNode && sourceNode.disconnect(); } catch (_) {}
  try { analyser && analyser.disconnect(); } catch (_) {}
  processor = null;
  captureSink = null;
  sourceNode = null;
  analyser = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }
}

// How much audio either side of a seam the bridge pass listens to. Long
// enough to carry the words that were cut and the ones anchoring them, short
// enough that recognising it costs a fraction of the clip.
const BRIDGE_MS = 1500;
// At most this many seams are re-recognised per dictation. Chunking exists so
// that the work is finished when the user stops talking; a noisy recording
// that suspects every boundary must not undo that.
const MAX_BRIDGES = 2;

// Join the chunk transcripts, going back to the audio for any seam the text
// alone could not stitch.
//
// A boundary the chunker built with 400ms of overlap should show that overlap
// in the two transcripts. When it does not, the cut landed inside a word --
// "transcription" arriving as "trans" and "cription" -- and no amount of
// string handling recovers it, because neither side ever contained the word.
// Re-recognising the audio that spans the seam does, because that pass hears
// it whole.
async function reconcileChunks(texts, sliceOf, gen) {
  const api = chunkingApi();
  if (!api || !api.reconcileChunkTranscripts) return texts.join(' ');
  const first = api.reconcileChunkTranscripts(texts);
  const suspects = api.suspectBoundaries
    ? api.suspectBoundaries(first.boundaries, MAX_BRIDGES)
    : [];
  if (!suspects.length) return api.joinChunkTranscripts(texts);

  const bridges = {};
  const span = Math.round(OUT_RATE * BRIDGE_MS / 1000);
  for (const index of suspects) {
    const left = chunkSlices[sliceOf[index - 1]];
    const right = chunkSlices[sliceOf[index]];
    if (!left || !right) continue;
    const head = left.subarray(Math.max(0, left.length - span));
    const tail = right.subarray(0, Math.min(right.length, span));
    const bridge = mergePcm([head, tail]);
    if (bridge.length < MIN_SLICE_SAMPLES) continue;
    try {
      const text = await window.voxden.transcribeLocal(
        encodeWav(bridge, OUT_RATE), { park: false, vad: false }
      );
      if (chunkingApi().shouldIgnoreGeneration(gen, captureGen)) return '';
      if (text && String(text).trim()) bridges[index] = String(text).trim();
    } catch (_) {
      // A failed bridge is a boundary that stays as it was, not a failed
      // dictation. The joined text is still the text.
    }
  }
  return api.joinChunkTranscripts(texts, bridges);
}

// A push-to-talk clip too short to hold a word is almost always a tap where a
// hold was needed. "No speech" blames the microphone for that; say what to do.
function nothingHeardMessage() {
  if (document.body.classList.contains('ptt')) {
    return 'Hold ' + shortcutLabel + ' while you speak';
  }
  return 'No speech';
}

async function finishCapture(shouldTranscribe) {
  if (!capturing && !shouldTranscribe) {
    teardownAudio();
    stopWebSpeech();
    return;
  }
  const gen = captureGen;
  capturing = false;
  stopWebSpeech();
  const chunks = pcmChunks;
  pcmChunks = [];
  teardownAudio();

  if (!shouldTranscribe) {
    captureGen += 1;
    resetChunkState();
    window.voxden.cancelled();
    return;
  }

  if (engineStatus === 'ready') setHud('transcribing');
  else setHud('transcribing', 'Loading speech model…');
  const webFallback = webText.trim();
  const hasPcm = chunks.length > 0 || dsPcmChunks.length > 0;

  if (wantsLocalAsr() && hasPcm) {
    try {
      if (chunker) {
        const tail = chunker.flush();
        if (tail) enqueueSlice(tail, gen);
      }
      const pcm = dsPcmChunks.length
        ? mergePcm(dsPcmChunks)
        : downsample(mergePcm(chunks), inputSampleRate, OUT_RATE);
      if (pcm.length < MIN_SLICE_SAMPLES) {
        captureGen += 1;
        resetChunkState();
        if (webFallback) window.voxden.transcript(webFallback);
        else window.voxden.captureFailed(nothingHeardMessage());
        return;
      }
      const ignore = chunkingApi() && chunkingApi().shouldIgnoreGeneration;
      let trimmed = '';
      if (chunkJobs.length) {
        const results = await Promise.all(chunkJobs);
        if (ignore && ignore(gen, captureGen)) return;
        const texts = [];
        const sliceOf = [];
        let failed = false;
        for (const result of results) {
          if (ignore && ignore(result.gen, gen)) continue;
          if (!result.ok) {
            failed = true;
            break;
          }
          if (result.text && result.text.trim()) {
            texts.push(result.text.trim());
            sliceOf.push(result.index);
          }
        }
        const joined = failed
          ? ''
          : await reconcileChunks(texts, sliceOf, gen);
        if (!failed && joined) {
          trimmed = joined.trim();
          if (!(ignore && ignore(gen, captureGen))) {
            const fullWav = encodeWav(pcm, OUT_RATE);
            if (window.voxden.parkAudio) window.voxden.parkAudio(fullWav);
          }
        }
      }
      if (!trimmed) {
        const wav = encodeWav(pcm, OUT_RATE);
        trimmed = String((await window.voxden.transcribeLocal(wav)) || '').trim();
      }
      if (ignore && ignore(gen, captureGen)) return;
      resetChunkState();
      if (trimmed) {
        window.voxden.transcript(trimmed);
      } else if (webFallback) {
        window.voxden.transcript(webFallback);
      } else {
        window.voxden.captureFailed('No speech');
      }
    } catch (err) {
      if (chunkingApi() && chunkingApi().shouldIgnoreGeneration(gen, captureGen)) return;
      resetChunkState();
      if (webFallback) {
        window.voxden.transcript(webFallback);
      } else {
        window.voxden.captureFailed((err && err.message) || 'Transcribe failed');
      }
    }
    return;
  }

  resetChunkState();

  if (webFallback) {
    window.voxden.transcript(webFallback);
    return;
  }

  // Reaching here with no engine means nothing ever had a chance to transcribe.
  // "No speech" blamed the microphone for a setup problem; say which it is and
  // point at Settings, where the actual missing package is named.
  if (engineStatus === 'unavailable') {
    window.voxden.captureFailed('Speech engine not set up');
    return;
  }

  window.voxden.captureFailed(hasPcm ? 'No speech' : nothingHeardMessage());
}

if (btnCancel) {
  btnCancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.voxden) window.voxden.cancel();
  });
}

if (btnConfirm) {
  btnConfirm.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.voxden) return;
    if (editingSuccess) return;
    window.voxden.confirm();
  });
}

if (label) {
  label.addEventListener('focus', () => beginSuccessEdit());
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      label.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelSuccessEdit = true;
      label.blur();
    }
  });
  label.addEventListener('blur', () => commitSuccessEdit());
}

function onIdleDictate(e) {
  if (e.target.closest && e.target.closest('.act')) return;
  // The gear and the grip live inside the same hit area as the bar, and this
  // handler is on the document, so without this a click on either would also
  // start a dictation.
  if (e.target.closest && e.target.closest('.flow-side')) return;
  if (dragging) return;
  if (!pill.classList.contains('idle')) return;
  resetIdleFace();
  e.preventDefault();
  e.stopPropagation();
  if (window.voxden) window.voxden.toggle();
}

// Listen on the document, not just the pill: the window only captures the mouse
// while the cursor is in the hover zone, so any click that reaches us there is
// meant for the bar even if it lands a few pixels off the resting shape.
document.addEventListener('click', onIdleDictate);

if (dragHandle) {
  dragHandle.addEventListener('pointerdown', beginFlowDrag);
  dragHandle.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    endFlowDrag();
  });
  dragHandle.addEventListener('pointercancel', endFlowDrag);
  dragHandle.addEventListener('lostpointercapture', endFlowDrag);
  dragHandle.addEventListener('dragstart', (e) => e.preventDefault());
}

// Backstops for a release the grip never sees. Windows can take the capture
// away without sending either pointerup or pointercancel -- Alt+Tab and the
// lock screen both do -- and a drag with no end leaves the bar on the cursor.
window.addEventListener('pointerup', endFlowDrag);
window.addEventListener('blur', endFlowDrag);

if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.voxden && typeof window.voxden.overlaySettings === 'function') {
      window.voxden.overlaySettings();
    }
  });
}

if (window.voxden) {
  window.voxden.onState((s) => {
    let revealAfterState = !!s.reveal;
    engine = s.engine || engine;
    if (typeof s.alwaysShowFlowBar === 'boolean') {
      alwaysShowFlowBar = s.alwaysShowFlowBar;
      document.body.classList.toggle('always-flow', alwaysShowFlowBar);
      if (!alwaysShowFlowBar) resetIdleFace();
    }
    if (typeof s.soundsEnabled === 'boolean') soundsEnabled = s.soundsEnabled;
    if (s.dictationQuality) dictationQuality = s.dictationQuality;
    if (s.shortcutLabel) shortcutLabel = s.shortcutLabel;
    if (typeof s.canRetry === 'boolean') canRetry = s.canRetry;
    if (s.microphone) micDeviceId = s.microphone;
    if (s.dictateMode) {
      document.body.classList.toggle('ptt', s.dictateMode === 'ptt');
    }
    if (typeof s.pttLocked === 'boolean') {
      const locked = s.pttLocked;
      pttLocked = locked;
      // The lock can land mid-recording, after the title was already set.
      if (locked && !s.mode && capturing) pill.title = recordingTitle(s.dictateMode);
    }
    if (s.engineStatus) {
      engineStatus = s.engineStatus;
      pill.title = 'Voxden';
    }
    if (s.mode === 'recording') pill.title = recordingTitle(s.dictateMode);
    if (s.mode === 'arming') {
      setHud('arming');
      revealAfterState = true;
      if (s.prepareOnly === false && !capturing) startCapture(s.engine);
    } else if (s.mode === 'recording') {
      revealAfterState = true;
      if (!capturing) startCapture(s.engine);
    } else if (s.mode === 'stop') {
      finishCapture(true);
    } else if (s.mode === 'cancel') {
      // Bumping the generation makes any transcription still in flight resolve
      // into a result nobody reads, so a cancel during "transcribing" cannot
      // paste a moment later. No cue: the user asked for this.
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      setHud('cancel', s.text || 'Cancelled');
      revealAfterState = true;
    } else if (s.mode === 'success') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      successEntryId = s.entryId ? String(s.entryId) : '';
      setHud('success', s.text || '');
      revealAfterState = true;
      playCue('success');
    } else if (s.mode === 'error') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      setHud('error', s.text || 'Transcription failed');
      revealAfterState = true;
      playCue('error');
    } else if (s.mode === 'idle') {
      successEntryId = '';
      editingSuccess = false;
      setHud('idle');
      if (alwaysShowFlowBar) revealAfterState = true;
      else if (document.body.classList.contains('shown')) popOut();
    } else if (s.mode === 'transcribing') {
      setHud('transcribing');
      revealAfterState = true;
    }
    // Apply the target shape before starting an entrance. Starting popIn on the
    // old idle bar and changing it to arming in the same task made the mic and
    // capsule compete for the first frame.
    if (revealAfterState) popIn();
    syncFlowVisual();
  });

  if (typeof window.voxden.onCursor === 'function') {
    window.voxden.onCursor(onCursor);
  }

  // Main owns the end of a drag as well as the middle of it: if the OS takes
  // the pointer capture away without a pointerup ever reaching us, this is the
  // only signal that the bar has been put down. endFlowDrag self-guards on
  // `dragging`, so the echo it sends back to main is a no-op.
  if (typeof window.voxden.onDragEnd === 'function') {
    window.voxden.onDragEnd(() => endFlowDrag());
  }

  window.voxden.ready();
  syncFlowVisual();
  setTimeout(() => { if (soundsEnabled) ensureSfxContext(); }, 1000);
}
