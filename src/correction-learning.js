'use strict';

const dict = require('./dictionary');

const MAX_FIELD = 12000;
const MAX_DICTATION = 4000;
const MAX_WORDS = 250;
const SETTLE_MS = 1800;

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').normalize('NFC');
}

// Establish the actual pasted span, including a paste over selected text.
// Repeated occurrences are only usable if the surrounding text proves which
// occurrence was inserted. Never fall back to diffing an entire document.
function locateInsertion(before, after, inserted) {
  if (!inserted || before === after) return null;
  const matches = [];
  let at = after.indexOf(inserted);
  while (at >= 0) {
    const prefix = after.slice(0, at);
    const suffix = after.slice(at + inserted.length);
    if (prefix.length + suffix.length <= before.length
        && before.startsWith(prefix) && before.endsWith(suffix)) {
      matches.push({ prefix, suffix });
      if (matches.length > 1) return null;
    }
    at = after.indexOf(inserted, at + 1);
  }
  return matches[0] || null;
}

function correctionPairs(original, edited) {
  if (!original || !edited || original.length > MAX_DICTATION || edited.length > MAX_DICTATION) return [];
  if (original.split(/\s+/).length > MAX_WORDS || edited.split(/\s+/).length > MAX_WORDS) return [];
  // Names, short terms, apostrophes and product spellings are useful vocabulary.
  // URLs, emails, numeric edits and whole sentence rewrites are not terms.
  const term = value => value.length <= 80 && /\p{L}/u.test(value)
    && value.split(/\s+/).length <= 3
    && /^[\p{L}\p{N}\p{M}]+(?:[ .\-'’][\p{L}\p{N}\p{M}]+)*$/u.test(value);
  return dict.extractPhrasePairs(original, edited).filter(pair =>
    term(pair.from) && term(pair.to)
      && dict.validateWord(pair.to).ok
      && dict.isLikelySpelling(pair.from, pair.to)
  ).slice(0, 3);
}

function createCorrectionTracker({ initial, text, onPairs, onStop = () => {},
  delay = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
  let before = normalizeText(initial && initial.text);
  let original = normalizeText(text);
  let anchor = null;
  let timer = null;
  let stopped = !initial || before.length > MAX_FIELD || !original || original.length > MAX_DICTATION;
  const fieldId = initial && initial.fieldId;
  const hwnd = initial && String(initial.hwnd);
  const seen = new Set();
  const startedAt = now();
  function stop() {
    if (timer) cancel(timer);
    timer = null;
    const wasStopped = stopped;
    stopped = true;
    before = original = '';
    anchor = null;
    seen.clear();
    if (!wasStopped) onStop();
  }
  function observe(snapshot) {
    if (stopped) return;
    if (!snapshot || snapshot.fieldId !== fieldId || String(snapshot.hwnd) !== hwnd
        || now() - startedAt >= 90000) return stop();
    const current = normalizeText(snapshot.text);
    if (current.length > MAX_FIELD) return stop();
    if (timer) cancel(timer);
    timer = null;
    if (!anchor) {
      if (now() - startedAt > 5000) return stop();
      if (current === before) return;
      anchor = locateInsertion(before, current, original);
      if (!anchor) return stop();
      before = '';
      return;
    }
    // A cleared/sent field, another draft, or an edit outside the pasted span
    // ends this session instead of teaching unrelated text.
    if (!current.startsWith(anchor.prefix) || !current.endsWith(anchor.suffix)
        || current.length < anchor.prefix.length + anchor.suffix.length) return stop();
    const edited = current.slice(anchor.prefix.length, current.length - anchor.suffix.length);
    if (!edited || edited.length > MAX_DICTATION) return stop();
    const pairs = correctionPairs(original, edited).filter(pair => !seen.has(JSON.stringify(pair)));
    if (!pairs.length) return;
    timer = delay(() => {
      timer = null;
      if (stopped) return;
      if (now() - startedAt >= 90000) return stop();
      for (const pair of pairs) seen.add(JSON.stringify(pair));
      onPairs(pairs);
    }, SETTLE_MS);
  }
  return { observe, stop, get active() { return !stopped; } };
}

module.exports = { createCorrectionTracker, correctionPairs, locateInsertion, normalizeText, SETTLE_MS };
