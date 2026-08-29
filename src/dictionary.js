'use strict';

const fs = require('fs');
const path = require('path');

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeWords(s) {
  const t = String(s || '').trim();
  if (!t) return [];
  return t.split(/\s+/).map(stripEdgePunct).filter(Boolean);
}

function stripEdgePunct(w) {
  return String(w || '').replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, '');
}

function extractPhrasePairs(original, edited) {
  const a = tokenizeWords(original);
  const b = tokenizeWords(edited);
  if (!a.length || !b.length) return [];
  if (a.join(' ') === b.join(' ')) return [];

  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ t: 'eq' });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= (i > 0 ? dp[i - 1][j] : -1))) {
      ops.push({ t: 'ins', b: b[j - 1] });
      j -= 1;
    } else {
      ops.push({ t: 'del', a: a[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();

  const pairs = [];
  let fromTok = [];
  let toTok = [];
  function flush() {
    const from = fromTok.join(' ');
    const to = toTok.join(' ');
    fromTok = [];
    toTok = [];
    if (!from || !to || from === to) return;
    if (from.split(/\s+/).length > 8 || to.split(/\s+/).length > 8) return;
    if (from.length < 2) return;
    pairs.push({ from, to });
  }
  for (const op of ops) {
    if (op.t === 'eq') flush();
    else {
      if (op.t === 'del') fromTok.push(op.a);
      if (op.t === 'ins') toTok.push(op.b);
    }
  }
  flush();
  return pairs;
}

function applyDictionary(text, phrases, withMeta) {
  if (!text || !phrases || !phrases.length) {
    return withMeta ? { text: text || '', hits: 0 } : (text || '');
  }
  const sorted = phrases
    .filter((p) => p && p.from && p.to && p.from !== p.to)
    .slice()
    .sort((a, b) => b.from.length - a.from.length);
  let s = String(text);
  let hits = 0;
  for (const p of sorted) {
    const re = new RegExp('\\b' + escapeRegExp(p.from) + '\\b', 'gi');
    const before = s;
    s = s.replace(re, p.to);
    if (s !== before) {
      const matches = before.match(re);
      hits += matches ? matches.length : 1;
    }
  }
  return withMeta ? { text: s, hits } : s;
}

const POISON_SINGLE_FROM = new Set([
  'see', 'to', 'too', 'two', 'service', 'get', 'wan',
]);

function hasAlnumEnds(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  return /^[a-z0-9](?:.*[a-z0-9])?$/i.test(t);
}

function validatePhrase(from, to) {
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  if (!src || !dst) return { ok: false, error: 'Both sides are required.' };
  if (src === dst) return { ok: false, error: 'Wrong and correct spellings must differ.' };
  if (!hasAlnumEnds(src)) {
    return { ok: false, error: 'Wrong spelling must start and end with a letter or number.' };
  }
  if (!hasAlnumEnds(dst)) {
    return { ok: false, error: 'Correct spelling must start and end with a letter or number.' };
  }
  if (dst.includes('$')) {
    return { ok: false, error: 'Correct spelling cannot contain $.' };
  }
  if (src.split(/\s+/).length > 8 || dst.split(/\s+/).length > 8) {
    return { ok: false, error: 'Use at most 8 words per side.' };
  }
  if (src.length < 2) {
    return { ok: false, error: 'Wrong spelling must be at least 2 characters.' };
  }
  const srcWords = src.split(/\s+/);
  if (srcWords.length === 1 && POISON_SINGLE_FROM.has(srcWords[0].toLowerCase())) {
    return { ok: false, error: `"${src}" is too common to map on its own. Use a longer phrase.` };
  }
  return { ok: true };
}

function upsertPhrase(phrases, from, to) {
  const validation = validatePhrase(from, to);
  if (!validation.ok) {
    return { ok: false, error: validation.error, phrases };
  }
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  const key = src.toLowerCase();
  const next = phrases.filter((p) => String(p.from).toLowerCase() !== key);
  next.unshift({ from: src, to: dst });
  return { ok: true, phrases: next };
}

function foldLetters(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const row = new Array(m + 1);
  for (let j = 0; j <= m; j++) row[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= m; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[m];
}

function isLikelySpelling(from, to) {
  const a = foldLetters(from);
  const b = foldLetters(to);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return true;
  const dist = levenshtein(a, b);
  const allowed = Math.max(2, Math.ceil(Math.max(a.length, b.length) * 0.4));
  return dist <= allowed;
}

function samePair(a, b) {
  return String(a.from).toLowerCase() === String(b.from).toLowerCase()
    && String(a.to) === String(b.to);
}

function retractPairs(phrases, pairs) {
  if (!pairs || !pairs.length) return phrases.slice();
  return phrases.filter((p) => !pairs.some((x) => samePair(p, x)));
}

function learn(phrases, original, edited) {
  let next = phrases.slice();
  const learned = [];
  const seen = new Set();
  for (const pair of extractPhrasePairs(original, edited)) {
    if (!isLikelySpelling(pair.from, pair.to)) continue;
    const result = upsertPhrase(next, pair.from, pair.to);
    if (!result.ok) continue;
    next = result.phrases;
    const k = pair.from.toLowerCase() + '\0' + pair.to;
    if (seen.has(k)) continue;
    seen.add(k);
    learned.push({ from: pair.from, to: pair.to });
  }
  return { phrases: next, learned };
}

function reviseLearned(phrases, previousLearned, original, edited) {
  return learn(retractPairs(phrases, previousLearned), original, edited);
}

function load(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const phrases = Array.isArray(raw.phrases)
      ? raw.phrases.filter((p) => p && p.from && p.to)
      : [];
    return { phrases };
  } catch (_) {
    return { phrases: [] };
  }
}

function save(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ phrases: (state && state.phrases) || [] }, null, 2)
  );
}

