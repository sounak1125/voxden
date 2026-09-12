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

// How long to wait for the relay before reporting a failed request. Median
// answers take under half a second; the tail runs to many seconds, and a
// dictation that pastes after four seconds of nothing feels broken. Upload
// time scales with the clip, so the budget does too, within a ceiling.
function cloudTimeoutMs(audioSeconds) {
  const sec = Math.max(0, Number(audioSeconds) || 0);
  return Math.min(12000, Math.round(3500 + sec * 250));
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

module.exports = { CloudTranscriber, cloudTimeoutMs, shouldTryCloud, MIN_CLIP_SECONDS };
