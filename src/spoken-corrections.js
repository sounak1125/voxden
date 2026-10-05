'use strict';

// Spoken corrections: "the cat is running on the field, no, no, in the park"
// pastes "the cat is running in the park".
//
// Someone who corrects themselves mid-sentence says the wrong words, a cue
// ("no", "sorry", "I mean", "wait", "actually", "make that", "or rather"),
// then the right words. This takes out the wrong words and the cue and keeps
// everything else. It is an opt-in setting (settings.spokenCorrections) and
// never runs in Verbatim mode.
//
// The cue words mostly mean something else. Replayed over 770 real
// dictations on 2026-10-05 they were "No, no" said to the listener, "Sorry,
// my bad", "I mean, see", "what I mean?" and "actually" for emphasis -- and a
// looser first version of these rules changed three of them, every one
// wrongly. So the rules are narrow, and a correction is made only when it is
// plain:
//
//  - It only takes words out. It never adds or rewrites one; the single
//    exception moves a unit back beside the corrected number ("3 pm, no, 4"
//    is "4 pm"), and that word was said too.
//  - The cue is set off by punctuation, so "he said no to the plan" is
//    never a correction, and a question ("no?", "what I mean?") never is.
//  - The new words start the way the old ones did: a number for a number, a
//    name for a name, a place ("in the park") for a place, "the ..." for
//    "the ...", a colour for a colour, or the same verb again ("test the
//    build, no, test the installer").
//  - The new words are about as long as the old ones, and anything said
//    after them starts like the rest of a sentence would (a preposition,
//    "and", "please"). "Monday, actually, Tuesday works better" is a new
//    thought, not a swap, and stays as said.
//  - A new clause is not a correction: "put it in the box, no, the box is
//    full" keeps every word.
//
// A whole statement can be taken back too, the way people mostly do it:
// "And push to main. No, no, don't push to main." That needs the new
// statement to repeat the old one's action word ("push") after "no" or
// "wait"; "No, it shouldn't be like that" repeats nothing and stays. The old
// statement must not be a question or about "you", and the new one must not
// add to it ("... too") or point back at it ("use it").
//
// Anything less clear is left exactly as it was said: a missed correction
// costs the user one edit, a wrong one costs them words they meant.

const CUES = [
  ['no', 'no', 'no'],
  ['no', 'no'],
  ['no', 'wait'],
  ['wait', 'no'],
  ['i', 'meant'],
  ['i', 'mean'],
  ['or', 'rather'],
  ['make', 'that'],
  ['no'],
  ['sorry'],
  ['wait'],
  ['actually'],
  ['correction'],
];

// Which kinds of words each cue may swap. "Sorry" is an apology as often as
// a correction, and "I mean" an explanation, so they swap only words that
// cannot be anything but a correction: "Rahul, sorry, Rohit"; "10, I mean 15".
const ALL_KINDS = new Set(['num', 'name', 'prep', 'det', 'color', 'word']);
const CUE_KINDS = {
  sorry: new Set(['num', 'name', 'color']),
  'i mean': new Set(['num', 'name', 'prep', 'color']),
  'i meant': new Set(['num', 'name', 'prep', 'color']),
};

const PREP = new Set(('in on at to for from with into onto by under over near inside outside after before until '
  + 'till across behind beside around through toward towards between of off').split(' '));
const DET = new Set('the a an this that these those my your our his her their its'.split(' '));
const COLOR = new Set(('red blue green yellow black white orange purple pink grey gray brown gold silver '
  + 'beige navy teal').split(' '));
const CONJ = new Set('and or but so then because'.split(' '));
// What may follow the new words without them being a new thought.
const CONTINUES = new Set([...PREP, ...CONJ, 'please', 'too', 'as', 'instead', 'today', 'tomorrow', 'tonight', 'now']);
const NUMWORD = new RegExp('^(?:\\d[\\d:.,]*(?:am|pm|st|nd|rd|th|k|m|%)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|'
  + 'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|'
  + 'seventy|eighty|ninety|hundred|thousand|million|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|'
  + 'eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|'
  + 'thirtieth|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|'
  + 'august|september|october|november|december)$', 'i');
