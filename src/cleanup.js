'use strict';

// Longest first, so "exclamation point" is consumed before "period" ever
// looks at the tail of it.
const VOICE_COMMANDS = [
  ['new paragraph', '\n\n'],
  ['exclamation point', '!'],
  ['exclamation mark', '!'],
  ['question mark', '?'],
  ['full stop', '.'],
  ['new line', '\n'],
  ['newline', '\n'],
  ['period', '.'],
  ['comma', ','],
];

// Every spoken command needs an explicit "insert". Bare, these collide with
// ordinary nouns — "during that period", "a comma separated export", "a new
// line of business", "a question mark over it" — and silently swallow real
// words. The prefix costs one syllable and makes the command unambiguous.
const INSERT_PREFIX = '\\binsert\\s+(?:an?\\s+)?';

// `stop` is what a spoken "period" becomes. cleanup() passes a marker so a
// stop the speaker asked for can be told apart from one the engine guessed.
function applyVoiceCommands(text, stop = '.') {
  let s = String(text || '');
  for (const [phrase, replacement] of VOICE_COMMANDS) {
    const re = new RegExp(INSERT_PREFIX + phrase.replace(/ /g, '\\s+') + '\\b', 'gi');
    s = s.replace(re, replacement === '.' ? stop : replacement);
  }
  return s;
}

// Spoken keyboard shortcuts. "control plus shift plus space" is a chord the
// speaker wants written as one thing, not four words of prose.
//
// This runs without an "insert" prefix, unlike the voice commands above, and
// the shape of the pattern is what makes that safe: the chain has to start with
// a modifier and be joined by "plus". Ordinary speech does not do that. "He
// lost control of it" has no joiner, "two plus two" has no modifier, and
// "control the output" has neither, so all three are copied through untouched.
const SHORTCUT_MODIFIERS = new Map([
  ['control', 'Ctrl'],
  ['ctrl', 'Ctrl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['command', 'Cmd'],
  ['cmd', 'Cmd'],
  ['windows', 'Win'],
  ['win', 'Win'],
  ['super', 'Win'],
]);

const SHORTCUT_KEYS = new Map([
  ['space', 'Space'],
  ['spacebar', 'Space'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['escape', 'Esc'],
  ['esc', 'Esc'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['backspace', 'Backspace'],
  ['insert', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['comma', ','],
  ['period', '.'],
  ['dot', '.'],
  ['slash', '/'],
  ['backslash', '\\'],
  ['semicolon', ';'],
  ['minus', '-'],
  ['dash', '-'],
  ['equals', '='],
  ['tilde', '~'],
]);

// Two-word names, checked before the single-word tables so "page up" is not
// read as the key "up" with "page" left stranded outside the chord.
const SHORTCUT_PAIRS = new Map([
  ['windows key', 'Win'],
  ['command key', 'Cmd'],
  ['page up', 'PageUp'],
  ['page down', 'PageDown'],
  ['caps lock', 'CapsLock'],
  ['up arrow', 'Up'],
  ['down arrow', 'Down'],
  ['left arrow', 'Left'],
  ['right arrow', 'Right'],
  ['arrow up', 'Up'],
  ['arrow down', 'Down'],
  ['arrow left', 'Left'],
  ['arrow right', 'Right'],
]);

// "a" and "i" are left in play as keys: Ctrl+A and Ctrl+I are common enough to
// be worth it. They are also the one place this can misread prose -- "temperature
// control plus a humidifier" comes out as "Temperature Ctrl+A humidifier",
// because nothing in the sentence separates the article from the key. Both are
// followed by an ordinary word, so there is no signal to test. The trade is
// deliberate; dropping the two letters would cost more than it saves.
function shortcutKeyName(word) {
  const w = String(word).toLowerCase();
  if (SHORTCUT_KEYS.has(w)) return SHORTCUT_KEYS.get(w);
  if (/^[a-z0-9]$/.test(w)) return w.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(w)) return 'F' + w.slice(1);
  return '';
}

// One segment of a chord: a two-word name if the pair table has it, otherwise a
// modifier or a key. Reports how many words it consumed so the caller can walk
// the chain.
function shortcutSegment(words, i) {
  if (i < 0 || i >= words.length) return null;
  if (i + 1 < words.length) {
    const pair = (words[i] + ' ' + words[i + 1]).toLowerCase();
    if (SHORTCUT_PAIRS.has(pair)) {
      return { text: SHORTCUT_PAIRS.get(pair), used: 2, modifier: pair.endsWith(' key') };
    }
  }
  const w = words[i].toLowerCase();
  if (SHORTCUT_MODIFIERS.has(w)) return { text: SHORTCUT_MODIFIERS.get(w), used: 1, modifier: true };
  const key = shortcutKeyName(words[i]);
  if (key) return { text: key, used: 1, modifier: false };
  return null;
}

// A chord cannot straddle punctuation or a line break, so the run between two
// of its words has to be blank. "Control, plus or minus five" stays prose.
function onlyBlankBetween(src, a, b) {
  return /^[ \t]*$/.test(src.slice(a, b));
}

function applyShortcuts(text) {
  const src = String(text || '');
  const toks = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(src))) toks.push({ w: m[0], start: m.index, end: re.lastIndex });
  if (!toks.length) return src;
  const words = toks.map((t) => t.w);

  let out = '';
  let copied = 0;
  let i = 0;
  while (i < toks.length) {
    const head = shortcutSegment(words, i);
    if (!head || !head.modifier) {
      i += 1;
      continue;
    }
    const parts = [head.text];
    let j = i + head.used;
    let joins = 0;
    while (j < toks.length) {
      const prevEnd = toks[j - 1].end;
      let segStart = j;
      // The engine writes the joiner either way round: as the word the speaker
      // said, or as the symbol it stands for.
      if (words[j].toLowerCase() === 'plus' && onlyBlankBetween(src, prevEnd, toks[j].start)) {
        segStart = j + 1;
        if (segStart >= toks.length) break;
        if (!onlyBlankBetween(src, toks[j].end, toks[segStart].start)) break;
      } else if (!/^[ \t]*\+[ \t]*$/.test(src.slice(prevEnd, toks[j].start))) {
        break;
      }
      const seg = shortcutSegment(words, segStart);
      if (!seg) break;
      parts.push(seg.text);
      joins += 1;
      j = segStart + seg.used;
    }
    if (!joins) {
      i += 1;
      continue;
    }
    out += src.slice(copied, toks[i].start) + parts.join('+');
    copied = toks[j - 1].end;
    i = j;
  }
  return out + src.slice(copied);
}

function applyScratchThat(text) {
  const parts = text.split(/\bscratch that\b/gi);
  if (parts.length === 1) return text;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      out = parts[i];
      continue;
    }
    out = out.replace(/[\s]*[^.?!\n\uE010]*$/, '');
    out += parts[i];
  }
  return out;
}

