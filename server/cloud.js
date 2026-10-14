'use strict';

// The upstream speech model, behind one function, plus what the relay needs
// to meter a clip without trusting the caller.
//
// The provider is OpenRouter's OpenAI-shaped transcription endpoint. The
// model is a string in the environment, so swapping providers in January is
// a config change here and nothing in the desktop app.

const DEFAULT_UPSTREAM_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
// The code default, used when CLOUD_MODEL is unset or empty. Production sets
// CLOUD_MODEL to assemblyai/universal-3-5-pro, so a deployment that loses the
// variable falls back to this model, not to the one it was running.
const DEFAULT_MODEL = 'microsoft/mai-transcribe-2';
const DEFAULT_TIMEOUT_MS = 20e3;
// The most dictionary terms any request carries. microsoft/mai-transcribe-2
// through OpenRouter refused 60 phrases with a 400 on 2026-09-11. On
// 2026-10-08 it took 30, 40, 50, 60, 80 and 102 (850 characters), and a name
// placed 102nd still corrected the text ("Vox10" to "Voxden"); more than 102
// was not tried. assemblyai/universal-3-5-pro took 24 and 100 keyterms on
// 2026-10-14 and nothing above 100 was tried either, so the cap stays at 100
// for both. A 400 with hints is retried without them, so a lower ceiling later
// costs hints, not the dictation. The app ranks terms by recency and use, so
// the cut keeps the ones that matter.
const MAX_PHRASES = 100;
// How long the model counts as warm after it last answered, warm-up or real
// clip. This only matters for a main model that has a cold start to hide
// (microsoft/mai-transcribe-2 answered slowly after gaps of five seconds and
// more; AssemblyAI shows none, so its warm-ups are skipped, see warmUp). The
// app warms the model as a recording starts and again whenever a recording has
// gone three seconds with nothing sent or in flight (src/main.js,
// CLOUD_KEEP_WARM_IDLE_MS), so this sits below that gap: each of those asks
// wakes the model, while a second hotkey tap a moment later is still answered
// from the first. A clip answered in the meantime counts too, so a long
// dictation whose segments are already going up pays for no silent clips at
// all.
const WARM_FRESH_MS = 1500;
// Hedging. A warm MAI model answers a clip in about half a second and a cold
// one in two or three, but now and then a request simply goes quiet, and the
// person who spoke waits out the whole of it. Once the first request has been
// quiet this long, a second identical one is sent beside it, the first answer wins
// and the other is cancelled. The time allowed grows with the clip, because a
// longer clip honestly takes longer; it is only ever a guess about "stuck", so
// it sits well past where answers normally arrive. Nothing is hedged that
// answers sooner, so the cost is one extra request on the slowest few percent.
// CLOUD_HEDGE_MS sets the base, and 0 turns it off. While a rescue model is
// configured (below) the hedge is off unless CLOUD_HEDGE_MS is set, because
// on a bad day both copies of the same model stall together.
const DEFAULT_HEDGE_MS = 2000;
const HEDGE_PER_SECOND_MS = 100;
const HEDGE_MAX_MS = 6000;

function hedgeAfterMs(baseMs, seconds) {
  const base = Number(baseMs);
  if (!(base > 0)) return 0;
  const grown = base + HEDGE_PER_SECOND_MS * Math.max(0, Number(seconds) || 0);
  return Math.round(Math.min(Math.max(base, HEDGE_MAX_MS), grown));
}

