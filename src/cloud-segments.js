'use strict';

// Split batch transcription audio at pauses while recording continues. This is
// deliberately conservative: uninterrupted speech keeps its full context, and
// every sample belongs to exactly one segment (including the final flush).
(function(root) {
  // A segment is transcribed on its own, so every cut costs the model the
  // words on the far side of it. That context is what lets it hear a name
  // like "Higgsfield" as one word; cut after "Higgs" and the first request
  // comes back with a broken word and the second with "field". The floor was
  // once 1.5 seconds with a 400ms pause, which sent most short dictations up
  // as two or three pieces and cut through any word the speaker slowed down
  // on. A warm model answered clips in about half a second (see
  // server/cloud.js), so splitting a short dictation should save little while
  // it costs accuracy; the cloud-request log line shows the real wait.
  // Segments now start at 8 seconds and need a 700ms pause, a break between
  // thoughts rather than a breath inside a word: short dictations go up whole,
  // and long ones still upload while the user talks.
  // Someone reading aloud may never pause that long, so past 45 seconds a
  // 300ms pause is enough. Only at 240 seconds is a segment cut with no pause
  // at all: the relay refuses clips over five minutes, so one that long would
  // otherwise fail whole (joinCloudTexts rejoins a word the cut went through).
  // Match the 0.004 RMS used by the cloud upload speech gate. The previous
  // 0.012 boundary counted softer syllables as silence even though the upload
  // gate correctly considered them audible.
  function createCloudSegmenter({ sampleRate = 16000, silenceMs = 700,
    minSegmentMs = 8000, speechRms = 0.004, longSegmentMs = 45000,
    longSilenceMs = 300, maxSegmentMs = 240000 } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0
      || !Number.isFinite(silenceMs) || silenceMs <= 0
      || !Number.isFinite(minSegmentMs) || minSegmentMs < 0
      || !Number.isFinite(speechRms) || speechRms <= 0
      || !Number.isFinite(longSegmentMs) || longSegmentMs < minSegmentMs
      || !Number.isFinite(longSilenceMs) || longSilenceMs <= 0
      || !Number.isFinite(maxSegmentMs) || maxSegmentMs < longSegmentMs) {
      throw new RangeError('Cloud segmenter requires a positive sample rate, silence duration and speech RMS, and a nonnegative minimum duration.');
    }

    const frameSize = 256;
    const silenceSamples = Math.ceil(sampleRate * silenceMs / 1000);
    const minSegmentSamples = Math.ceil(sampleRate * minSegmentMs / 1000);
    const longSegmentSamples = Math.ceil(sampleRate * longSegmentMs / 1000);
    const longSilenceSamples = Math.ceil(sampleRate * longSilenceMs / 1000);
    const maxSegmentSamples = Math.ceil(sampleRate * maxSegmentMs / 1000);
    const speechEnergy = speechRms * speechRms;
    let chunks = [];
    let sampleCount = 0;
    let frameCount = 0;
    let frameEnergy = 0;
    let quietSamples = 0;
    let hasSpeech = false;

    function drain() {
      if (!sampleCount) return null;
      const segment = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of chunks) {
        segment.set(chunk, offset);
        offset += chunk.length;
      }
      chunks = [];
      sampleCount = frameCount = quietSamples = 0;
      frameEnergy = 0;
      hasSpeech = false;
      return segment;
    }

    function push(samples) {
      if (!(samples instanceof Float32Array)) {
        throw new TypeError('Cloud segmenter expects mono Float32Array PCM.');
      }
      const segments = [];
      let start = 0;
      for (let i = 0; i < samples.length; i++) {
        sampleCount++;
        frameCount++;
        frameEnergy += samples[i] * samples[i];
        if (frameCount !== frameSize) continue;

        // Keep frame boundaries stable across push calls, even when the audio
        // source supplies partial or differently sized buffers.
        if (frameEnergy / frameSize >= speechEnergy) {
          hasSpeech = true;
          quietSamples = 0;
        } else if (hasSpeech) {
          quietSamples += frameSize;
        }
        frameCount = 0;
        frameEnergy = 0;

        const pauseNeeded = sampleCount >= longSegmentSamples ? longSilenceSamples : silenceSamples;
        if ((hasSpeech && quietSamples >= pauseNeeded && sampleCount >= minSegmentSamples)
          || sampleCount >= maxSegmentSamples) {
          chunks.push(samples.slice(start, i + 1));
          segments.push(drain());
          start = i + 1;
        }
      }
      // Copy retained data because microphone buffers may be reused immediately
      // after push returns. Grow a list of chunks, never concatenate the entire
      // recording on each push; total copying stays linear in the audio length.
      if (start < samples.length) chunks.push(samples.slice(start));
      return segments;
    }

    // Preserve even a partial detection frame and silence-only tails. The caller
    // can apply its existing silence gate. Flush also resets this instance.
    return { push, flush: drain };
  }

  // Bounded overlap of requests, not audio. Audio boundaries and the caller's
  // ordered result array stay unchanged. A failure stops work not yet sent.
  function createCloudQueue({ concurrency = 2, now = () => Date.now() } = {}) {
    const limit = Math.max(1, Math.min(2, Math.floor(concurrency) || 1));
    let active = 0, failure = null;
    const waiting = [];
    function cancel(error = new Error('Dictation cancelled.')) {
      failure = failure || error;
      for (const job of waiting.splice(0)) job.reject(failure);
    }
    function pump() {
      while (!failure && active < limit && waiting.length) {
        const job = waiting.shift();
        const started = now();
        active++;
        Promise.resolve().then(job.work).then(value => {
          job.resolve({ value, queueMs: Math.max(0, started - job.queued), requestMs: Math.max(0, now() - started) });
        }, error => { cancel(error); job.reject(error); }).finally(() => { active--; pump(); });
      }
    }
    return {
      enqueue(work) {
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => { waiting.push({ work, resolve, reject, queued: now() }); pump(); });
      },
      cancel,
    };
  }

  // Join segment transcripts in order. Segments share no audio, so nothing is
  // deduplicated and a word said twice stays twice. The one repair is a word
  // the model heard cut off at the end of a segment and marked with a hyphen
  // ("Higgs-" or "Higgs-."): the rest of it opens the next segment, so the two
  // halves are rejoined ("Higgsfield"). A capital the model gave the second
  // half only because it opened a clip is dropped; an acronym keeps its case.
  // Anchored at a word start and capped at 40 characters, so a long run of
  // letters is one pass, not one per character.
  const CUT_WORD = /(?<![\p{L}\p{M}\p{N}])([\p{L}\p{M}\p{N}]{1,40})[-\u2010]{1,3}(?:\.{1,3}|\u2026)?$/u;
  const WORD_HEAD = /^[\p{L}\p{N}]/u;
  function joinCloudTexts(texts) {
    const parts = [];
    for (const text of texts || []) {
      const part = String(text || '').trim();
      if (!part) continue;
      const previous = parts.length ? parts[parts.length - 1] : '';
      const cut = previous.match(CUT_WORD);
      if (cut && WORD_HEAD.test(part)) {
        const space = part.search(/\s/);
        let head = space < 0 ? part : part.slice(0, space);
        const rest = space < 0 ? '' : part.slice(space);
        const tail = head.slice(1);
        if (tail && tail === tail.toLowerCase()) head = head[0].toLowerCase() + tail;
        parts[parts.length - 1] = previous.slice(0, cut.index) + cut[1] + head + rest;
        continue;
      }
      parts.push(part);
    }
    return parts.join(' ');
  }

  const api = { createCloudSegmenter, createCloudQueue, joinCloudTexts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voxdenCloudSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
