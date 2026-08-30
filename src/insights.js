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

const HEATMAP_WEEKS = 17;
const MIN_HEATMAP_WEEKS = 6;
const DIFF_MAX_WORDS = 600;
const DISPLAY_BUCKETS = ['ai', 'work', 'email', 'personal', 'other'];

const AI_TITLE_HINTS = [
  'chatgpt', 'openai', 'claude', 'anthropic', 'copilot', 'gemini', 'bard',
  'perplexity', 'poe.com', 'character.ai', 'midjourney', 'cursor', 'github copilot',
  'chat.openai', 'aistudio.google', 'labs.google', 'huggingface', 'replicate',
];

const AI_EXE_HINTS = [
  'cursor.exe', 'code.exe', 'cod.exe', 'devenv.exe', 'windsurf.exe',
];

// A process name identifies the host, not always the destination. Browser tabs
// and desktop shells can surface as Chrome or PowerShell while their window
// title still tells us the user dictated into ChatGPT, Claude, or another AI
// tool. Keep this ordered from specific to broad so "ChatGPT - OpenAI" remains
// ChatGPT rather than collapsing into the generic OpenAI label.
const AI_TARGETS = [
  { id: 'chatgpt', label: 'ChatGPT', titles: ['chatgpt', 'chat.openai'] },
  { id: 'claude', label: 'Claude', titles: ['claude'] },
  { id: 'github-copilot', label: 'GitHub Copilot', titles: ['github copilot'] },
  { id: 'copilot', label: 'Copilot', titles: ['copilot'] },
  { id: 'gemini', label: 'Gemini', titles: ['gemini', 'bard'] },
  { id: 'perplexity', label: 'Perplexity', titles: ['perplexity'] },
  { id: 'poe', label: 'Poe', titles: ['poe.com'] },
  { id: 'character-ai', label: 'Character.AI', titles: ['character.ai'] },
  { id: 'midjourney', label: 'Midjourney', titles: ['midjourney'] },
  { id: 'google-ai-studio', label: 'Google AI Studio', titles: ['aistudio.google', 'labs.google'] },
  { id: 'hugging-face', label: 'Hugging Face', titles: ['huggingface'] },
  { id: 'replicate', label: 'Replicate', titles: ['replicate'] },
  { id: 'anthropic', label: 'Anthropic', titles: ['anthropic'] },
  { id: 'openai', label: 'OpenAI', titles: ['openai'] },
  { id: 'cursor', label: 'Cursor', titles: ['cursor'], exes: ['cursor.exe'] },
  { id: 'windsurf', label: 'Windsurf', titles: ['windsurf'], exes: ['windsurf.exe'] },
  { id: 'vscode', label: 'VS Code', exes: ['code.exe'] },
  { id: 'visual-studio', label: 'Visual Studio', exes: ['devenv.exe'] },
  { id: 'codex', label: 'Codex', exes: ['cod.exe'] },
];

const BUCKET_LABELS = {
  ai: 'AI prompts',
  work: 'Work messages',
  email: 'Emails',
  personal: 'Personal messages',
  other: 'Other tasks',
};

const MILESTONES = [
  { words: 250, label: 'a full page' },
  { words: 750, label: 'a blog post' },
  { words: 1500, label: 'a long essay' },
  { words: 5000, label: 'a short story' },
  { words: 10000, label: 'a book chapter' },
  { words: 25000, label: 'a novella' },
  { words: 50000, label: 'a novel' },
  { words: 100000, label: 'an epic novel' },
];

const PACE_WPM_CEILING = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar-day arithmetic, so DST transitions never shift a cell.
function addDays(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function tokenizeWords(s) {
  return String(s || '').trim().toLowerCase().match(/\S+/g) || [];
}

function multisetDiff(a, b) {
  const counts = new Map();
  for (const w of a) counts.set(w, (counts.get(w) || 0) + 1);
  let extraB = 0;
  for (const w of b) {
    const c = counts.get(w) || 0;
    if (c > 0) counts.set(w, c - 1);
    else extraB += 1;
  }
  let extraA = 0;
  for (const c of counts.values()) extraA += c;
  return Math.max(extraA, extraB);
}

// Number of words that changed between two versions of the same transcript.
// Substitutions count once; pure insertions and deletions count once each.
function wordDiffCount(a, b) {
  const A = tokenizeWords(a);
  const B = tokenizeWords(b);
  if (!A.length && !B.length) return 0;
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  if (A.length > DIFF_MAX_WORDS || B.length > DIFF_MAX_WORDS) return multisetDiff(A, B);

  let prev = new Array(B.length + 1).fill(0);
  let row = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    row[0] = 0;
    for (let j = 1; j <= B.length; j++) {
      row[j] = A[i - 1] === B[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], row[j - 1]);
    }
    const swap = prev;
    prev = row;
    row = swap;
  }
  return Math.max(A.length, B.length) - prev[B.length];
}

