'use strict';

let metrics;
let dictLib;
if (typeof require !== 'undefined') {
  try {
    metrics = require('./metrics');
    dictLib = require('./dictionary');
  } catch (_) {}
}
if (!metrics && typeof globalThis !== 'undefined') {
  metrics = globalThis.voxdenMetrics;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'is', 'it', 'i', 'you', 'we', 'that', 'this', 'with', 'was', 'are', 'be',
  'have', 'had', 'not', 'so', 'if', 'as', 'my', 'your', 'can', 'do', 'just',
]);

function frequentTerms(entries, limit) {
  if (dictLib && dictLib.frequentTerms) {
    return dictLib.frequentTerms(entries, limit);
  }
  const max = limit || 24;
  const counts = new Map();
  for (const e of entries || []) {
    const words = String((e && e.text) || '').toLowerCase().match(/[a-z0-9']+/g) || [];
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function countWords(s) {
  if (metrics && metrics.countWords) return metrics.countWords(s);
  const t = String(s || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}
const WORDS_PER_PAGE = 250;
const HEATMAP_WEEKS = 16;
const DISPLAY_BUCKETS = ['ai', 'work', 'email', 'personal', 'other'];

const AI_TITLE_HINTS = [
  'chatgpt', 'openai', 'claude', 'anthropic', 'copilot', 'gemini', 'bard',
  'perplexity', 'poe.com', 'character.ai', 'midjourney', 'cursor', 'github copilot',
  'chat.openai', 'aistudio.google', 'labs.google', 'huggingface', 'replicate',
];

const AI_EXE_HINTS = [
  'cursor.exe', 'code.exe', 'cod.exe', 'devenv.exe', 'windsurf.exe',
];

const BUCKET_LABELS = {
  ai: 'AI prompts',
  work: 'Work',
  email: 'Email',
  personal: 'Personal',
  other: 'Other',
};

const PACE_WPM_CEILING = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts, tzOffsetMs) {
  const d = new Date(ts + (tzOffsetMs || 0));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (tzOffsetMs || 0);
}

function isAiContext(exe, title) {
  const ex = String(exe || '').toLowerCase();
  const ti = String(title || '').toLowerCase();
  if (AI_EXE_HINTS.some((h) => ex === h || ex.endsWith('\\' + h))) return true;
  return AI_TITLE_HINTS.some((h) => ti.includes(h));
}

function displayBucket(entry) {
  if (isAiContext(entry.exe, entry.title)) return 'ai';
  const cat = String(entry.category || 'other').toLowerCase();
  if (DISPLAY_BUCKETS.includes(cat) && cat !== 'ai') return cat;
  return 'other';
}

function friendlyExe(exe) {
  const base = String(exe || '').split(/[/\\]/).pop() || '';
  if (!base) return 'Unknown app';
  return base.replace(/\.exe$/i, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function filterByRange(entries, range, now) {
  const all = entries || [];
  if (range === 'all') return all.slice();
  const days = range === '7d' ? 7 : 30;
  const cutoff = (now || Date.now()) - days * DAY_MS;
  return all.filter((e) => (e && e.ts) >= cutoff);
}

function computeStreaks(entries, now) {
  const daySet = new Set();
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    daySet.add(startOfDay(e.ts));
  }
  const days = [...daySet].sort((a, b) => a - b);
  if (!days.length) return { currentStreak: 0, longestStreak: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] - days[i - 1] === DAY_MS) run += 1;
    else {
      if (run > longest) longest = run;
      run = 1;
    }
  }
  if (run > longest) longest = run;

  const today = startOfDay(now || Date.now());
  const yesterday = today - DAY_MS;
  let current = 0;
  if (daySet.has(today) || daySet.has(yesterday)) {
    let cursor = daySet.has(today) ? today : yesterday;
    while (daySet.has(cursor)) {
      current += 1;
      cursor -= DAY_MS;
    }
  }

  return { currentStreak: current, longestStreak: longest };
}

function computeHeatmap(entries, now) {
  const end = startOfDay(now || Date.now());
  const spanDays = HEATMAP_WEEKS * 7;
  const rawStart = end - (spanDays - 1) * DAY_MS;
  const endDow = (new Date(end).getUTCDay() + 6) % 7;
  const gridStart = end - (endDow + (HEATMAP_WEEKS - 1) * 7) * DAY_MS;

  const wordsByDay = new Map();
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    const d = startOfDay(e.ts);
    wordsByDay.set(d, (wordsByDay.get(d) || 0) + countWords(e.text));
  }

  let maxWords = 0;
  const grid = [];
  for (let row = 0; row < 7; row++) grid[row] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    for (let row = 0; row < 7; row++) {
      const ts = gridStart + (w * 7 + row) * DAY_MS;
      const words = ts >= rawStart && ts <= end ? (wordsByDay.get(ts) || 0) : 0;
      if (words > maxWords) maxWords = words;
      grid[row].push({ ts, words, level: 0, inRange: ts >= rawStart && ts <= end });
    }
  }
  for (let row = 0; row < 7; row++) {
    for (let w = 0; w < HEATMAP_WEEKS; w++) {
      const cell = grid[row][w];
      if (!cell.inRange || cell.words <= 0) cell.level = 0;
      else if (maxWords <= 0) cell.level = 0;
      else {
        const ratio = cell.words / maxWords;
        if (ratio >= 0.75) cell.level = 4;
        else if (ratio >= 0.5) cell.level = 3;
        else if (ratio >= 0.25) cell.level = 2;
        else cell.level = 1;
      }
    }
  }
  return { grid, weeks: HEATMAP_WEEKS, startTs: rawStart, endTs: end };
}

function computeVolumeDelta(entries, range, now) {
  const ts = now || Date.now();
  if (range === '7d') {
    const curStart = ts - 7 * DAY_MS;
    const prevStart = ts - 14 * DAY_MS;
    return wordDelta(entries, curStart, ts, prevStart, curStart);
  }
  if (range === '30d') {
    const curStart = ts - 30 * DAY_MS;
    const prevStart = ts - 60 * DAY_MS;
    return wordDelta(entries, curStart, ts, prevStart, curStart);
  }
  const thisMonthStart = Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), 1);
  const lastMonthStart = Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth() - 1, 1);
  return wordDelta(entries, thisMonthStart, ts, lastMonthStart, thisMonthStart);
}

