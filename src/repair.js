'use strict';

// Acoustic recognition repair.
//
// Three different jobs used to be tangled together, and the tangle is why none
// of them worked properly:
//
//   1. deciding that "bubba neshwar" is a mangled "Bhubaneswar"
//   2. replacing text the user explicitly asked to have replaced
//   3. tidying fillers and punctuation into readable prose
//
// (2) is src/vocabulary.js applyEntries -- deterministic, no judgement.
// (3) is src/cleanup.js and src/style.js, deterministic rules that never
//     introduce a word, so they cannot invent a name either.
// (1) is this file, and it had nowhere to live. The dictionary tried to cover
//     it by generating spelling variants ahead of time and matching them
//     exactly, which only ever caught the misspellings somebody had thought of
//     in advance. The cleanup could not cover it because repairing a name
//     means introducing a word, which its rules exist to prevent -- and
//     loosening those rules to let names through would let everything
//     through.
//
// So repair is its own stage with its own evidence rule: a span of the
// transcript may be rewritten to a vocabulary term only when what the engine
// heard sounds like that term and does not sound like ordinary speech. It runs
// on engines that cannot be told the vocabulary up front (Parakeet has no
// context input at all) and as a backstop on the ones that can.
//
// The failure mode to fear is not a missed repair. It is "I said 'his field'
// and it typed 'Higgsfield'." Every gate below is pointed at that.

const phon = require('./phonetics');
const vocab = require('./vocabulary');

// How close a mishearing may be before it stops being the same word.
//
// These are the numbers the dictionary's isLikelySpelling already used for
// deciding whether a user's manual edit was a spelling fix, tightened, because
// this decides it without a user in the loop.
const PHONETIC_PREFIX_MIN = 3;
const PHONETIC_LENGTH_RATIO_MAX = 1.25;
const PHONETIC_DISTANCE_RATIO_MAX = 0.25;
const ORTHOGRAPHIC_RATIO_MAX = 0.25;
// Short strings are where ratios lie. At four letters a single edit is already
// a quarter of the word, so a fixed floor decides those instead: two four-
// letter strings one edit apart are not evidence of anything.
const ORTHOGRAPHIC_MIN_LENGTH = 6;
// Non-Latin scripts get no phonetic model here -- phoneticCode strips anything
// outside a-z -- so they are held to a plain edit-distance rule on the
// characters themselves, which is tighter than the phonetic one on purpose.
const UNICODE_DISTANCE_RATIO_MAX = 0.25;
const MIN_TERM_LENGTH = 3;

// How much a reason is worth when two candidates tie on confidence. `spacing`
// is exact -- the same letters in the same order -- so it must win over a
// homophone, which is a judgement. Without this, "seedance2" matched the
// shorter "Seedance" and silently dropped the "2".
const REASON_RANK = { spacing: 5, homophone: 4, orthographic: 3, 'unicode-near-miss': 2, phonetic: 1 };

function reasonRank(reason) {
  return REASON_RANK[String(reason || '')] || 0;
}

// Confidence levels a repair can be made at. Only `strong` and `likely` are
// applied; `weak` is recorded for the diagnostics so a term that keeps nearly
// matching can be seen without being acted on.
const CONFIDENCE = Object.freeze({ strong: 3, likely: 2, weak: 1, none: 0 });