function isAiContext(exe, title) {
  const ex = String(exe || '').toLowerCase();
  const ti = String(title || '').toLowerCase();
  if (AI_EXE_HINTS.some((h) => ex === h || ex.endsWith('\\' + h))) return true;
  return AI_TITLE_HINTS.some((h) => ti.includes(h));
}

function aiTarget(exe, title) {
  const ex = String(exe || '').toLowerCase().split(/[/\\]/).pop() || '';
  const ti = String(title || '').toLowerCase();
  for (const target of AI_TARGETS) {
    if ((target.titles || []).some((hint) => ti.includes(hint))) return target;
    if ((target.exes || []).includes(ex)) return target;
  }
  return null;
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

function appIdentity(entry) {
  const e = entry || {};
  const target = aiTarget(e.exe, e.title);
  if (target) return { key: 'ai:' + target.id, label: target.label };
  const exe = String(e.exe || '');
  return { key: 'exe:' + exe.toLowerCase(), label: friendlyExe(exe) };
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
  if (!days.length) return { currentStreak: 0, longestStreak: 0, currentDays: new Set() };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (addDays(days[i - 1], 1) === days[i]) run += 1;
    else {
      if (run > longest) longest = run;
      run = 1;
    }
  }
  if (run > longest) longest = run;

  const today = startOfDay(now || Date.now());
  const yesterday = addDays(today, -1);
  const currentDays = new Set();
  let current = 0;
  if (daySet.has(today) || daySet.has(yesterday)) {
    let cursor = daySet.has(today) ? today : yesterday;
    while (daySet.has(cursor)) {
      current += 1;
      currentDays.add(cursor);
      cursor = addDays(cursor, -1);
    }
  }

  return { currentStreak: current, longestStreak: longest, currentDays };
}

// Sunday-first grid ending today, one column per week. The window grows with
// your history instead of always spanning HEATMAP_WEEKS: a fixed window makes
// a new account look like months of missed days rather than a short history.
function computeHeatmap(entries, now, currentDays) {
  const end = startOfDay(now || Date.now());
  const endDow = new Date(end).getDay();

  let firstDay = null;
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    const d = startOfDay(e.ts);
    if (firstDay === null || d < firstDay) firstDay = d;
  }
  // Days before the first dictation are not-applicable rather than idle, so
  // they are excluded from the window and drawn like future days.
  const spanDays = firstDay === null
    ? 0
    : Math.round((end - firstDay) / DAY_MS) + endDow + 1;
  const weeks = Math.max(
    MIN_HEATMAP_WEEKS,
    Math.min(HEATMAP_WEEKS, Math.ceil(spanDays / 7))
  );
  const columns = [];
  const wordsByDay = new Map();
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    const d = startOfDay(e.ts);
    wordsByDay.set(d, (wordsByDay.get(d) || 0) + countWords(e.text));
  }

  const gridStart = addDays(end, -(endDow + (weeks - 1) * 7));
  let maxWords = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let row = 0; row < 7; row++) {
      const ts = addDays(gridStart, w * 7 + row);
      const future = ts > end;
      const beforeStart = firstDay !== null && ts < firstDay;
      const words = future ? 0 : (wordsByDay.get(ts) || 0);
      if (words > maxWords) maxWords = words;
      col.push({
        ts,
        words,
        level: 0,
        future,
        beforeStart,
        outOfRange: future || beforeStart,
        inStreak: !!(currentDays && currentDays.has(ts)),
      });
    }
    columns.push(col);
  }

  for (const col of columns) {
    for (const cell of col) {
      if (cell.future || cell.words <= 0 || maxWords <= 0) { cell.level = 0; continue; }
      const ratio = cell.words / maxWords;
      if (ratio >= 0.66) cell.level = 4;
      else if (ratio >= 0.33) cell.level = 3;
      else if (ratio >= 0.1) cell.level = 2;
      else cell.level = 1;
    }
  }

  const months = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const m = new Date(columns[w][0].ts).getMonth();
    if (m !== lastMonth) {
      months.push({ column: w, label: MONTH_NAMES[m] });
      lastMonth = m;
    }
  }

  return { columns, weeks, months, maxWords, startTs: gridStart, endTs: end };
}

