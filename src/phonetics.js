'use strict';

// Phonetic tooling for Voxden's correction dictionary.
//
// Whisper is pinned to English decoding (sidecar/transcribe.py), so an
// unfamiliar name never arrives as itself — it arrives as whatever English the
// decoder could assemble from the sounds. "Bhubaneswar" comes back as "bubba
// neshwar". The letters are far apart; the sounds are not. Everything here works
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
  + 'yard year yes yet you young your '
  // Added after an audit found generated spellings eating ordinary speech:
  // "cling" for Kling, "script" for ScriptUI, "hail" for Hailuo. A word only
  // has to be common enough that somebody says it without meaning the tool.
  + 'able across act actual add age ago agree air allow almost alone along already always amount animal answer appear apply area arm army art aside attack attempt author average avoid '
  + 'baby balance ball bank base basic bear beat beauty become begin behind believe below bench beside beyond bill bird blood blow blue board boat body bone book bore born borrow bother bottle bottom bowl branch brave bread breath bridge bright bring broad brother brown brush build burn bury business busy '
  + 'cake calm camp cancel candle cap capital captain card carry cart carve cast catch cause cell centre chain chance change charge chart chase cheap check cheer chest chief choice choose church circle claim class clean clear clerk clever climb cling clock cloth cloud club coast coat coffee coin cold collect colour column comfort common company compare complete concern condition connect consider contain continue control cook cool copy corn corner correct cost cotton count couple course court cover crack craft crash cream create cross crowd crown cry cure curious current curve custom '
  + 'damage dance danger dark date dead deal dear death debt decide deep defend degree delay deliver demand depend describe desert design desire desk destroy detail develop device dinner direct dirt discover discuss disease distance divide doctor double doubt dozen drag drama draw dream dress drift drive drop drum duck dust duty '
  + 'eager ear earn earth ease east easy edge educate effect effort either elect element else empty enemy energy engine enjoy enter entire equal error escape event exact examine example except exchange excite excuse exist expect expense experience explain express extend extra '
  + 'fail fair faith false fame farm fashion fat fault favour fear feather feed female fence fever field fight figure file fill film final finger finish firm fit fix flag flame flash flat flesh float flood floor flour flow flower fly fold follow force forest forget forgive fork form former forward frame fresh fruit fuel funny future '
  + 'gain garden gas gate gather general gentle gift glad glass goal goat gold govern grace grade grain grand grant grass grave gray great greet grey grind ground guard guess guest guide guilt gun '
  + 'habit hail hall hammer handle hang happen harbour harm harvest haste hat hate health heat heaven heavy hedge height hell hello hide hill hire history hit hole holiday hollow holy honest honour hook hope horn hospital host hotel human humour hunt hurry hurt '
  + 'ice ill image imagine import improve inch include increase indeed industry influence inform injure ink inner insect inside instead interest introduce invent invite iron island issue item '
  + 'jar jaw jewel joint joke journey joy judge juice jump justice '
  + 'keen kick kill kiss knee knife knock knot '
  + 'labour lack lake lamp language latter laughter layer lazy leaf lean leap lease leather lecture legal lend length lesson level liberty library lie lift limb limit link lip liquid literature load loaf loan local lock lodge lonely loose lord loss loud lower loyal luck lunch lung '
  + 'machine mad magazine magic mail major manner mark market marriage mass master match material matter meal measure medicine medium member memory mention merchant mercy mere message metal method middle mild mile military mill million mineral minister minor mint minute mirror mission mistake mix model modern modest moment monkey moon moral motion motor mountain mouse mud murder muscle mystery '
  + 'nail narrow nation native nature navy near neat neck needle neglect neighbour nerve nest net neutral noble noise none noon nor normal nose notice noun novel nurse nut '
  + 'oak obey object observe occasion occupy occur ocean odd offer office officer onion opinion oppose orange organ origin ought ounce outside oven owe owner '
  + 'pack pain paint pair palace pale palm pan panel parent park parliament partial particular partner path patient pattern pause peace peak pen pencil pepper perfect perform period permit person pet photograph physical piano pick picnic pig pile pilot pin pink pipe pity plain plane plant plastic plate pleasant pleasure plenty plough pocket poem poet police policy polish political pool popular port portion position positive possess post pot potato pound pour powder practice praise pray prefer prepare presence prevent previous price pride priest prince principle print prison private prize probable proceed process produce profit program progress promise proof proper propose protect proud prove provide public publish pump punish pupil purchase pure purple purpose pursue '
  + 'quality quantity quarter queen '
  + 'race radio rail raise range rank rapid rare rate rather raw ray reach react realize rear reason receive recent recognize record recover reduce refer reflect refuse regard region regret regular reject relate relief religion remain remark remedy remind remove rent repair repeat reply report represent republic reputation request require rescue research reserve resist resource respect respond responsible result retire reveal reverse review reward ribbon rid rifle rise risk rival roar roast rob rock rod roll roof root rope rose rough route row royal rub rubber rude rug ruin rule rush '
  + 'sack sad safe sail sake salary sale sand satisfy sauce scale scarce scatter scene scheme science score scrape scratch screen screw script sea seal search seed seek seize seldom select self senate senior sentence separate series serious servant settle severe sew shade shadow shake shame shape share sharp shed sheep sheet shelf shell shelter shift shine shirt shock shoot shore shoulder shout shower shut shy sick silence silk silver similar simple sin sing sink situation skill skin skirt slave slide slight slip slope slow smell smoke smooth snake soap social society soft soil soldier solid solve sorrow sort soul soup sour source spare spark speed spell spend spirit spite split spoil spoon sport spot spread spring square squeeze stable staff stage stain stair stamp stand standard steady steal steam steel stem stick stiff stir stock stomach storm stove straight strain strange stream strength stretch strike string strip stroke structure struggle stuff stupid subject submit substance succeed sudden suffer sufficient sugar suggest suit sum supper supply support suppose surface surprise surround suspect swear sweep swell swing sword symbol sympathy system '
  + 'tail tank tap task tax tea tear temper temple tend tender tent term terrible territory test text thick thief thin thread threat throat thumb thunder ticket tide tie tight timber tin tip tired title tobacco toe tone tongue tool tooth total tower track trade traffic train translate travel treasure treat tremble trial tribe trick troop tropical truck trust truth tube tune tunnel twist type '
  + 'ugly uncle unit universe unless unusual upper urge usual '
  + 'vain valley value variety various vast vegetable vehicle venture verse vessel victory village violent virtue visible vision volume vote voyage '
  + 'wage wagon waist wander want warn waste wave wax weak wealth weapon weather weave wedding weed weekend weigh weight welcome wet wheat wheel whip whisper whistle wicked wild willing wing wipe wire wise wit witness wonder wood wool worry worse worship worth wound wrap wreck wrist').split(' '));

