'use strict';

// Split batch transcription audio at pauses while recording continues. This is
// deliberately conservative: uninterrupted speech keeps its full context, and
// every sample belongs to exactly one segment (including the final flush).
(function(root) {
  function createCloudSegmenter({ sampleRate = 16000, silenceMs = 400,
    minSegmentMs = 3000, speechRms = 0.012 } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0
      || !Number.isFinite(silenceMs) || silenceMs <= 0
      || !Number.isFinite(minSegmentMs) || minSegmentMs < 0
      || !Number.isFinite(speechRms) || speechRms <= 0) {
      throw new RangeError('Cloud segmenter requires a positive sample rate, silence duration and speech RMS, and a nonnegative minimum duration.');
    }

    const frameSize = 256;
    const silenceSamples = Math.ceil(sampleRate * silenceMs / 1000);
    const minSegmentSamples = Math.ceil(sampleRate * minSegmentMs / 1000);
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

        if (hasSpeech && quietSamples >= silenceSamples && sampleCount >= minSegmentSamples) {
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

  const api = { createCloudSegmenter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voxdenCloudSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
