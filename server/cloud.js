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
    const phrases = Array.isArray(req.terms)
      ? req.terms.map((t) => String(t || '').trim()).filter(Boolean).slice(0, MAX_PHRASES)
      : [];
    try {
      return await attempt(req, phrases);
    } catch (err) {
      // The provider has been seen to answer 400 to a real dictionary as a
      // phrase list while accepting the same clip without one. The hints
      // are an optimisation; the transcript is the job. Try once more bare.
      if (phrases.length && err && err.status === 400) {
        const result = await attempt(req, []);
        result.hintsDropped = true;
        return result;
      }
      throw err;
    }
  }

  async function attempt(req, phrases) {
    const body = {
      model,
      input_audio: { data: String(req.audioBase64 || ''), format: String(req.format || 'wav') },
    };
    if (req.language) body.language = String(req.language);
    if (phrases.length) {
      // Keyword biasing, as the model's OpenRouter page documents it.
      body.provider = { options: { azure: { phraseList: { phrases } } } };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
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
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw Object.assign(new Error(timedOut ? 'The speech model did not answer in time.' : 'The speech model could not be reached.'),
        { code: timedOut ? 'timeout' : 'upstream' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { parsed = null; }
    if (!res.ok) {
      const detail = parsed && parsed.error ? (parsed.error.message || parsed.error) : '';
      throw Object.assign(new Error('The speech model returned ' + res.status + (detail ? ': ' + String(detail).slice(0, 160) : '') + '.'),
        { code: 'upstream', status: res.status });
    }
    const usage = (parsed && parsed.usage) || {};
    return {
      text: String((parsed && parsed.text) || ''),
      billedSeconds: Number(usage.seconds) > 0 ? Number(usage.seconds) : 0,
      cost: Number(usage.cost) > 0 ? Number(usage.cost) : 0,
      model,
    };
  }

  // Establish DNS and TLS to the upstream ahead of the first clip. Measured
  // from a cold service, the first transcription took 5.4 s and the next
  // 0.7 s; the difference is connection setup and it lands on whichever
  // user dictates first. Any response counts, including an error.
  async function warmUp() {
    if (!apiKey) return false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      await fetchImpl(url, { method: 'HEAD', headers: { Authorization: 'Bearer ' + apiKey }, signal: controller ? controller.signal : undefined });
      return true;
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { transcribe, warmUp, model, configured: !!apiKey };
}

module.exports = { createCloudTranscriber, wavSeconds, DEFAULT_MODEL, DEFAULT_UPSTREAM_URL };
