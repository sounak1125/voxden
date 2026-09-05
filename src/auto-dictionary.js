'use strict';

const dict = require('./dictionary');
const vocab = require('./vocabulary');

// Receipts stay in the main process. Object identity makes an old Undo harmless
// after the user edits, deletes, or re-adds the same spelling. The snapshot also
// protects against a caller editing an owned object in place.
const ownedPhrases = new WeakMap();

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalized(value) {
  return typeof value === 'string' ? vocab.normalize(value).replace(/\s+/g, ' ') : '';
}

function key(value) {
  return normalized(value).toLowerCase();
}

function fingerprint(phrase) {
  return JSON.stringify(phrase);
}

function validCorrection(from, to) {
  if (!from || !to || from === to || from.length > 80 || to.length > 80) return false;
  if (from.split(' ').length > 3 || to.split(' ').length > 3) return false;
  return dict.validatePhrase(from, to, 'mapping').ok
    && dict.validateWord(to).ok
    && dict.isLikelySpelling(from, to);
}

// Only the corrected term is learned. An edit is evidence for the spelling the
// user wants, not permission to replace every future occurrence of the old word.
// Explicit mappings remain available through the Dictionary view.
function addCorrections(dictionary, pairs) {
  const current = dictionary || {};
  const phrases = list(current.phrases);
  const variants = list(current.variants);
  const pending = list(current.pending);
  const taken = new Set();
  const blocked = new Set(list(current.blocked).map(key));
  for (const phrase of phrases.concat(variants)) {
    if (!phrase) continue;
    taken.add(key(phrase.from));
    taken.add(key(phrase.to));
  }

  const added = [];
  const skipped = [];
  const seenSources = new Set();
  for (const pair of list(pairs)) {
    const from = normalized(pair && pair.from);
    const to = normalized(pair && pair.to);
    const fromKey = key(from);
    const toKey = key(to);
    let reason = '';
    if (!validCorrection(from, to)) reason = 'invalid';
    else if (blocked.has(fromKey) || blocked.has(toKey)) reason = 'blocked';
    else if (taken.has(fromKey) || taken.has(toKey) || seenSources.has(fromKey)) reason = 'known';
    else if (pending.some((proposal) => {
      if (!proposal) return false;
      const source = key(proposal.from);
      const target = key(proposal.to);
      // Keep matching proposals: accepting a replacement rule is a separate
      // decision from saving a canonical spelling. Conflicting proposals win
      // over an automatic guess until the user resolves them.
      if (source === fromKey && target === toKey) return false;
      return source === fromKey || source === toKey || target === fromKey || target === toKey;
    })) reason = 'pending-conflict';
    if (reason) {
      skipped.push({ from, to, reason });
      continue;
    }
    const phrase = dict.makePhrase(to, to, { kind: 'word', source: 'learned' });
    ownedPhrases.set(phrase, fingerprint(phrase));
    added.push(phrase);
    taken.add(toKey);
    seenSources.add(fromKey);
  }

  return {
    dictionary: added.length
      ? Object.assign({}, current, { phrases: added.slice().reverse().concat(phrases) })
      : current,
    added,
    skipped,
  };
}

function undoCorrections(dictionary, added) {
  const current = dictionary || {};
  const receipts = new Set(list(added));
  const removed = [];
  const phrases = list(current.phrases).filter((phrase) => {
    if (!phrase || !receipts.has(phrase) || phrase.kind !== 'word' || phrase.source !== 'learned'
      || !ownedPhrases.has(phrase) || ownedPhrases.get(phrase) !== fingerprint(phrase)) return true;
    removed.push(phrase);
    return false;
  });
  if (!removed.length) return { dictionary: current, removed };

  const removedTargets = new Set(removed.map((phrase) => key(phrase.to)));
  const liveTargets = new Set(phrases.map((phrase) => key(phrase && phrase.to)));
  // Do not globally clean variants: unrelated entries may have changed since
  // the receipt was issued. Only an orphan belonging to this Undo is removed.
  const variants = list(current.variants).filter((variant) => !variant
    || !removedTargets.has(key(variant.to)) || liveTargets.has(key(variant.to)));
  return { dictionary: Object.assign({}, current, { phrases, variants }), removed };
}

module.exports = { addCorrections, undoCorrections };
