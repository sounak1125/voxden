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
// Measured on 2026-09-11 against microsoft/mai-transcribe-2 through
// OpenRouter: 30 phrases accepted, 60 refused with a 400, single words and
// multi-word terms alike. The exact ceiling is somewhere between; 30 is the
// largest count seen to work. The app ranks terms by recency and use, so
// the cut keeps the ones that matter.
const MAX_PHRASES = 30;
// How long a finished warm-up counts as keeping the model warm. The cold
// answer was seen after gaps of five seconds and more; two and a half keeps
// a second hotkey tap from sending another silent clip.
const WARM_FRESH_MS = 2500;

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
// provider bills, so a client cannot shave its own count.
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
      byteRate = buf.readUInt32LE(body + 8);
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

  async function transcribe(request) {
    const req = request || {};
    if (!apiKey) throw Object.assign(new Error('Cloud transcription is not configured on this server.'), { code: 'unconfigured' });
    let phrases = Array.isArray(req.terms)
      ? req.terms.map((t) => String(t || '').trim()).filter(Boolean).slice(0, MAX_PHRASES)
      : [];
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (req.signal?.aborted) cancel();
    else req.signal?.addEventListener('abort', cancel, { once: true });
    // One deadline covers every attempt, response body and backoff together.
    const timer = setTimeout(cancel, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const abortError = () => Object.assign(new Error(req.signal?.aborted
      ? 'Dictation cancelled.' : 'The speech model did not answer in time.'),
      { code: req.signal?.aborted ? 'cancelled' : 'timeout' });
    let hintsDropped = false, retries = 0;
    try {
      for (let index = 0; index < 3; index++) {
        if (controller.signal.aborted) throw abortError();
        try {
          const result = await attempt(req, phrases, controller.signal);
          if (controller.signal.aborted) throw abortError();
          if (hintsDropped) result.hintsDropped = true;
          if (retries) { result.retried = true; result.retries = retries; }
          return result;
        } catch (err) {
          if (controller.signal.aborted) throw abortError();
          if (index === 2) throw err;
          // Dictionary hints are optional; a rejected list should not lose speech.
          if (phrases.length && err.status === 400) {
            phrases = []; hintsDropped = true;
            continue;
          }
          const transient = [408, 429, 500, 502, 503, 504].includes(err.status)
            || (err.code === 'upstream' && !err.status);
          if (!transient) throw err;
          const delay = Math.max(1000 * 2 ** retries, err.retryAfterMs || 0);
          if (Date.now() + delay >= deadline) throw err;
          retries++;
          // Retry only this rejected segment. Successful earlier segments stay
          // in the desktop queue and the relay meters only the final success.
          await retryWait(delay, controller.signal);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) throw abortError();
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', cancel);
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
      model,
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
  // tapping the hotkey pays for one silent clip, not one per tap.
  let warmInFlight = null;
  let warmedAt = 0;
  function warmUp() {
    if (!apiKey) return Promise.resolve(false);
    if (warmInFlight) return warmInFlight;
    if (warmedAt && Date.now() - warmedAt < WARM_FRESH_MS) return Promise.resolve(true);
    warmInFlight = transcribe({ audioBase64: SILENT_WAV_BASE64, format: 'wav' })
      .then(() => { warmedAt = Date.now(); return true; }, () => false)
      .finally(() => { warmInFlight = null; });
    return warmInFlight;
  }

  return { transcribe, warmUp, model, configured: !!apiKey };
}

module.exports = { createCloudTranscriber, wavSeconds, DEFAULT_MODEL, DEFAULT_UPSTREAM_URL };
