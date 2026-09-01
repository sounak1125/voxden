'use strict';

// Structured custom vocabulary.
//
// The dictionary used to be a flat list of {from, to} pairs matched with
// `new RegExp('\\b' + from + '\\b', 'gi')`. Three things were wrong with that
// and all three were user-visible:
//
//   * `\b` is defined against ASCII word characters. In "मैं नमस्ते बोलता",
//     every position is a `\b` boundary and none of them is a word edge, so a
//     Devanagari replacement either never fired or fired inside a word.
//   * Validation was `/^[a-z0-9](?:.*[a-z0-9])?$/i`, which refused "नमस्ते",
//     "Café" and "José" outright -- the app told the user their own name was
//     not a word.
//   * A pair carried no language, no script, no provenance and no usage, so
//     "rank by relevance within a token budget" had nothing to rank on. The
//     prompt builder took the first 64 entries and hoped.
//
// An entry here is the term, not a spelling of it: one canonical form, the
// aliases the engines actually produce for it, the script it is written in,
// where it came from and when it was last useful. Aliases never go into a
// model prompt -- teaching a decoder the wrong spelling is how you get the
// wrong spelling -- they are what the post-recognition stages match against.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

// Scripts that separate words with spaces. Boundary assertions are meaningful
// for these and meaningless for the rest: Han and Thai run words together, so
// requiring a non-letter on each side of a term would match nothing.
const SPACED_SCRIPTS = new Set(['latn', 'deva', 'cyrl', 'grek', 'arab', 'hebr', 'beng', 'taml', 'telu', 'guru', 'knda', 'mlym', 'orya', 'gujr', 'sinh', 'thaa']);

