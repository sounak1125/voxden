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

// These files are <script>-loaded as well as required, so every top-level name
// lands in one shared global scope per page. A plain `api` here collided with
// the same name in suggestions.js and killed that whole file on load.
const metricsApi = {
  TYPING_WPM_BASELINE,
  countWords,
  computeMetrics,
  formatWpm,
  formatTimeSaved,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = metricsApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.voxdenMetrics = metricsApi;
}