// Keep machine-readable tokens intact while formatting the surrounding prose.
function withStructuredTokens(text, transform) {
  const tokens = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+%-]+@[\w.-]+\.[a-z]{2,}|\b(?:[\w-]+\.)+[a-z]{2,63}\b(?:[\/:?#][^\s<>]*)?|\b\d+(?:[,.]\d+)+\b/gi;
  const protectedText = String(text || '').replace(pattern, match => {
    const token = match.replace(/[.!?,;:]+$/, '');
    const suffix = match.slice(token.length);
    return '\uE000' + (tokens.push(token) - 1) + '\uE001' + suffix;
  });
  return transform(protectedText).replace(/\uE000(\d+)\uE001/g, (_, i) => tokens[Number(i)]);
}

// Short forms whose full stop does not end a sentence. Only a lower-case word
// after one is at stake -- "etc. and so on" -- since a capital is already one.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx',
  'inc', 'ltd', 'corp', 'dept', 'fig', 'cf', 'al', 'misc',
]);

// Whether `before` -- text up to and including a . ! ? or ellipsis -- ends a
// sentence. An ellipsis is a pause the speaker talked through, and dotted
// short forms (p.m., e.g., U.S., Ph.D.) keep their sentence going.
function endsSentence(before) {
  const s = String(before || '').replace(/[)"'”’]+$/, '');
  if (/(?:\.\.|…)$/.test(s)) return false;
  if (/[!?]$/.test(s)) return true;
  if (!/\.$/.test(s)) return false;
  const word = (s.match(/(\S+)$/) || ['', ''])[1];
  if (/^(?:\p{L}{1,3}\.){2,}$/u.test(word)) return false;
  return !ABBREVIATIONS.has(word.slice(0, -1).toLowerCase());
}

const SENTENCE_WORD = "\\p{L}[\\p{L}\\p{M}\\p{N}'’_-]*";

// Hands the first word of every sentence to `change(word, rest)` and splices
// its answer back in: the one definition of a sentence start for cleanup and
// every tone. `lineStarts` also counts the first word of each line. After an
// ellipsis or a short form the engine's own capital is what says a new
// sentence began.
function mapSentenceStarts(text, change, { lineStarts = false } = {}) {
  const re = new RegExp('^(\\s*)(' + SENTENCE_WORD + ')|([.!?…]+[)"\'”’]*)(\\s+)(' + SENTENCE_WORD + ')'
    + (lineStarts ? '|(\\n)([ \\t]*)(' + SENTENCE_WORD + ')' : ''), 'gu');
  return String(text || '').replace(re, (...args) => {
    const [match, pad, first, stop, gap, word, newline, indent, lineWord] = args;
    const offset = args[args.length - 2];
    const whole = args[args.length - 1];
    const rest = whole.slice(offset + match.length);
    if (first !== undefined) return pad + change(first, rest);
    if (lineWord !== undefined) return newline + indent + change(lineWord, rest);
    if ((lineStarts && gap.includes('\n')) || endsSentence(whole.slice(0, offset) + stop)
      || /^\p{Lu}/u.test(word)) return stop + gap + change(word, rest);
    return match;
  });
}

// A word with a capital inside it was written that way on purpose -- iPhone,
// eBay, macOS -- and keeps its spelling at the start of a sentence too.
function capitalizeWord(word) {
  if (!/^\p{Ll}/u.test(word) || /\p{Lu}/u.test(word.slice(1))) return word;
  return word[0].toUpperCase() + word.slice(1);
}

function capitalizeSentences(text) {
  return mapSentenceStarts(text, capitalizeWord);
}

// The cloud engine marks a pause with a full stop and carries on in lower
// case: "a soft smile. and very natural look". A lower-case joining word after
// the stop is the engine saying the sentence went on, so the stop goes. A stop
// the speaker asked for ("insert period") is still a marker at this point and
// is never touched.
const CONTINUATION_WORDS = '(?:and|or|but|nor|of|from|with|without|as|like|than|that|which|who|whom|whose|where|when|while|whereas|because|to|for|in|on|at|by|into|onto|about|over|under|until|unless|via|per|toward|towards|before|after)';
const SPOKEN_STOP = '\uE010';

function joinPausePeriods(text) {
  const re = new RegExp('(\\S+)\\.([ \\t]+)(?=' + CONTINUATION_WORDS + "(?![\\p{L}\\p{N}'’_-]))", 'gu');
  return String(text || '').replace(re, (match, word, gap) => (endsSentence(word + '.') ? word + gap : match));
}

function tidyPunct(text) {
  let s = text.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/ +([.,!?])/g, '$1');
  s = s.replace(/([!?])([A-Za-z])/g, '$1 $2');
  // A stop run into the next word is a missing space -- "done.The" -- but a
  // single letter on either side makes it one word: p.m., e.g., U.S., Ph.D.
  s = s.replace(/(\p{L}{2,})\.(?=\p{L}{2}|I\b)/gu, '$1. ');
  s = s.replace(/,([^\s])/g, ', $1');
  s = s.replace(/\s+([.!?])/g, '$1');
  return s;
}

