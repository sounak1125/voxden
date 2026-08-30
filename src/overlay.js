'use strict';

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const btnCancel = document.getElementById('btn-cancel');
const btnConfirm = document.getElementById('btn-confirm');
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
let markTimer = 0;
let hideToken = 0;
let hideFallback = 0;
let alwaysShowFlowBar = false;
let hudMode = 'idle';
let overInteractive = false;
let ignoreMouse = null;
let enterTimer = 0;
let soundsEnabled = true;
let shortcutLabel = 'Ctrl+Shift+Space';
let micDeviceId = 'default';
let sfxCtx = null;
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
// Two heights, because one rect cannot be both tight and stable. The enter rect
// hugs the resting bar so the mic only appears when you are actually on it; the
// stay rect is tall enough to hold the 32px circle the bar expands into, so the
// cursor does not fall out of its own hover target. Same width for both, so
// there is no horizontal edge to oscillate across.
const HOVER_W = 54;          // bar is 44 wide, plus 5px of slack each side
const HOVER_ENTER_H = 24;    // bar is 4 tall, sitting HOVER_BOTTOM off the floor
const HOVER_STAY_H = 46;     // must cover the expanded 32px circle
const HOVER_BOTTOM = 10;     // gap from the zone's floor to the window edge

let canRetry = false;
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

function playCue(kind) {
  if (!soundsEnabled) return;
  try {
    const ctx = sfxCtx || new AudioContext();
    sfxCtx = ctx;
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
  return m === 'recording' || m === 'transcribing' || m === 'success' || m === 'error' || editingSuccess;
}

function inHoverZone(x, y) {
  const left = (window.innerWidth - HOVER_W) / 2;
  if (x < left || x > left + HOVER_W) return false;
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
  const expanded = !alwaysShowFlowBar || hudMode !== 'idle' || overInteractive;
  document.body.classList.toggle('flow-expanded', expanded);
  const capture = overInteractive || isActiveHud();
  setIgnoreMouse(!capture);
}

function canPlayIdleFace() {
  return alwaysShowFlowBar
    && hudMode === 'idle'
    && !overInteractive
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
  const next = !!(pos && pos.inside) && inHoverZone(pos.x, pos.y);
  if (next === overInteractive) return;
  overInteractive = next;
  if (next) resetIdleFace();
  else scheduleIdleFace();
  syncFlowVisual();
}

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
    if (token !== hideToken) return;
    pill.removeEventListener('animationend', done);
    if (enterTimer) {
      clearTimeout(enterTimer);
      enterTimer = 0;
    }
    document.body.classList.remove('entering');
  }
  pill.addEventListener('animationend', done);
  enterTimer = setTimeout(() => done(), 420);
  syncFlowVisual();
  scheduleIdleFace();
}

function popOut() {
  resetIdleFace();
  if (!document.body.classList.contains('shown')) {
    document.body.classList.remove('hiding', 'entering');
    window.voxden.hudHidden();
    return;
  }
  const token = ++hideToken;
  document.body.classList.remove('shown', 'entering', 'flow-expanded', 'flow-face', 'flow-face-open', 'flow-listening');
  document.body.classList.add('hiding');
  function finish(ev) {
    if (ev && ev.target !== pill) return;
    if (token !== hideToken) return;
    if (hideFallback) {
      clearTimeout(hideFallback);
      hideFallback = 0;
    }
    pill.removeEventListener('animationend', finish);
    document.body.classList.remove('hiding');
    window.voxden.hudHidden();
  }
  pill.addEventListener('animationend', finish);
  hideFallback = setTimeout(() => finish(), 360);
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
  const fromWidth = pill.getBoundingClientRect().width;
  const next = mode || 'idle';
  if (next !== 'idle') resetIdleFace();
  if (next !== 'success') setSuccessEditable(false);
  hudMode = next;
  const marked = pill.classList.contains('marked');
  pill.className = 'pill ' + hudMode + (marked ? ' marked' : '')
    + ((hudMode === 'success' || hudMode === 'error') && canRetry ? ' can-retry' : '');
  if (hudMode !== 'recording') {
    pill.style.setProperty('--mic', '#ffffff');
    stopWaveLoop();
  } else {
    startWaveLoop();
  }
  if (text) {
    label.textContent = text;
    label.style.display = 'block';
    if (hudMode === 'success') lastSuccessText = text;
  } else if (hudMode !== 'success' && hudMode !== 'error' && hudMode !== 'recording' && hudMode !== 'transcribing' && !marked) {
    label.textContent = '';
    label.style.display = 'none';
  }
  setSuccessEditable(hudMode === 'success' && !!successEntryId);
  syncPillWidth(fromWidth);
  syncFlowVisual();
  if (btnConfirm) {
    const retry = (hudMode === 'success' || hudMode === 'error') && canRetry;
    btnConfirm.title = retry ? 'Retry last dictation' : 'Done';
    btnConfirm.setAttribute('aria-label', retry ? 'Retry last dictation' : 'Finish recording');
  }
  if (hudMode === 'idle') scheduleIdleFace();
}

// The recording/success/error pills are content-sized, and `width: auto` cannot
// be transitioned -- the pill jumped straight from the 32px circle to its full
// width the instant you clicked. Measure the natural width for the new state and
// pin it, so the same morph that handles hover handles this too. Idle keeps its
// width from CSS, which is what drives the bar/mic/face shapes.
// `fromWidth` must be measured by the caller BEFORE the new class lands --
// measuring here would already report the new state's width and the pill would
// snap straight to it.
function syncPillWidth(fromWidth) {
  if (hudMode === 'idle') {
    pill.style.width = '';
    return;
  }
  pill.style.width = 'auto';
  const to = pill.getBoundingClientRect().width;
  pill.style.width = fromWidth + 'px';
  void pill.offsetWidth;
  pill.style.width = to + 'px';
}