const SCRIPT_TESTS = [
  ['deva', /\p{Script=Devanagari}/u],
  ['beng', /\p{Script=Bengali}/u],
  ['guru', /\p{Script=Gurmukhi}/u],
  ['gujr', /\p{Script=Gujarati}/u],
  ['orya', /\p{Script=Oriya}/u],
  ['taml', /\p{Script=Tamil}/u],
  ['telu', /\p{Script=Telugu}/u],
  ['knda', /\p{Script=Kannada}/u],
  ['mlym', /\p{Script=Malayalam}/u],
  ['sinh', /\p{Script=Sinhala}/u],
  ['arab', /\p{Script=Arabic}/u],
  ['hebr', /\p{Script=Hebrew}/u],
  ['cyrl', /\p{Script=Cyrillic}/u],
  ['grek', /\p{Script=Greek}/u],
  ['hani', /\p{Script=Han}/u],
  ['kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['hang', /\p{Script=Hangul}/u],
  ['thai', /\p{Script=Thai}/u],
  ['latn', /\p{Script=Latin}/u],
];

// The script a language is normally written in. Used to decide whether an
// entry belongs to a dictation before it is offered to the engine: a
// Devanagari term in an English dictation is noise in the prompt and a
// false-substitution risk in the transcript.
const LANGUAGE_SCRIPTS = Object.freeze({
  en: 'latn',
  hi: 'deva',
  de: 'latn',
  fr: 'latn',
  es: 'latn',
  pt: 'latn',
  it: 'latn',
  nl: 'latn',
});

// Unicode normalisation is not optional here. "नमस्ते" typed in the settings
// window and "नमस्ते" produced by an engine can be different code point
// sequences for the same word, and an un-normalised comparison calls them
// different terms forever.
function normalize(value) {
  return String(value == null ? '' : value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Case folding for keys. toLowerCase is locale-independent in JS and correct
// for the scripts that have case; the ones that do not are unaffected.
function foldKey(value) {
  return normalize(value).toLowerCase();
}

function detectScript(value) {
  const text = normalize(value);
  if (!text) return null;
  const found = new Set();
  for (const ch of text) {
    for (const [name, re] of SCRIPT_TESTS) {
      if (re.test(ch)) {
        found.add(name);
        break;
      }
    }
  }
  if (!found.size) return null;
  if (found.size === 1) return [...found][0];
  // A romanised name written alongside its native spelling is one term in two
  // scripts. Report the dominant one; `mixed` would make every rule below
  // choose the conservative branch for what is usually plain Latin text.
  let best = null;
  let bestCount = 0;
  for (const name of found) {
    let count = 0;
    const re = SCRIPT_TESTS.find(([n]) => n === name)[1];
    for (const ch of text) if (re.test(ch)) count += 1;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function usesWordSeparators(script) {
  return SPACED_SCRIPTS.has(String(script || 'latn'));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A term matcher that works in any script.
//
// The boundary is a negative lookaround over letters, numbers and combining
// marks rather than `\b`. Marks matter: "नमस्ते" ends in a vowel sign, and a
// boundary class that omitted \p{M} would let "नमस्" match inside it.
// Whitespace inside a multi-word term is relaxed, so a two-word name written
// with a double space or split across a line break still matches one entry.
function termPattern(term, options) {
  const opts = options || {};
  const text = normalize(term);
  if (!text) return null;
  const body = escapeRegExp(text).replace(/\\?\s+/g, '\\s+');
  const script = opts.script || detectScript(text);
  const flags = 'g' + (opts.caseSensitive ? '' : 'i') + 'u';
  if (!usesWordSeparators(script)) return new RegExp(body, flags);
  const edge = '[\\p{L}\\p{N}\\p{M}]';
  return new RegExp('(?<!' + edge + ')' + body + '(?!' + edge + ')', flags);
}

function makeRule(from, to, meta) {
  const src = normalize(from);
  const dst = normalize(to);
  const m = meta || {};
  return {
    from: src,
    to: dst,
    caseSensitive: !!m.caseSensitive,
    script: m.script || detectScript(src) || null,
  };
}

function normalizeLanguage(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id || id === '*' || id === 'any') return '*';
  return id.slice(0, 8);
}

function entryId(canonical) {
  const key = foldKey(canonical);
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  return 'v' + hash.toString(36);
}

const SOURCES = new Set(['manual', 'learned', 'seed', 'migrated']);

function normalizeSource(value) {
  const id = String(value || '').trim().toLowerCase();
  return SOURCES.has(id) ? id : 'manual';
}

function makeEntry(canonical, options) {
  const opts = options || {};
  const term = normalize(canonical);
  const script = opts.script || detectScript(term) || null;
  const now = Number(opts.now) || Date.now();
  const aliases = [];
  const seen = new Set([foldKey(term)]);
  for (const alias of opts.aliases || []) {
    const value = normalize(alias);
    const key = foldKey(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    aliases.push(value);
  }
  return {
    id: opts.id || entryId(term),
    canonical: term,
    script,
    // '*' means "any dictation". A Latin term is usually fine everywhere -- a
    // product name does not stop being itself in a German sentence -- so the
    // language is only pinned when the caller says so or the script says so.
    language: normalizeLanguage(opts.language || languageForScript(script)),
    aliases,
    rules: (opts.rules || []).map((r) => makeRule(r.from, r.to, r)).filter((r) => r.from && r.to),
    source: normalizeSource(opts.source),
    createdAt: Number(opts.createdAt) || now,
    updatedAt: Number(opts.updatedAt) || now,
    lastUsedAt: Number(opts.lastUsedAt) || 0,
    useCount: Math.max(0, Number(opts.useCount) || 0),
  };
}

// Which dictation language an entry belongs to, inferred from its script.
// Latin stays unpinned because it is the script of most of the menu.
function languageForScript(script) {
  if (!script || script === 'latn') return '*';
  for (const [lang, s] of Object.entries(LANGUAGE_SCRIPTS)) {
    if (s === script) return lang;
  }
  return '*';
}

function normalizeEntry(raw) {
  if (!raw) return null;
  const canonical = normalize(raw.canonical || raw.to || raw.term);
  if (!canonical) return null;
  return makeEntry(canonical, {
    id: raw.id,
    script: raw.script,
    language: raw.language,
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    source: raw.source,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastUsedAt: raw.lastUsedAt,
    useCount: raw.useCount,
  });
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

// Fold the legacy {phrases, variants} shape into entries.
//
// The legacy file stays on disk untouched and keeps being the thing the
// dictionary UI edits. Entries are derived from it on every load and merged
// with whatever metadata a previous run recorded, so a downgrade to an older
// Voxden loses the usage counters and nothing else. That is the whole reason
// this is a derivation rather than a rewrite: a migration that throws away the
// user's dictionary to gain a schema is not a migration.
function fromDictionary(state, previous, options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const phrases = (state && state.phrases) || [];
  const variants = (state && state.variants) || [];
  const prior = new Map();
  for (const entry of previous || []) {
    const normalized = normalizeEntry(entry);
    if (normalized) prior.set(foldKey(normalized.canonical), normalized);
  }

  const byCanonical = new Map();
  function ensure(canonical, source, createdAt) {
    const key = foldKey(canonical);
    if (byCanonical.has(key)) return byCanonical.get(key);
    const carried = prior.get(key);
    const entry = makeEntry(canonical, {
      source: carried ? carried.source : source,
      createdAt: (carried && carried.createdAt) || createdAt || now,
      // Order in the legacy file is meaningful -- upsertPhrase unshifts, so
      // the newest term is first. That ordering becomes the recency signal,
      // which is what makes a word added a minute ago outrank one from March.
      updatedAt: (carried && carried.updatedAt) || createdAt || now,
      lastUsedAt: carried ? carried.lastUsedAt : 0,
      useCount: carried ? carried.useCount : 0,
      language: carried ? carried.language : undefined,
    });
    byCanonical.set(key, entry);
    return entry;
  }

  // Newest first in the legacy list, so walk it backwards and hand out
  // increasing timestamps: index 0 ends up the most recent.
  const ordered = phrases.slice().reverse();
  ordered.forEach((phrase, index) => {
    if (!phrase || !phrase.to) return;
    const entry = ensure(phrase.to, phrase.source, now - (ordered.length - index) * 1000);
    const from = normalize(phrase.from);
    if (!from) return;
    // A rule whose two sides differ only in case is still a rule -- it is how
    // "javascript" becomes "JavaScript". Comparing folded keys here dropped
    // every one of them.
    if (from === entry.canonical) return;
    if (!entry.aliases.some((a) => foldKey(a) === foldKey(from))) entry.aliases.push(from);
    entry.rules.push(makeRule(from, entry.canonical, { source: phrase.source }));
  });

  // Every term normalises its own casing.
  //
  // The flat matcher was case-insensitive, so a bare word entry
  // {from: 'Voxden', to: 'Voxden'} already rewrote "voxden" to "Voxden" as a
  // side effect of the `gi` flags. Losing that on the way to a structured
  // model would have looked like a regression to anyone whose dictionary is
  // mostly plain words, so it is now explicit instead of accidental.
  for (const entry of byCanonical.values()) {
    if (entry.rules.some((r) => r.to === entry.canonical && foldKey(r.from) === foldKey(entry.canonical))) {
      continue;
    }
    entry.rules.push(makeRule(entry.canonical, entry.canonical, { source: 'canonical' }));
  }

  for (const variant of variants) {
    if (!variant || !variant.to || !variant.from) continue;
    const key = foldKey(variant.to);
    const entry = byCanonical.get(key);
    if (!entry) continue;
    const from = normalize(variant.from);
    if (!from || foldKey(from) === foldKey(entry.canonical)) continue;
    if (entry.aliases.some((a) => foldKey(a) === foldKey(from))) continue;
    entry.aliases.push(from);
    // Generated spellings are matched, never taught to a model, and never
    // promoted to a rule the user did not write. They come back from
    // phonetics.generateVariants and are only as good as that guess.
    entry.rules.push(makeRule(from, entry.canonical, { generated: true }));
  }

  return [...byCanonical.values()];
}

// ---------------------------------------------------------------------------
// Ranking and budgets
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const RECENCY_HALF_LIFE_DAYS = 21;

function recencyScore(timestamp, now) {
  const age = Math.max(0, (Number(now) || Date.now()) - (Number(timestamp) || 0));
  if (!timestamp) return 0;
  return Math.pow(0.5, age / (RECENCY_HALF_LIFE_DAYS * DAY_MS));
}

const SOURCE_WEIGHT = { manual: 3, seed: 2.5, migrated: 2, learned: 1.5 };

// Whether an entry has any business being offered to a dictation in this
// language. A Devanagari term is not a candidate for an English dictation --
// including it wastes prompt budget and invites a false substitution -- but a
// Latin term stays a candidate everywhere, because product names do not change
// script when the sentence does.
function matchesLanguage(entry, language) {
  const want = normalizeLanguage(language);
  if (!entry) return false;
  if (entry.language === '*' || want === '*') return true;
  return entry.language === want;
}

function scoreEntry(entry, options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  let score = SOURCE_WEIGHT[entry.source] || 1;
  // A word saved seconds ago is the single most likely thing to be said next;
  // that is the whole reason someone stops to add it.
  score += 4 * recencyScore(entry.updatedAt, now);
  score += 3 * recencyScore(entry.lastUsedAt, now);
  score += Math.log1p(entry.useCount) * 1.5;
  if (opts.language && entry.language === normalizeLanguage(opts.language)) score += 1.5;
  // Terms the user has actually been saying lately, from the transcript
  // history. Cheap relevance: it is the difference between a prompt about
  // today's project and a prompt about every project.
  if (opts.recentTerms && opts.recentTerms.has(foldKey(entry.canonical))) score += 2.5;
  return score;
}

// Terms seen in recent transcripts, folded for lookup. Only the newest entries
// are read: relevance here means "this week", not "ever".
function recentTermSet(historyEntries, limit) {
  const out = new Set();
  const max = Math.max(1, Number(limit) || 40);
  for (const entry of (historyEntries || []).slice(0, max)) {
    const text = normalize((entry && entry.text) || '');
    if (!text) continue;
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu) || []) {
      out.add(word);
    }
  }
  return out;
}

function rank(entries, options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const language = opts.language;
  const scored = [];
  for (const raw of entries || []) {
    const entry = normalizeEntry(raw);
    if (!entry || !matchesLanguage(entry, language)) continue;
    scored.push({ entry, score: scoreEntry(entry, { now, language, recentTerms: opts.recentTerms }) });
  }
  scored.sort((a, b) => (b.score - a.score)
    || (b.entry.updatedAt - a.entry.updatedAt)
    || a.entry.canonical.localeCompare(b.entry.canonical));
  const limit = Number(opts.limit) || scored.length;
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry);
}

// Rough token count, without loading a tokenizer into the main process.
//
// Byte-pair vocabularies are far denser on Latin text than on anything else:
// English averages near four characters per token, Devanagari and CJK closer
// to one. Guessing high on non-Latin is the safe direction -- an
// under-estimate overruns Whisper's 223-token prompt window and the tail, the
// newest terms, is what gets silently cut.
function estimateTokens(value) {
  const text = normalize(value);
  if (!text) return 0;
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\s\p{P}]/u.test(ch)) latin += 1;
    else if (/\p{Script=Latin}|\p{N}/u.test(ch)) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 3.5) + other;
}

const CONTEXT_PREFIXES = Object.freeze({
  // Whisper conditions on the prompt as if it were previous speech, so a bare
  // comma-separated list reads as the most natural thing to have just heard.
  initial_prompt: '',
  // Qwen3-ASR takes the context as a system message. A bare list, with no
  // instruction wrapped around it, measured identically to an instructed one
  // on the held-out recordings (WER 0.148 either way) and costs fewer of the
  // tokens the budget is spending, so the words go in on their own.
  context: '',
});

// Build the vocabulary string an engine is actually given.
//
// Only canonical spellings go in. Aliases are misrecognitions; putting them in
// front of a decoder is asking for them back. Terms are packed newest-and-most-
// relevant first so that whatever the budget cuts is the least useful tail,
// and the caller is told what was dropped rather than left to assume it fit.
function contextFor(entries, options) {
  const opts = options || {};
  const capabilities = require('./asr-capabilities');
  const engine = capabilities.normalizeEngine(opts.engine);
  const declared = capabilities.vocabularyBudget(engine);
  // The engine's declared budget is the ceiling, never a target. A caller may
  // ask for less -- a smaller list is cheaper to prefill and measurably faster
  // -- but nothing may ask for more than the engine can hold.
  const budget = {
    mechanism: declared.mechanism,
    maxTerms: Math.min(declared.maxTerms, Number(opts.maxTerms) || declared.maxTerms),
    maxTokens: Math.min(declared.maxTokens, Number(opts.maxTokens) || declared.maxTokens),
  };
  if (!budget.mechanism) {
    return {
      text: '',
      mechanism: null,
      budget: { terms: 0, tokens: 0, maxTerms: 0, maxTokens: 0 },
      included: [],
      dropped: (entries || []).map((e) => e.canonical),
    };
  }
  const prefix = opts.prefix == null
    ? (CONTEXT_PREFIXES[budget.mechanism] || '')
    : String(opts.prefix);
  const included = [];
  const dropped = [];
  let tokens = estimateTokens(prefix);
  for (const entry of entries || []) {
    const term = normalize(entry && entry.canonical);
    if (!term) continue;
    if (included.length >= budget.maxTerms) {
      dropped.push(term);
      continue;
    }
    const cost = estimateTokens(term) + 1; // the separator
    if (tokens + cost > budget.maxTokens) {
      dropped.push(term);
      continue;
    }
    tokens += cost;
    included.push(term);
  }
  const body = included.join(', ');
  return {
    text: body ? prefix + body + (prefix ? '.' : '') : '',
    mechanism: budget.mechanism,
    budget: {
      terms: included.length,
      tokens,
      maxTerms: budget.maxTerms,
      maxTokens: budget.maxTokens,
    },
    included,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

// Explicit, user-authored replacements only.
//
// This is the deterministic half of vocabulary correction: a rule fires when
// its exact text is present, in any script, and nothing is guessed. Everything
// that involves judging whether two words sound alike lives in src/repair.js,
// behind its own evidence gate, so that a confident substitution and a
// speculative one are never made by the same code.
function applyEntries(text, entries, options) {
  const opts = options || {};
  const source = String(text == null ? '' : text);
  if (!source || !entries || !entries.length) {
    return { text: source, hits: 0, applied: [] };
  }
  // Longest rule first: "See Dance too" has to win over "See Dance".
  const rules = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (opts.language && !matchesLanguage(entry, opts.language)) continue;
    for (const rule of entry.rules || []) {
      if (!rule || !rule.from || !rule.to) continue;
      rules.push({ rule, entry });
    }
  }
  rules.sort((a, b) => b.rule.from.length - a.rule.from.length);

  let out = normalize(source);
  let hits = 0;
  const applied = [];
  for (const { rule, entry } of rules) {
    const pattern = termPattern(rule.from, {
      script: rule.script,
      caseSensitive: rule.caseSensitive,
    });
    if (!pattern) continue;
    const before = out;
    let changed = 0;
    out = out.replace(pattern, (match) => {
      if (match !== rule.to) changed += 1;
      return rule.to;
    });
    if (changed && out !== before) {
      hits += changed;
      applied.push({ from: rule.from, to: rule.to, count: changed, entryId: entry.id });
    }
  }
  return { text: out, hits, applied };
}

// Which entries a finished transcript actually used, for the usage counters
// that feed ranking. Matching on the canonical form means a term the engine
// got right on its own still counts as relevant.
function usedEntries(text, entries) {
  const out = [];
  for (const entry of entries || []) {
    const pattern = termPattern(entry.canonical, { script: entry.script });
    if (pattern && pattern.test(String(text || '').normalize('NFC'))) out.push(entry.id);
  }
  return out;
}

function touch(entries, usedIds, now) {
  const stamp = Number(now) || Date.now();
  const used = new Set(usedIds || []);
  return (entries || []).map((entry) => (used.has(entry.id)
    ? Object.assign({}, entry, { lastUsedAt: stamp, useCount: (entry.useCount || 0) + 1 })
    : entry));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadState(filePath) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    raw = null;
  }
  const legacy = raw || {};
  const dictionary = {
    phrases: Array.isArray(legacy.phrases) ? legacy.phrases : [],
    variants: Array.isArray(legacy.variants) ? legacy.variants : [],
    pending: Array.isArray(legacy.pending) ? legacy.pending : [],
    blocked: Array.isArray(legacy.blocked) ? legacy.blocked : [],
  };
  const stored = Array.isArray(legacy.entries)
    ? legacy.entries.map(normalizeEntry).filter(Boolean)
    : [];
  return {
    version: SCHEMA_VERSION,
    entries: fromDictionary(dictionary, stored),
    phrases: dictionary.phrases,
    variants: dictionary.variants,
    pending: dictionary.pending,
    blocked: dictionary.blocked,
  };
}

// Written alongside the legacy keys, never instead of them. An older build
// reading this file finds exactly the phrases and variants it wrote.
function saveState(filePath, state) {
  const s = state || {};
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    version: SCHEMA_VERSION,
    phrases: s.phrases || [],
    variants: s.variants || [],
    pending: s.pending || [],
    blocked: s.blocked || [],
    entries: (s.entries || []).map(normalizeEntry).filter(Boolean),
  }, null, 2));
}

module.exports = {
  SCHEMA_VERSION,
  LANGUAGE_SCRIPTS,
  normalize,
  foldKey,
  detectScript,
  usesWordSeparators,
  languageForScript,
  termPattern,
  makeEntry,
  makeRule,
  normalizeEntry,
  normalizeLanguage,
  matchesLanguage,
  fromDictionary,
  recencyScore,
  scoreEntry,
  recentTermSet,
  rank,
  estimateTokens,
  contextFor,
  applyEntries,
  usedEntries,
  touch,
  loadState,
  saveState,
};