// A unit may follow a corrected number: "10, I mean 15 seconds".
const UNITS = new Set(('second seconds minute minutes min mins hour hours hr hrs day days week weeks month months '
  + 'year years am pm percent dollar dollars rupee rupees euro euros pound pounds cent cents bucks k people '
  + 'person kid kids time times item items page pages word words credit credits mb gb tb kb km miles mile meters '
  + 'metre metres meter kg grams gram pieces piece copies copy tickets ticket slides slide steps step').split(' '));
// Words that make the new words a clause of their own.
const AUX = new Set(('is are was were be been am will would can could should shall might must has have had do does '
  + "did isn't aren't wasn't weren't won't wouldn't can't cannot couldn't shouldn't hasn't haven't hadn't don't "
  + "doesn't didn't it's that's there's here's he's she's what's who's i'm you're we're they're i'll you'll we'll "
  + "they'll he'll she'll it'll").split(' '));
// A repeated word lines two phrases up only when it carries meaning.
const PLAIN = new Set(('this that with from have will just like what when then there they them your yours mine '
  + 'about would could should also very really actually maybe some just than into onto here were been does done '
  + 'make made know think want need going gonna wanna well okay yeah sure').split(' '));
const FILLERS = new Set('um umm uh uhh uhm er erm hmm hm ah eh mm'.split(' '));
// After these, "sorry" is an apology and "no" an answer.
const NOT_A_CORRECTION_AFTER = {
  sorry: new Set('for about to that but i we if my again'.split(' ')),
  no: new Set('but i we that if my again thanks worries problem'.split(' ')),
};

// Taking back a whole statement and saying it again (restatement below) is
// what "no" and "wait" do. "Actually", "sorry" and "I mean" as often add to
// a statement as take it back ("I love this design. Actually, I love the
// colours"), so they never remove one.
const RESTATE_CUES = new Set(['no no no', 'no no', 'no', 'no wait', 'wait no', 'wait', 'or rather', 'correction']);
const PRONOUNS = "i we he she they it i'll we'll he'll she'll they'll i'd we'd they'd let's lets".split(' ');
const NEGATIONS = "don't dont not never didn't doesn't won't shouldn't can't cannot".split(' ');
// What may come before an action word: who does it, will or can, not.
const LEADS = new Set([...PRONOUNS, ...AUX, ...NEGATIONS, 'please', 'just', 'to']);
const YOU = new Set("you your yours you're you've you'll you'd".split(' '));
// "No, but ...", "no, thanks": an answer however the rest goes.
const NEVER_RESTATES = new Set('but if thanks worries problem again'.split(' '));
// A new statement with these adds to the old one rather than replacing it:
// "It works on Windows. No, no, it works on Mac too."
const ADDS = new Set('too also both either again another more additionally'.split(' '));
// A new statement that points back with these needs the old one: "Use the
// blue button. No, no, use it for the header."
const POINTS_BACK = new Set('it them this that these those him her there'.split(' '));
const MAX_RESTATED = 12;

const MAX_SPAN = 6;
const MAX_PASSES = 4;