function computeVolumeDelta(entries, range, now) {
  const ts = now || Date.now();
  if (range === '7d') {
    const curStart = ts - 7 * DAY_MS;
    const prevStart = ts - 14 * DAY_MS;
    return wordDelta(entries, curStart, ts, prevStart, curStart, 'vs last week');
  }
  if (range === '30d') {
    const curStart = ts - 30 * DAY_MS;
    const prevStart = ts - 60 * DAY_MS;
    return wordDelta(entries, curStart, ts, prevStart, curStart, 'vs last month');
  }
  const d = new Date(ts);
  const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  return wordDelta(entries, thisMonthStart, ts, lastMonthStart, thisMonthStart, 'this month');
}

function wordDelta(entries, curStart, curEnd, prevStart, prevEnd, suffix) {
  let cur = 0;
  let prev = 0;
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    const w = countWords(e.text);
    if (e.ts >= curStart && e.ts <= curEnd) cur += w;
    else if (e.ts >= prevStart && e.ts < prevEnd) prev += w;
  }
  if (prev <= 0 && cur <= 0) return null;
  if (prev <= 0) return { direction: 'up', percent: null, label: 'new activity ' + suffix };
  const change = Math.round(((cur - prev) / prev) * 100);
  if (change === 0) return null;
  return {
    direction: change > 0 ? 'up' : 'down',
    percent: Math.abs(change),
    label: Math.abs(change) + '% ' + suffix,
  };
}

// Nearest milestone already cleared, plus progress toward the next one.
function computeMilestone(totalWords) {
  let reached = null;
  let next = MILESTONES[0];
  for (const m of MILESTONES) {
    if (totalWords >= m.words) { reached = m; next = null; }
    else { next = m; break; }
  }
  const reachedWords = reached ? reached.words : 0;
  const percent = next
    ? Math.max(2, Math.min(100, Math.round(((totalWords - reachedWords) / (next.words - reachedWords)) * 100)))
    : 100;
  return {
    text: reached ? "You've written " + reached.label + '!' : null,
    next: next ? next.label : null,
    nextWords: next ? next.words - totalWords : 0,
    percent,
  };
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

// Fixes Voxden made on the way from raw speech to pasted text.
function computeFixes(entries) {
  let dictionary = 0;
  let style = 0;
  let hasData = false;
  for (const e of entries || []) {
    if (!e) continue;
    if (typeof e.dictionaryHits === 'number') { dictionary += e.dictionaryHits; hasData = true; }
    if (typeof e.styleFixes === 'number') { style += e.styleFixes; hasData = true; }
  }
  return { dictionary, style, total: dictionary + style, hasData };
}

function computeCategoryMix(entries) {
  const counts = { ai: 0, work: 0, email: 0, personal: 0, other: 0 };
  let withTarget = 0;
  let tracked = 0;
  for (const e of entries || []) {
    if (!e || (!e.exe && !e.title && !e.category)) continue;
    withTarget += 1;
    counts[displayBucket(e)] += 1;
    tracked += 1;
  }
  const rows = DISPLAY_BUCKETS.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    count: counts[id],
    percent: tracked > 0 ? Math.round((counts[id] / tracked) * 100) : 0,
  })).sort((a, b) => b.count - a.count);
  return { rows, tracked, withTarget };
}

function topApps(entries, limit) {
  const counts = new Map();
  for (const e of entries || []) {
    if (!e || !e.exe) continue;
    const identity = appIdentity(e);
    const prev = counts.get(identity.key);
    counts.set(identity.key, {
      exe: e.exe,
      label: identity.label,
      words: (prev ? prev.words : 0) + countWords(e.text),
      count: (prev ? prev.count : 0) + 1,
    });
  }
  const all = [...counts.values()].sort((a, b) => b.words - a.words);
  return { list: all.slice(0, limit || 5), total: all.length };
}

