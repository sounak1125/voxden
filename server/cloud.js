'use strict';

// The upstream speech model, behind one function, plus what the relay needs
// to meter a clip without trusting the caller.
//
// The provider is OpenRouter's OpenAI-shaped transcription endpoint. The
// model is a string in the environment, so swapping providers in January is
// a config change here and nothing in the desktop app.

const DEFAULT_UPSTREAM_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const DEFAULT_MODEL = 'microsoft/mai-transcribe-2';
const DEFAULT_TIMEOUT_MS = 20e3;
// microsoft/mai-transcribe-2 through OpenRouter refused 60 phrases with a 400
// on 2026-09-11. On 2026-10-08 it took 30, 40, 50, 60, 80 and 102 (850
// characters), and a name placed 102nd still corrected the text ("Vox10" to
// "Voxden"). More than 102 was not tried, so the cap stays just under it. A
// 400 with hints is retried without them, so a lower ceiling later costs
// hints, not the dictation. The app ranks terms by recency and use, so the
// cut keeps the ones that matter.
const MAX_PHRASES = 100;
// How long the model counts as warm after it last answered, warm-up or real
// clip. The cold answer was seen after gaps of five seconds and more. The app
// asks again every 2.5 s while the user is recording (src/main.js,
// CLOUD_KEEP_WARM_MS), so this sits below that: each of those asks wakes the
// model, while a second hotkey tap a moment later is still answered from the
// first. A clip answered in the meantime counts too, so a long dictation
// whose segments are already going up pays for no silent clips at all.
const WARM_FRESH_MS = 1500;
// Hedging. A warm model answers a clip in about half a second and a cold one in
// two or three, but now and then a request simply goes quiet, and the person
// who spoke waits out the whole of it. Once the first request has been quiet
// this long, a second identical one is sent beside it, the first answer wins
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
// assemblyai/universal-3-5-pro is the rescue. On 72 of the owner's clips
// (2026-10-12), with the dictionary sent, it answered in 0.5-1.3 s with 8.9%
// word error and 22 of 27 dictionary words, against 10.4% and 12 of 27 for
// openai/gpt-4o-mini-transcribe, at $0.45 per audio hour (the mini model came
// to $0.18-0.30 with its dictionary prompt billed as tokens). The main model
// still wins on accuracy (7.1%, 24 of 27), so the rescue is the second chance
// and never the first choice. The time allowed grows with the clip, like the
// hedge. CLOUD_RESCUE_MODEL names the model ('' or 'none' turns the rescue
// off), and CLOUD_RESCUE_MS the base, where 0 also turns it off. The warm-up
// never rescues.
const DEFAULT_RESCUE_MODEL = 'assemblyai/universal-3-5-pro';
const DEFAULT_RESCUE_MS = 4000;
const RESCUE_PER_SECOND_MS = 100;
const RESCUE_MAX_MS = 8000;
// The dictionary reaches the rescue the way that model's maker takes hints,
// and OpenRouter passes them through only as provider options. Azure's
// phraseList belongs to the main model alone and is never sent to a rescue.
//  - assemblyai/...: provider.options.assemblyai.keyterms_prompt, the same
//    cleaned list the main model gets (verified live on 2026-10-14 with 24 and
//    100 terms). The unified keyterms field and word_boost do nothing there.
//  - openai/...: a "Vocabulary: A, B, C" prompt in provider.options.openai.prompt,
//    the only way OpenRouter passes hints to OpenAI's models (the unified
//    keyterms field is refused with a 400). It is long enough for a few dozen
//    names and no longer, because a transcription model treats a prompt as
//    text it may continue.
//  - any other family: no hints, because how it takes them is unknown.
const RESCUE_PROMPT_MAX = 800;
const RESCUE_PROMPT_HEAD = 'Vocabulary: ';

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

// What the rescue request carries for the dictionary, by who makes the model:
// { provider } to merge into the body (absent when there is nothing to send),
// and `prompted` when that is a text prompt a model may read back.
function rescueHints(model, terms) {
  const family = String(model || '').split('/')[0].trim().toLowerCase();
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
  const rescueName = opts.rescueModel === undefined || opts.rescueModel === null
    ? DEFAULT_RESCUE_MODEL : String(opts.rescueModel).trim();
  const rescueBaseMs = opts.rescueMs === undefined || opts.rescueMs === null || opts.rescueMs === ''
    ? DEFAULT_RESCUE_MS : Number(opts.rescueMs);
  const rescueModel = rescueName === '' || rescueName.toLowerCase() === 'none' || !(rescueBaseMs > 0) ? '' : rescueName;
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
          // still out: its answer is the last one to wait for. Anything else
          // (a refused request, bad audio) is the answer today, rescue or not.
          if (rescue.running && isTransient(err)) {
            rescue.done.then((answer) => {
              if (answer) return;
              settle(reject, controller.signal.aborted ? abortError() : err);
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
    if (phrases.length) {
      // Keyword biasing, as the model's OpenRouter page documents it.
      body.provider = { options: { azure: { phraseList: { phrases } } } };
    }
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
    if (hints.provider) body.provider = hints.provider;
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
  // service, the first transcription took 4 to 5 s and the next 0.6 s; a
  // HEAD request warmed the connection but not the model behind it, and the
  // first real dictation still paid. So the warm-up is a real transcription
  // of a third of a second of silence: a fraction of a cent, and the cold
  // start lands here instead of on whoever dictates first.
  //
  // The app also asks for this when a recording starts (POST
  // /v1/transcribe/warm): measured 2026-09-13, the provider answers a clip
  // in ~0.5 s when it handled one moments ago and in 2-3 s after a gap of a
  // few seconds, and a short dictation has no earlier segment to hide that
  // behind. Warm-ups are coalesced: one in flight serves every caller, and
  // one that finished within WARM_FRESH_MS is not repeated, so a user
  // tapping the hotkey pays for one silent clip, not one per tap. While the
  // user records, the app repeats the request so the model is still warm
  // when they stop; see WARM_FRESH_MS.
  function warmUp() {
    if (!apiKey) return Promise.resolve(false);
    if (warmInFlight) return warmInFlight;
    if (warmedAt && Date.now() - warmedAt < WARM_FRESH_MS) return Promise.resolve(true);
    // A silent clip is not worth a second model, nor a second request.
    warmInFlight = transcribe({ audioBase64: SILENT_WAV_BASE64, format: 'wav', hedge: false, rescue: false })
      .then(() => true, () => false)
      .finally(() => { warmInFlight = null; });
    return warmInFlight;
  }

  // `settings` is what the options came to, for the log and the tests.
  return { transcribe, warmUp, model, configured: !!apiKey, settings: { hedgeMs: hedgeBaseMs, rescueModel, rescueMs: rescueBaseMs } };
}

module.exports = {
  createCloudTranscriber, wavSeconds, hedgeAfterMs, rescueAfterMs, rescuePrompt,
  DEFAULT_MODEL, DEFAULT_UPSTREAM_URL, DEFAULT_HEDGE_MS, DEFAULT_RESCUE_MODEL, DEFAULT_RESCUE_MS, RESCUE_PROMPT_MAX, WARM_FRESH_MS, MAX_PHRASES,
};
