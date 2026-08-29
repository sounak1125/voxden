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
let idleCubeTimer = 0;
let idleCubeSteps = [];
let idleCubePlaying = false;

// Idle easter egg. IDLE_CUBE_MORPH_MS must match --morph in overlay.css.
const IDLE_CUBE_DELAY_MS = 22000;
const IDLE_CUBE_MORPH_MS = 420;
const IDLE_CUBE_HOLD_MS = 3600;

// Hover target, in window coordinates. Deliberately a fixed rect rather than the
// pill's own box: the pill resizes when it expands, and measuring it would make
// the edge of the hot zone move under the cursor and flicker.
const HOVER_ZONE_W = 120;
const HOVER_ZONE_H = 44;

const OUT_RATE = 16000;
const MIN_SLICE_SEC = 0.3;
const MIN_SLICE_SAMPLES = Math.round(MIN_SLICE_SEC * OUT_RATE);

let captureGen = 0;
let dsPcmChunks = [];

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
  return m === 'recording' || m === 'transcribing';
}

function inHoverZone(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = (w - HOVER_ZONE_W) / 2;
  return x >= left && x <= left + HOVER_ZONE_W && y >= h - HOVER_ZONE_H && y <= h;
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

function canPlayIdleCube() {
  return alwaysShowFlowBar
    && hudMode === 'idle'
    && !overInteractive
    && !idleCubePlaying
    && document.body.classList.contains('shown')
    && !document.body.classList.contains('hiding');
}

function clearIdleCubeSteps() {
  for (const t of idleCubeSteps) clearTimeout(t);
  idleCubeSteps = [];
}

function stepIdleCube(fn, ms) {
  idleCubeSteps.push(setTimeout(fn, ms));
}

function startIdleCube() {
  if (!canPlayIdleCube()) {
    scheduleIdleCube();
    return;
  }
  idleCubePlaying = true;
  // Each beat is its own class swap so CSS transitions carry the motion:
  // fold into the cube, open the eyes, close them, unfold back to the bar.
  document.body.classList.add('flow-cube');
  stepIdleCube(() => document.body.classList.add('flow-cube-open'), IDLE_CUBE_MORPH_MS);
  stepIdleCube(() => document.body.classList.remove('flow-cube-open'), IDLE_CUBE_MORPH_MS + IDLE_CUBE_HOLD_MS);
  stepIdleCube(finishIdleCube, IDLE_CUBE_MORPH_MS + IDLE_CUBE_HOLD_MS + 240);
}

function finishIdleCube() {
  clearIdleCubeSteps();
  idleCubePlaying = false;
  document.body.classList.remove('flow-cube', 'flow-cube-open');
  scheduleIdleCube();
}

function abortIdleCube() {
  clearIdleCubeSteps();
  idleCubePlaying = false;
  document.body.classList.remove('flow-cube', 'flow-cube-open');
}

function scheduleIdleCube() {
  if (idleCubeTimer || idleCubePlaying) return;
  if (!canPlayIdleCube()) return;
  idleCubeTimer = setTimeout(() => {
    idleCubeTimer = 0;
    startIdleCube();
  }, IDLE_CUBE_DELAY_MS);
}

function resetIdleCube() {
  abortIdleCube();
  if (idleCubeTimer) {
    clearTimeout(idleCubeTimer);
    idleCubeTimer = 0;
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
  if (next) resetIdleCube();
  else scheduleIdleCube();
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
    scheduleIdleCube();
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
  scheduleIdleCube();
}

function popOut() {
  resetIdleCube();
  if (!document.body.classList.contains('shown')) {
    document.body.classList.remove('hiding', 'entering');
    window.voxden.hudHidden();
    return;
  }
  const token = ++hideToken;
  document.body.classList.remove('shown', 'entering', 'flow-expanded', 'flow-cube', 'flow-cube-open');
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

function setHud(mode, text) {
  const next = mode || 'idle';
  if (next !== 'idle') resetIdleCube();
  hudMode = next;
  const marked = pill.classList.contains('marked');
  pill.className = 'pill ' + hudMode + (marked ? ' marked' : '');
  if (hudMode !== 'recording') {
    pill.style.setProperty('--bar', '#8d8d94');
    pill.style.setProperty('--mic', '#ffffff');
    stopWaveLoop();
  } else {
    startWaveLoop();
  }
  if (text) {
    label.textContent = text;
    label.style.display = 'block';
  } else if (hudMode !== 'success' && hudMode !== 'error' && hudMode !== 'recording' && hudMode !== 'transcribing' && !marked) {
    label.textContent = '';
    label.style.display = 'none';
  }
  syncFlowVisual();
  if (hudMode === 'idle') scheduleIdleCube();
}

function resetChunkState() {
  dsPcmChunks = [];
}

function flashMarked() {
  pill.classList.add('marked');
  if (markTimer) clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    pill.classList.remove('marked');
  }, 800);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rgb(r, g, b) {
  return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
}

function colorForLevel(t) {
  const stops = [
    [141, 141, 148],
    [34, 232, 196],
    [74, 250, 130],
    [255, 204, 64],
  ];
  const x = Math.max(0, Math.min(0.999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return rgb(lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f));
}

function barSample(buf, start, span) {
  const n = buf.length;
  const from = Math.max(0, Math.min(n - 1, start));
  const to = Math.max(from + 1, Math.min(n, start + span));
  let peak = 0;
  for (let i = from; i < to; i++) {
    const v = Math.abs((buf[i] - 128) / 128);
    if (v > peak) peak = v;
  }
  return peak;
}

function updateWave(level, buf) {
  const n = waveBars.length;
  const mid = (n - 1) / 2;
  const t = performance.now() / 1000;
  const slice = buf ? Math.max(4, Math.floor(buf.length / n)) : 0;
  for (let i = 0; i < n; i++) {
    const dist = mid === 0 ? 0 : Math.abs(i - mid) / mid;
    const envelope = 0.32 + 0.68 * (1 - dist);
    const idle = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * 7.4 + i * 0.95));
    let voice = level * 4.2;
    if (buf && buf.length) {
      voice = Math.max(voice, barSample(buf, i * slice, slice) * 2.4);
    }
    const amp = idle * 0.55 + voice;
    waveBars[i].style.height = Math.max(3, Math.min(16, 3 + amp * 13 * envelope)) + 'px';
  }
  const heat = Math.min(1, Math.max(0, (level - 0.012) / 0.18));
  const color = colorForLevel(Math.max(heat, 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2.2))));
  pill.style.setProperty('--bar', heat > 0.1 ? colorForLevel(heat) : color);
  pill.style.setProperty('--mic', heat > 0.12 ? colorForLevel(heat) : '#ffffff');
  pill.classList.toggle('speaking', heat > 0.14);
}