function stripHallucinations(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  const whole = s.replace(/[.!?]+$/g, '').trim().toLowerCase();
  if (
    whole === 'thanks for watching' ||
    whole === 'thank you for watching' ||
    whole === 'please subscribe' ||
    whole === 'subscribe' ||
    whole === 'the end' ||
    whole === 'you' ||
    /^subtitles by\b/.test(whole)
  ) {
    return '';
  }
  s = s.replace(
    /\s+(thanks for watching|thank you for watching|please subscribe)\.?\s*$/i,
    ''
  );
  return s.trim();
}

function wordKey(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '');
}

function phraseKey(words) {
  return words.map(wordKey).filter(Boolean).join(' ');
}

// Words people say twice on purpose. Collapsing one deletes a word the speaker
// chose: "very, very good", "bye bye", "no no no", "she had had enough", and
// Indian English doubling -- "different different accounts" for "various".
const MEANT_TWICE = new Set([
  'very', 'really', 'much', 'far', 'long', 'way', 'super', 'too', 'more', 'many',
  'no', 'yes', 'yeah', 'yep', 'yup', 'nope', 'ok', 'okay', 'oh', 'ah', 'aha', 'ha', 'haha',
  'wow', 'yay', 'yo', 'hey', 'hi', 'hello', 'bye', 'please', 'sorry', 'go', 'come', 'why',
  'knock', 'tick', 'tock', 'chop', 'blah', 'la', 'na', 'boo', 'had',
  'little', 'different', 'small', 'big', 'tiny', 'slow', 'slowly', 'quick', 'quickly',
  'fast', 'soon', 'hot', 'same',
]);

