'use strict';

// Phonetic tooling for Voxden's correction dictionary.
//
// Whisper is pinned to English decoding (sidecar/transcribe.py), so an
// unfamiliar name never arrives as itself — it arrives as whatever English the
// decoder could assemble from the sounds. "Subhrajit" comes back as "sub
// trees". The letters are far apart; the sounds are not. Everything here works
// on sounds, so the app can still recognise the correction as a spelling.

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// Frequent English words. Two jobs: keep a content edit ("milk" -> "eggs")
// from being mistaken for a spelling fix, and keep generated variants from
// hijacking ordinary speech.
const COMMON_WORDS = new Set(('a about above after again against all also am an and any are around as ask at away '
  + 'back bad bag be because bed been before being best better between big bit both box boy bread break bring but buy by '
  + 'call came can car care case cat chair child city close cold come could country cup cut '
  + 'dad day dear did die different do dog done door down draw drink drive drop dry during '
  + 'each early eat egg eggs eight end enough even ever every eye eyes '
  + 'face fact fall family far fast father feel few field find fine fire first fish five floor fly follow food foot for form found four free friend from front full fun '
  + 'game get girl give glass go god going gold good got great green group grow '
  + 'had hair half hand happy hard has hat have he head hear heart help her here high him his hold home hope horse hot hour house how however hundred husband '
  + 'i idea if in into is it its '
  + 'job join jump just '
  + 'keep key kid kind king kitchen know '
  + 'lady land large last late later laugh law lay lead learn leave left leg less let letter life light like line list little live long look lose lot love low '
  + 'made main make man many may maybe me mean meat meet men might milk mind mine minute miss money month more morning most mother mouth move much music must my '
  + 'name near need never new news next nice night nine no north not note nothing now number '
  + 'of off often oh oil ok old on once one only open or order other our out over own '
  + 'page paper part party pass past pay people perhaps person phone pick picture piece place plan play please point poor possible power present press pretty problem public pull push put '
  + 'question quick quiet quite '
  + 'rain reach read ready real reason red remember rest return rich ride right ring rise river road rock room round run '
  + 'said salt same sat save saw say school sea season seat second see seem sell send sense sent serve service set seven several shall she ship shoe shop short should show side sight sign since sing single sir sister sit six size sky sleep small smile snow so some son song soon sorry sound south space speak special spend stand star start state stay step still stone stop store story street strong study such sudden sugar summer sun sure sweet swim '
  + 'table take talk tall taste teach team tell ten than thank that the their them then there these they thing think third this those though thought three through throw thus time to today together told tomorrow tonight too took top touch toward town tree trip trouble true try turn twice two '
  + 'under until up upon us use usual '
  + 'very view visit voice '
  + 'wait walk wall want war warm was wash watch water way we wear week well went were west what when where whether which while white who whole why wide wife will win wind window wine winter wish with within without woman women word work world would write wrong '
  + 'yard year yes yet you young your').split(' '));

function isCommonWord(word) {
  return COMMON_WORDS.has(String(word || '').toLowerCase());
}