// The rescue. On 2026-10-11 to 13 microsoft/mai-transcribe-2 went quiet on
// half of all requests and about one in ten ran into the 20 s deadline, and
// the same-model hedge did not help because both copies stalled. So when the
// main model has not answered by the time below, ONE request goes to a
// different model beside it. The first answer wins and every other request is
// cancelled. A main-model failure that is worth retrying (429, 408, 5xx,
// unreachable) sends the rescue at once instead of waiting for the clock.
//
// With the code's default main model (MAI) the rescue is
// assemblyai/universal-3-5-pro. On 72 of the owner's clips (2026-10-12), with
// the dictionary sent, it answered in 0.5-1.3 s with 8.9% word error and 22 of
// 27 dictionary words, against 10.4% and 12 of 27 for
// openai/gpt-4o-mini-transcribe, at $0.45 per audio hour (the mini model came
// to $0.18-0.30 with its dictionary prompt billed as tokens). The main model
// then won on accuracy (7.1%, 24 of 27), so the rescue is the second chance
// and never the first choice. Production has since made AssemblyAI the main
// model and named the GPT model as the rescue. The time allowed grows with the
// clip, like the hedge. CLOUD_RESCUE_MODEL names the model ('' or 'none'
// turns the rescue off), and CLOUD_RESCUE_MS the base, where 0 also turns it
// off. The warm-up never rescues.
//
// A rescue that is the main model itself would repeat the request that just
// stalled, which on a bad day stalls together with it. So when the rescue
// resolves to the main model, which is what an AssemblyAI CLOUD_MODEL with no
// CLOUD_RESCUE_MODEL used to give, it becomes the other family's default: GPT
// when the main model is AssemblyAI, AssemblyAI otherwise.
const DEFAULT_RESCUE_MODEL = 'assemblyai/universal-3-5-pro';
const DEFAULT_RESCUE_AGAINST_ASSEMBLYAI = 'openai/gpt-4o-mini-transcribe';
const DEFAULT_RESCUE_MS = 4000;
const RESCUE_PER_SECOND_MS = 100;
const RESCUE_MAX_MS = 8000;
// The dictionary reaches a model the way that model's maker takes hints, and
// OpenRouter passes them through only as provider options.
//  - assemblyai/...: provider.options.assemblyai.keyterms_prompt, the same
//    cleaned list whichever role the model has (verified live on 2026-10-14
//    with 24 and 100 terms). The unified keyterms field and word_boost do
//    nothing there.
//  - openai/...: a "Vocabulary: A, B, C" prompt in provider.options.openai.prompt,
//    the only way OpenRouter passes hints to OpenAI's models (the unified
//    keyterms field is refused with a 400). It is long enough for a few dozen
//    names and no longer, because a transcription model treats a prompt as
//    text it may continue.
//  - any other family: no hints for a rescue, because how it takes them is
//    unknown. A main model of any other family gets Azure's phraseList, as
//    Microsoft's model page documents it for microsoft/mai-transcribe-2.
const RESCUE_PROMPT_MAX = 800;
const RESCUE_PROMPT_HEAD = 'Vocabulary: ';
// Retention. Every request asks OpenRouter to route to providers that keep
// nothing, in the way each family accepts (checked live on 2026-10-14):
//  - assemblyai/... and microsoft/...: provider.zdr = true, zero data
//    retention. Both answered 200.
//  - any other family, the OpenAI rescue included: provider.data_collection =
//    'deny'. openai/gpt-4o-mini-transcribe answered zdr with a 404 ("No
//    endpoints found matching your data policy"); all three models accepted
//    'deny'.
// It sits beside the hint options in `provider`, and neither replaces the
// other. A model of a family nobody has tried may find no endpoint that meets
// the policy and answer 404 to everything; a 404 is not retried and, from the
// main model, fails every dictation. Try a new CLOUD_MODEL once before it ships.
const ZDR_FAMILIES = new Set(['assemblyai', 'microsoft']);

function rescueAfterMs(baseMs, seconds) {
  const base = Number(baseMs);
  if (!(base > 0)) return 0;
  const grown = base + RESCUE_PER_SECOND_MS * Math.max(0, Number(seconds) || 0);
  return Math.round(Math.min(Math.max(base, RESCUE_MAX_MS), grown));
}