function wordDelta(entries, curStart, curEnd, prevStart, prevEnd) {
  let cur = 0;
  let prev = 0;
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    const w = countWords(e.text);
    if (e.ts >= curStart && e.ts <= curEnd) cur += w;
    else if (e.ts >= prevStart && e.ts < prevEnd) prev += w;
  }
  if (prev <= 0 && cur <= 0) return null;
  if (prev <= 0) return { direction: 'up', percent: 100, label: 'new activity' };
  const change = Math.round(((cur - prev) / prev) * 100);
  if (change === 0) return null;
  return {
    direction: change > 0 ? 'up' : 'down',
    percent: Math.abs(change),
    label: (change > 0 ? '+' : '') + change + '% vs prior period',
  };
}

function milestoneText(totalWords) {
  if (totalWords < WORDS_PER_PAGE) return null;
  const pages = Math.floor(totalWords / WORDS_PER_PAGE);
  if (pages < 2) return 'About 1 page of writing';
  if (pages < 10) return 'About ' + pages + ' pages of writing';
  if (pages < 40) return 'About ' + pages + ' pages — a short essay';
  return 'About ' + pages + ' pages — novel territory';
}

function countLearnedPairs(entries) {
  let n = 0;
  for (const e of entries || []) {
    if (Array.isArray(e.learnedPairs)) n += e.learnedPairs.length;
  }
  return n;
}

function countEdited(entries) {
  let n = 0;
  for (const e of entries || []) {
    if (!e) continue;
    if (String(e.text || '') !== String(e.original || '')) n += 1;
  }
  return n;
}

function sumDictionaryHits(entries) {
  let n = 0;
  let hasData = false;
  for (const e of entries || []) {
    if (!e || typeof e.dictionaryHits !== 'number') continue;
    hasData = true;
    n += e.dictionaryHits;
  }
  return { total: n, hasData };
}