// Collapse a string to the consonant skeleton of how it sounds. Vowels carry
// almost no information once Whisper has guessed wrong, so they are dropped; a
// leading vowel survives as a single "A" so "Aishwarya" and "shwarya" do not
// collide. Digraph handling is tuned for romanised Indian names: the aspirated
// pairs (bh dh gh jh kh ph th) are exactly what an English-forced decoder
// flattens, so they fold onto their unaspirated consonant.
function phoneticCode(input) {
  const s = String(input || '').toLowerCase().replace(/[^a-z]+/g, '');
  if (!s) return '';

  const out = [];
  const push = (code) => {
    if (!code) return;
    if (out.length && out[out.length - 1] === code) return;
    out.push(code);
  };

  let i = 0;
  if (VOWELS.has(s[0])) {
    push('A');
    while (i < s.length && VOWELS.has(s[i])) i += 1;
  }

  for (; i < s.length; i += 1) {
    const c = s[i];
    const next = s[i + 1] || '';
    const after = s[i + 2] || '';

    if (VOWELS.has(c)) continue;

    if (c === 'c' && next === 'h' && after === 'h') { push('C'); i += 2; continue; }
    if (c === 's' && next === 'c' && after === 'h') { push('S'); push('K'); i += 2; continue; }
    if (next === 'h') {
      if (c === 'c') { push('C'); i += 1; continue; }
      if (c === 's') { push('S'); i += 1; continue; }
      if (c === 'p') { push('F'); i += 1; continue; }
      if (c === 'b') { push('B'); i += 1; continue; }
      if (c === 'd') { push('D'); i += 1; continue; }
      if (c === 'g') { push('G'); i += 1; continue; }
      if (c === 'j') { push('J'); i += 1; continue; }
      if (c === 'k') { push('K'); i += 1; continue; }
      if (c === 't') { push('T'); i += 1; continue; }
    }
    if (c === 'c' && next === 'k') { push('K'); i += 1; continue; }
    if (c === 'q' && next === 'u') { push('K'); i += 1; continue; }

    if (c === 'x') { push('K'); push('S'); continue; }
    if (c === 'q') { push('K'); continue; }
    if (c === 'c') { push(next === 'e' || next === 'i' || next === 'y' ? 'S' : 'K'); continue; }
    if (c === 'w' || c === 'v') { push('V'); continue; }
    if (c === 'z') { push('S'); continue; }
    if (c === 'y') { push(i === 0 ? 'Y' : ''); continue; }
    if (c === 'h') { push(i === 0 ? 'H' : ''); continue; }
    push(c.toUpperCase());
  }

  return out.join('');
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

function sharedPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

// A name Whisper mangled is still recognisable as a name: capitalised, and not
// a word English already owns. Acronyms and terms carrying digits count too.
function looksLikeProperNoun(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (token.length < 2) continue;
    if (isCommonWord(token)) continue;
    if (/[0-9]/.test(token)) return true;
    if (/^[A-Z]/.test(token)) return true;
    if (/[A-Z]/.test(token.slice(1))) return true;
  }
  return false;
}

// --- variant generation -------------------------------------------------
//
// One correction should not have to be repeated for every way Whisper can
// mishear the same name. These rewrite rules run over the canonical spelling
// to produce the neighbourhood it is likely to arrive as. Each is a single
// substitution applied to the whole term; splits are layered on top, which is
// what turns "Subhrajit" into "sub rajit".

const SOUND_SWAPS = [
  [/chh/g, 'ch'],
  [/bh/g, 'b'], [/dh/g, 'd'], [/gh/g, 'g'], [/jh/g, 'j'],
  [/kh/g, 'k'], [/ph/g, 'f'], [/th/g, 't'],
  [/v/g, 'w'], [/w/g, 'v'],
  [/sh/g, 's'],
  [/ee/g, 'i'], [/ie/g, 'ee'], [/oo/g, 'u'], [/aa/g, 'a'],
  [/y$/g, 'i'], [/i$/g, 'y'], [/a$/g, 'ah'],
  [/j/g, 'z'], [/z/g, 'j'],
  [/ck/g, 'k'], [/k/g, 'c'],
];

// Consonant clusters a syllable can actually start with — English onsets plus
// the aspirated and glide clusters that romanised Indian names rely on. A
// split that leaves the second half starting with anything else ("hi|ggsfield")
// is not a word the decoder would ever produce, so it is not worth a rule.
const ONSETS = new Set(('bh bl br by ch chh cl cr dh dr dv dw dy fl fr gh gl gn gr gy jh jy kh kl kn kr ky '
  + 'ly my ny ph pl pn pr ps py qu ry sc sch scr sh shr sk sl sm sn sp spl spr sq squ st str sv sw sy '
  + 'th thr tr tw ty vr vy wh wr').split(' '));

