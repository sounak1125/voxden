'use strict';

const TYPING_WPM_BASELINE = 40;

// A recording has to be at least this long to be a trustworthy speaking-pace
// sample. Under a second, the wall clock we measure -- capture-ready to stop --
// is dominated by start/stop jitter and the ~85ms audio-buffer granularity, so
// the rate it implies is noise. It is also where a new user's first attempts
// land: the mic warm-up clips their opening words, leaving a short tail measured
// against a sliver of time, and a single such entry can drag a small history's
// average up to a figure nobody actually speaks at.
const MIN_TIMED_DURATION_MS = 1000;

// The average is a duration-weighted mean of the per-entry rates, so it can
// never exceed the fastest sample it is built from -- which makes this per-entry
// cap the ceiling on the whole figure. It sits just above the pace bar's own top
// (insights PACE_WPM_CEILING is 200) so a genuinely fast speaker still registers,
// but low enough that a run of clipped short bursts -- what produced the
// impossible 229 on a fresh install -- cannot pull the headline past a rate a
// person can actually sustain. A reading above it has words and a duration that
// do not describe the same window, so it is dropped rather than counted.
const MAX_PLAUSIBLE_WPM = 220;

function countWords(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

// Whether a history entry can be trusted as a speaking-pace sample. Anything
// without a real duration, too short to measure, or implying an impossible rate
// is kept out of every pace figure, so one bad reading -- common on a fresh
// install with only a handful of dictations -- cannot define the number the
// user sees. Word counts and time-saved use their own full-history totals; this
// gate is only for words-per-minute.
function isPaceSample(entry) {
  if (!entry) return false;
  const d = Number(entry.durationMs);
  if (!Number.isFinite(d) || d < MIN_TIMED_DURATION_MS) return false;
  const w = countWords(entry.text);
  if (w <= 0) return false;
  return w / (d / 60000) <= MAX_PLAUSIBLE_WPM;
}

function computeMetrics(entries) {
  // Pace and time-saved are different measurements and must not share a filter.
  // Words-per-minute only trusts samples long enough to measure and plausible in
  // rate (isPaceSample), so one clipped reading cannot define it. Time saved
  // credits every real dictation, because even a sub-second one spared the user
  // from typing those words -- gating it on the pace filter used to zero out a
  // fresh user's time-saved along with their unreliable pace.
  let paceWords = 0;
  let paceDurationMs = 0;
  let savedWords = 0;
  let savedDurationMs = 0;

  for (const e of entries || []) {
    const d = e && Number(e.durationMs);
    if (!Number.isFinite(d) || d <= 0) continue;
    const w = countWords(e.text);
    if (w <= 0) continue;
    savedWords += w;
    savedDurationMs += d;
    if (isPaceSample(e)) {
      paceWords += w;
      paceDurationMs += d;
    }
  }

  const avgWpm = paceDurationMs > 0
    ? Math.round(paceWords / (paceDurationMs / 60000))
    : null;

  const typingTimeMs = savedWords > 0
    ? (savedWords / TYPING_WPM_BASELINE) * 60000
    : 0;

  const timeSavedMs = savedDurationMs > 0
    ? Math.max(0, Math.round(typingTimeMs - savedDurationMs))
    : null;

  // timedWords/totalDurationMs describe the pace basis (the "from N timed words"
  // note and whether the pace card has data), so they report the pace sample,
  // not the wider time-saved set. timeSavedMs is computed above from that wider
  // set, so it is deliberately NOT typingTime(timedWords) - totalDurationMs.
  return {
    avgWpm,
    timeSavedMs,
    timedWords: paceWords,
    totalDurationMs: paceDurationMs,
    typingWpmBaseline: TYPING_WPM_BASELINE,
  };
}

function formatWpm(wpm) {
  if (wpm == null || !Number.isFinite(wpm) || wpm <= 0) return '—';
  return wpm.toLocaleString();
}

function formatTimeSaved(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' sec';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' min';
  const hrs = min / 60;
  return hrs >= 10 ? Math.round(hrs) + ' hrs' : hrs.toFixed(1) + ' hrs';
}

function beginDictationTiming(now) {
  const stopAt = Number(now);
  return {
    stopAt: Number.isFinite(stopAt) ? stopAt : Date.now(),
    recognitionMs: 0,
    modelRecognitionMs: 0,
    rewriteMs: 0,
    pasteMs: 0,
    pastedAt: 0,
  };
}

function markRecognitionComplete(timing, now, modelRecognitionMs) {
  if (!timing || timing.recognitionMs > 0) return timing;
  const at = Number(now);
  if (Number.isFinite(at) && at >= timing.stopAt) {
    timing.recognitionMs = Math.round(at - timing.stopAt);
  }
  const modelMs = Number(modelRecognitionMs);
  if (Number.isFinite(modelMs) && modelMs > 0) {
    timing.modelRecognitionMs = Math.round(modelMs);
  }
  return timing;
}

function addRewriteDuration(timing, elapsedMs) {
  if (!timing) return timing;
  const elapsed = Number(elapsedMs);
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    timing.rewriteMs += Math.round(elapsed);
  }
  return timing;
}

function markPasteComplete(timing, startedAt, finishedAt) {
  if (!timing) return timing;
  const started = Number(startedAt);
  const finished = Number(finishedAt);
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    timing.pasteMs += Math.round(finished - started);
    timing.pastedAt = finished;
  }
  return timing;
}

function dictationTimingFields(timing) {
  if (!timing || !timing.stopAt || !timing.pastedAt) return {};
  const stopToPasteMs = Math.max(0, Math.round(timing.pastedAt - timing.stopAt));
  const recognitionMs = Math.max(0, Math.round(Number(timing.recognitionMs) || 0));
  const modelRecognitionMs = Math.max(0, Math.round(Number(timing.modelRecognitionMs) || 0));
  const rewriteMs = Math.max(0, Math.round(Number(timing.rewriteMs) || 0));
  const pasteMs = Math.max(0, Math.round(Number(timing.pasteMs) || 0));
  const postProcessMs = Math.max(0, stopToPasteMs - recognitionMs - rewriteMs - pasteMs);
  return { recognitionMs, modelRecognitionMs, rewriteMs, pasteMs, postProcessMs, stopToPasteMs };
}

function formatLatency(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return Math.round(value) + ' ms';
  return (value / 1000).toFixed(value < 10000 ? 2 : 1).replace(/\.0$/, '') + ' s';
}

// These files are <script>-loaded as well as required, so every top-level name
// lands in one shared global scope per page. A plain `api` here collided with
// the same name in suggestions.js and killed that whole file on load.
const metricsApi = {
  TYPING_WPM_BASELINE,
  MIN_TIMED_DURATION_MS,
  MAX_PLAUSIBLE_WPM,
  countWords,
  isPaceSample,
  computeMetrics,
  formatWpm,
  formatTimeSaved,
  beginDictationTiming,
  markRecognitionComplete,
  addRewriteDuration,
  markPasteComplete,
  dictationTimingFields,
  formatLatency,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = metricsApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.voxdenMetrics = metricsApi;
}