function isCommonWord(word) {
  return COMMON_WORDS.has(String(word || '').toLowerCase());
}

// Collapse a string to the consonant skeleton of how it sounds. Vowels carry
// almost no information once Whisper has guessed wrong, so they are dropped; a
// leading vowel survives as a single "A" so "Aurangabad" and "rangabad" do not
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
// what turns "Bhubaneswar" into "bhu baneswar".

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
function looksLikeAcronym(token) {
  const t = String(token || '').toLowerCase();
  if (t.length < 2 || t.length > 4) return false;
  if (!/^[a-z]+$/.test(t)) return false;
  if (isCommonWord(t)) return false;
  const vowels = (t.match(/[aeiou]/g) || []).length;
  if (vowels === 0) return true;
  return t.length <= 3 && vowels <= 1;
}

const LETTER_NAMES = {
  a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef',
  g: 'gee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay', l: 'el',
  m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar',
  s: 'ess', t: 'tee', u: 'you', v: 'vee', w: 'doubleu',
  x: 'ex', y: 'why', z: 'zee',
};

function acronymForms(token, phraseHasMoreWords) {
  const t = String(token || '').toLowerCase();
  const letters = t.split('');
  const forms = [letters.join(' ')];
  if (letters.length >= 2) forms.push(letters.join('.'));
  const names = letters.map((ch) => LETTER_NAMES[ch]).filter(Boolean);
  if (names.length === letters.length) forms.push(names.join(' '));
  if (LETTER_NAMES[letters[0]] && t.length >= 3) {
    forms.push(LETTER_NAMES[letters[0]] + ' ' + t.slice(1));
  }
  // Whisper often hears a leading "n" as "and"/"an"/"end". Only keep those
  // on a longer phrase so "and pm" alone cannot eat ordinary speech.
  if (phraseHasMoreWords && letters[0] === 'n' && letters.length >= 2) {
    const rest = t.slice(1);
    forms.push('and ' + rest);
    forms.push('an ' + rest);
    forms.push('end ' + rest);
  }
  return forms;
}

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
  const short = parts.filter((p) => p.length < 2);
  if (short.length) {
    if (!short.every((p) => /^[a-z]$/.test(p))) return false;
    const canonHasAcronym = String(canonical || '').split(/\s+/).some(looksLikeAcronym);
    if (!canonHasAcronym) return false;
  }
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

  // Short jargon ("npm") comes back letter-by-letter or as "and PM".
  const moreThanOne = words.length > 1;
  words.forEach((w, idx) => {
    if (!looksLikeAcronym(w)) return;
    for (const form of acronymForms(w, moreThanOne)) {
      const rebuilt = words.slice(0, idx).concat([form], words.slice(idx + 1)).join(' ');
      consider(rebuilt);
    }
  });

  return out;
}

module.exports = {
  COMMON_WORDS,
  isCommonWord,
  phoneticCode,
  levenshtein,
  sharedPrefix,
  looksLikeProperNoun,
  looksLikeAcronym,
  generateVariants,
  syllableSplits,
  isSafeVariant,
};