const MEANT_TWICE_PHRASES = new Set([
  'thank you', 'come on', 'oh my god', 'my god', 'oh no', 'no way', "what's up",
  'see you', 'excuse me', 'bye bye', 'yes sir', 'no sir', 'hurry up', 'go on',
]);

// Function words a speaker stumbles on. A comma between two copies of one of
// these is still a stumble -- "I, I think" -- while a comma between two copies
// of anything else may be a choice: "different, different", "little, little".
const STUMBLE_WORDS = new Set([
  'a', 'an', 'the', 'i', "i'm", "i'll", "i've", "i'd", 'it', "it's", 'its', 'you',
  "you're", 'we', "we're", 'they', "they're", 'he', 'she', 'me', 'my', 'your', 'our',
  'their', 'his', 'her', 'them', 'us', 'this', 'that', 'these', 'those', 'there', 'here',
  'and', 'or', 'but', 'so', 'if', 'then', 'because', 'as', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'from', 'with', 'into', 'about', 'like', 'is', 'are', 'was', 'were', 'be',
  'been', 'do', 'does', 'did', 'have', 'has', 'can', 'could', 'will', 'would', 'should',
  'shall', 'may', 'might', 'must', 'not', 'what', "what's", 'which', 'who', 'where',
  'when', 'how', 'just', 'also', 'well', 'now',
]);

function isCapitalized(word) {
  return /^[^\p{L}]*\p{Lu}/u.test(word);
}