function resetChunkState() {
  dsPcmChunks = [];
  chunkJobs = [];
  if (chunker && typeof chunker.reset === 'function') chunker.reset();
  chunker = null;
}

function chunkingApi() {
  return globalThis.voxdenChunking || null;
}

function wantsLocalAsr() {
  if (engineStatus === 'unavailable') return false;
  return engine === 'whisper'
    || engineStatus === 'starting'
    || engineStatus === 'loading'
    || engineStatus === 'ready';
}

function enqueueSlice(pcm, gen) {
  if (!pcm || !pcm.length) return;
  if (pcm.length < MIN_SLICE_SAMPLES) return;
  if (!window.voxden || typeof window.voxden.transcribeLocal !== 'function') return;
  const wav = encodeWav(pcm, OUT_RATE);
  const job = window.voxden.transcribeLocal(wav, { park: false, vad: false })
    .then((text) => ({ gen, ok: true, text: String(text || '') }))
    .catch((err) => ({ gen, ok: false, error: err }));
  chunkJobs.push(job);
}

function flashMarked() {
  pill.classList.add('marked');
  if (markTimer) clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    pill.classList.remove('marked');
  }, 800);
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
  resetChunkState();
  engine = useEngine || 'webspeech';
  if (wantsLocalAsr() && engineStatus === 'ready' && chunkingApi()) {
    chunker = chunkingApi().createChunker();
  }
  setHud('recording');

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
    pcmChunks.push(raw);
    if (wantsLocalAsr()) {
      const ds = downsample(raw, inputSampleRate, OUT_RATE);
      dsPcmChunks.push(ds);
      if (chunker) {
        const slices = chunker.push(ds);
        for (const slice of slices) enqueueSlice(slice, captureGen);
      }
    }
  };
  sourceNode.connect(analyser);
  sourceNode.connect(processor);
  captureSink = audioCtx.createMediaStreamDestination();
  processor.connect(captureSink);
  startWaveLoop();
  playCue('start');

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
        else window.voxden.captureFailed('No speech');
        return;
      }
      const ignore = chunkingApi() && chunkingApi().shouldIgnoreGeneration;
      let trimmed = '';
      if (chunkJobs.length) {
        const results = await Promise.all(chunkJobs);
        if (ignore && ignore(gen, captureGen)) return;
        const texts = [];
        let failed = false;
        for (const result of results) {
          if (ignore && ignore(result.gen, gen)) continue;
          if (!result.ok) {
            failed = true;
            break;
          }
          if (result.text && result.text.trim()) texts.push(result.text.trim());
        }
        const joined = chunkingApi()
          ? chunkingApi().joinChunkTranscripts(texts)
          : texts.join(' ');
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

  window.voxden.captureFailed('No speech');
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
  if (!pill.classList.contains('idle')) return;
  resetIdleFace();
  e.preventDefault();
  e.stopPropagation();
  if (window.voxden) window.voxden.toggle();
}

// Listen on the document, not just the pill: the window only captures the mouse
// while the cursor is in the hover zone, so any click that reaches us there is
// meant for the bar even if it lands a few pixels off the 4px resting shape.
document.addEventListener('click', onIdleDictate);

if (window.voxden) {
  window.voxden.onState((s) => {
    engine = s.engine || engine;
    if (typeof s.alwaysShowFlowBar === 'boolean') {
      alwaysShowFlowBar = s.alwaysShowFlowBar;
      document.body.classList.toggle('always-flow', alwaysShowFlowBar);
      if (!alwaysShowFlowBar) resetIdleFace();
    }
    if (typeof s.soundsEnabled === 'boolean') soundsEnabled = s.soundsEnabled;
    if (s.shortcutLabel) shortcutLabel = s.shortcutLabel;
    if (typeof s.canRetry === 'boolean') canRetry = s.canRetry;
    if (s.microphone) micDeviceId = s.microphone;
    if (s.dictateMode) {
      document.body.classList.toggle('ptt', s.dictateMode === 'ptt');
    }
    if (s.engineStatus) {
      engineStatus = s.engineStatus;
      pill.title = 'Voxden';
    }
    if (s.mode === 'recording') {
      pill.title = s.dictateMode === 'ptt'
        ? 'Release ' + shortcutLabel + ' to finish'
        : 'Press ' + shortcutLabel + ' again to finish';
    }
    if (s.reveal) popIn();
    if (s.marked) flashMarked();
    if (s.mode === 'recording') {
      popIn();
      if (!capturing) startCapture(s.engine);
    } else if (s.mode === 'stop') {
      finishCapture(true);
    } else if (s.mode === 'cancel') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      popIn();
      setHud('error', s.text || 'Transcription failed');
      playCue('error');
    } else if (s.mode === 'success') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      successEntryId = s.entryId ? String(s.entryId) : '';
      setHud('success', s.text || '');
      playCue('success');
    } else if (s.mode === 'error') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      popIn();
      setHud('error', s.text || 'Transcription failed');
      playCue('error');
    } else if (s.mode === 'idle') {
      successEntryId = '';
      editingSuccess = false;
      setHud('idle');
      if (alwaysShowFlowBar) popIn();
      else if (document.body.classList.contains('shown')) popOut();
    } else if (s.mode === 'transcribing') {
      setHud('transcribing');
    }
    syncFlowVisual();
  });

  if (typeof window.voxden.onCursor === 'function') {
    window.voxden.onCursor(onCursor);
  }

  window.voxden.ready();
  syncFlowVisual();
}
