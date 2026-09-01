'use strict';

const TYPING_WPM_BASELINE = 40;

function countWords(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function computeMetrics(entries) {
  let timedWords = 0;
  let totalDurationMs = 0;

  for (const e of entries || []) {
    const w = countWords(e.text);
    const d = e && e.durationMs;
    if (typeof d === 'number' && d > 0 && w > 0) {
      timedWords += w;
      totalDurationMs += d;
    }
  }

  const avgWpm = totalDurationMs > 0
    ? Math.round(timedWords / (totalDurationMs / 60000))
    : null;

  const typingTimeMs = timedWords > 0
    ? (timedWords / TYPING_WPM_BASELINE) * 60000
    : 0;

  const timeSavedMs = totalDurationMs > 0
    ? Math.max(0, Math.round(typingTimeMs - totalDurationMs))
    : null;

  return { avgWpm, timeSavedMs, timedWords, totalDurationMs, typingWpmBaseline: TYPING_WPM_BASELINE };
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
  countWords,
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
