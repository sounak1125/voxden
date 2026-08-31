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

function applyVoiceCommands(text) {
  let s = String(text || '');
  for (const [phrase, replacement] of VOICE_COMMANDS) {
    const re = new RegExp(INSERT_PREFIX + phrase.replace(/ /g, '\\s+') + '\\b', 'gi');
    s = s.replace(re, replacement);
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
    out = out.replace(/[\s]*[^.?!\n]*$/, '');
    out += parts[i];
  }
  return out;
}

function capitalizeSentences(text) {
  const chars = text.split('');
  let cap = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) continue;
    if (cap && /[a-z]/.test(ch)) {
      chars[i] = ch.toUpperCase();
      cap = false;
    } else {
      cap = false;
    }
    if (/[.!?]/.test(ch)) cap = true;
    if (ch === '\n') cap = true;
  }
  return chars.join('');
}

function tidyPunct(text) {
  let s = text.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/ +([.,!?])/g, '$1');
  s = s.replace(/([.!?])([A-Za-z])/g, '$1 $2');
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

function collapseAdjacentWords(words) {
  const out = [];
  for (const word of words) {
    const key = wordKey(word);
    const prev = out[out.length - 1];
    if (key && prev && wordKey(prev) === key) {
      const prevCore = prev.replace(/[^a-z0-9']/gi, '');
      const nextCore = word.replace(/[^a-z0-9']/gi, '');
      if (nextCore && nextCore.length === word.length && prevCore.length !== prev.length) {
        out[out.length - 1] = word;
      }
      continue;
    }
    out.push(word);
  }
  return out;
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
        const a = phraseKey(next.slice(i, i + len));
        const b = phraseKey(next.slice(i + len, i + len * 2));
        if (a && a === b) {
          next.splice(i + len, len);
          changed = true;
          continue;
        }
        i += 1;
      }
    }
  }
  return next;
}

function dedupeRepeats(text) {
  const lines = String(text || '').split('\n');
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
  return outLines.join('\n').trim();
}

function cleanup(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  s = stripHallucinations(s);
  if (!s) return '';
  // Before the voice commands, so a chord is matched against what was actually
  // said rather than against text those have already rewritten.
  s = applyShortcuts(s);
  s = applyVoiceCommands(s);
  s = applyScratchThat(s);
  s = tidyPunct(s);
  s = capitalizeSentences(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return s;
}

// Verbatim keeps every word the speaker chose. Whitespace, punctuation
// spacing, and sentence capitalization are typographic, so they still run;
// stripHallucinations stays because a sign-off the engine invented is not a
// word anyone said. applyShortcuts, applyVoiceCommands and applyScratchThat all
// delete or replace real speech, so none of them belongs here -- someone
// dictating verbatim who says "control plus C" wants those words.
function cleanupVerbatim(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  s = stripHallucinations(s);
  if (!s) return '';
  s = tidyPunct(s);
  s = capitalizeSentences(s);
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// Module-specific, not `api`: overlay.html shares one global scope between this
// and chunking.js. See scripts/test-globals.js.
const cleanupApi = {
  cleanup,
  cleanupVerbatim,
  dedupeRepeats,
  applyShortcuts,
  applyVoiceCommands,
  applyScratchThat,
  capitalizeSentences,
  stripHallucinations,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = cleanupApi;
} else {
  globalThis.voxdenCleanup = cleanupApi;
}
