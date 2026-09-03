'use strict';

// Was anyone speaking? Decided from the recording itself, before it goes
// anywhere near a speech model.
//
// Every engine in use here will write words over silence sooner or later --
// a recording that holds nothing but room tone comes back as "Thank you." or
// a sentence from the vocabulary prompt -- and that text used to be pasted
// like any other. The engines' own voice filters do not cover this: the
// chunk slices are sent with filtering off on purpose, and the Qwen backend
// ignores the flag altogether. So the gate lives here, on the 16 kHz float
// samples the page already holds, and applies to every engine the same way.
//
// The measure is loudness over short frames, which is what the chunker uses
// to find pauses. The floor is set well below the chunker's idea of speech:
// this only has to tell "nobody said anything" from "somebody said
// something", and a quiet talker on a distant microphone must pass. Anything
// that trips the floor for a few frames in a row counts. The verdict carries
// the numbers it was made from, so a wrong call can be read off the log.
//
// Wrapped in a closure because overlay.html loads this as a plain script
// next to chunking.js, and the two would otherwise share one scope.
(function () {
  const SAMPLE_RATE = 16000;
  // Frames of this length are scored individually.
  const FRAME_MS = 30;
  // A frame louder than this is "active". The chunker calls 0.012 speech; a
  // third of that still sits above suppressed room noise, which measures in
  // the low thousandths on the microphones tried.
  const ACTIVE_RMS = 0.004;
  // This many active frames in a row, at least once, and it is speech. Three
  // frames is 90 ms: shorter than any word, longer than a click or a knock.
  const MIN_RUN_FRAMES = 3;
  // A single sample past this is a real signal no matter what the frames say
  // -- a clipped consonant can be over in one frame.
  const PEAK_FLOOR = 0.25;

  function frameRms(samples, from, to) {
    let sum = 0;
    for (let i = from; i < to; i++) {
      const v = samples[i];
      sum += v * v;
    }
    return Math.sqrt(sum / (to - from));
  }

  function round(v) {
    return Math.round(v * 10000) / 10000;
  }

  // pcm: Float32Array (or array-like) of mono samples in [-1, 1].
  // Returns { speech, peak, rms, activeMs, longestRunMs, durationMs }.
  function analyseSpeech(pcm, options) {
    const opts = options || {};
    const rate = Number(opts.sampleRate) || SAMPLE_RATE;
    const frameLen = Math.max(1, Math.round((Number(opts.frameMs) || FRAME_MS) * rate / 1000));
    const activeRms = Number.isFinite(opts.activeRms) ? opts.activeRms : ACTIVE_RMS;
    const minRun = Math.max(1, Number(opts.minRunFrames) || MIN_RUN_FRAMES);
    const peakFloor = Number.isFinite(opts.peakFloor) ? opts.peakFloor : PEAK_FLOOR;
    const samples = pcm || [];
    const n = samples.length;

    let peak = 0;
    let sumSq = 0;
    let activeFrames = 0;
    let run = 0;
    let longestRun = 0;
    for (let start = 0; start + frameLen <= n; start += frameLen) {
      const end = start + frameLen;
      let frameSum = 0;
      for (let i = start; i < end; i++) {
        const v = samples[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        frameSum += v * v;
      }
      sumSq += frameSum;
      const rms = Math.sqrt(frameSum / frameLen);
      if (rms >= activeRms) {
        activeFrames += 1;
        run += 1;
        if (run > longestRun) longestRun = run;
      } else {
        run = 0;
      }
    }
    const scored = Math.floor(n / frameLen) * frameLen;
    const rms = scored > 0 ? Math.sqrt(sumSq / scored) : 0;
    const speech = longestRun >= minRun || peak >= peakFloor;
    const frameMs = frameLen * 1000 / rate;
    return {
      speech,
      peak: round(peak),
      rms: round(rms),
      activeMs: Math.round(activeFrames * frameMs),
      longestRunMs: Math.round(longestRun * frameMs),
      durationMs: Math.round(n * 1000 / rate),
    };
  }

  const speechGateExports = {
    analyseSpeech,
    frameRms,
    ACTIVE_RMS,
    MIN_RUN_FRAMES,
    PEAK_FLOOR,
    FRAME_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = speechGateExports;
  } else {
    globalThis.voxdenSpeechGate = speechGateExports;
  }
})();
