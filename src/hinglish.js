'use strict';

// Devanagari to the Latin letters people actually type Hindi in.
//
// Every speech model Voxden runs, local or cloud, hears a Hindi word and
// writes it in Hindi script. Someone dictating in English with Hindi mixed
// in ("aap kidhar se ho") does not want "आप किधर से हो" in a WhatsApp box.
// This turns the script back into the informal romanisation Hinglish uses:
// no diacritics, "aa" for the long a, "ee"/"oo" only where a speaker would
// stretch the vowel, and the silent schwa dropped where Hindi drops it.
//
// It is rule-based and will not match every person's spelling ("nahi" vs
// "nahin", "hun" vs "hoon"). The dictionary runs after it, so a spelling the
// user cares about can be pinned there like any other word.

const VOWELS = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};

const MATRAS = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};

const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // ड़ and ढ़ are written with a d in Hinglish: "thoda", "ladki", "padhna".
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y',
  'ळ': 'l',
};

// Words everybody spells one way, ahead of the rules. The rules would give
// "naheen" and "yah"; nobody types those.
const COMMON = {
  'नहीं': 'nahi', 'नही': 'nahi', 'यह': 'yeh', 'वह': 'woh', 'में': 'mein', 'मैं': 'main',
  'हूँ': 'hoon', 'हूं': 'hoon', 'क्यों': 'kyun', 'क्योंकि': 'kyunki', 'कोई': 'koi', 'भाई': 'bhai',
  'कुछ': 'kuch', 'बहुत': 'bahut', 'अच्छा': 'accha', 'अच्छी': 'acchi', 'अच्छे': 'acche',
  'ठीक': 'theek', 'हाँ': 'haan', 'हां': 'haan', 'जी': 'ji', 'और': 'aur', 'या': 'ya',
  'चाहिए': 'chahiye', 'चाहिये': 'chahiye', 'लिए': 'liye', 'गई': 'gayi', 'गए': 'gaye', 'हुआ': 'hua',
  'हुई': 'hui', 'हुए': 'hue', 'कर': 'kar', 'करो': 'karo', 'दो': 'do', 'तो': 'toh',
};

const VIRAMA = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const AVAGRAHA = 'ऽ';
const DEVANAGARI_RE = /[ऀ-ॿ]/;
const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function hasDevanagari(text) {
  return DEVANAGARI_RE.test(String(text || ''));
}

// One word of Devanagari into syllable pieces: each consonant with whether
// it carries an explicit vowel, a virama, or the inherent schwa.
function tokenize(word) {
  const chars = Array.from(word.normalize('NFC'));
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (ch === NUKTA || ch === AVAGRAHA) continue;
    if (chars[i + 1] === NUKTA && CONSONANTS[ch + NUKTA]) { ch = ch + NUKTA; i++; }
    if (CONSONANTS[ch]) {
      const piece = { c: CONSONANTS[ch], v: null, virama: false, nasal: '' };
      let j = i + 1;
      if (chars[j] === NUKTA) { j++; }
      if (MATRAS[chars[j]]) { piece.v = MATRAS[chars[j]]; j++; }
      else if (chars[j] === VIRAMA) { piece.virama = true; j++; }
      if (chars[j] === ANUSVARA || chars[j] === CHANDRABINDU) { piece.nasal = 'n'; j++; }
      if (chars[j] === VISARGA) { piece.nasal += 'h'; j++; }
      out.push(piece);
      i = j - 1;
    } else if (VOWELS[ch]) {
      const piece = { c: '', v: VOWELS[ch], virama: false, nasal: '' };
      let j = i + 1;
      if (chars[j] === ANUSVARA || chars[j] === CHANDRABINDU) { piece.nasal = 'n'; j++; }
      if (chars[j] === VISARGA) { piece.nasal += 'h'; j++; }
      out.push(piece);
      i = j - 1;
    } else if (DEVANAGARI_DIGITS.includes(ch)) {
      out.push({ c: '', v: String(DEVANAGARI_DIGITS.indexOf(ch)), virama: false, nasal: '', literal: true });
    } else if (ch === '।' || ch === '॥') {
      out.push({ c: '', v: '.', virama: false, nasal: '', literal: true });
    } else {
      out.push({ c: '', v: ch, virama: false, nasal: '', literal: true });
    }
  }
  return out;
}

// Which consonants keep their inherent "a". Hindi drops the schwa at the end
// of a word and in the middle when the letters around it can carry the
// syllable: "karna" not "karanaa", but "samajh" not "samjh". Applied right
// to left the way the standard schwa-deletion rule is stated: a schwa goes
// when the previous piece has a vowel and the next one has one too.
function romanizeWord(word) {
  const bare = word.normalize('NFC');
  if (COMMON[bare]) return COMMON[bare];
  const pieces = tokenize(bare);
  const keepSchwa = pieces.map(() => true);
  const hasVowel = (p) => p && (p.v !== null || p.literal);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    if (p.literal || !p.c || p.v !== null || p.virama) continue;
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    if (!next) { keepSchwa[i] = false; continue; }
    const prevVoiced = prev && (hasVowel(prev) || (prev.c && keepSchwa[i - 1] !== false && !prev.virama));
    const nextVoiced = next && (hasVowel(next) || (next.c && keepSchwa[i + 1]));
    if (prev && prevVoiced && nextVoiced && !next.virama) keepSchwa[i] = false;
  }
  let out = '';
  pieces.forEach((p, i) => {
    if (p.literal) { out += p.v; return; }
    // Two vowels meeting get the glide a speaker puts between them:
    // "aaiye" (आइए), "sreeya", "gayi".
    if (!p.c && p.v !== null && /(i|ee|aa)$/.test(out) && /^[ae]/.test(p.v)) out += 'y';
    out += p.c;
    if (p.v !== null) out += p.v === 'e' && p.nasal ? 'ei' : p.v;
    else if (!p.virama && keepSchwa[i]) out += 'a';
    out += p.nasal;
  });
  // Casual spellings: a long vowel at the end of a word is written short
  // ("karna", "gaya", "ki"), "aai" collapses ("bhai", "jaai" -> "jai"),
  // a nasal "oo" is "un" ("aaunga"), and the ch+chh cluster loses a ch
  // ("accha"). Word-initial "aa" stays ("aap").
  out = out.replace(/(.)aa$/, '$1a').replace(/(.)ee$/, '$1i')
    .replace(/aai$/, 'ai').replace(/oon(?=[a-z])/g, 'un').replace(/chchh/g, 'cch');
  return out;
}

// Romanise every Devanagari run in the text and leave everything else as it
// was. A word that mixes scripts is handled piece by piece.
function romanizeHindi(text) {
  const input = String(text || '');
  if (!hasDevanagari(input)) return input;
  // The danda is punctuation, not part of the word: "आता।" is "aata." and
  // the end-of-word spelling rules must see the word end at the त.
  return input
    .replace(/॥/g, '.').replace(/।/g, '.')
    .replace(/[ऀ-ॣ०-ॿ]+/g, (run) => romanizeWord(run));
}

module.exports = { romanizeHindi, romanizeWord, hasDevanagari };