// "Vocabulary: A, B, C" from the dictionary in the app's order, cut before the
// first term that would push it past RESCUE_PROMPT_MAX. Empty without terms.
function rescuePrompt(terms) {
  let prompt = RESCUE_PROMPT_HEAD;
  let count = 0;
  for (const term of terms || []) {
    const next = prompt + (count ? ', ' : '') + term;
    if (next.length > RESCUE_PROMPT_MAX) break;
    prompt = next;
    count++;
  }
  return count ? prompt : '';
}

// The dictionary as the app sent it, ready for any model: trimmed, without
// blanks or repeats, in the app's order, at most MAX_PHRASES long.
function cleanTerms(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const terms = [];
  for (const item of list) {
    const term = String(item || '').trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_PHRASES) break;
  }
  return terms;
}

// What a request to an AssemblyAI or OpenAI model carries for the dictionary
// (the rescue's, and the main model's when it is one of those): { provider } to
// merge into the body (absent when there is nothing to send), and `prompted`
// when that is a text prompt a model may read back.
function rescueHints(model, terms) {
  const family = modelFamily(model);
  if (!terms || !terms.length) return {};
  if (family === 'assemblyai') {
    return { provider: { options: { assemblyai: { keyterms_prompt: terms.slice() } } }, prompted: false };
  }
  if (family === 'openai') {
    const prompt = rescuePrompt(terms);
    return prompt ? { provider: { options: { openai: { prompt } } }, prompted: true } : {};
  }
  return {};
}

// The `provider` object of a request: the retention setting for the model's
// family (see ZDR_FAMILIES) with the dictionary's provider options beside it.
// Every request has one, hints or not.
function providerFor(model, hints) {
  const retention = ZDR_FAMILIES.has(modelFamily(model)) ? { zdr: true } : { data_collection: 'deny' };
  return { ...((hints && hints.provider) || {}), ...retention };
}

// Languages. A request's `language` is the app's dictation language as a short
// code, or nothing, which means detect. A model answers a code it does not take
// in its own way: AssemblyAI refuses it with a 400, and with no code it detects
// among its own languages only, so Bengali comes back as Hindi-script gibberish.
// So the relay holds each model family's list and checks it before the clip is
// reserved or sent anywhere. This is the one place the lists live; a new model
// with a list of its own adds one entry to LANGUAGE_RULES.
//
//  - assemblyai/...: the 18 languages of Universal-3.5 Pro. Each code was sent
//    through OpenRouter on 2026-10-14 and accepted (HTTP 200); nb, iw, zh-CN and
//    bn were refused with a 400. Norwegian is 'no', so the 'nb' that apps up to
//    2.1.9 send is mapped to it. Any other code is refused (`refused`), and the
//    caller answers 400 with code 'language': nothing is sent upstream and
//    nothing is charged. src/asr.js DICTATION_LANGUAGES must name these same
//    codes (scripts/test-asr.js checks), or the app would offer a language the
//    relay refuses.
//  - any other family: GENERAL_LANGUAGES, the 60 codes the relay forwarded
//    before Universal-3.5 Pro (Microsoft's table). A code outside it is dropped
//    and the model detects, exactly as before; nothing is refused.
const ASSEMBLYAI_LANGUAGES = Object.freeze([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'da', 'nl', 'fi', 'he', 'hi', 'ja', 'zh', 'no', 'sv', 'tr', 'vi',
]);
const GENERAL_LANGUAGES = Object.freeze([
  'en', 'hi', 'af', 'ar', 'hy', 'as', 'az', 'bn', 'bs', 'bg', 'yue', 'ca', 'zh', 'cs', 'da', 'nl', 'et', 'fil', 'fi', 'fr',
  'gl', 'de', 'el', 'gu', 'he', 'hu', 'is', 'id', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'ml', 'mr', 'ne',
  'nb', 'or', 'fa', 'pl', 'pt', 'pa', 'ro', 'ru', 'sk', 'sl', 'es', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi',
]);
// Codes the same language goes by, as { received: sent }. General's table says
// 'nb' where AssemblyAI says 'no', and an app that sends one should reach the
// other whichever model is configured.
const LANGUAGE_RULES = new Map([
  ['assemblyai', { codes: ASSEMBLYAI_LANGUAGES, aliases: new Map([['nb', 'no']]), refuses: true }],
]);
const GENERAL_LANGUAGE_RULES = { codes: GENERAL_LANGUAGES, aliases: new Map([['no', 'nb']]), refuses: false };

