'use strict';

// Spoken numbers, written as numbers.
//
// The engines write what they hear -- "one point zero point sixteen", "twenty
// five percent", "two thousand and five" -- and prose wants "1.0.16", "25%",
// "2005". This is the deterministic half of that: it recognises the shapes a
// person actually says and rewrites only those, leaving every ambiguous word
// alone. "One of them", "no one", "second thoughts" are prose and stay prose.
//
// Rules, in order of precedence at any position:
//   - a run of three or more single digits is read out as digits ("five five
//     five one two three four" -> 5551234), which is how numbers, codes and
//     phone numbers are spoken
//   - an ordinal with a tens part, or from "tenth" up, becomes a suffix form
//     ("twenty fifth" -> 25th); "first" to "ninth" on their own stay words
//   - a cardinal phrase, with any "point" chain after it ("one point zero
//     point sixteen" -> 1.0.16, "three point one four" -> 3.14)
//
// A phrase is written as digits when it is more than one word, or ten or
// more, or carries a decimal, or sits next to a unit or a label that makes
// it a figure ("five percent", "version five", "page three"). A bare "one" to
// "nine" is left as the word, which is also what style guides ask for.

const ONES = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19],
]);

const TENS = new Map([
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
  ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);

const SCALES = new Map([
  ['hundred', 100], ['thousand', 1000], ['million', 1000000],
  ['billion', 1000000000], ['trillion', 1000000000000],
]);

const ORDINAL_UNITS = new Map([
  ['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5],
  ['sixth', 6], ['seventh', 7], ['eighth', 8], ['ninth', 9],
]);

const ORDINAL_WORDS = new Map([
  ['tenth', 10], ['eleventh', 11], ['twelfth', 12], ['thirteenth', 13],
  ['fourteenth', 14], ['fifteenth', 15], ['sixteenth', 16],
  ['seventeenth', 17], ['eighteenth', 18], ['nineteenth', 19],
  ['twentieth', 20], ['thirtieth', 30], ['fortieth', 40], ['fiftieth', 50],
  ['sixtieth', 60], ['seventieth', 70], ['eightieth', 80], ['ninetieth', 90],
  ['hundredth', 100], ['thousandth', 1000], ['millionth', 1000000],
]);

// Words after a number that make a bare "one" to "nine" a figure.
const UNITS_AFTER = new Set([
  'percent', 'cents', 'dollars', 'euros', 'pounds', 'rupees', 'bucks',
  'kg', 'kilograms', 'kilos', 'grams', 'g', 'mg', 'lbs', 'ounces', 'oz',
  'meters', 'metres', 'm', 'km', 'kilometers', 'kilometres', 'miles', 'cm',
  'mm', 'inches', 'feet', 'ft', 'litres', 'liters', 'ml', 'gb', 'mb', 'kb',
  'tb', 'ghz', 'mhz', 'hz', 'fps', 'px', 'pixels', 'degrees', 'am', 'pm',
  "o'clock", 'x',
]);

// Words before a number that make it a figure: "page three", "version two".
// Not "no": "no one came" is prose.
const LABELS_BEFORE = new Set([
  'number', 'version', 'chapter', 'page', 'room', 'step', 'item',
  'level', 'figure', 'table', 'section', 'part', 'episode', 'season',
  'grade', 'floor', 'line', 'unit', 'phase', 'round', 'week', 'day',
  'question', 'option', 'point', 'stage', 'tier', 'gate', 'route', 'highway',
  'iphone', 'windows', 'python', 'node', 'gpt', 'claude',
]);

function isDigitWord(w) {
  return ONES.has(w) && ONES.get(w) < 10;
}

// Tokens are alphabetic words with an optional apostrophe, so "o'clock" is one
// token. Two number words belong to the same phrase only when nothing but
// blanks or a single hyphen sits between them: "five. Six" is two sentences.
function tokenize(text) {
  const toks = [];
  const re = /[A-Za-z][A-Za-z']*|%/g;
  let m;
  while ((m = re.exec(text))) {
    toks.push({ w: m[0], lower: m[0].toLowerCase(), start: m.index, end: re.lastIndex });
  }
  return toks;
}

function joined(text, toks, i) {
  if (i <= 0) return true;
  return /^(?:[ \t]+|[ \t]*-[ \t]*)$/.test(text.slice(toks[i - 1].end, toks[i].start));
}

// A cardinal phrase starting at i. Returns null when the word there is not a
// number. `used` counts tokens; `group` says whether the phrase was a single
// tens-or-teens group, which is what a spoken year is two of.
function parseCardinal(text, toks, i) {
  let total = 0;
  let current = 0;
  let j = i;
  let lastScale = Infinity;
  let sawAny = false;
  let hasOnes = false;
  let hasTens = false;
  let hasHundred = false;
  let articleStart = false;
  if (j < toks.length && (toks[j].lower === 'a' || toks[j].lower === 'an')) {
    const next = toks[j + 1];
    if (!next || !joined(text, toks, j + 1) || !SCALES.has(next.lower)) return null;
    articleStart = true;
    current = 1;
    j += 1;
  }
  while (j < toks.length) {
    if (j > i && !joined(text, toks, j)) break;
    const w = toks[j].lower;
    if (ONES.has(w)) {
      const v = ONES.get(w);
      if (hasOnes) break;
      if (v === 0 && (current > 0 || total > 0)) break;
      if (v >= 10 && hasTens) break;
      current += v;
      hasOnes = true;
      if (v >= 10) hasTens = true;
      sawAny = true;
      j += 1;
      continue;
    }
    if (TENS.has(w)) {
      if (hasTens || hasOnes) break;
      current += TENS.get(w);
      hasTens = true;
      sawAny = true;
      j += 1;
      continue;
    }
    if (w === 'hundred') {
      if (hasHundred || current === 0 || current > 99) break;
      current *= 100;
      hasHundred = true;
      hasOnes = false;
      hasTens = false;
      sawAny = true;
      j += 1;
      continue;
    }
    if (SCALES.has(w)) {
      const scale = SCALES.get(w);
      if (scale >= lastScale) break;
      if (current === 0 && total === 0 && !articleStart) break;
      total += (current || 1) * scale;
      current = 0;
      lastScale = scale;
      hasOnes = false;
      hasTens = false;
      hasHundred = false;
      sawAny = true;
      j += 1;
      continue;
    }
    if (w === 'and' && sawAny && current === 0 && total > 0 && j + 1 < toks.length
        && joined(text, toks, j + 1)) {
      const n = toks[j + 1].lower;
      if (ONES.has(n) || TENS.has(n)) {
        j += 1;
        continue;
      }
      break;
    }
    if (w === 'and' && sawAny && hasHundred && current % 100 === 0 && j + 1 < toks.length
        && joined(text, toks, j + 1)) {
      const n = toks[j + 1].lower;
      if (ONES.has(n) || TENS.has(n)) {
        j += 1;
        continue;
      }
      break;
    }
    break;
  }
  if (!sawAny) return null;
  const value = total + current;
  const group = total === 0 && !hasHundred && value >= 10 && value <= 99;
  return { value, used: j - i, group };
}

function parseOrdinal(text, toks, i) {
  // "twenty fifth", "one hundred and first": a cardinal whose last group is
  // an ordinal unit word.
  const card = parseCardinal(text, toks, i);
  if (card) {
    let k = i + card.used;
    // "one hundred and first": the cardinal stops before an "and" that is
    // not followed by a number word, so the ordinal has to step over it.
    if (k + 1 < toks.length && toks[k].lower === 'and' && card.value % 100 === 0
        && card.value > 0 && joined(text, toks, k) && joined(text, toks, k + 1)
        && (ORDINAL_UNITS.has(toks[k + 1].lower) || ORDINAL_WORDS.has(toks[k + 1].lower))) {
      k += 1;
    }
    if (k < toks.length && joined(text, toks, k)) {
      const w = toks[k].lower;
      const used = k - i + 1;
      if (ORDINAL_UNITS.has(w) && card.value % 10 === 0 && card.value > 0) {
        return { value: card.value + ORDINAL_UNITS.get(w), used };
      }
      if (ORDINAL_WORDS.has(w)) {
        const v = ORDINAL_WORDS.get(w);
        if (v < 100 && card.value % 100 === 0 && card.value > 0) {
          return { value: card.value + v, used };
        }
        if (v >= 100 && card.value < v && card.value > 0) {
          return { value: card.value * v, used };
        }
      }
    }
    return null;
  }
  const w = toks[i].lower;
  if (ORDINAL_WORDS.has(w)) return { value: ORDINAL_WORDS.get(w), used: 1 };
  return null;
}

function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  const mod10 = n % 10;
  if (mod10 === 1) return 'st';
  if (mod10 === 2) return 'nd';
  if (mod10 === 3) return 'rd';
  return 'th';
}

// The digits after a "point": single digits are read one by one ("point one
// four" -> 14); anything else is a number in its own right ("point sixteen").
function parseFraction(text, toks, i) {
  if (i >= toks.length || !joined(text, toks, i)) return null;
  if (isDigitWord(toks[i].lower)) {
    let s = '';
    let j = i;
    while (j < toks.length && joined(text, toks, j) && isDigitWord(toks[j].lower)) {
      s += String(ONES.get(toks[j].lower));
      j += 1;
    }
    return { text: s, used: j - i };
  }
  const card = parseCardinal(text, toks, i);
  if (!card || card.value >= 1000) return null;
  return { text: String(card.value), used: card.used };
}

function parseDigitRun(text, toks, i) {
  let j = i;
  let s = '';
  while (j < toks.length && (j === i || joined(text, toks, j)) && isDigitWord(toks[j].lower)) {
    s += String(ONES.get(toks[j].lower));
    j += 1;
  }
  if (j - i < 3) return null;
  return { text: s, used: j - i };
}

function labelBefore(text, toks, i) {
  if (i === 0) return false;
  const prev = toks[i - 1];
  if (!LABELS_BEFORE.has(prev.lower)) return false;
  return /^[ \t]+$/.test(text.slice(prev.end, toks[i].start));
}

function spokenNumbersToDigits(input) {
  const text = String(input || '');
  if (!text) return '';
  const toks = tokenize(text);
  if (!toks.length) return text;
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < toks.length) {
    let replacement = null;
    let used = 0;

    const run = parseDigitRun(text, toks, i);
    if (run) {
      replacement = run.text;
      used = run.used;
    }

    if (!replacement) {
      const ord = parseOrdinal(text, toks, i);
      if (ord) {
        replacement = String(ord.value) + ordinalSuffix(ord.value);
        used = ord.used;
      }
    }

    if (!replacement) {
      const card = parseCardinal(text, toks, i);
      if (card) {
        let value = card.value;
        used = card.used;
        let multi = card.used > 1;
        // Two tens groups in a row are a year: "twenty twenty six".
        if (card.group) {
          const k = i + used;
          const next = k < toks.length && joined(text, toks, k) ? parseCardinal(text, toks, k) : null;
          if (next && next.group) {
            value = value * 100 + next.value;
            used += next.used;
            multi = true;
          }
        }
        let s = String(value);
        let decimal = false;
        let k = i + used;
        while (k + 1 < toks.length && toks[k].lower === 'point' && joined(text, toks, k)) {
          const frac = parseFraction(text, toks, k + 1);
          if (!frac) break;
          s += '.' + frac.text;
          used = k + 1 + frac.used - i;
          k = i + used;
          decimal = true;
        }
        const single = card.used === 1 && value < 10 && !decimal;
        const after = k < toks.length && joined(text, toks, k) ? toks[k] : null;
        const afterWord = after ? after.lower : '';
        const unitAfter = after && (UNITS_AFTER.has(afterWord) || afterWord === '%'
          || (afterWord === 'per' && k + 1 < toks.length && toks[k + 1].lower === 'cent'));
        if (!single || multi || unitAfter || labelBefore(text, toks, i)) {
          if (afterWord === 'percent' || afterWord === '%') {
            s += '%';
            used += 1;
          } else if (afterWord === 'per' && k + 1 < toks.length && toks[k + 1].lower === 'cent') {
            s += '%';
            used += 2;
          } else if (afterWord === 'dollars' || afterWord === 'bucks') {
            s = '$' + s;
            used += 1;
          }
          replacement = s;
        } else {
          used = 0;
        }
      }
    }

    if (!replacement) {
      i += 1;
      continue;
    }
    out += text.slice(copied, toks[i].start) + replacement;
    copied = toks[i + used - 1].end;
    i += used;
  }
  return out + text.slice(copied);
}

const numbersApi = { spokenNumbersToDigits };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = numbersApi;
} else {
  globalThis.voxdenNumbers = numbersApi;
}