function promptFrom(phrases, historyEntries, limit) {
  const cap = Math.max(1, Number(limit) || 64);
  const terms = [];
  const seen = new Set();
  for (const p of phrases || []) {
    const t = String((p && p.to) || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    terms.push(t);
  }
  const wordCount = countWordsInHistory(historyEntries);
  const { profile } = getUnderstandingProfile(wordCount);
  if (profile.frequentTermLimit > 0) {
    for (const w of frequentTerms(historyEntries, profile.frequentTermLimit)) {
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      terms.push(w);
    }
  }
  return terms.slice(0, cap).join(', ');
}

const UNDERSTANDING_PROFILES = [
  {
    id: 'learning',
    threshold: 0,
    name: 'Learning',
    copy: 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.',
    frequentTermLimit: 0,
  },
  {
    id: 'personalized',
    threshold: 2500,
    name: 'Personalized',
    copy: 'Voxden uses your dictionary and frequent words on future transcripts.',
    frequentTermLimit: 24,
  },
  {
    id: 'expert',
    threshold: 4000,
    name: 'Expert',
    copy: 'Voxden adapts to the spellings you teach it in your transcripts.',
    frequentTermLimit: 48,
  },
];

const UNDERSTANDING_WORD_GOAL = UNDERSTANDING_PROFILES[1].threshold;

function getUnderstandingProfile(wordCount) {
  let index = 0;
  for (let i = UNDERSTANDING_PROFILES.length - 1; i >= 0; i--) {
    if (wordCount >= UNDERSTANDING_PROFILES[i].threshold) {
      index = i;
      break;
    }
  }
  return { index, profile: UNDERSTANDING_PROFILES[index] };
}

function understandingState(wordCount) {
  const count = Math.max(0, Number(wordCount) || 0);
  const { index, profile } = getUnderstandingProfile(count);
  const next = UNDERSTANDING_PROFILES[index + 1] || null;
  const rangeStart = profile.threshold;
  const rangeEnd = next ? next.threshold : profile.threshold;
  let percent = 100;
  if (next) {
    const span = rangeEnd - rangeStart;
    percent = span > 0
      ? Math.min(100, Math.round(((count - rangeStart) / span) * 100))
      : 0;
  }
  return {
    understandingProfile: profile.id,
    understandingProfileName: profile.name,
    understandingProfileIndex: index,
    understandingCopy: profile.copy,
    understandingGoal: next ? next.threshold : profile.threshold,
    understandingPercent: percent,
    understandingUnlocked: index >= 1,
    understandingMaxed: index >= UNDERSTANDING_PROFILES.length - 1,
    wordCount: count,
  };
}

function countWordsInHistory(entries) {
  let n = 0;
  for (const e of entries || []) {
    const t = String((e && e.text) || '').trim();
    if (t) n += t.split(/\s+/).length;
  }
  return n;
}

function frequentTerms(entries, limit) {
  const max = limit || 24;
  const counts = new Map();
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
    'is', 'it', 'i', 'you', 'we', 'that', 'this', 'with', 'was', 'are', 'be',
    'have', 'had', 'not', 'so', 'if', 'as', 'my', 'your', 'can', 'do', 'just',
  ]);
  for (const e of entries || []) {
    const words = String((e && e.text) || '').toLowerCase().match(/[a-z0-9']+/g) || [];
    for (const w of words) {
      if (w.length < 3 || stop.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

module.exports = {
  applyDictionary,
  extractPhrasePairs,
  validatePhrase,
  upsertPhrase,
  isLikelySpelling,
  retractPairs,
  learn,
  reviseLearned,
  load,
  save,
  promptFrom,
  countWordsInHistory,
  frequentTerms,
  getUnderstandingProfile,
  understandingState,
  UNDERSTANDING_PROFILES,
  UNDERSTANDING_WORD_GOAL,
};