function modelFamily(model) {
  return String(model || '').split('/')[0].trim().toLowerCase();
}

// What a request's `language` becomes for the configured main model:
// { language } is the code to send ('' to let the model detect), and
// { refused: true } means the model cannot take it and nothing should be sent.
function resolveLanguage(model, requested) {
  const raw = String(requested || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return { language: '' };
  const rules = LANGUAGE_RULES.get(modelFamily(model)) || GENERAL_LANGUAGE_RULES;
  const code = rules.aliases.has(raw) ? rules.aliases.get(raw) : raw;
  if (rules.codes.includes(code)) return { language: code };
  return rules.refuses ? { refused: true } : { language: '' };
}

// Failures worth another try: the provider is busy, slow, down or unreachable.
function isTransient(err) {
  return [408, 429, 500, 502, 503, 504].includes(err.status)
    || (err.code === 'upstream' && !err.status);
}

// A third of a second of 16 kHz mono silence, for the warm-up call.
function silentWav(seconds) {
  const rate = 16000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const SILENT_WAV_BASE64 = silentWav(0.3).toString('base64');

// Seconds of audio in a canonical PCM WAV, from its own header. The relay
// meters what it received, not what the caller claims and not what the
// provider bills, so a client cannot shave its own count. A byte rate that
// disagrees with the sample rate, channels and sample size beside it is a
// header written to under-count, and the clip is refused.
function wavByteRate(buf, body) {
  const channels = buf.readUInt16LE(body + 2);
  const sampleRate = buf.readUInt32LE(body + 4);
  const byteRate = buf.readUInt32LE(body + 8);
  const bits = buf.readUInt16LE(body + 14);
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000 || ![8, 16, 24, 32].includes(bits)) return 0;
  return byteRate === sampleRate * channels * (bits / 8) ? byteRate : 0;
}

function wavSeconds(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      byteRate = wavByteRate(buf, body);
    } else if (id === 'data') {
      if (!byteRate) return 0;
      const dataBytes = Math.min(size, buf.length - body);
      return dataBytes / byteRate;
    }
    offset = body + size + (size % 2);
  }
  return 0;
}

