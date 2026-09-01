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

// How many tokens either side of a boundary may be the same speech heard
// twice. The chunker deliberately keeps OVERLAP_MS of audio at the front of
// each slice, so an overlap is expected, not exceptional -- 400ms is one or
// two words, and the ceiling leaves room for the VAD padding on top.
const MAX_OVERLAP_TOKENS = 6;

function overlapKey(word) {
  return String(word || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}\p{M}]+$/gu, '');
}

function splitTokens(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

// Stitch two chunk transcripts, removing the speech the overlap made them
// both contain.
//
// The longest suffix of the left side that equals the head of the right side
// is the duplicated audio, so the right side loses it. Comparison is on folded
// tokens, because the two passes punctuate and capitalise the same words
// differently -- "saying," and "saying" are the same word heard twice.
function stitch(leftTokens, rightTokens) {
  const maxK = Math.min(MAX_OVERLAP_TOKENS, leftTokens.length, rightTokens.length);
  for (let k = maxK; k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      const a = overlapKey(leftTokens[leftTokens.length - k + i]);
      const b = overlapKey(rightTokens[i]);
      if (!a || a !== b) {
        same = false;
        break;
      }
    }
    if (same) return { tokens: rightTokens.slice(k), overlap: k };
  }
  return { tokens: rightTokens, overlap: 0 };
}

// Join the chunk transcripts of one dictation into the text that gets pasted.
//
// This used to be `texts.join(' ')` handed to the repeat collapser, which is
// two different mistakes. The overlap the chunker adds on purpose came through
// as duplicated words at every boundary; and the repeat collapser, aimed at
// the whole transcript to clean them up, also flattened repetition the speaker
// actually produced.
//
// Overlap is now removed where it happens, by matching the tokens either side
// of each boundary. `boundaries` reports what was found: a boundary where no
// overlap could be matched is one where the audio was cut through a word, and
// the caller can decide whether to go back to the recording for it.
// Repair one boundary using a transcript of the audio that spans it.
//
// The bridge is a fresh recognition of the seam itself -- the tail of one
// slice and the head of the next, decoded as continuous speech -- so it is the
// only one of the three that heard the words that were cut in half. It is
// spliced in only when it anchors on both sides: an unanchored bridge would be
// a third opinion pasted between two others, which is how a word gets said
// three times. Failing to anchor falls back to plain concatenation, which is
// what the boundary would have got anyway.
function spliceBridge(leftTokens, rightTokens, bridgeText) {
  const bridge = splitTokens(bridgeText);
  const declined = { left: leftTokens, tokens: rightTokens, applied: false, overlap: 0 };
  if (!bridge.length) return declined;
  // A seam that cut through a word leaves half of it on each side -- "trans"
  // and "cription". Neither half can anchor, so each side is allowed to give
  // up its one fragment token to find the anchor behind it. That fragment is
  // then dropped, because the bridge heard the whole word.
  for (let dropLeft = 0; dropLeft <= 1; dropLeft++) {
    const left = dropLeft ? leftTokens.slice(0, leftTokens.length - 1) : leftTokens;
    if (!left.length) continue;
    const head = stitch(left, bridge);
    if (head.overlap === 0) continue;
    for (let dropRight = 0; dropRight <= 1; dropRight++) {
      const right = rightTokens.slice(dropRight);
      const tail = stitch(bridge, right);
      if (tail.overlap === 0) continue;
      return {
        left,
        tokens: head.tokens.concat(tail.tokens),
        applied: true,
        overlap: head.overlap + tail.overlap,
      };
    }
  }
  return declined;
}

function reconcileChunkTranscripts(parts, bridges) {
  const texts = [];
  for (const part of parts || []) {
    const t = String(part || '').trim();
    if (t) texts.push(t);
  }
  if (!texts.length) return { text: '', boundaries: [], chunks: 0, bridged: 0 };
  const bridgeAt = bridges || {};
  let tokens = splitTokens(texts[0]);
  const boundaries = [];
  let bridged = 0;
  for (let i = 1; i < texts.length; i++) {
    const next = splitTokens(texts[i]);
    let joined = stitch(tokens, next);
    let repaired = false;
    if (joined.overlap === 0 && bridgeAt[i]) {
      const spliced = spliceBridge(tokens, next, bridgeAt[i]);
      if (spliced.applied) {
        tokens = spliced.left;
        joined = { tokens: spliced.tokens, overlap: spliced.overlap };
        repaired = true;
        bridged += 1;
      }
    }
    boundaries.push({
      index: i,
      overlap: joined.overlap,
      // Nothing matched across a boundary that was built to overlap. Either the
      // cut landed inside a word or one of the two passes dropped it.
      suspect: joined.overlap === 0,
      bridged: repaired,
      left: tokens.slice(-2).join(' '),
      right: next.slice(0, 2).join(' '),
    });
    tokens = tokens.concat(joined.tokens);
  }
  return { text: tokens.join(' ').trim(), boundaries, chunks: texts.length, bridged };
}

// Which boundaries are worth going back to the audio for. Capped, because a
// long dictation with a noisy microphone can suspect every seam and the point
// of chunking is that the work is already done when the user stops talking.
function suspectBoundaries(boundaries, limit) {
  const max = Math.max(0, Number(limit) == null ? 2 : Number(limit));
  return (boundaries || []).filter((b) => b && b.suspect).slice(0, max).map((b) => b.index);
}

function joinChunkTranscripts(parts, bridges) {
  const joined = reconcileChunkTranscripts(parts, bridges);
  if (!joined.text) return '';
  // The repeat collapser still runs, but on text that no longer carries the
  // overlap duplicates -- so what it removes is the engine stuttering, which
  // is what it was written for.
  return getDedupe()(joined.text);
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

// Not `chunkingApi`: overlay.js already has a function by that name in the same
// scope. Not `api` either -- that is what collided with cleanup.js and stopped
// this file loading at all, which silently disabled streaming transcription.
const chunkingExports = {
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
  reconcileChunkTranscripts,
  spliceBridge,
  suspectBoundaries,
  MAX_OVERLAP_TOKENS,
  shouldIgnoreGeneration,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = chunkingExports;
} else {
  globalThis.voxdenChunking = chunkingExports;
}
