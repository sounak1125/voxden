'use strict';

// The desktop side of Polish: one text, one request to the relay, one polished
// text back or one reason it did not happen. Like src/cloud.js, the network
// goes through `fetchImpl` and the session token through `token`, and every
// failure is an Error with a `code` the caller can act on:
//
//   empty     nothing to polish
//   long      over the words one polish takes
//   auth      no session, or the relay rejected it
//   plan      the account is not Pro
//   cap       not enough cloud credits left for this polish
//   blocked   the model would not polish this text (nothing charged)
//   timeout   no answer in time (nothing charged)
//   network   the relay could not be reached
//   upstream  the model failed behind the relay (nothing charged)

const credits = require('./credits');

// What the relay can do to a text (server/polish.js MODES, which the app does
// not ship): polish it, correct its grammar only, or tighten it. One price.
const POLISH_MODES = ['polish', 'grammar', 'tighten'];

// Whether a polish may be offered, and what it would cost, before anything is
// sent: the answer the flow bar and the Polish page show next to the button.
function polishQuote(text, account) {
  const words = credits.polishWords(text);
  const cost = credits.polishCredits(words);
  const quote = {
    words,
    credits: cost,
    label: credits.creditAmountLabel(cost),
    maxWords: credits.POLISH_MAX_WORDS,
    remaining: null,
    ok: false,
    reason: '',
  };
  const acct = account || null;
  if (!words) return Object.assign(quote, { reason: 'empty' });
  if (words > credits.POLISH_MAX_WORDS) return Object.assign(quote, { reason: 'long' });
  if (!acct || !acct.signedIn) return Object.assign(quote, { reason: 'signed-out' });
  if (acct.plan !== 'pro') return Object.assign(quote, { reason: 'plan' });
  const meter = credits.normalizeCloud(acct.cloud);
  if (meter) {
    quote.remaining = meter.creditsRemaining;
    if (meter.creditsCap > 0 && meter.creditsRemaining < cost) return Object.assign(quote, { reason: 'cap' });
  }
  return Object.assign(quote, { ok: true });
}

class PolishClient {
  constructor(options) {
    const opts = options || {};
    this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.token = typeof opts.token === 'function' ? opts.token : () => '';
    this.now = opts.now || (() => Date.now());
  }

  async polish(text, options) {
    const opts = options || {};
    const body = { text: String(text || '').trim() };
    if (!body.text) throw Object.assign(new Error('Nothing to polish.'), { code: 'empty' });
    const token = this.token();
    if (!token) throw Object.assign(new Error('Sign in to use Polish.'), { code: 'auth' });
    if (Array.isArray(opts.terms) && opts.terms.length) body.terms = opts.terms.slice(0, 100);
    const mode = opts.mode === undefined ? 'polish' : String(opts.mode);
    if (!POLISH_MODES.includes(mode)) throw Object.assign(new Error('Unknown polish mode.'), { code: 'mode' });
    if (mode !== 'polish') body.mode = mode;
    // A short polish answers in about a second, a 2,000-word one in about half
    // a minute; the wait covers the relay trying both of its models on it.
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs)
      : credits.polishWaitMs(credits.polishWords(body.text));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => controller.abort();
    if (opts.signal && opts.signal.aborted) cancel();
    else if (opts.signal) opts.signal.addEventListener('abort', cancel, { once: true });
    const started = this.now();
    let res;
    let parsed = null;
    try {
      res = await this.fetch(this.baseUrl + '/polish', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      try { parsed = await res.json(); } catch (err) {
        if (controller.signal.aborted) throw err;
      }
    } catch (err) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Polish cancelled.'), { code: 'cancelled' });
      if (controller.signal.aborted) throw Object.assign(new Error('Polish timed out. Nothing was charged.'), { code: 'timeout' });
      throw Object.assign(new Error('Polish could not reach Voxden Cloud. Check your connection.'), { code: 'network' });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', cancel);
    }
    if (!res.ok) {
      const code = (parsed && parsed.code)
        || (res.status === 401 ? 'auth' : res.status === 402 ? 'plan' : 'upstream');
      throw Object.assign(new Error((parsed && parsed.error) || ('Polish returned ' + res.status + '.')), { code, status: res.status });
    }
    // A relay from before the modes ignores one and polishes; it also sends no
    // mode back. Its polish was still charged, but it is not what was asked for.
    if (mode !== 'polish' && (!parsed || parsed.mode !== mode)) {
      throw Object.assign(new Error('Voxden Cloud cannot do this yet. Try Polish instead.'), { code: 'mode' });
    }
    return {
      text: String((parsed && parsed.text) || ''),
      mode,
      credits: Number(parsed && parsed.credits) || 0,
      cloud: (parsed && parsed.cloud) || null,
      ms: this.now() - started,
    };
  }
}

module.exports = { PolishClient, polishQuote, POLISH_MODES };
