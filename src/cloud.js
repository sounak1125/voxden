'use strict';

// The desktop side of cloud transcription: one clip, one request to the
// relay, one answer or one reason it did not happen.
//
// Pure by construction. The network goes through `fetchImpl`, the session
// token through `token`, so main.js hands in Electron's fetch and the account
// manager and the tests hand in fakes. Every failure is an Error carrying a
// `code` the caller can act on:
//
//   timeout   the relay did not answer within the request budget
//   network   the relay could not be reached
//   auth      no session, or the relay rejected it
//   plan      the account is not Pro
//   cap       this month's hours are used up
//   upstream  the speech model failed behind the relay
//
// The caller decides what to do with each; this module only names them.

const MIN_CLIP_SECONDS = 0.3;
// The relay answers a warm-up request at once, before the model does; this
// only bounds a relay that cannot be reached, so the request is not left open.
const WARM_TIMEOUT_MS = 4000;

// The relay has a 20-second total recovery budget. Leave room for that
// budget and the audio upload; a fast success still returns immediately.
function cloudTimeoutMs(audioSeconds) {
  const sec = Math.max(0, Number(audioSeconds) || 0);
  return Math.min(40000, Math.round(25000 + sec * 50));
}

function shouldTryCloud(options) {
  const opts = options || {};
  if (!opts.enabled) return { ok: false, reason: 'off' };
  const account = opts.account || null;
  if (!account || !account.signedIn) return { ok: false, reason: 'signed-out' };
  if (account.plan !== 'pro') return { ok: false, reason: 'plan' };
  const cloud = account.cloud || {};
  if (Number(cloud.creditsCap) > 0 && Number(cloud.creditsUsed) >= Number(cloud.creditsCap)) {
    return { ok: false, reason: 'cap' };
  }
  if (Number(cloud.hoursCap) > 0 && Number(cloud.hoursUsed) >= Number(cloud.hoursCap)) return { ok: false, reason: 'cap' };
  if (!(Number(opts.audioSeconds) >= MIN_CLIP_SECONDS)) return { ok: false, reason: 'short' };
  return { ok: true, reason: '' };
}

class CloudTranscriber {
  constructor(options) {
    const opts = options || {};
    this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.token = typeof opts.token === 'function' ? opts.token : () => '';
    this.now = opts.now || (() => Date.now());
  }

  // Ask the relay to wake the model, as a recording starts. The answer is a
  // bare yes or no and nothing depends on it: a dictation proceeds the same
  // way whether the warm-up landed, was refused or never reached the relay.
  // It only decides whether the clip sent at stop meets a warm model.
  async warm() {
    const token = this.token();
    if (!token) return false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), WARM_TIMEOUT_MS) : null;
    try {
      const res = await this.fetch(this.baseUrl + '/transcribe/warm', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        signal: controller ? controller.signal : undefined,
      });
      return !!(res && res.ok);
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async transcribe(wav, options) {
    const opts = options || {};
    const token = this.token();
    if (!token) throw Object.assign(new Error('Not signed in.'), { code: 'auth' });
    const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
    const body = { audio: buf.toString('base64'), format: 'wav' };
    // 'auto' is more than one dictation language: no hint, the model detects.
    if (opts.language && opts.language !== 'auto') body.language = String(opts.language);
    if (Array.isArray(opts.terms) && opts.terms.length) body.terms = opts.terms.slice(0, 100);
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : cloudTimeoutMs(opts.audioSeconds);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const cancel = () => controller?.abort();
    if (opts.signal?.aborted) cancel();
    else opts.signal?.addEventListener('abort', cancel, { once: true });
    const started = this.now();
    let res;
    let parsed = null;
    try {
      res = await this.fetch(this.baseUrl + '/transcribe', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      // Headers can arrive long before the response body finishes. Keep the
      // same deadline active while reading it, and do not swallow an abort
      // as though the relay had returned malformed JSON.
      try { parsed = await res.json(); } catch (err) {
        if ((controller && controller.signal.aborted)
            || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) throw err;
      }
    } catch (err) {
      if (opts.signal?.aborted) throw Object.assign(new Error('Dictation cancelled.'), { code: 'cancelled' });
      const timedOut = (controller && controller.signal.aborted)
        || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
      const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
      let message = 'Cloud transcription could not be reached.';
      if (timedOut) message = 'Cloud transcription timed out.';
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        message = 'Cloud transcription could not be reached (the account host name could not be found).';
      } else if (code === 'ECONNREFUSED') {
        message = 'Cloud transcription could not be reached (the account service is not running).';
      }
      throw Object.assign(new Error(message), { code: timedOut ? 'timeout' : 'network' });
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
    }
    if (!res.ok) {
      const code = (parsed && parsed.code)
        || (res.status === 401 ? 'auth' : res.status === 402 ? 'plan' : 'upstream');
      throw Object.assign(new Error((parsed && parsed.error) || ('Cloud transcription returned ' + res.status + '.')),
        { code, status: res.status });
    }
    return {
      text: String((parsed && parsed.text) || ''),
      seconds: Number(parsed && parsed.seconds) || 0,
      cloud: (parsed && parsed.cloud) || null,
      ms: this.now() - started,
    };
  }
}

// The speech provider rate limits now and then. The relay has already retried
// by the time a 429 reaches the app, and it passes the provider's status on in
// its message ("The speech model returned 429: ..."), under its own 502.
function providerBusy(err) {
  return !!err && err.code === 'upstream' && /\breturned 429\b/.test(String(err.message || ''));
}

// Cloud first; the local engine only when the provider was busy. Every other
// cloud failure -- plan, cap, sign-in, network, a cancel -- keeps its own
// message, and so does a busy provider when the local engine cannot answer
// either: "download a speech model" is not what went wrong.
async function cloudThenLocal(cloud, local, hooks) {
  const h = hooks || {};
  try {
    return await cloud();
  } catch (err) {
    if (!providerBusy(err) || (h.allowed && !h.allowed())) throw err;
    if (h.starting) h.starting(err);
    try {
      return await local();
    } catch (_) {
      throw err;
    }
  }
}

module.exports = { CloudTranscriber, cloudTimeoutMs, shouldTryCloud, providerBusy, cloudThenLocal, MIN_CLIP_SECONDS };
