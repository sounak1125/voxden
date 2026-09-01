'use strict';

// Measurement primitives for the dictation evaluation harness.
//
// Everything here is deliberately script-agnostic. The old scoring assumed
// ASCII words separated by spaces, which silently reported a perfect score for
// any Devanagari reference -- both sides tokenised to nothing, so the distance
// was zero. Splitting on the Unicode letter/number classes is what makes a
// Hindi run mean anything at all.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .trim();
}

// Scoring tokens. Punctuation is dropped because no ASR engine is judged on
// where it puts a comma; the cleanup and style stages own that, and they are
// measured separately by the meaning-change checks.
function words(value) {
  return normalizeText(value).match(WORD_RE) || [];
}

function chars(value) {
  return Array.from(normalizeText(value).replace(/\s+/g, ' '));
}

// Levenshtein over arbitrary token arrays, with the edit breakdown the report
// needs. Two rolling rows plus a backtrace grid; the grid is what lets
// substitutions be told apart from an insert/delete pair.
function alignCost(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const grid = new Uint8Array((n + 1) * (m + 1));
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    grid[j] = 1; // insertion
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    grid[i * (m + 1)] = 2; // deletion
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      let best = prev[j - 1] + (same ? 0 : 1);
      let op = same ? 0 : 3;
      if (prev[j] + 1 < best) {
        best = prev[j] + 1;
        op = 2;
      }
      if (cur[j - 1] + 1 < best) {
        best = cur[j - 1] + 1;
        op = 1;
      }
      cur[j] = best;
      grid[i * (m + 1) + j] = op;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const counts = { hits: 0, sub: 0, ins: 0, del: 0 };
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = grid[i * (m + 1) + j];
    if (op === 0) {
      counts.hits += 1;
      i -= 1;
      j -= 1;
    } else if (op === 3) {
      counts.sub += 1;
      i -= 1;
      j -= 1;
    } else if (op === 2) {
      counts.del += 1;
      i -= 1;
    } else {
      counts.ins += 1;
      j -= 1;
    }
  }
  return { distance: prev[m], counts };
}

function errorRate(refTokens, hypTokens) {
  if (!refTokens.length) {
    return {
      rate: hypTokens.length ? 1 : 0,
      distance: hypTokens.length,
      refLength: 0,
      counts: { hits: 0, sub: 0, ins: hypTokens.length, del: 0 },
    };
  }
  const { distance, counts } = alignCost(refTokens, hypTokens);
  return { rate: distance / refTokens.length, distance, refLength: refTokens.length, counts };
}

function wer(reference, hypothesis) {
  return errorRate(words(reference), words(hypothesis));
}

function cer(reference, hypothesis) {
  return errorRate(chars(reference), chars(hypothesis));
}

// Whether a term appears in a token stream as a contiguous run. Substring
// matching on the raw string would count "Rhea" inside "Rheable"; the token
// walk is what keeps term recall honest.
function containsTermTokens(haystack, needle) {
  const target = words(needle);
  if (!target.length) return false;
  for (let i = 0; i + target.length <= haystack.length; i++) {
    let ok = true;
    for (let k = 0; k < target.length; k++) {
      if (haystack[i + k] !== target[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// Exact custom-term precision and recall.
//
// A term is only counted when the reference actually contains it, so a
// vocabulary far larger than the utterance does not dilute the score.
// `forbidden` is the negative set: terms that must NOT appear, which is how a
// false dictionary substitution gets caught rather than rewarded.
function termScore(reference, hypothesis, terms, forbidden) {
  const refTokens = words(reference);
  const hypTokens = words(hypothesis);
  let expected = 0;
  let recalled = 0;
  const missed = [];
  for (const term of terms || []) {
    if (!containsTermTokens(refTokens, term)) continue;
    expected += 1;
    if (containsTermTokens(hypTokens, term)) recalled += 1;
    else missed.push(term);
  }
  const inserted = [];
  for (const term of forbidden || []) {
    if (containsTermTokens(refTokens, term)) continue;
    if (containsTermTokens(hypTokens, term)) inserted.push(term);
  }
  const produced = recalled + inserted.length;
  return {
    expected,
    recalled,
    missed,
    inserted,
    falseInsertions: inserted.length,
    recall: expected ? recalled / expected : null,
    precision: produced ? recalled / produced : null,
  };
}

// Which script a string is written in. Used to check the engine answered in
// the language that was spoken instead of transliterating it.
function scriptOf(value) {
  const counts = new Map();
  for (const ch of String(value || '')) {
    let name = null;
    if (/\p{Script=Devanagari}/u.test(ch)) name = 'deva';
    else if (/\p{Script=Latin}/u.test(ch)) name = 'latn';
    else if (/\p{Script=Han}/u.test(ch)) name = 'hani';
    else if (/\p{Script=Arabic}/u.test(ch)) name = 'arab';
    else if (/\p{Script=Cyrillic}/u.test(ch)) name = 'cyrl';
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    script: best,
    share: total ? bestCount / total : 0,
    counts: Object.fromEntries(counts),
  };
}

function percentile(values, p) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function median(values) {
  return percentile(values, 50);
}

function mean(values) {
  const list = (values || []).filter((v) => Number.isFinite(v));
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

// Corpus rates are pooled, not averaged per clip: a two-word utterance must
// not weigh the same as a two-minute one.
function pooled(results, key) {
  let distance = 0;
  let length = 0;
  for (const r of results || []) {
    const m = r && r[key];
    if (!m) continue;
    distance += m.distance;
    length += m.refLength;
  }
  return length ? distance / length : null;
}

module.exports = {
  normalizeText,
  words,
  chars,
  wer,
  cer,
  errorRate,
  containsTermTokens,
  termScore,
  scriptOf,
  percentile,
  median,
  mean,
  pooled,
};