// A copy that ends in a comma, dash or ellipsis was followed by a pause.
function hasPause(word) {
  return /[^\p{L}\p{N}'’]$/u.test(word);
}

function edges(word) {
  const lead = word.match(/^[^\p{L}\p{N}']*/u)[0];
  const tail = word.slice(lead.length).match(/[^\p{L}\p{N}']*$/u)[0];
  return { lead, core: word.slice(lead.length, word.length - tail.length), tail };
}

// One word standing for several copies of it: the punctuation the sentence
// continues from (the last copy's), and the capital only where a sentence
// starts. Mid-sentence, a capital on one copy is the engine opening a
// sentence that never opened.
function mergeCopies(copies, atStart) {
  const last = edges(copies[copies.length - 1]);
  const first = edges(copies[0]);
  const cores = copies.map(copy => edges(copy).core);
  const upper = cores.find(core => isCapitalized(core));
  const lower = cores.find(core => !isCapitalized(core));
  const core = upper && lower ? (atStart ? upper : lower) : last.core;
  return first.lead + core + last.tail;
}

function wordRepeatIsStumble(prev, word, key, atStart) {
  if (/\d/.test(key)) return false; // "1 1 2 3" is a code
  if (endsSentence(prev)) return false; // "No. No, I won't."
  if (MEANT_TWICE.has(key)) return false;
  if (!atStart && isCapitalized(prev) && isCapitalized(word)) return false; // Walla Walla, Baden Baden
  if (hasPause(prev) && !STUMBLE_WORDS.has(key)) return false;
  return true;
}

function collapseAdjacentWords(words) {
  const out = [];
  for (const word of words) {
    const key = wordKey(word);
    const prev = out[out.length - 1];
    const atStart = out.length < 2 || endsSentence(out[out.length - 2]);
    if (key && prev && wordKey(prev) === key && wordRepeatIsStumble(prev, word, key, atStart)) {
      out[out.length - 1] = mergeCopies([prev, word], atStart);
      continue;
    }
    out.push(word);
  }
  return out;
}

// `run` holds every copy, `len` words each. A restart is a stumble -- "how can
// I, how can I start" -- but a sentence said twice, a name in a list, or a
// line that ends on the repeat after a pause was said that way on purpose.
function phraseRepeatIsStumble(run, len, unit, closesLine) {
  for (let t = 0; t < run.length - 1; t++) {
    if (endsSentence(run[t])) return false; // "Not in the website. In the website, ..."
  }
  if (/\d/.test(unit) || MEANT_TWICE_PHRASES.has(unit)) return false;
  if (unit.split(' ').every(w => MEANT_TWICE.has(w))) return false; // "no no no no"
  for (let t = 0; t < run.length; t++) {
    // "Nano Banana Pro and Nano Banana 2": capitals inside are names.
    if (t % len && isCapitalized(run[t]) && !/^I(?:['’]\p{L}+)?[^\p{L}]*$/u.test(run[t])) return false;
  }
  const closes = closesLine || endsSentence(run[run.length - 1]);
  return !(closes && hasPause(run[len - 1])); // "what's up, what's up?"
}

function collapseAdjacentPhrases(words) {
  let next = words.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const maxLen = Math.min(8, Math.floor(next.length / 2));
    for (let len = maxLen; len >= 2; len--) {
      let i = 0;
      while (i + len * 2 <= next.length) {
        const unit = phraseKey(next.slice(i, i + len));
        if (!unit || unit !== phraseKey(next.slice(i + len, i + len * 2))) {
          i += 1;
          continue;
        }
        let copies = 2;
        while (i + len * (copies + 1) <= next.length
          && phraseKey(next.slice(i + len * copies, i + len * (copies + 1))) === unit) copies += 1;
        const end = i + len * copies;
        const run = next.slice(i, end);
        if (!phraseRepeatIsStumble(run, len, unit, end >= next.length)) {
          // Past the whole run: a window shifted one word into it is the
          // same repeat again ("is slop, this" in "this is slop" x3).
          i = end;
          continue;
        }
        const atStart = i === 0 || endsSentence(next[i - 1]);
        const merged = [];
        for (let t = 0; t < len; t++) {
          const forms = [];
          for (let c = 0; c < copies; c++) forms.push(run[c * len + t]);
          merged.push(mergeCopies(forms, atStart && t === 0));
        }
        next.splice(i, len * copies, ...merged);
        changed = true;
      }
    }
  }
  return next;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Collapses a stumble ("the the", "how can I, how can I start") and leaves
// what was said twice on purpose. `protectedPhrases` are dictionary terms and
// their spoken forms: "Bora Bora" has to reach the dictionary whole to be
// spelled the way the user taught it.
function dedupeRepeats(text, protectedPhrases = []) {
  const kept = [];
  let s = String(text || '');
  const phrases = [...new Set((protectedPhrases || []).filter(p => typeof p === 'string' && p.trim()))]
    .sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    s = s.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(phrase.trim()) + '(?![\\p{L}\\p{N}_])', 'giu'),
      match => '\uE500' + (kept.push(match) - 1) + '\uE501');
  }
  const lines = s.split('\n');
  const outLines = [];
  for (const line of lines) {
    let words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      outLines.push('');
      continue;
    }
    words = collapseAdjacentWords(words);
    words = collapseAdjacentPhrases(words);
    outLines.push(words.join(' '));
  }
  return outLines.join('\n').trim().replace(/\uE500(\d+)\uE501/g, (_, i) => kept[Number(i)]);
}

function cleanup(raw, language = 'en') {
  if (!raw) return '';
  if (!/^en(?:-|$)/i.test(language)) return cleanupVerbatim(raw);
  return withStructuredTokens(raw, value => {
    let s = String(value).replace(/[ \t]+/g, ' ').trim();
    s = stripHallucinations(s);
    if (!s) return '';
    // Match keyboard chords before voice commands rewrite their words.
    s = applyShortcuts(s);
    s = applyVoiceCommands(s, SPOKEN_STOP);
    s = applyScratchThat(s);
    s = joinPausePeriods(s).replace(/\uE010/g, '.');
    s = tidyPunct(s);
    s = capitalizeSentences(s);
    return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  });
}

// Verbatim keeps every word the speaker chose. Whitespace, punctuation
// spacing, and sentence capitalization are typographic, so they still run;
// The audio gate handles silence; text alone cannot identify invented words.
// applyShortcuts, applyVoiceCommands and applyScratchThat all
// delete or replace real speech, so none of them belongs here -- someone
// dictating verbatim who says "control plus C" wants those words.
function cleanupVerbatim(raw) {
  if (!raw) return '';
  return withStructuredTokens(raw, value => {
    let s = String(value).replace(/[ \t]+/g, ' ').trim();
    s = tidyPunct(s);
    s = capitalizeSentences(s);
    return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  });
}

// Module-specific, not `api`: overlay.html shares one global scope between this
// and chunking.js. See scripts/test-globals.js.
const cleanupApi = {
  withStructuredTokens,
  cleanup,
  cleanupVerbatim,
  dedupeRepeats,
  applyShortcuts,
  applyVoiceCommands,
  applyScratchThat,
  capitalizeSentences,
  capitalizeWord,
  mapSentenceStarts,
  endsSentence,
  stripHallucinations,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = cleanupApi;
} else {
  globalThis.voxdenCleanup = cleanupApi;
}
