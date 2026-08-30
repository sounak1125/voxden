'use strict';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;
const SPEECH_RMS = 0.012;
// Commit natural pauses and continuous speech early enough that most of the ASR
// work happens while the user is still talking instead of after they press stop.
const SILENCE_MS = 500;
const MAX_SPEECH_MS = 6000;
const OVERLAP_MS = 400;
const MIN_SLICE_MS = 300;
const FLUSH_MIN_MS = 150;

function samplesForMs(ms, rate) {
  return Math.max(1, Math.round((Number(ms) || 0) * (Number(rate) || SAMPLE_RATE) / 1000));
}

function rms(samples, start, end) {
  const from = Math.max(0, start | 0);
  const to = Math.min(samples.length, end == null ? samples.length : end | 0);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / (to - from));
}

function concatFloat32(parts) {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function getDedupe() {
  if (typeof require === 'function') {
    try { return require('./cleanup').dedupeRepeats; } catch (_) {}
  }
  if (typeof globalThis !== 'undefined' && globalThis.voxdenCleanup) {
    return globalThis.voxdenCleanup.dedupeRepeats;
  }
  return function (text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  };
}

function joinChunkTranscripts(parts) {
  const texts = [];
  for (const part of parts || []) {
    const t = String(part || '').trim();
    if (t) texts.push(t);
  }
  if (!texts.length) return '';
  return getDedupe()(texts.join(' '));
}

function shouldIgnoreGeneration(resultGen, captureGen) {
  return Number(resultGen) !== Number(captureGen);
}

function createChunker(options) {
  const opts = options || {};
  const sampleRate = Number(opts.sampleRate) || SAMPLE_RATE;
  const frameSize = Math.max(64, Number(opts.frameSize) || FRAME_SIZE);
  const speechRms = opts.speechRms == null ? SPEECH_RMS : Number(opts.speechRms);
  const silenceNeed = samplesForMs(opts.silenceMs == null ? SILENCE_MS : opts.silenceMs, sampleRate);
  const maxSpeech = samplesForMs(opts.maxSpeechMs == null ? MAX_SPEECH_MS : opts.maxSpeechMs, sampleRate);
  const overlapSamples = samplesForMs(opts.overlapMs == null ? OVERLAP_MS : opts.overlapMs, sampleRate);
  const minSlice = samplesForMs(opts.minSliceMs == null ? MIN_SLICE_MS : opts.minSliceMs, sampleRate);
  const flushMin = samplesForMs(opts.flushMinMs == null ? FLUSH_MIN_MS : opts.flushMinMs, sampleRate);

  let leftover = new Float32Array(0);
  let pending = [];
  let pendingSamples = 0;
  let speechSamples = 0;
  let silenceRun = 0;
  let inSpeech = false;
  let emitted = false;

  function resetSpeechCounters() {
    speechSamples = 0;
    silenceRun = 0;
    inSpeech = false;
  }

  function takePending(keepOverlap) {
    if (!pending.length) return new Float32Array(0);
    const pcm = concatFloat32(pending);
    if (keepOverlap && overlapSamples > 0 && pcm.length > overlapSamples) {
      pending = [pcm.slice(pcm.length - overlapSamples)];
      pendingSamples = pending[0].length;
    } else {
      pending = [];
      pendingSamples = 0;
    }
    resetSpeechCounters();
    return pcm;
  }

  function maybeCommit(force) {
    if (!force && !inSpeech) return null;
    if (!force && silenceRun < silenceNeed && speechSamples < maxSpeech) return null;
    if (!force && pendingSamples < minSlice) return null;
    if (force && emitted && pendingSamples <= overlapSamples + frameSize) return null;
    if (force && pendingSamples < flushMin) return null;
    const pcm = takePending(!force);
    if (pcm.length < (force ? flushMin : minSlice)) return null;
    emitted = true;
    return pcm;
  }

  function push(samples) {
    const incoming = samples && samples.length ? samples : new Float32Array(0);
    const combined = leftover.length ? concatFloat32([leftover, incoming]) : incoming;
    leftover = new Float32Array(0);
    const slices = [];
    let offset = 0;
    while (offset + frameSize <= combined.length) {
      const copy = combined.slice(offset, offset + frameSize);
      offset += frameSize;
      pending.push(copy);
      pendingSamples += copy.length;
      const spoken = rms(copy, 0, copy.length) >= speechRms;
      if (spoken) {
        inSpeech = true;
        speechSamples += copy.length;
        silenceRun = 0;
      } else if (inSpeech) {
        silenceRun += copy.length;
      }
      const committed = maybeCommit(false);
      if (committed) slices.push(committed);
    }
    if (offset < combined.length) leftover = combined.slice(offset);
    return slices;
  }

  function flush() {
    if (leftover.length) {
      pending.push(leftover);
      pendingSamples += leftover.length;
      leftover = new Float32Array(0);
    }
    return maybeCommit(true);
  }

  function reset() {
    leftover = new Float32Array(0);
    pending = [];
    pendingSamples = 0;
    emitted = false;
    resetSpeechCounters();
  }

  return { push, flush, reset };
}

const api = {
  SAMPLE_RATE,
  FRAME_SIZE,
  SPEECH_RMS,
  SILENCE_MS,
  MAX_SPEECH_MS,
  OVERLAP_MS,
  MIN_SLICE_MS,
  rms,
  createChunker,
  joinChunkTranscripts,
  shouldIgnoreGeneration,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  globalThis.voxdenChunking = api;
}
