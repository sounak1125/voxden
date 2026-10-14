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
  function createCloudQueue({ concurrency = 2, now = () => Date.now() } = {}) {
    const limit = Math.max(1, Math.min(2, Math.floor(concurrency) || 1));
    let active = 0, failure = null;
    const waiting = [];
    function cancel(error = new Error('Dictation cancelled.')) {
      failure = failure || error;
      for (const job of waiting.splice(0)) job.reject(failure);
    }
    function pump() {
      while (!failure && active < limit && waiting.length) {
        const job = waiting.shift();
        const started = now();
        active++;
        Promise.resolve().then(job.work).then(value => {
          job.resolve({ value, queueMs: Math.max(0, started - job.queued), requestMs: Math.max(0, now() - started) });
        }, error => { cancel(error); job.reject(error); }).finally(() => { active--; pump(); });
      }
    }
    return {
      enqueue(work) {
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => { waiting.push({ work, resolve, reject, queued: now() }); pump(); });
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
  // lowerJoinCapitals).
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
  function lowerJoinCapitals(parts) {
    let evidence = null, english = null;
    for (let i = 1; i < parts.length; i++) {
      const before = parts[i - 1].slice(-8);
      if (SENTENCE_END.test(before) || OPEN_END.test(before)) continue;
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

  function joinCloudTexts(texts) {
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
    lowerJoinCapitals(parts);
    return parts.join(' ');
  }

  const api = { createCloudSegmenter, createCloudQueue, joinCloudTexts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voxdenCloudSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