function computeCategoryMix(entries) {
  const counts = { ai: 0, work: 0, email: 0, personal: 0, other: 0 };
  let withTarget = 0;
  for (const e of entries || []) {
    if (!e || (!e.exe && !e.title && !e.category)) continue;
    withTarget += 1;
    counts[displayBucket(e)] += countWords(e.text);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = DISPLAY_BUCKETS.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    words: counts[id],
    percent: total > 0 ? Math.round((counts[id] / total) * 100) : 0,
  })).filter((r) => r.words > 0)
    .sort((a, b) => b.words - a.words);
  return { rows, total, withTarget };
}

function topApps(entries, limit) {
  const counts = new Map();
  for (const e of entries || []) {
    if (!e || !e.exe) continue;
    const key = String(e.exe).toLowerCase();
    counts.set(key, {
      exe: e.exe,
      label: friendlyExe(e.exe),
      words: (counts.get(key) ? counts.get(key).words : 0) + countWords(e.text),
    });
  }
  return [...counts.values()]
    .sort((a, b) => b.words - a.words)
    .slice(0, limit || 4);
}

function rangeSubtitle(filtered, range) {
  const n = filtered.length;
  const label = range === '7d' ? 'this week' : range === '30d' ? 'this month' : 'all time';
  if (!n) return 'No dictations ' + label;
  const words = filtered.reduce((s, e) => s + countWords(e.text), 0);
  return n.toLocaleString() + ' dictations · ' + words.toLocaleString() + ' words ' + label;
}

function computeInsights(entries, phrases, range, now) {
  const filtered = filterByRange(entries, range || 'all', now);
  const m = metrics && metrics.computeMetrics
    ? metrics.computeMetrics(filtered)
    : { avgWpm: null, timeSavedMs: null, timedWords: 0, totalDurationMs: 0 };
  const typingBaseline = (metrics && metrics.TYPING_WPM_BASELINE) || 40;
  const totalWords = filtered.reduce((s, e) => s + countWords(e.text), 0);
  const pacePercent = m.avgWpm != null
    ? Math.min(100, Math.round((m.avgWpm / PACE_WPM_CEILING) * 100))
    : null;
  let paceCaption = null;
  if (m.avgWpm != null && m.avgWpm > 0) {
    const mult = (m.avgWpm / typingBaseline).toFixed(1);
    paceCaption = mult + '× faster than typing at ' + typingBaseline + ' WPM';
  }
  const delta = computeVolumeDelta(entries || [], range || 'all', now);
  const streaks = computeStreaks(entries || [], now);
  const heatmap = computeHeatmap(entries || [], now);
  const mix = computeCategoryMix(filtered);
  const apps = topApps(filtered, 4);
  const hits = sumDictionaryHits(filtered);
  const learnedPairCount = countLearnedPairs(filtered);
  const editedCount = countEdited(filtered);
  const frequent = frequentTerms(filtered, 8);

  return {
    range: range || 'all',
    subtitle: rangeSubtitle(filtered, range || 'all'),
    pace: {
      avgWpm: m.avgWpm,
      percent: pacePercent,
      caption: paceCaption,
      hasTimed: m.timedWords > 0,
    },
    volume: {
      words: totalWords,
      dictations: filtered.length,
      delta,
      milestone: milestoneText(totalWords),
    },
    taught: {
      dictionarySize: (phrases || []).length,
      learnedPairs: learnedPairCount,
      editedTranscripts: editedCount,
      dictionaryHits: hits.total,
      hasDictionaryHits: hits.hasData,
    },
    where: {
      rows: mix.rows,
      withTarget: mix.withTarget,
      apps,
    },
    rhythm: {
      currentStreak: streaks.currentStreak,
      longestStreak: streaks.longestStreak,
      heatmap,
    },
    words: frequent,
  };
}

const insightsApi = {
  PACE_WPM_CEILING,
  WORDS_PER_PAGE,
  HEATMAP_WEEKS,
  DISPLAY_BUCKETS,
  BUCKET_LABELS,
  isAiContext,
  displayBucket,
  friendlyExe,
  filterByRange,
  computeInsights,
  computeStreaks,
  computeHeatmap,
  milestoneText,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = insightsApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.voxdenInsights = insightsApi;
}
