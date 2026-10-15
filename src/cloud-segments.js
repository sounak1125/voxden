'use strict';

// Split batch transcription audio at pauses while recording continues. This is
// deliberately conservative: uninterrupted speech keeps its full context, and
// every sample belongs to exactly one segment (including the final flush).
(function(root) {
  // A segment is transcribed on its own, so every cut costs the model the
  // words on the far side of it. That context is what lets it hear a name
  // like "Higgsfield" as one word; cut after "Higgs" and the first request
  // comes back with a broken word and the second with "field". The floor was
  // once 1.5 seconds with a 400ms pause, which sent most short dictations up
  // as two or three pieces and cut through any word the speaker slowed down
  // on; 8 seconds fixed that but left 3-6 seconds of speech to transcribe
  // after the user stopped.
  // Segments now start at 4 seconds and need a 700ms pause, a break between
  // thoughts rather than a breath inside a word: dictations under 4 seconds go
  // up whole, and longer ones still upload while the user talks. Measured on
  // 72 of the owner's clips on 2026-10-13: word error was 9.1%, 7.7% and 7.1%
  // at 1.5s, 4s and 8s (4s against 8s is within noise), and dictionary words
  // heard 23, 23 and 24 of 27 (4s lost one name at a cut). A model of real
  // response times puts 4s about 0.2s faster after stop than 8s on a normal
  // day and no faster on a slow one; a live check was inconclusive. Do not go
  // below 4s without an accuracy run on the owner's clips
  // (temp/speed-2026-10-12/segacc.js) and a live replay
  // (temp/speed-2026-10-12/replay.js). The cloud-request log line shows the
  // real wait.
  // Re-measured on 2026-10-15 for the two-lane relay (MAI transcribes the
  // pieces cut while the user talks, AssemblyAI the last piece and any MAI
  // piece still out at stop; temp/speed-2026-10-12/results/phase0-report.md):
  // 4s pieces scored 8.0% word error against 8.9% for production (every piece
  // on AssemblyAI). 3s and 2s pieces were faster after stop but lost accuracy
  // (2s: 9.7-9.8%) and left two to five times the stray full stops and
  // mid-sentence capitals at joins, so the owner kept 4s. The relay advertises
  // the sizes for the accounts it runs lanes for (main.js
  // cloudDictationConfig); every other recording uses the defaults below.
  // Someone reading aloud may never pause that long, so past 45 seconds a
  // 300ms pause is enough. Only at 240 seconds is a segment cut with no pause
  // at all: the relay refuses clips over five minutes, so one that long would
  // otherwise fail whole (joinCloudTexts rejoins a word the cut went through).
  // Match the 0.004 RMS used by the cloud upload speech gate. The previous
  // 0.012 boundary counted softer syllables as silence even though the upload
  // gate correctly considered them audible.
  function createCloudSegmenter({ sampleRate = 16000, silenceMs = 700,
    minSegmentMs = 4000, speechRms = 0.004, longSegmentMs = 45000,
    longSilenceMs = 300, maxSegmentMs = 240000 } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0
      || !Number.isFinite(silenceMs) || silenceMs <= 0
      || !Number.isFinite(minSegmentMs) || minSegmentMs < 0
      || !Number.isFinite(speechRms) || speechRms <= 0
      || !Number.isFinite(longSegmentMs) || longSegmentMs < minSegmentMs
      || !Number.isFinite(longSilenceMs) || longSilenceMs <= 0
      || !Number.isFinite(maxSegmentMs) || maxSegmentMs < longSegmentMs) {
      throw new RangeError('Cloud segmenter requires a positive sample rate, silence duration and speech RMS, and a nonnegative minimum duration.');
    }

    const frameSize = 256;
    const silenceSamples = Math.ceil(sampleRate * silenceMs / 1000);
    const minSegmentSamples = Math.ceil(sampleRate * minSegmentMs / 1000);
    const longSegmentSamples = Math.ceil(sampleRate * longSegmentMs / 1000);
    const longSilenceSamples = Math.ceil(sampleRate * longSilenceMs / 1000);
    const maxSegmentSamples = Math.ceil(sampleRate * maxSegmentMs / 1000);
    const speechEnergy = speechRms * speechRms;
    let chunks = [];
    let sampleCount = 0;
    let frameCount = 0;
    let frameEnergy = 0;
    let quietSamples = 0;
    let hasSpeech = false;

    function drain() {
      if (!sampleCount) return null;
      const segment = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of chunks) {
        segment.set(chunk, offset);
        offset += chunk.length;
      }
      chunks = [];
      sampleCount = frameCount = quietSamples = 0;
      frameEnergy = 0;
      hasSpeech = false;
      return segment;
    }

    function push(samples) {
      if (!(samples instanceof Float32Array)) {
        throw new TypeError('Cloud segmenter expects mono Float32Array PCM.');
      }
      const segments = [];
      let start = 0;
      for (let i = 0; i < samples.length; i++) {
        sampleCount++;
        frameCount++;
        frameEnergy += samples[i] * samples[i];
        if (frameCount !== frameSize) continue;

        // Keep frame boundaries stable across push calls, even when the audio
        // source supplies partial or differently sized buffers.
        if (frameEnergy / frameSize >= speechEnergy) {
          hasSpeech = true;
          quietSamples = 0;
        } else if (hasSpeech) {
          quietSamples += frameSize;
        }
        frameCount = 0;
        frameEnergy = 0;

        const pauseNeeded = sampleCount >= longSegmentSamples ? longSilenceSamples : silenceSamples;
        if ((hasSpeech && quietSamples >= pauseNeeded && sampleCount >= minSegmentSamples)
          || sampleCount >= maxSegmentSamples) {
          chunks.push(samples.slice(start, i + 1));
          segments.push(drain());
          start = i + 1;
        }
      }
      // Copy retained data because microphone buffers may be reused immediately
      // after push returns. Grow a list of chunks, never concatenate the entire
      // recording on each push; total copying stays linear in the audio length.
      if (start < samples.length) chunks.push(samples.slice(start));
      return segments;
    }

    // Preserve even a partial detection frame and silence-only tails. The caller
    // can apply its existing silence gate. Flush also resets this instance.
    return { push, flush: drain };
  }

  // Bounded overlap of requests, not audio. Audio boundaries and the caller's
  // ordered result array stay unchanged. A failure stops work not yet sent.
  // Two at once by default; up to four when the relay runs lanes, since it
  // then gives the pieces sent while the user talks a pool of their own.
  // `enqueue(work, { now: true })` starts at once whatever is running (the
  // last piece at stop must never wait behind the others), and `release()`
  // sends the pieces still waiting when the user stopped. Both go to the
  // relay's tail pool, not the body one, so they have a limit of their own:
  // at most `tailConcurrency` (4) of them run at once, the `now` piece
  // included, whatever is still out from before the stop. A relay answers a
  // request over its pool with a 429 that fails the whole dictation.
  function createCloudQueue({ concurrency = 2, tailConcurrency = 4, now = () => Date.now() } = {}) {
    const limit = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
    const tailLimit = Math.max(1, Math.min(4, Math.floor(tailConcurrency) || 1));
    let active = 0, tailActive = 0, failure = null, released = false;
    const waiting = [];
    function cancel(error = new Error('Dictation cancelled.')) {
      failure = failure || error;
      for (const job of waiting.splice(0)) job.reject(failure);
    }
    function start(job, tail) {
      const started = now();
      if (tail) tailActive++;
      else active++;
      Promise.resolve().then(job.work).then(value => {
        job.resolve({ value, queueMs: Math.max(0, started - job.queued), requestMs: Math.max(0, now() - started) });
      }, error => { cancel(error); job.reject(error); }).finally(() => {
        if (tail) tailActive--;
        else active--;
        pump();
      });
    }
    function pump() {
      while (!failure && waiting.length && (released ? tailActive < tailLimit : active < limit)) {
        start(waiting.shift(), released);
      }
    }
    return {
      enqueue(work, options) {
        if (failure) return Promise.reject(failure);
        const urgent = !!(options && options.now);
        return new Promise((resolve, reject) => {
          const job = { work, resolve, reject, queued: now() };
          if (urgent) start(job, true);
          else { waiting.push(job); pump(); }
        });
      },
      release() {
        released = true;
        pump();
      },
      cancel,
    };
  }

  // Join segment transcripts in order. Segments share no audio, so nothing is
  // deduplicated and a word said twice stays twice. The one repair is a word
  // the model heard cut off at the end of a segment and marked with a hyphen
  // ("Higgs-" or "Higgs-."): the rest of it opens the next segment, so the two
  // halves are rejoined ("Higgsfield"). A capital the model gave the second
  // half only because it opened a clip is dropped; an acronym keeps its case.
  // If the next segment opens with a longer word that starts with the fragment
  // ("f-" then "For him", "Hig-" then "Higgsfield") the speaker stuttered or
  // restarted the word; it was not cut in two, so nothing is merged and both
  // are kept as said. A first word exactly as long as the fragment ("Bu-" then
  // "bu", "Ta-" then "ta") is the rest of a doubled word and is merged. The
  // test cannot tell "pa-" then "paya" (papaya) or "Cin-" then "cinnati" from
  // a restart; they stay restarts, which is rare, and telling them apart
  // would need a second signal.
  // The model also capitalises the first word of every clip it is given, so a
  // piece that opens "Like the image" after "it's on a" arrives as "a Like the
  // image". After the rejoin, a join's first word is lowered when it is
  // provably an ordinary word and nothing says it is part of a name (see
  // lowerJoinCapitals). Before that, a full stop the model put at a join
  // where the sentence plainly goes on is removed (see fixJoinStops), and an
  // em-dash restart is recognised (see dashRestart).
  // Anchored at a word start and capped at 40 characters, so a long run of
  // letters is one pass, not one per character.
  const CUT_WORD = /(?<![\p{L}\p{M}\p{N}])([\p{L}\p{M}\p{N}]{1,40})[-\u2010]{1,3}(?:\.{1,3}|\u2026)?$/u;
  const WORD_HEAD = /^[\p{L}\p{N}]/u;

  // Function words, auxiliaries, discourse words and very common verbs,
  // adjectives and nouns: words that open a clip far more often as plain
  // English than as anything else. Names and brands that are mainly words are
  // left out (will, may, mark, notion, play, meet), and so is "I". Some listed
  // words are also a name or a title when they lead a longer one (New York,
  // Next.js, Go, Call of Duty, Times of India); lowerJoinCapitals keeps those
  // by looking at what follows the word, not by leaving the word out.
  // Inflections and contractions are handled by ordinaryWord(), so the plural
  // or -ing form of a listed word needs no entry. (being and thing stay
  // listed: ordinaryWord reaches them only by accident, through its
  // doubled-letter rule applied to the e-added stems "bee" and "thee".) A word
  // that is not here is still lowered if the same dictation says it in
  // lowercase elsewhere. This list stays inside this file: src/phonetics.js is
  // node-only, and classic overlay scripts share one global lexical scope.
  const ORDINARY = new Set(`
    a an the this that these those some any all each every both either another other such much many
    more most few less several own same
    it its he him his she her they them their we us our you your me my one someone something anything
    everything nothing anyone everyone myself yourself himself herself itself themselves ourselves
    in on at to for of with from by as into over under about after before between through during
    without within against around up down out off than across along until
    and but or so if because while though although since unless whether yet once
    what when where why how which who whom whose however
    is are was were be been being am do does did doing done have has had can could would should
    might must gonna wanna can't won't goes going gone
    not no yes yeah yep nope okay like just then now there here very really actually basically maybe
    also too even still only already always never sometimes often usually probably definitely honestly
    obviously anyway well right sure uh um hmm oh again instead rather quite almost ever soon
    later today tomorrow yesterday exactly simply finally pretty
    make take show give get got go went see want need use know think thought say said tell told ask
    come came look find found put keep let try call work help feel seem mean turn read write talk wait
    change check fix took gave
    thing time way lot bit part kind sort stuff
    good great bad new old big small long short different full first second third last next
  `.split(/\s+/).filter(Boolean));

  // True for a lowercase word that is ordinary: on the list, a contraction of a
  // listed word (it's, don't, we'll), or a listed word with a plain ending
  // (shows, taking, wanted). A stem needs three letters so that names which
  // happen to end in -ing or -es (Ming, Wes, Ames) never reduce to "me", "we"
  // or "am".
  const CONTRACTION = /^(.+?)(?:'(?:s|re|ve|ll|d)|n't)$/;
  function ordinaryWord(word) {
    if (ORDINARY.has(word)) return true;
    const contraction = word.match(CONTRACTION);
    if (contraction) return ORDINARY.has(contraction[1]);
    if (word.includes("'")) return false;
    const stems = [];
    const strip = (count, add = '') => stems.push(word.slice(0, -count) + add);
    if (word.endsWith('ing')) { strip(3); strip(3, 'e'); }
    else if (word.endsWith('ed')) { strip(2); strip(1); }
    else if (word.endsWith('es')) { strip(2); strip(1); }
    else if (word.endsWith('s') && !word.endsWith('ss')) strip(1);
    return stems.some(stem => stem.length > 2 && (ORDINARY.has(stem)
      || (stem[stem.length - 1] === stem[stem.length - 2] && ORDINARY.has(stem.slice(0, -1)))));
  }

  // A word is letters, marks and digits, with inner apostrophes ("it's").
  const WORD = /[\p{L}\p{M}\p{N}]+(?:['\u{2019}][\p{L}\p{M}\p{N}]+)*/gu;
  const LEAD_WORD = /^[\p{L}\p{M}\p{N}]+(?:['\u{2019}][\p{L}\p{M}\p{N}]+)*/u;
  // A capital followed only by lowercase: not GPT, iPhone, OpenAI or Mp3.
  const CAPITALISED = /^\p{Lu}[\p{Ll}\p{M}]*(?:['\u{2019}]\p{Ll}[\p{Ll}\p{M}]*)*$/u;
  const NOT_LATIN = /[^\p{Script=Latin}\p{M}'\u{2019}]/u;
  const SENTENCE_MARK = /[.?!\u{2026}\u{3002}\u{FF01}\u{FF1F}\u{0964}]/u;
  const SENTENCE_END = /[.?!\u{2026}\u{3002}\u{FF01}\u{FF1F}\u{0964}][\s"')\]}\u{201C}\u{201D}\u{2018}\u{2019}]*$/u;
  // After a colon, an em or en dash, or a hyphen standing alone, the next
  // capital may be a real new clause. So may it after an opening quote or
  // bracket the clip ended on (a closing straight quote follows a letter or
  // mark, an opening one follows a space, a bracket or another opener). A
  // hyphen attached to a word ("f-", "Hig-") is a stutter marker, not a clause
  // break.
  const OPEN_END = /(?::|[\u{2014}\u{2013}]|(?:^|\s)-{1,3}|[\u{201C}\u{2018}(\[]|(?:^|[\s(\[\u{201C}\u{2018}])")\s*$/u;
  const normal = word => word.toLowerCase().replace(/\u{2019}/gu, "'");
  const IS_I = /^I(?:'|\u{2019}|$)/u;
  // Lowering needs a dictation that is mostly English, because ORDINARY is an
  // English list: German capitalises its nouns ("ein Kind", "das Bad"), and
  // those would be read as an English word that opens a clip. Measured on
  // 2026-10-14 as the share of Latin-script words that ordinaryWord accepts:
  // the owner's 72 clips, every dictation that is cut at all (37 at 4 s)
  // scores 0.54 to 0.85 (median 0.73); 39 German, Spanish, French, Portuguese,
  // Italian, Dutch, Polish, Indonesian, Turkish and Hinglish dictations of 26
  // to 39 words score 0 to 0.13, and no 12-word stretch of them reaches 0.3
  // (10-word stretches: 8 of 908 do, 8-word: 2 of 986; a dictation that short
  // is not cut). Reproduce with temp/release-audit-2-1-10/english-ratio.js
  // and short-foreign.js.
  const ENGLISH_SHARE = 0.3;

  // What the whole dictation says about its words: those it writes in
  // lowercase, and those it capitalises in the middle of a sentence (a name).
  // The first word of every piece is skipped, as is any word after a sentence
  // end: neither capital tells anything, and the join word itself must not
  // count as its own evidence.
  function wordEvidence(parts) {
    const lower = new Set(), capitalised = new Set();
    for (const part of parts) {
      let end = 0, first = true;
      for (const match of part.matchAll(WORD)) {
        const word = match[0];
        const opens = first || SENTENCE_MARK.test(part.slice(end, match.index));
        first = false;
        end = match.index + word.length;
        if (word === word.toLowerCase()) lower.add(normal(word));
        else if (!opens && CAPITALISED.test(word)) capitalised.add(normal(word));
      }
    }
    return { lower, capitalised };
  }

  // The share of the dictation's Latin-script words that are ordinary English.
  // Numbers and other scripts are not counted either way.
  function englishShare(parts) {
    let latin = 0, ordinary = 0;
    for (const part of parts) {
      for (const match of part.matchAll(WORD)) {
        if (NOT_LATIN.test(match[0])) continue;
        latin++;
        if (ordinaryWord(normal(match[0]))) ordinary++;
      }
    }
    return latin ? ordinary / latin : 0;
  }

  // True when one of the three words after `start` in `text` is capitalised
  // ("I" and I-contractions do not count) before a sentence mark ends the
  // clause: "New York", "Wells Fargo", "Times of India", "Call of Duty". A
  // capital after a full stop opens a sentence and says nothing.
  function capitalFollows(text, start) {
    const rest = text.slice(start);
    let end = 0, count = 0;
    for (const match of rest.matchAll(WORD)) {
      if (SENTENCE_MARK.test(rest.slice(end, match.index))) return false;
      const word = match[0];
      if (/^\p{Lu}/u.test(word) && !IS_I.test(word)) return true;
      end = match.index + word.length;
      if (++count === 3) return false;
    }
    return false;
  }

  // MAI ends almost every piece with a full stop, wherever the cut fell, so a
  // dictation cut into pieces can come back "I left it on the. Table". A
  // final "." (or the Hindi danda) at a join is removed when the sentence
  // plainly goes on: the model wrote the next piece's first word in
  // lowercase, which it does when it heard the piece open mid-sentence, or,
  // in a mostly English dictation, the piece ends on a word no spoken
  // sentence ends on ("the", "and"; not prepositions: "I want to." and
  // "afraid of." do end one) or the next opens with "than". Then
  // lowerJoinCapitals treats the join like any other, so "on the" then
  // "Table" stays "on the Table" unless the dictation says "table" elsewhere.
  // Never touched: "?", "!", "...", a stop inside a closing quote or bracket,
  // abbreviations and initials (Mr., e.g., U.S., J.), a number followed by a
  // number ("2." then "5"). The word lists never judge a piece of one or two
  // words ("Oh my.", "Just because."), which is as often a whole sentence as
  // a fragment; the lowercase rule still does. A lowercase word with a
  // capital in it (iPhone, eBay) is a name, not evidence of a continuation.
  // Tuned on 2026-10-15 (temp/speed-2026-10-12/joinpunct.js, parameters in
  // results/joinpunct-params.json): across 550 continuing joins of the
  // owner's clips it took MAI's stray stops from 74 to 52 and removed no real
  // sentence end, all of it through the lowercase rule; the word lists never
  // fired, so they are kept to words that almost never end a sentence. The
  // length of the pause at the cut was tried too and left out: at the
  // threshold that helped, it removed one more stray stop and three real ones.
  // The Hindi and Hinglish lists are uncalibrated (the clips hold one
  // Devanagari dictation), so they apply only for a user who dictates Hindi or
  // Hinglish (joinCloudTexts' `hindi` option, from main). The Hinglish lists
  // also need a dictation that is not mostly English and holds Hinglish words
  // no Romance or Turkish sentence has ("nahi", "bhi", "kya"): "se", "ne",
  // "par" and "ya" are everyday words in those. "ki" is not on the Hinglish
  // never-final list: it is "that" but also "did" ("maine baat ki.").
  const NEVER_FINAL = new Set(['a', 'an', 'the', 'and', 'or', 'if', 'than']);
  const CONTINUATION_HEAD = new Set(['than']);
  const HINGLISH_NEVER_FINAL = new Set(['ka', 'ke', 'ko', 'aur', 'se', 'mein', 'ne', 'par', 'lekin', 'kyunki', 'agar', 'ya']);
  const HINGLISH_CONTINUATION_HEAD = new Set(['ki', 'ka', 'ke', 'ko', 'se', 'mein', 'ne', 'par']);
  // lowerJoinCapitals lowers only in a mostly English dictation, so at a
  // removed stop in a Hinglish one these words are lowered here.
  const HINGLISH_LOWER = new Set([...HINGLISH_NEVER_FINAL, ...HINGLISH_CONTINUATION_HEAD, 'main', 'mera', 'meri', 'mere',
    'mujhe', 'hum', 'tum', 'aap', 'yeh', 'ye', 'woh', 'wo', 'toh', 'to', 'kya', 'nahi', 'nahin', 'hai', 'hain', 'tha',
    'thi', 'bhi', 'ab', 'phir', 'matlab', 'accha', 'haan', 'jo', 'jab']);
  // Two of these make a Latin-script dictation Hinglish rather than Spanish,
  // Italian, Portuguese, French or Turkish.
  const HINGLISH_MARKERS = new Set(['hain', 'nahi', 'nahin', 'kya', 'mujhe', 'matlab', 'accha', 'acha', 'kyunki', 'lekin',
    'toh', 'yeh', 'woh', 'bhi', 'aur', 'tha', 'thi', 'mera', 'meri', 'hum', 'aap', 'kuch', 'bahut', 'abhi', 'kaise',
    'kyun', 'wala', 'wali', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'karna', 'karo', 'maine', 'humne', 'unhone']);
  const HINDI_NEVER_FINAL = new Set(['कि', 'का', 'के', 'को', 'और', 'से', 'में', 'ने', 'पर', 'लेकिन', 'क्योंकि', 'अगर', 'या', 'जो']);
  const HINDI_CONTINUATION_HEAD = new Set(['कि', 'का', 'के', 'की', 'को', 'से', 'में', 'ने', 'पर']);
  const STOP_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'inc', 'ltd', 'co',
    'corp', 'dept', 'approx', 'est', 'mt', 'ft', 'vol', 'fig', 'gen', 'gov', 'sgt', 'capt', 'col', 'lt', 'rev', 'hon']);
  const DEVANAGARI = /[\u{0900}-\u{097F}]/u;
  const LAST_WORD = /([\p{L}\p{M}\p{N}]+(?:['\u{2019}][\p{L}\p{M}\p{N}]+)*)[^\p{L}\p{M}\p{N}]*$/u;

  // The final stop a join may lose: one "." ('digit' after a number) or one
  // danda. Not "..", not the cut-word marker "Higgs-.", which the rejoin owns.
  function joinStop(text) {
    if (/[^\u{0964}]\u{0964}$/u.test(text)) return 'danda';
    if (!/[^.]\.$/u.test(text) || /[-\u{2010}]\.$/u.test(text)) return '';
    return /\p{N}\.$/u.test(text) ? 'digit' : 'stop';
  }

  function stopIsAbbreviation(text) {
    if (/(?:^|[^\p{L}])(?:\p{L}\.){2,}$/u.test(text)) return true;
    if (/(?:^|[^\p{L}])\p{Lu}\.$/u.test(text) && !/(?:^|[^\p{L}])I\.$/u.test(text)) return true;
    const word = text.match(/(?:^|[^\p{L}])(\p{L}+)\.$/u);
    return !!word && STOP_ABBREVIATIONS.has(word[1].toLowerCase());
  }

  function wordsAtLeast(text, count) {
    let seen = 0;
    for (const _ of text.matchAll(WORD)) if (++seen >= count) return true;
    return false;
  }

  function hinglishLike(parts) {
    let markers = 0;
    for (const part of parts) {
      for (const match of part.matchAll(WORD)) if (HINGLISH_MARKERS.has(normal(match[0])) && ++markers >= 2) return true;
    }
    return false;
  }

  // Edits parts in place. `english`: englishShare(parts) >= ENGLISH_SHARE;
  // `hindi`: the user dictates Hindi or Hinglish.
  function fixJoinStops(parts, english, hindi) {
    const hinglish = hindi && !english && hinglishLike(parts);
    for (let i = 1; i < parts.length; i++) {
      const previous = parts[i - 1], next = parts[i];
      const stop = joinStop(previous);
      if (!stop) continue;
      const lead = next.match(LEAD_WORD);
      const leadWord = lead ? lead[0] : '';
      if (stop === 'digit' && /^\p{N}/u.test(next)) continue;
      if (stop !== 'danda' && stopIsAbbreviation(previous)) continue;
      // Only the end is read: a long unspaced run (Chinese, Japanese) would
      // make an unanchored word match quadratic.
      const last = previous.slice(-80, -1).match(LAST_WORD);
      const tail = last ? normal(last[1]) : '';
      const head = normal(leadWord);
      // The word lists never judge a piece of one or two words.
      const lists = wordsAtLeast(previous, 3);
      let continues;
      if (stop === 'danda' || (DEVANAGARI.test(tail) && DEVANAGARI.test(head))) {
        continues = hindi && lists && (HINDI_NEVER_FINAL.has(tail) || HINDI_CONTINUATION_HEAD.has(head));
      } else {
        continues = (lists && english && (NEVER_FINAL.has(tail) || CONTINUATION_HEAD.has(head)))
          || (lists && hinglish && (HINGLISH_NEVER_FINAL.has(tail) || HINGLISH_CONTINUATION_HEAD.has(head)))
          || /^\p{Ll}[^\p{Lu}]*$/u.test(leadWord);
      }
      if (!continues) continue;
      parts[i - 1] = previous.slice(0, -1);
      if (hinglish && HINGLISH_LOWER.has(head) && /^\p{Lu}\p{Ll}+$/u.test(leadWord)) {
        parts[i] = next[0].toLowerCase() + next.slice(1);
      }
    }
  }

  // AssemblyAI writes a restarted word with an em dash where MAI writes a
  // hyphen: "the lang—" then "Language settings". When the next piece opens
  // with a longer word that starts with the fragment, the dash is a restart,
  // not a clause break, and the word after it is lowered like any other join
  // (lowerJoinCapitals' name rules still apply). The dash stays as written.
  // A fragment that is itself an ordinary word ("going to—" then "Today"), or
  // a single letter ("I—" then "Instead"), is read as a clause break, as before.
  const DASH_FRAGMENT = /(?<![\p{L}\p{M}\p{N}])([\p{L}\p{M}\p{N}]{2,40})\u{2014}$/u;
  function dashRestart(previous, part) {
    const cut = previous.match(DASH_FRAGMENT);
    const lead = part.match(LEAD_WORD);
    if (!cut || !lead) return false;
    const fragment = normal(cut[1]);
    const first = normal(lead[0]);
    return first.length > fragment.length && first.startsWith(fragment) && !ordinaryWord(fragment);
  }

  // Lower the first letter of a piece that opens a sentence the previous piece
  // has not ended, when the word is provably ordinary (listed, or said in
  // lowercase elsewhere in the dictation) and nothing says it is a name or a
  // new sentence: never "I" or I-contractions, acronyms or mixed case,
  // anything with a digit, non-Latin script, a domain-like name (Next.js), a
  // word the dictation capitalises mid-sentence elsewhere, or a word followed
  // by a capitalised one (New York, Times of India, and No-Code, whose hyphen
  // splits it into two words). A clip whose first clause is a question keeps
  // its capital ("Is that right?"), and so does one after an unclosed quote or
  // bracket.
  // A name inside ordinary speech wins over a lowered word: "how" then "The
  // script Rhea wrote" keeps its "The". Nothing is lowered unless the whole
  // dictation is mostly English (englishShare). Edits parts in place.
  function lowerJoinCapitals(parts, restarts) {
    let evidence = null, english = null;
    for (let i = 1; i < parts.length; i++) {
      const before = parts[i - 1].slice(-8);
      if (SENTENCE_END.test(before) || (OPEN_END.test(before) && !(restarts && restarts.has(i)))) continue;
      const lead = parts[i].match(LEAD_WORD);
      if (!lead) continue;
      const word = lead[0];
      if (!CAPITALISED.test(word) || NOT_LATIN.test(word) || IS_I.test(word)
        || /^\.\p{L}/u.test(parts[i].slice(word.length))
        || capitalFollows(parts[i], word.length)) continue;
      const stop = parts[i].match(/[.?!]/);
      if (stop && stop[0] === '?') continue;
      evidence = evidence || wordEvidence(parts);
      const key = normal(word);
      if (evidence.capitalised.has(key)) continue;
      if (!ordinaryWord(key) && !evidence.lower.has(key)) continue;
      if (english === null) english = englishShare(parts) >= ENGLISH_SHARE;
      if (!english) continue;
      parts[i] = parts[i][0].toLowerCase() + parts[i].slice(1);
    }
  }

  // options.hindi: the user dictates Hindi or Hinglish (see fixJoinStops).
  function joinCloudTexts(texts, options) {
    const parts = [];
    for (const text of texts || []) {
      const part = String(text || '').trim();
      if (!part) continue;
      const previous = parts.length ? parts[parts.length - 1] : '';
      const cut = previous.match(CUT_WORD);
      if (cut && WORD_HEAD.test(part)) {
        const space = part.search(/\s/);
        let head = space < 0 ? part : part.slice(0, space);
        const rest = space < 0 ? '' : part.slice(space);
        // A longer word that opens with the fragment is a restart; one exactly
        // as long ("Bu-" then "bu") is the second half of a doubled word.
        const first = head.match(/^[\p{L}\p{M}\p{N}]+/u)[0].toLowerCase();
        const fragment = cut[1].toLowerCase();
        const restart = first.length > fragment.length && first.startsWith(fragment);
        if (!restart) {
          const tail = head.slice(1);
          if (tail && tail === tail.toLowerCase()) head = head[0].toLowerCase() + tail;
          parts[parts.length - 1] = previous.slice(0, cut.index) + cut[1] + head + rest;
          continue;
        }
      }
      parts.push(part);
    }
    const restarts = new Set();
    for (let i = 1; i < parts.length; i++) if (dashRestart(parts[i - 1], parts[i])) restarts.add(i);
    if (parts.some((part, i) => i < parts.length - 1 && joinStop(part))) {
      fixJoinStops(parts, englishShare(parts) >= ENGLISH_SHARE, !!(options && options.hindi));
    }
    lowerJoinCapitals(parts, restarts);
    return parts.join(' ');
  }

  const api = { createCloudSegmenter, createCloudQueue, joinCloudTexts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voxdenCloudSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