function tokenize(text) {
  const out = [];
  const source = vocab.normalize(text);
  const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu;
  let match;
  while ((match = re.exec(source)) !== null) {
    out.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return { source, tokens: out };
}

function isLatin(value) {
  const script = vocab.detectScript(value);
  return !script || script === 'latn';
}

function foldLetters(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Is this span of transcript made only of words that mean something on their
// own? "his field" is; "hig sfield" is not.
//
// The rule is: NO word in the span may be ordinary English. Not "not all of
// them" -- none of them. The looser version was measured on the held-out
// recordings and produced seven false substitutions in seven clips, including
// among them ordinary two-word spans rewritten into technical terms, and it
// pushed word error rate up rather than down. One ordinary word inside a
// window is enough to mean the user was speaking, not being misheard.
//
// This deliberately gives up a class of repair: "See Dance too" for
// "Seedance 2" is three ordinary words and will never be repaired
// automatically. That case belongs to the explicit rules in
// src/vocabulary.js, where the user has said in so many words what they want
// replaced. Guessing is reserved for spans that could not have been speech.
function isOrdinarySpeech(words) {
  if (!words.length) return true;
  return words.some((w) => isEverydayWord(w));
}

// Inflections count as ordinary. "timing", "saying" and "happened" are not in
// the common-word list, but "time", "say" and "happen" are, and all three were
// substituted for vocabulary terms before this stripping existed.
const SUFFIXES = ["'s", '’s', 'ing', 'ed', 'es', 'er', 'est', 'ly', 's'];

function isEverydayWord(word) {
  const value = String(word || '').toLowerCase();
  if (!value) return true;
  if (phon.isCommonWord(value)) return true;
  for (const suffix of SUFFIXES) {
    if (!value.endsWith(suffix) || value.length - suffix.length < 2) continue;
    const stem = value.slice(0, value.length - suffix.length);
    if (phon.isCommonWord(stem)) return true;
    // "running" -> "runn" -> "run"; "carries" -> "carri" -> "carry".
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]
      && phon.isCommonWord(stem.slice(0, -1))) return true;
    if (stem.endsWith('i') && phon.isCommonWord(stem.slice(0, -1) + 'y')) return true;
    if (phon.isCommonWord(stem + 'e')) return true;
  }
  return false;
}

// Whether a vocabulary term is the kind of thing worth repairing towards.
// A term that is itself an ordinary word ("prompt", "regex") is only ever
// applied through its explicit rules, never through a phonetic guess, because
// a phonetic guess at an ordinary word is indistinguishable from a wrong one.
function isRepairable(entry) {
  const canonical = String((entry && entry.canonical) || '');
  if (canonical.length < MIN_TERM_LENGTH) return false;
  // Same everyday-word test the transcript side uses, so a term and a span are
  // never judged by two different standards.
  const words = canonical.split(/\s+/);
  if (words.every((w) => isEverydayWord(w))) return false;
  return true;
}

// How strongly a heard span matches a term.
function scoreMatch(heard, term) {
  const a = vocab.normalize(heard);
  const b = vocab.normalize(term);
  if (!a || !b) return { confidence: CONFIDENCE.none, reason: 'empty' };
  if (a.toLowerCase() === b.toLowerCase()) {
    return { confidence: CONFIDENCE.none, reason: 'already-correct' };
  }

  if (!isLatin(b) || !isLatin(a)) {
    // Different scripts entirely is not a mishearing, it is a translation, and
    // this stage does not translate.
    if (vocab.detectScript(a) !== vocab.detectScript(b)) {
      return { confidence: CONFIDENCE.none, reason: 'script-mismatch' };
    }
    const distance = phon.levenshtein(a.toLowerCase(), b.toLowerCase());
    const ratio = distance / Math.max(a.length, b.length);
    if (ratio <= UNICODE_DISTANCE_RATIO_MAX) {
      return { confidence: CONFIDENCE.likely, reason: 'unicode-near-miss', ratio };
    }
    return { confidence: CONFIDENCE.none, reason: 'unicode-far', ratio };
  }

  const foldedA = foldLetters(a);
  const foldedB = foldLetters(b);
  if (!foldedA || !foldedB) return { confidence: CONFIDENCE.none, reason: 'unfoldable' };
  if (foldedA === foldedB) {
    // Same letters, different spacing or punctuation: "seedance2" for
    // "Seedance 2". No phonetics needed and no risk taken.
    return { confidence: CONFIDENCE.strong, reason: 'spacing' };
  }

  const codeA = phon.phoneticCode(foldedA);
  const codeB = phon.phoneticCode(foldedB);
  if (codeA && codeB && codeA === codeB) {
    return { confidence: CONFIDENCE.strong, reason: 'homophone' };
  }

  const span = Math.max(foldedA.length, foldedB.length);
  const orth = phon.levenshtein(foldedA, foldedB) / span;
  if (orth <= ORTHOGRAPHIC_RATIO_MAX && span >= ORTHOGRAPHIC_MIN_LENGTH) {
    return { confidence: CONFIDENCE.likely, reason: 'orthographic', ratio: orth };
  }

  // The mangled-proper-noun case: the decoder kept the opening consonants and
  // improvised the rest. Only offered for terms that look like names, and only
  // when the two codes agree on the front and are of comparable length.
  if (!codeA || !codeB) return { confidence: CONFIDENCE.none, reason: 'no-code' };
  if (!phon.looksLikeProperNoun(b)) return { confidence: CONFIDENCE.none, reason: 'not-a-name' };
  if (phon.sharedPrefix(codeA, codeB) < PHONETIC_PREFIX_MIN) {
    return { confidence: CONFIDENCE.none, reason: 'prefix-mismatch' };
  }
  const longer = Math.max(codeA.length, codeB.length);
  const shorter = Math.min(codeA.length, codeB.length);
  if (longer / shorter > PHONETIC_LENGTH_RATIO_MAX) {
    return { confidence: CONFIDENCE.none, reason: 'length-mismatch' };
  }
  const ratio = phon.levenshtein(codeA, codeB) / longer;
  if (ratio <= PHONETIC_DISTANCE_RATIO_MAX) {
    return { confidence: CONFIDENCE.likely, reason: 'phonetic', ratio };
  }
  return { confidence: CONFIDENCE.weak, reason: 'phonetic-far', ratio };
}