// Dictations per hour of day, for the "when you speak" histogram.
function computeClock(entries) {
  const hours = new Array(24).fill(0);
  let total = 0;
  for (const e of entries || []) {
    if (!e || !e.ts) continue;
    hours[new Date(e.ts).getHours()] += 1;
    total += 1;
  }
  let peak = 0;
  for (let h = 1; h < 24; h++) if (hours[h] > hours[peak]) peak = h;
  const max = hours[peak] || 0;
  return {
    hours: hours.map((count, hour) => ({
      hour,
      count,
      percent: max > 0 ? Math.round((count / max) * 100) : 0,
    })),
    peakHour: total > 0 ? peak : null,
    total,
  };
}

function computeLength(entries) {
  let longest = 0;
  let words = 0;
  let n = 0;
  for (const e of entries || []) {
    if (!e) continue;
    const w = countWords(e.text);
    if (w > longest) longest = w;
    words += w;
    n += 1;
  }
  return {
    average: n > 0 ? Math.round(words / n) : 0,
    longest,
  };
}

function rangeSubtitle(filtered, range) {
  const n = filtered.length;
  const label = range === '7d' ? 'in the last 7 days' : range === '30d' ? 'in the last 30 days' : 'all time';
  if (!n) return 'No dictations ' + label;
  const words = filtered.reduce((s, e) => s + countWords(e.text), 0);
  return n.toLocaleString() + ' dictations · ' + words.toLocaleString() + ' words ' + label;
}

function computeInsights(entries, phrases, range, now) {
  const all = entries || [];
  const filtered = filterByRange(all, range || 'all', now);
  const m = metrics && metrics.computeMetrics
    ? metrics.computeMetrics(filtered)
    : { avgWpm: null, timeSavedMs: null, timedWords: 0, totalDurationMs: 0 };
  const typingBaseline = (metrics && metrics.TYPING_WPM_BASELINE) || 40;
  const totalWords = filtered.reduce((s, e) => s + countWords(e.text), 0);
  const pacePercent = m.avgWpm != null
    ? Math.min(100, Math.round((m.avgWpm / PACE_WPM_CEILING) * 100))
    : null;
  let paceMultiplier = null;
  if (m.avgWpm != null && m.avgWpm > 0) {
    paceMultiplier = (m.avgWpm / typingBaseline).toFixed(1);
  }
  const delta = computeVolumeDelta(all, range || 'all', now);
  const streaks = computeStreaks(all, now);
  const heatmap = computeHeatmap(all, now, streaks.currentDays);
  const mix = computeCategoryMix(filtered);
  const apps = topApps(filtered, 5);
  const fixes = computeFixes(filtered);

  return {
    range: range || 'all',
    subtitle: rangeSubtitle(filtered, range || 'all'),
    pace: {
      avgWpm: m.avgWpm,
      percent: pacePercent,
      multiplier: paceMultiplier,
      typingBaseline,
      timeSavedMs: m.timeSavedMs,
      timedWords: m.timedWords || 0,
      hasTimed: m.timedWords > 0,
    },
    fixes,
    volume: {
      words: totalWords,
      dictations: filtered.length,
      delta,
      milestone: computeMilestone(totalWords),
    },
    taught: {
      dictionarySize: (phrases || []).length,
      learnedPairs: countLearnedPairs(all),
      editedTranscripts: countEdited(filtered),
    },
    where: {
      rows: mix.rows,
      tracked: mix.tracked,
      withTarget: mix.withTarget,
      apps: apps.list,
      totalApps: apps.total,
    },
    rhythm: {
      currentStreak: streaks.currentStreak,
      longestStreak: streaks.longestStreak,
      heatmap,
    },
    words: frequentTerms(filtered, 18),
    clock: computeClock(filtered),
    length: computeLength(filtered),
  };
}

const insightsApi = {
  PACE_WPM_CEILING,
  HEATMAP_WEEKS,
  MIN_HEATMAP_WEEKS,
  MILESTONES,
  DISPLAY_BUCKETS,
  BUCKET_LABELS,
  isAiContext,
  displayBucket,
  friendlyExe,
  appIdentity,
  filterByRange,
  wordDiffCount,
  computeInsights,
  computeStreaks,
  computeHeatmap,
  computeFixes,
  computeMilestone,
  computeClock,
  computeLength,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = insightsApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.voxdenInsights = insightsApi;
}