const bare = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
const endsSentence = (w) => /[.?!]["')\]]*$/.test(w);
const endsClause = (w) => /[,.;:?!]["')\]]*$/.test(w);
const isQuestion = (w) => /\?["')\]]*$/.test(w);
const setOff = (w) => /[,.;:!?—–-]["')\]]*$/.test(w) || /^[—–-]+$/.test(w);

function tokenize(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  let start = true;
  while ((m = re.exec(text))) {
    out.push({ w: m[0], b: bare(m[0]), at: m.index, end: m.index + m[0].length, start });
    start = endsSentence(m[0]);
  }
  return out;
}

function kindOf(tok) {
  const b = tok.b;
  if (!b) return null;
  if (NUMWORD.test(b)) return 'num';
  if (PREP.has(b)) return 'prep';
  if (DET.has(b)) return 'det';
  if (COLOR.has(b)) return 'color';
  const core = tok.w.replace(/^[^\p{L}\p{N}]+/u, '');
  if (!tok.start && b !== 'i' && !b.startsWith("i'") && /^\p{Lu}/u.test(core)) return 'name';
  return null;
}

function matchCue(toks, i) {
  for (const words of CUES) {
    if (i + words.length > toks.length) continue;
    let ok = true;
    for (let k = 0; k < words.length; k++) {
      if (toks[i + k].b !== words[k]) { ok = false; break; }
    }
    if (ok) return words;
  }
  return null;
}

const skippable = (tok) => !tok.b || FILLERS.has(tok.b);

function capitalizeFirst(s) {
  return s.replace(/^(\P{L}*)(\p{L})/u, (_, lead, ch) => lead + ch.toUpperCase());
}
function lowercaseFirst(s) {
  return s.replace(/^(\P{L}*)(\p{L})/u, (_, lead, ch) => lead + ch.toLowerCase());
}

// A phrase swapped for one like it: "on the field, no, in the park",
// "3, no, 4", "Rahul, sorry, Rohit". The edit, or null.
function phraseSwap(text, toks, i, r, cueName) {
  const first = toks[r];
  const allowed = CUE_KINDS[cueName] || ALL_KINDS;
  const firstKind = kindOf(first);
  const kind = firstKind && allowed.has(firstKind) ? firstKind : null;
  const cueStartsSentence = toks[i].start;
  const sameWord = !kind && !cueStartsSentence && allowed.has('word')
    && first.b.length >= 4 && !PLAIN.has(first.b) ? first.b : null;
  if (!kind && !sameWord) return null;

  // The old words: back from the cue to the nearest one that starts the way
  // the new ones do, within the sentence (or the one the cue just ended).
  let found = -1;
  for (let j = i - 1, steps = 0; j >= 0 && steps < MAX_SPAN + 2; j--, steps++) {
    if (j < i - 1 && endsSentence(toks[j].w)) break;
    if (sameWord ? toks[j].b === sameWord : kindOf(toks[j]) === kind) { found = j; break; }
  }
  if (found < 0) return null;
  {
    const spanToks = toks.slice(found, i);
    const spanWords = spanToks.filter(t => !skippable(t)).map(t => t.b);
    if (!spanWords.length || spanWords.length > MAX_SPAN) return null;

    // The new words: up to the next comma or full stop.
    const repair = [];
    for (let q = r; q < toks.length; q++) {
      if (!skippable(toks[q])) repair.push(toks[q]);
      if (endsClause(toks[q].w)) break;
    }
    const repairWords = repair.map(t => t.b);
    const L = spanWords.length;
    // Said again the same way, it is a repeat, not a fix.
    if (repairWords.slice(0, L).join(' ') === spanWords.join(' ')) return null;
    // A new clause ("no, the box is full") is a new thought.
    if (repairWords.some(w => AUX.has(w) && !spanWords.includes(w))) return null;
    // From the start of a new sentence, only a short fragment corrects the
    // sentence before ("... the field. No, no, in the park.").
    if (cueStartsSentence) {
      let e = r;
      while (e < toks.length && !endsSentence(toks[e].w)) e++;
      if (e - r + 1 > 5) return null;
    }

    let unitMove = null;
    if (kind === 'prep') {
      // A place for a place: the new phrase runs to the next preposition or
      // "and", whatever its length, and the rest carries on.
    } else {
      const continuation = repairWords.slice(L);
      const continues = !continuation.length || CONTINUES.has(continuation[0])
        || (kind === 'num' && UNITS.has(continuation[0])
          && (continuation.length === 1 || CONTINUES.has(continuation[1])));
      if (repairWords.length >= L && continues) {
        // Swapped like for like.
      } else if (kind === 'num' && L <= 3 && NUMWORD.test(spanWords[0])
        && !spanWords.slice(1).some(w => NUMWORD.test(w))
        && (repairWords.length === 1 || CONTINUES.has(repairWords[1]))) {
        // "3 pm, no, 4" and "two coffees, make that three": the number is
        // swapped and its unit, said once, stays with it.
        unitMove = spanToks.slice(1).filter(t => !skippable(t));
      } else {
        return null;
      }
    }

    const before = text.slice(0, spanToks[0].at);
    let rest = text.slice(first.at);
    if (unitMove) {
      const lead = first.w.match(/^(.*?)([,.;:!?"')\]]*)$/);
      const unit = unitMove.map(t => t.w).join(' ').replace(/[,.;:!?—–-]+$/, '');
      rest = lead[1] + ' ' + unit + lead[2] + text.slice(first.end);
    }
    if (spanToks[0].start) rest = capitalizeFirst(rest);
    else if (first.start && kind !== 'name' && kind !== 'num') rest = lowercaseFirst(rest);
    return {
      text: before + rest,
      removed: text.slice(spanToks[0].at, first.at).trim(),
    };
  }
}

// Whether the word at k starts what someone does: the start of a sentence,
// or after a comma, "and", "I", "will", "don't", "to".
function opensStatement(toks, k) {
  if (k === 0 || toks[k].start) return true;
  const prev = toks[k - 1];
  return endsClause(prev.w) || CONJ.has(prev.b) || LEADS.has(prev.b);
}

const sameSaying = (a, b) => a.map(t => t.b).filter(Boolean).join(' ') === b.map(t => t.b).filter(Boolean).join(' ');

// A statement taken back and said again: "And push to main. No, no, don't
// push to main." The new statement repeats the old one's action word
// ("push"), which is what makes it a correction rather than an answer: "No,
// it shouldn't be like that" repeats nothing. The old statement goes, the new
// one stays. Never for one that was a question or about "you" -- that is
// talking to someone, not taking words back.
function restatement(text, toks, i, r) {
  // The new statement's action word, after at most three of "I", "will",
  // "don't" and the like.
  const leads = [];
  let m = r;
  while (m < toks.length && leads.length < 3 && (LEADS.has(toks[m].b) || skippable(toks[m]))) {
    if (endsClause(toks[m].w)) return null;
    if (!skippable(toks[m])) leads.push(toks[m].b);
    m++;
  }
  if (m >= toks.length) return null;
  const action = toks[m];
  if (action.b.length < 3 || LEADS.has(action.b) || PREP.has(action.b) || DET.has(action.b)
    || CONJ.has(action.b) || NUMWORD.test(action.b)) return null;

  // Where the new statement ends: its full stop, or within a sentence its comma.
  const cueStartsSentence = toks[i].start;
  let e = r;
  let words = 0;
  for (; e < toks.length; e++) {
    if (!skippable(toks[e])) words++;
    if (cueStartsSentence ? endsSentence(toks[e].w) : endsClause(toks[e].w)) break;
  }
  if (e >= toks.length) e = toks.length - 1;
  if (words > MAX_RESTATED || m > e || isQuestion(toks[e].w)) return null;
  const restated = toks.slice(r, e + 1);

  let start = -1;
  if (cueStartsSentence) {
    // The whole sentence before goes.
    let s = i - 1;
    while (s > 0 && !endsSentence(toks[s - 1].w)) s--;
    const said = toks.slice(s, i);
    if (said.length > MAX_RESTATED || isQuestion(toks[i - 1].w)) return null;
    if (!said.some((t, n) => t.b === action.b && opensStatement(toks, s + n))) return null;
    start = s;
  } else {
    for (let j = i - 1, steps = 0; j >= 0 && steps < MAX_RESTATED; j--, steps++) {
      if (j < i - 1 && endsSentence(toks[j].w)) break;
      if (toks[j].b !== action.b || !opensStatement(toks, j)) continue;
      // "I want to send it, no, I want to share it": the "I" goes too.
      let s = j;
      for (let p = leads.length - 1; p >= 0 && s > 0 && toks[s - 1].b === leads[p]
        && !endsSentence(toks[s - 1].w); p--) s--;
      start = s;
      break;
    }
    if (start < 0) return null;
  }
  const said = toks.slice(start, i);
  if (said.some(t => YOU.has(t.b))) return null;
  if (sameSaying(said, restated)) return null;
  const saidWords = new Set(said.map(t => t.b));
  const afterAction = toks.slice(m + 1, e + 1).map(t => t.b);
  if (afterAction.some(w => ADDS.has(w))) return null;
  if (afterAction.some(w => POINTS_BACK.has(w) && !saidWords.has(w))) return null;
  const before = text.slice(0, toks[start].at);
  let rest = text.slice(toks[r].at);
  if (toks[start].start) rest = capitalizeFirst(rest);
  return {
    text: before + rest,
    removed: text.slice(toks[start].at, toks[r].at).trim(),
  };
}

// One correction, the first plain one in the text, or null.
function correctOnce(text) {
  const toks = tokenize(text);
  for (let i = 1; i < toks.length; i++) {
    const cue = matchCue(toks, i);
    if (!cue) continue;
    const cueName = cue.join(' ');
    const cueEnd = i + cue.length;
    // A question is never a correction: "add those, no?", "what I mean?"
    if (isQuestion(toks[cueEnd - 1].w)) continue;
    let r = cueEnd;
    while (r < toks.length && skippable(toks[r])) r++;
    if (r >= toks.length) continue;
    // The cue has to interrupt: punctuation before it or after it.
    if (!setOff(toks[i - 1].w) && !setOff(toks[r - 1].w)) continue;
    // "No, I ..." is usually an answer, so it never swaps a phrase; it can
    // still take back a statement it repeats ("I want pizza. No, I want
    // pasta."), which an answer does not.
    const answer = NOT_A_CORRECTION_AFTER[cueName] && NOT_A_CORRECTION_AFTER[cueName].has(toks[r].b);
    const edit = (answer ? null : phraseSwap(text, toks, i, r, cueName))
      || (RESTATE_CUES.has(cueName) && !NEVER_RESTATES.has(toks[r].b) ? restatement(text, toks, i, r) : null);
    if (edit) return edit;
  }
  return null;
}

// --- A model's edit, checked -------------------------------------------------
// Speech takes back words in more shapes than rules can know ("walk into the
// field. Uh. No, no, not in the field. Put it in the water."), so with Voxden
// Cloud a text model is asked to take out what the speaker took back (server
// /v1/corrections). Its answer is only used when it did nothing else: every
// word it kept was said, in order, and every run of words it dropped is one of
//  - filler sounds ("uh"),
//  - a word said twice in a row ("in, uh, in"),
//  - words taken back: at least one word, then the cue ("no", "sorry",
//    "wait", "I mean"...), then at most a short echo ("not in the field").
// Words taken back may not be a question or about "you" -- that is talking to
// someone -- and not more than 25 of them go at once. Anything else and the
// whole answer is dropped, and the rules above have their turn.

const MODEL_CUES = new Set('no nope nah sorry wait actually mean meant scratch rather instead correction oops'.split(' '));
// Words too common to show that an echo repeats what was taken back.
const FUNCTION_WORDS = new Set([...PREP, ...DET, ...CONJ, ...PRONOUNS, ...AUX, ...NEGATIONS, 'not', 'yes', 'yeah', 'okay', 'just', 'like']);
const MAX_TAKEN_BACK = 25;
const MAX_ECHO = 8;

function wordTokens(text) {
  return tokenize(String(text || '').replace(/[‘’]/g, "'")).filter(t => t.b);
}

// Which of the words said were kept, matching each kept word to the first one
// said that fits (or, from the end, the last), or null when a kept word was
// never said in that order.
function matchKept(said, kept, fromEnd) {
  const keep = new Array(said.length).fill(false);
  if (fromEnd) {
    let k = kept.length - 1;
    for (let s = said.length - 1; s >= 0 && k >= 0; s--) {
      if (said[s].b === kept[k].b) { keep[s] = true; k--; }
    }
    return k < 0 ? keep : null;
  }
  let k = 0;
  for (let s = 0; s < said.length && k < kept.length; s++) {
    if (said[s].b === kept[k].b) { keep[s] = true; k++; }
  }
  return k === kept.length ? keep : null;
}

// The model's edit as { text, removed }, or null when it did anything but
// take out words the speaker took back. "Ship it today. No, no, ship it
// tomorrow." keeps the second "ship it", so the words are matched from the
// end as well as from the start, and either reading may show the edit is
// sound: the text is the same both ways.
function checkModelEdit(input, output) {
  const said = wordTokens(input);
  const kept = wordTokens(output);
  if (!said.length || !kept.length || kept.length >= said.length) return null;
  for (const fromEnd of [false, true]) {
    const keep = matchKept(said, kept, fromEnd);
    const removed = keep && takenBackRuns(input, said, keep);
    if (removed) return { text: String(output).trim(), removed };
  }
  return null;
}

// What each run of dropped words was, or null when one of them is not filler,
// a word said twice, or words taken back with their cue.
function takenBackRuns(input, said, keep) {
  const removed = [];
  for (let s = 0; s < said.length;) {
    if (keep[s]) { s++; continue; }
    let e = s;
    while (e < said.length && !keep[e]) e++;
    const run = said.slice(s, e);
    const words = run.filter(t => !FILLERS.has(t.b));
    if (words.length) {
      const before = said.slice(Math.max(0, s - words.length), s).map(t => t.b).join(' ');
      const after = said.slice(e, e + words.length).map(t => t.b).join(' ');
      const runWords = words.map(t => t.b).join(' ');
      const repeat = keep[s - 1] && before === runWords || keep[e] && after === runWords;
      if (!repeat) {
        const cueAt = words.findIndex(t => MODEL_CUES.has(t.b));
        if (cueAt < 1) return null;
        let lastCue = cueAt;
        words.forEach((t, n) => { if (MODEL_CUES.has(t.b)) lastCue = n; });
        const takenBack = words.slice(0, cueAt);
        const echo = words.slice(lastCue + 1);
        if (takenBack.length > MAX_TAKEN_BACK || echo.length > MAX_ECHO) return null;
        if (takenBack.some(t => YOU.has(t.b)) || isQuestion(takenBack[takenBack.length - 1].w)) return null;
        // A stutter before the cue ("I, I sorry, I really didn't know") takes
        // nothing back; dropping it would only drop the "sorry".
        const next = said.slice(e).find(t => !FILLERS.has(t.b));
        if (next && takenBack.every(t => t.b === next.b)) return null;
        // "Not different colour, I mean the accent colour": what it takes back
        // was said before the "not", and is still there.
        if (takenBack[0].b === 'not') return null;
        const meant = new Set(takenBack.map(t => t.b).filter(b => b.length > 2 && !FUNCTION_WORDS.has(b)));
        // An echo repeats what was taken back ("not in the field") and ends
        // where a phrase ends; anything else is the start of the new words
        // ("No, no, don't push to | main" or "3, no, 4 | tomorrow").
        if (echo.length) {
          if (!echo.some(t => meant.has(t.b)) || !endsClause(echo[echo.length - 1].w)) return null;
        }
        // New words have to follow, and they have to answer what was taken
        // back: say a word of it again ("push to main. No, no, don't push"),
        // or put the same kind of thing in its place ("3, no, 4"; "Rahul,
        // sorry, Rohit"; "on the field, no, in the park"). A "no" at the end, a
        // restart ("they obviously, no, doesn't know") or a new idea ("it
        // should change. No. Or maybe remove it") takes nothing back.
        const after = [];
        for (let a = e; a < said.length && after.length < 12; a++) {
          if (keep[a] && !FILLERS.has(said[a].b)) after.push(said[a]);
        }
        if (!after.length) return null;
        const firstKind = kindOf(takenBack[0]);
        const sameKind = !!firstKind && kindOf(after[0]) === firstKind;
        if (!sameKind && !echo.some(t => meant.has(t.b)) && !after.some(t => meant.has(t.b))) return null;
        removed.push(input.slice(run[0].at, run[run.length - 1].end).trim());
      }
    }
    s = e;
  }
  return removed.length ? removed : null;
}

// The text with each named piece taken out, in order, or null when a piece is
// not where the text says it should be. The seams are tidied: one space, and
// a capital where a piece took a sentence's first words.
function removePieces(text, pieces) {
  let out = String(text || '');
  let from = 0;
  for (const piece of pieces || []) {
    const p = String(piece || '').trim();
    if (!p) continue;
    let at = out.indexOf(p, from);
    if (at < 0) at = out.toLowerCase().indexOf(p.toLowerCase(), from);
    if (at < 0) return null;
    const startsSentence = at === 0 || /[.?!]["')\]]*\s*$/.test(out.slice(0, at));
    let rest = out.slice(at + p.length).replace(/^\s+/, '');
    if (startsSentence) rest = capitalizeFirst(rest);
    const head = out.slice(0, at).replace(/\s+$/, '');
    // "ton my | . He has a car" joins as "ton my. He has a car".
    out = head + (head && !/^[,.;:!?]/.test(rest) ? ' ' : '') + rest;
    from = head.length;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/([,.;:!?])\1+/g, '$1').trim();
}

// Whether a dictation is worth asking the model about at all: it has a cue
// with words before it. Most dictations have none, and send nothing.
function mayTakeBack(text) {
  const toks = wordTokens(text);
  return toks.some((t, n) => n > 0 && MODEL_CUES.has(t.b) && (t.b !== 'mean' && t.b !== 'meant' || toks[n - 1].b === 'i'));
}

// Every plain correction in the text, in order. `removed` lists what was
// taken out, for the history entry; an unchanged text has none.
function applySpokenCorrections(text) {
  let out = String(text || '');
  const removed = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const step = correctOnce(out);
    if (!step) break;
    out = step.text;
    removed.push(step.removed);
  }
  return { text: out, removed };
}

module.exports = { applySpokenCorrections, checkModelEdit, mayTakeBack, removePieces };
