'use strict';

const fs = require('fs');
const path = require('path');
const phon = require('./phonetics');

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

const VARIANT_LIMIT = 10;

// Teaching one spelling of a name should teach the rest of them. The decoder
// has many ways to fail on the same word and the user should not have to hit
// each one by hand, so a learned proper noun is expanded into the neighbourhood
// of spellings it is likely to come back as.
//
// Variants live in their own list rather than in `phrases`. That keeps the
// dictionary UI showing only what the user actually taught, and leaves
// promptFrom untouched: a variant shares its parent's `to`, which promptFrom
// de-dupes on, so the whole set costs zero of the 64 prompt slots.
function expandVariants(phrases, variants, to) {
  const dst = String(to || '').trim();
  const list = Array.isArray(variants) ? variants.slice() : [];
  if (!dst || !phon.looksLikeProperNoun(dst)) return list;

  const taken = new Set();
  for (const p of phrases || []) taken.add(String(p.from).toLowerCase());
  for (const v of list) taken.add(String(v.from).toLowerCase());

  for (const candidate of phon.generateVariants(dst, VARIANT_LIMIT)) {
    const key = candidate.toLowerCase();
    if (taken.has(key)) continue;
    if (!validatePhrase(candidate, dst).ok) continue;
    taken.add(key);
    list.push({ from: candidate, to: dst });
  }
  return list;
}

// Drop generated variants whose parent term is gone from the dictionary.
function syncVariants(phrases, variants) {
  const live = new Set((phrases || []).map((p) => String(p.to)));
  return (variants || []).filter((v) => v && live.has(String(v.to)));
}

// Everything applyDictionary should match against: what the user taught plus
// what was generated from it. Order does not matter, applyDictionary sorts.
function matchList(state) {
  const s = state || {};
  const phrases = Array.isArray(s.phrases) ? s.phrases : [];
  const variants = Array.isArray(s.variants) ? s.variants : [];
  return phrases.concat(variants);
}

function upsertPhrase(phrases, from, to, variants) {
  const validation = validatePhrase(from, to);
  if (!validation.ok) {
    return { ok: false, error: validation.error, phrases, variants: variants || [] };
  }
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  const key = src.toLowerCase();
  const next = phrases.filter((p) => String(p.from).toLowerCase() !== key);
  next.unshift({ from: src, to: dst });
  return {
    ok: true,
    phrases: next,
    variants: expandVariants(next, syncVariants(next, variants), dst),
  };
}

function removePhrase(phrases, variants, from) {
  const key = String(from || '').toLowerCase();
  const next = (phrases || []).filter((p) => String(p.from).toLowerCase() !== key);
  return { phrases: next, variants: syncVariants(next, variants) };
}

function foldLetters(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const levenshtein = phon.levenshtein;

// How far a mangled proper noun is allowed to drift before we stop believing
// it is the same word. Whisper keeps the opening consonants of a name it does
// not know and improvises the rest, so agreement on the front carries most of
// the signal; the length ratio is what stops "Sam" from being read as a
// mishearing of "Simran".
const NAME_PREFIX_MIN = 2;
const NAME_LENGTH_RATIO_MAX = 1.5;
const NAME_DISTANCE_RATIO_MAX = 0.7;

function isLikelySpelling(from, to) {
  const a = foldLetters(from);
  const b = foldLetters(to);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return true;

  // 1. Orthographic near-miss: an ordinary typo or a casing fix.
  const dist = levenshtein(a, b);
  const allowed = Math.max(2, Math.ceil(Math.max(a.length, b.length) * 0.4));
  if (dist <= allowed) return true;

  const codeA = phon.phoneticCode(a);
  const codeB = phon.phoneticCode(b);
  if (!codeA || !codeB) return false;

  // 2. Same sounds, different letters. This is the whole Indian-name case:
  //    "sucky" and "Kharagpur" are four edits apart on paper and identical aloud,
  //    so rule 1 can never see them.
  if (codeA === codeB) return true;

  // 3. A badly mangled proper noun — "sub trees" for "Bhubaneswar". Gated on the
  //    target being a name, because an ordinary word swap must never qualify
  //    however close it sounds.
  if (!phon.looksLikeProperNoun(to)) return false;
  if (phon.sharedPrefix(codeA, codeB) < NAME_PREFIX_MIN) return false;
  const longer = Math.max(codeA.length, codeB.length);
  const shorter = Math.min(codeA.length, codeB.length);
  if (longer / shorter > NAME_LENGTH_RATIO_MAX) return false;
  return levenshtein(codeA, codeB) / longer <= NAME_DISTANCE_RATIO_MAX;
}

function samePair(a, b) {
  return String(a.from).toLowerCase() === String(b.from).toLowerCase()
    && String(a.to) === String(b.to);
}

function retractPairs(phrases, pairs) {
  if (!pairs || !pairs.length) return phrases.slice();
  return phrases.filter((p) => !pairs.some((x) => samePair(p, x)));
}

function learn(phrases, original, edited, variants) {
  let next = phrases.slice();
  let nextVariants = Array.isArray(variants) ? variants.slice() : [];
  const learned = [];
  const seen = new Set();
  for (const pair of extractPhrasePairs(original, edited)) {
    if (!isLikelySpelling(pair.from, pair.to)) continue;
    const result = upsertPhrase(next, pair.from, pair.to, nextVariants);
    if (!result.ok) continue;
    next = result.phrases;
    nextVariants = result.variants;
    const k = pair.from.toLowerCase() + '\0' + pair.to;
    if (seen.has(k)) continue;
    seen.add(k);
    learned.push({ from: pair.from, to: pair.to });
  }
  return { phrases: next, variants: nextVariants, learned };
}

function reviseLearned(phrases, previousLearned, original, edited, variants) {
  const kept = retractPairs(phrases, previousLearned);
  return learn(kept, original, edited, syncVariants(kept, variants));
}

function load(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const phrases = Array.isArray(raw.phrases)
      ? raw.phrases.filter((p) => p && p.from && p.to)
      : [];
    const variants = Array.isArray(raw.variants)
      ? raw.variants.filter((p) => p && p.from && p.to)
      : [];
    return { phrases, variants: syncVariants(phrases, variants) };
  } catch (_) {
    return { phrases: [], variants: [] };
  }
}

function save(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      phrases: (state && state.phrases) || [],
      variants: (state && state.variants) || [],
    }, null, 2)
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
  removePhrase,
  expandVariants,
  syncVariants,
  matchList,
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