function createCloudTranscriber(options) {
  const opts = options || {};
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || DEFAULT_MODEL);
  const url = String(opts.upstreamUrl || DEFAULT_UPSTREAM_URL);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // A rescue model is on unless it is named '' or 'none', or its base is 0.
  let rescueName = opts.rescueModel === undefined || opts.rescueModel === null
    ? DEFAULT_RESCUE_MODEL : String(opts.rescueModel).trim();
  // Never the main model itself: see DEFAULT_RESCUE_MODEL.
  if (rescueName && rescueName.toLowerCase() === model.trim().toLowerCase()) {
    rescueName = modelFamily(model) === 'assemblyai' ? DEFAULT_RESCUE_AGAINST_ASSEMBLYAI : DEFAULT_RESCUE_MODEL;
  }
  const rescueBaseMs = opts.rescueMs === undefined || opts.rescueMs === null || opts.rescueMs === ''
    ? DEFAULT_RESCUE_MS : Number(opts.rescueMs);
  const rescueModel = rescueName === '' || rescueName.toLowerCase() === 'none' || !(rescueBaseMs > 0) ? '' : rescueName;
  // Whether warmUp() sends its silent clip upstream. 'auto' (the default)
  // sends it unless the main model is AssemblyAI's: no cold start has been
  // measured for it (24 timed requests on 2026-10-12, 7 to 101 s apart, took
  // 0.76-2.3 s and followed clip length, not the gap; a small sample), and
  // every silent clip is a billed request. MAI's cold start was measured, so
  // it keeps its warm-ups. 'on' and 'off' force it either way (CLOUD_WARMUP),
  // so a cold start that shows up later is one setting away.
  const warmSetting = String(opts.warmup === undefined || opts.warmup === null ? '' : opts.warmup).trim().toLowerCase();
  const warmUpstream = warmSetting === 'on' ? true : warmSetting === 'off' ? false : modelFamily(model) !== 'assemblyai';
  // The same-model hedge keeps running only when it was asked for by name once
  // a rescue is there to take its place.
  const hedgeAsked = !(opts.hedgeMs === undefined || opts.hedgeMs === null || opts.hedgeMs === '');
  const hedgeBaseMs = hedgeAsked ? Number(opts.hedgeMs) : (rescueModel ? 0 : DEFAULT_HEDGE_MS);

  let warmInFlight = null;
  let warmedAt = 0;

  async function transcribe(request) {
    const req = request || {};
    if (!apiKey) throw Object.assign(new Error('Cloud transcription is not configured on this server.'), { code: 'unconfigured' });
    let phrases = cleanTerms(req.terms);
    // The rescue keeps the whole dictionary even if the main model refuses its
    // phrase list: the two take hints in different ways.
    const terms = phrases.slice();
    const startedAt = Date.now();
    // The deadline and the caller. Everything below is cancelled with it.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (req.signal?.aborted) cancel();
    else req.signal?.addEventListener('abort', cancel, { once: true });
    // One deadline covers every attempt, response body and backoff together.
    const timer = setTimeout(cancel, timeoutMs);
    const deadline = startedAt + timeoutMs;
    const abortError = () => Object.assign(new Error(req.signal?.aborted
      ? 'Dictation cancelled.' : 'The speech model did not answer in time.'),
      { code: req.signal?.aborted ? 'cancelled' : 'timeout' });
    // Everything sent to the main model. It also stops when the rescue answers.
    const main = new AbortController();
    const stopMain = () => main.abort();
    if (controller.signal.aborted) stopMain();
    else controller.signal.addEventListener('abort', stopMain, { once: true });
    let hintsDropped = false, retries = 0;
    // One hedge per transcription, however many retries it takes: the cost of
    // a stuck clip is one extra request, not one per attempt.
    const hedge = { after: req.hedge === false ? 0 : hedgeAfterMs(hedgeBaseMs, req.seconds), fired: false };

    // One rescue per transcription, timed from here and not per attempt. It runs
    // beside whatever the main model is doing, backoff included. `done` settles
    // with its answer, or with null if it failed or was cancelled.
    const rescue = {
      after: req.rescue === false || !rescueModel ? 0 : rescueAfterMs(rescueBaseMs, req.seconds),
      fired: false, running: false, trigger: '', firedAt: 0, failure: '', controller: null, timer: null, done: null, settle: null,
    };
    rescue.done = new Promise((resolve) => { rescue.settle = resolve; });
    const fireRescue = (trigger) => {
      if (!(rescue.after > 0) || rescue.fired || controller.signal.aborted || Date.now() >= deadline) return;
      rescue.fired = true;
      rescue.running = true;
      rescue.trigger = trigger;
      rescue.firedAt = Date.now() - startedAt;
      clearTimeout(rescue.timer);
      const own = new AbortController();
      rescue.controller = own;
      if (controller.signal.aborted) own.abort();
      else controller.signal.addEventListener('abort', () => own.abort(), { once: true });
      rescueAttempt(req, terms, own.signal).then((result) => {
        rescue.running = false;
        rescue.settle(result);
      }, (err) => {
        rescue.running = false;
        rescue.failure = err && err.code === 'echo' ? 'prompt echo' : err && err.code === 'empty' ? 'empty answer'
          : err && err.status ? 'HTTP ' + err.status : 'unreachable';
        rescue.settle(null);
      });
    };
    if (rescue.after > 0) rescue.timer = setTimeout(() => fireRescue('timer'), rescue.after);

    // What the clip's journey so far says about the main model, for the log.
    const describe = (result) => {
      if (hedge.fired) result.hedged = true;
      if (hintsDropped) result.hintsDropped = true;
      if (retries) { result.retried = true; result.retries = retries; }
      if (rescue.fired) {
        result.rescueFired = true;
        if (rescue.failure) result.rescueFailed = rescue.failure;
      }
      return result;
    };

    // The main model, with its hedge and its retries.
    const askMain = async () => {
      for (let index = 0; index < 3; index++) {
        if (main.signal.aborted) throw abortError();
        try {
          const result = await raceAttempt(req, phrases, main.signal, hedge);
          if (main.signal.aborted) throw abortError();
          warmedAt = Date.now();
          return describe(result);
        } catch (err) {
          if (main.signal.aborted) throw abortError();
          // A busy or unreachable provider does not wait for the clock.
          if (isTransient(err)) fireRescue('error');
          if (index === 2) throw err;
          // Dictionary hints are optional; a rejected list should not lose speech.
          if (phrases.length && err.status === 400) {
            phrases = []; hintsDropped = true;
            continue;
          }
          if (!isTransient(err)) throw err;
          const delay = Math.max(1000 * 2 ** retries, err.retryAfterMs || 0);
          if (Date.now() + delay >= deadline) throw err;
          retries++;
          // Retry only this rejected segment. Successful earlier segments stay
          // in the desktop queue and the relay meters only the final success.
          await retryWait(delay, main.signal);
        }
      }
    };

    let graceTimer = null;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
        askMain().then((result) => {
          if (controller.signal.aborted) return settle(reject, abortError());
          settle(resolve, result);
        }, (err) => {
          if (controller.signal.aborted) return settle(reject, abortError());
          // The main model gave up on something temporary while the rescue is
          // still out: its answer is the last one to wait for, but only for a
          // grace period. Anything else (a refused request, bad audio) is the
          // answer today, rescue or not.
          //
          // The grace is the allowance the main model got before it counted as
          // quiet (rescueAfterMs: 4 s plus 100 ms per second of audio, 8 s at
          // most, or whatever CLOUD_RESCUE_MS says), never past the deadline.
          // Answers normally arrive in 0.5-3 s and the rescue has already had
          // the main model's own retries (about 3 s) on top of this, so one
          // still silent after the allowance is stuck by the very standard that
          // sent it. Waiting for the deadline instead cost the user 20 s and
          // relabelled the error "timeout", which hid a 429 from providerBusy
          // (src/cloud.js, the local fallback) and made the app retry for
          // another 20 s. When the grace runs out, or the rescue fails, or the
          // deadline comes first, the main model's own error is what is thrown;
          // only the caller's cancel is reported as a cancel.
          if (rescue.running && isTransient(err)) {
            const grace = Math.max(0, Math.min(deadline - Date.now(), rescueAfterMs(rescueBaseMs, req.seconds)));
            graceTimer = setTimeout(() => settle(reject, err), grace);
            rescue.done.then((answer) => {
              if (answer) return;
              settle(reject, req.signal?.aborted ? abortError() : err);
            });
            return;
          }
          settle(reject, err);
        });
        rescue.done.then((answer) => {
          if (!answer) return;
          if (controller.signal.aborted) return settle(reject, abortError());
          // The first answer wins; what the main model has out is cancelled below.
          answer.rescued = true;
          answer.rescueTrigger = rescue.trigger;
          answer.rescueFiredAtMs = rescue.firedAt;
          answer.rescuedAfterMs = Date.now() - startedAt;
          settle(resolve, describe(answer));
        });
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(rescue.timer);
      clearTimeout(graceTimer);
      req.signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', stopMain);
      // Whatever lost is cancelled: the rescue if the main model answered,
      // and any request the main model still has out if the rescue did.
      if (rescue.controller) rescue.controller.abort();
      stopMain();
    }
  }

  function retryWait(ms, signal) {
    if (opts.retryWait) return opts.retryWait(ms, signal);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Aborted'));
      const abort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  // One attempt, with a second sent beside it if the first has been quiet for
  // `hedge.after` ms. The first answer wins; the other request is cancelled and
  // whatever it does afterwards is ignored. A failure only counts once every
  // request in flight has failed, and the first one's error is the one reported,
  // so the retry rules above see the same error they always did. After the
  // hedge has fired, `hedge.fired` stays true and no later attempt hedges.
  function raceAttempt(req, phrases, signal, hedge) {
    if (!(hedge.after > 0) || hedge.fired) return attempt(req, phrases, signal);
    return new Promise((resolve, reject) => {
      const racers = [];
      let finished = false;
      let failures = 0;
      let firstError = null;
      let timer = null;
      // Everything still in flight is cancelled except the request that won.
      const finish = (settle, value, winner) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const racer of racers) {
          signal.removeEventListener('abort', racer.onAbort);
          if (racer !== winner) racer.controller.abort();
        }
        settle(value);
      };
      const launch = (second) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
        const racer = { controller, onAbort };
        racers.push(racer);
        attempt(req, phrases, controller.signal).then((result) => {
          if (finished) return;
          if (second) result.hedgeWon = true;
          finish(resolve, result, racer);
        }, (err) => {
          if (finished) return;
          failures++;
          if (!firstError) firstError = err;
          if (failures >= racers.length) finish(reject, firstError);
        });
      };
      launch(false);
      timer = setTimeout(() => {
        if (finished) return;
        hedge.fired = true;
        launch(true);
      }, hedge.after);
    });
  }

  async function attempt(req, phrases, signal) {
    const body = {
      model,
      input_audio: { data: String(req.audioBase64 || ''), format: String(req.format || 'wav') },
    };
    if (req.language) body.language = String(req.language);
    // Keyword biasing, as each vendor takes it through OpenRouter: an
    // AssemblyAI or OpenAI CLOUD_MODEL gets rescueHints()'s option for its
    // vendor, so swapping the main model keeps the dictionary; anything else
    // gets Azure's phrase list, as Microsoft's model page documents it. The
    // retention setting rides beside it, and stays when a refused list is
    // dropped.
    let hints = {};
    if (phrases.length) {
      const family = modelFamily(model);
      hints = family === 'assemblyai' || family === 'openai'
        ? rescueHints(model, phrases)
        : { provider: { options: { azure: { phraseList: { phrases } } } } };
    }
    body.provider = providerFor(model, hints);
    return send(body, signal);
  }

  // The one request to the rescue model. It is sent once and never retried,
  // so a 400 for its prompt ends it; a failure of any kind just leaves the main
  // model to answer. The dictionary goes up the way that model's maker takes
  // it (rescueHints). When a text prompt was sent, an answer that contains the
  // prompt's own heading is the model reading the prompt back instead of the
  // audio, and is no answer; a keyterm list is not text the model can echo, so
  // "vocabulary:" in such an answer is something the speaker said.
  async function rescueAttempt(req, terms, signal) {
    const body = {
      model: rescueModel,
      input_audio: { data: String(req.audioBase64 || ''), format: String(req.format || 'wav') },
    };
    if (req.language) body.language = String(req.language);
    const hints = rescueHints(rescueModel, terms);
    body.provider = providerFor(rescueModel, hints);
    const answer = await send(body, signal);
    if (hints.prompted && /vocabulary:/i.test(answer.text)) throw Object.assign(new Error('The rescue model repeated its prompt.'), { code: 'echo' });
    // The app only uploads pieces its speech gate heard, so an empty rescue is
    // a miss, not silence: keep waiting for the main model instead of pasting nothing.
    if (!String(answer.text || '').trim()) throw Object.assign(new Error('The rescue model returned no text.'), { code: 'empty' });
    return answer;
  }

  // One request to the provider, whichever model it names, and its answer in
  // the shape the relay meters.
  async function send(body, signal) {
    let res;
    let parsed = null;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://voxden.app',
          'X-Title': 'Voxden',
        },
        body: JSON.stringify(body),
        signal,
      });
      // The upstream deadline covers both headers and the complete body.
      // An aborted body is a timeout, not a successful empty transcript.
      try { parsed = await res.json(); } catch (err) {
        if (signal.aborted
            || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) throw err;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      throw Object.assign(new Error('The speech model could not be reached.'), { code: 'upstream' });
    }
    if (!res.ok) {
      const detail = parsed && parsed.error ? (parsed.error.message || parsed.error) : '';
      const retryAfter = res.headers?.get?.('retry-after');
      const seconds = retryAfter == null || retryAfter === '' ? NaN : Number(retryAfter);
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(retryAfter || '') - Date.now()) || 0;
      throw Object.assign(new Error('The speech model returned ' + res.status + (detail ? ': ' + String(detail).slice(0, 160) : '') + '.'),
        { code: 'upstream', status: res.status, retryAfterMs });
    }
    const usage = (parsed && parsed.usage) || {};
    return {
      text: String((parsed && parsed.text) || ''),
      billedSeconds: Number(usage.seconds) > 0 ? Number(usage.seconds) : 0,
      cost: Number(usage.cost) > 0 ? Number(usage.cost) : 0,
      model: body.model,
    };
  }

  // Wake the whole path ahead of the first clip. Measured from a cold
  // service on microsoft/mai-transcribe-2, the first transcription took 4 to
  // 5 s and the next 0.6 s; a HEAD request warmed the connection but not the
  // model behind it, and the first real dictation still paid. So the warm-up
  // is a real transcription of a third of a second of silence: a fraction of
  // a cent, and the cold start lands here instead of on whoever dictates
  // first.
  //
  // The app also asks for this when a recording starts (POST
  // /v1/transcribe/warm): measured 2026-09-13 on MAI, the provider answers a
  // clip in ~0.5 s when it handled one moments ago and in 2-3 s after a gap
  // of a few seconds, and a short dictation has no earlier segment to hide
  // that behind. Warm-ups are coalesced: one in flight serves every caller,
  // and one that finished within WARM_FRESH_MS is not repeated, so a user
  // tapping the hotkey pays for one silent clip, not one per tap. While the
  // user records, the app asks again after three quiet seconds so the model
  // is still warm when they stop; see WARM_FRESH_MS.
  //
  // With an AssemblyAI main model none of this is sent (warmUpstream above):
  // the call still answers true, because the model is as ready as it will
  // get, and nothing is billed.
  function warmUp() {
    if (!apiKey) return Promise.resolve(false);
    if (!warmUpstream) return Promise.resolve(true);
    if (warmInFlight) return warmInFlight;
    if (warmedAt && Date.now() - warmedAt < WARM_FRESH_MS) return Promise.resolve(true);
    // A silent clip is not worth a second model, nor a second request.
    warmInFlight = transcribe({ audioBase64: SILENT_WAV_BASE64, format: 'wav', hedge: false, rescue: false })
      .then(() => true, () => false)
      .finally(() => { warmInFlight = null; });
    return warmInFlight;
  }

  // `settings` is what the options came to, for the log and the tests.
  return {
    transcribe, warmUp, model, configured: !!apiKey,
    settings: { hedgeMs: hedgeBaseMs, rescueModel, rescueMs: rescueBaseMs, warmUp: warmUpstream },
  };
}

module.exports = {
  createCloudTranscriber, wavSeconds, hedgeAfterMs, rescueAfterMs, rescuePrompt, resolveLanguage, ASSEMBLYAI_LANGUAGES, GENERAL_LANGUAGES,
  DEFAULT_MODEL, DEFAULT_UPSTREAM_URL, DEFAULT_HEDGE_MS, DEFAULT_RESCUE_MODEL, DEFAULT_RESCUE_MS, RESCUE_PROMPT_MAX, WARM_FRESH_MS, MAX_PHRASES,
};