function startWaveLoop() {
  if (raf) return;
  function frame() {
    if (!pill.classList.contains('recording')) {
      raf = 0;
      return;
    }
    let level = 0;
    let buf = null;
    if (analyser) {
      buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      level = Math.sqrt(sum / buf.length);
    }
    updateWave(level, buf);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}

function stopWaveLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
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
  setHud('recording');

  try {
    const audio = {
      echoCancellation: true,
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
  inputSampleRate = audioCtx.sampleRate;
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!capturing) return;
    const raw = new Float32Array(e.inputBuffer.getChannelData(0));
    pcmChunks.push(raw);
    if (engine === 'whisper') {
      dsPcmChunks.push(downsample(raw, inputSampleRate, OUT_RATE));
    }
  };
  sourceNode.connect(analyser);
  sourceNode.connect(processor);
  captureSink = audioCtx.createMediaStreamDestination();
  processor.connect(captureSink);
  startWaveLoop();
  playCue('start');

  if (engine === 'webspeech' && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
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
      if (capturing && engine === 'webspeech' && recognition) {
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

  setHud('transcribing');
  const webFallback = webText.trim();
  const hasPcm = chunks.length > 0 || dsPcmChunks.length > 0;

  if (engine === 'whisper' && hasPcm) {
    try {
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
      const wav = encodeWav(pcm, OUT_RATE);
      const text = (await window.voxden.transcribeLocal(wav)) || '';
      if (gen !== captureGen) return;
      resetChunkState();
      const trimmed = text.trim();
      if (trimmed) {
        window.voxden.transcript(trimmed);
      } else if (webFallback) {
        window.voxden.transcript(webFallback);
      } else {
        window.voxden.captureFailed('No speech');
      }
    } catch (err) {
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
    if (window.voxden) window.voxden.confirm();
  });
}

function onIdleDictate(e) {
  if (e.target.closest && e.target.closest('.act')) return;
  if (!pill.classList.contains('idle')) return;
  resetIdleCube();
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
      if (!alwaysShowFlowBar) resetIdleCube();
    }
    if (typeof s.soundsEnabled === 'boolean') soundsEnabled = s.soundsEnabled;
    if (s.shortcutLabel) shortcutLabel = s.shortcutLabel;
    if (s.microphone) micDeviceId = s.microphone;
    if (s.dictateMode) {
      document.body.classList.toggle('ptt', s.dictateMode === 'ptt');
    }
    if (s.engineStatus) {
      pill.title = engine === 'whisper'
        ? 'Voxden'
        : (s.engineStatus === 'loading' || s.engineStatus === 'starting')
          ? 'Speech model loading — accuracy limited until ready'
          : 'Basic English-only engine';
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