function hasValidOnset(part) {
  const m = /^[^aeiou]+/.exec(String(part || '').toLowerCase());
  if (!m) return true;
  const cluster = m[0];
  if (cluster.length === 1) return true;
  return ONSETS.has(cluster);
}

function hasVowel(s) {
  for (const ch of String(s || '').toLowerCase()) {
    if (VOWELS.has(ch)) return true;
  }
  return false;
}

// Split a single word at syllable boundaries. Two shapes count: the open
// syllable V|CV ("su|brajit") and the closed syllable VC|CV ("sub|rajit"),
// which is the one an English decoder reaches for most often. Both halves must
// be pronounceable alone — the same test Whisper implicitly applies when it
// breaks an unknown name into two English-shaped words.
function syllableSplits(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 5) return [];
  const out = [];
  for (let i = 2; i <= w.length - 2; i += 1) {
    if (VOWELS.has(w[i])) continue;
    const openSyllable = VOWELS.has(w[i - 1]);
    const closedSyllable = !openSyllable && VOWELS.has(w[i - 2] || '');
    if (!openSyllable && !closedSyllable) continue;
    const left = w.slice(0, i);
    const right = w.slice(i);
    if (left.length < 2 || right.length < 2) continue;
    if (!hasVowel(left) || !hasVowel(right)) continue;
    if (!hasValidOnset(right)) continue;
    out.push(left + ' ' + right);
  }
  return out;
}

function normalizeVariant(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A generated variant becomes a live find-and-replace rule, so anything that
// could fire on ordinary speech has to be thrown away here.
function isSafeVariant(variant, canonical) {
  const v = normalizeVariant(variant);
  if (!v) return false;
  if (v === normalizeVariant(canonical)) return false;
  if (!/^[a-z0-9](?:.*[a-z0-9])?$/.test(v)) return false;

  const parts = v.split(' ');
  if (parts.length === 1) {
    if (v.length < 4) return false;
    return !isCommonWord(v);
  }
  if (parts.some((p) => p.length < 2)) return false;
  return !parts.every((p) => isCommonWord(p));
}

function generateVariants(canonical, limit) {
  const cap = Math.max(0, Number(limit) || 12);
  if (!cap) return [];
  const base = String(canonical || '').trim();
  if (base.length < 4) return [];
  if (!/^[A-Za-z][A-Za-z0-9 '-]*$/.test(base)) return [];

  const normalized = normalizeVariant(base);
  const words = normalized.split(' ');
  const seen = new Set([normalized]);
  const out = [];

  const consider = (candidate) => {
    const v = normalizeVariant(candidate);
    if (seen.has(v)) return;
    seen.add(v);
    if (!isSafeVariant(v, base)) return;
    if (out.length < cap) out.push(v);
  };

  // Sound-level rewrites of the whole term.
  const soundAlikes = [normalized];
  for (const [pattern, replacement] of SOUND_SWAPS) {
    const swapped = normalized.replace(pattern, replacement);
    if (swapped !== normalized && !soundAlikes.includes(swapped)) {
      soundAlikes.push(swapped);
      consider(swapped);
    }
  }

  // Multi-word canonicals also get run together, which is how "Nano Banana"
  // comes back as "nanobanana".
  if (words.length > 1) consider(words.join(''));

  // Splits, layered over each sound-alike. A name Whisper cannot place is
  // usually returned as two English-shaped words rather than one unknown one.
  for (const form of soundAlikes) {
    const formWords = form.split(' ');
    for (let w = 0; w < formWords.length; w += 1) {
      for (const split of syllableSplits(formWords[w])) {
        const rebuilt = formWords.slice(0, w).concat(split, formWords.slice(w + 1)).join(' ');
        consider(rebuilt);
      }
    }
  }

  return out;
}

module.exports = {
  COMMON_WORDS,
  isCommonWord,
  phoneticCode,
  levenshtein,
  sharedPrefix,
  looksLikeProperNoun,
  generateVariants,
  syllableSplits,
  isSafeVariant,
};