// Words either side of a full stop are two different thoughts, never one
// misheard term. Without this, "the paid ones. So it's not" offered "ones. So"
// as a candidate and it came back as "ONNX".
function crossesBoundary(source, window) {
  for (let k = 1; k < window.length; k++) {
    const gap = source.slice(window[k - 1].end, window[k].start);
    if (/[^\s'’-]/.test(gap)) return true;
  }
  return false;
}

// Spans of the transcript the engine itself flagged as shaky, mapped onto
// character offsets. Whisper is the only engine that reports this. When it is
// present, a repair inside one of those spans is believed more readily,
// because the engine has already said it was not sure -- that is what "recheck
// uncertain spans" means when the only evidence available is the decoder's own
// log-probability.
function uncertainRanges(segments, source) {
  const ranges = [];
  for (const segment of segments || []) {
    const text = vocab.normalize(segment && segment.text);
    if (!text) continue;
    const at = source.indexOf(text);
    if (at >= 0) ranges.push({ start: at, end: at + text.length });
  }
  return ranges;
}

function inRanges(ranges, start, end) {
  return (ranges || []).some((r) => start >= r.start && end <= r.end);
}

// Repair one transcript.
//
// Windows of one to four words are compared against every repairable term of a
// matching width. Longest windows win, each position is used once, and a
// window is only rewritten when the evidence clears the gate. The result
// carries every decision -- including the ones that were declined -- so the
// diagnostics can explain a repair that did happen and a repair that did not.
function betterMatch(next, current) {
  if (next.confidence !== current.confidence) return next.confidence > current.confidence;
  const a = reasonRank(next.reason);
  const b = reasonRank(current.reason);
  if (a !== b) return a > b;
  return (next.ratio || 0) < (current.ratio || 0);
}

function repairTranscript(text, entries, options) {
  const opts = options || {};
  const { source, tokens } = tokenize(text);
  const empty = { text: source, repairs: [], considered: [], escalate: [] };
  if (!source || !tokens.length || !entries || !entries.length) return empty;

  const language = opts.language;
  const candidates = [];
  for (const entry of entries) {
    if (!entry || !isRepairable(entry)) continue;
    if (language && !vocab.matchesLanguage(entry, language)) continue;
    candidates.push({ entry, words: entry.canonical.split(/\s+/).length });
  }
  if (!candidates.length) return empty;

  const ranges = uncertainRanges(opts.segments, source);
  const policy = String(opts.policy || 'safe');
  const hasConfidence = Array.isArray(opts.segments);
  const maxWindow = Math.min(4, Math.max(...candidates.map((c) => c.words)) + 1);
  const used = new Array(tokens.length).fill(false);
  const repairs = [];
  const considered = [];
  const escalate = [];

  // Whether a match is strong enough evidence to rewrite the user's words.
  //
  // Measured, not guessed. Applying every phonetic match on the held-out
  // recordings turned "Laura called me this morning" into "LoRA called me this
  // morning", "an entropic system" into "an Anthropic system" and "the sole
  // character" into "the Soul Character" -- four ordinary sentences broken to
  // recover two names. Sounding alike is not evidence that the speaker meant
  // the other word; it is evidence that two words sound alike.
  //
  // So only two things license a rewrite:
  //
  //   * `spacing` -- the letters are identical and only the spaces moved.
  //     "seedance2" is "Seedance 2" with no judgement involved at all.
  //   * the decoder said it was unsure of that span. Whisper reports
  //     avg_logprob per segment; when it has already flagged the words as a
  //     guess, replacing the guess with a term the user taught is a better
  //     guess.
  //
  // Everything else is returned as an escalation candidate instead of being
  // applied. An engine with no confidence signal and no context input --
  // Parakeet -- cannot resolve those on its own, and the honest answer is to
  // recheck the audio on an engine that can take the vocabulary, not to
  // rewrite on a hunch. src/main.js decides whether that recheck is worth the
  // latency; this file only reports that there is something to recheck.
  function decide(match, uncertain) {
    if (match.reason === 'spacing') return 'apply';
    if (policy === 'aggressive') {
      return match.confidence >= CONFIDENCE.likely ? 'apply' : 'skip';
    }
    if (uncertain && match.confidence >= CONFIDENCE.likely) return 'apply';
    if (!hasConfidence && match.confidence >= CONFIDENCE.strong) return 'escalate';
    return 'skip';
  }

  for (let width = maxWindow; width >= 1; width--) {
    for (let i = 0; i + width <= tokens.length; i++) {
      let taken = false;
      for (let k = 0; k < width; k++) if (used[i + k]) taken = true;
      if (taken) continue;
      const window = tokens.slice(i, i + width);
      if (crossesBoundary(source, window)) continue;
      const heardWords = window.map((t) => t.word);
      const heard = source.slice(window[0].start, window[window.length - 1].end);
      if (isOrdinarySpeech(heardWords)) continue;

      let best = null;
      for (const candidate of candidates) {
        // A one-word term does not get rebuilt out of four words, and a
        // four-word term is not found inside one.
        if (Math.abs(candidate.words - width) > 1) continue;
        const match = scoreMatch(heard, candidate.entry.canonical);
        if (match.confidence === CONFIDENCE.none) continue;
        if (!best || betterMatch(match, best.match)) best = { candidate, match };
      }
      if (!best) continue;

      const uncertain = inRanges(ranges, window[0].start, window[window.length - 1].end);
      const verdict = decide(best.match, uncertain);
      const record = {
        heard,
        term: best.candidate.entry.canonical,
        entryId: best.candidate.entry.id,
        confidence: best.match.confidence,
        reason: best.match.reason,
        ratio: best.match.ratio == null ? null : Number(best.match.ratio.toFixed(3)),
        uncertain,
        verdict,
        applied: verdict === 'apply',
      };
      considered.push(record);
      if (verdict === 'escalate') escalate.push(record);
      if (verdict !== 'apply') continue;
      for (let k = 0; k < width; k++) used[i + k] = true;
      repairs.push(Object.assign({
        start: window[0].start,
        end: window[window.length - 1].end,
      }, record));
    }
  }

  if (!repairs.length) return { text: source, repairs: [], considered, escalate };
  repairs.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const repair of repairs) {
    out += source.slice(cursor, repair.start) + repair.term;
    cursor = repair.end;
  }
  out += source.slice(cursor);
  return { text: out, repairs, considered, escalate };
}

module.exports = {
  CONFIDENCE,
  betterMatch,
  reasonRank,
  tokenize,
  isEverydayWord,
  crossesBoundary,
  isOrdinarySpeech,
  isRepairable,
  scoreMatch,
  uncertainRanges,
  repairTranscript,
};
