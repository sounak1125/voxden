'use strict';

// The desktop side of the account: sign in with an emailed code, keep the
// session token, and remember what the plan entitles this PC to.
//
// Everything network-facing goes through `fetchImpl` and everything secret
// through `encrypt`/`decrypt`, so main.js hands in Electron's fetch and
// safeStorage and the tests hand in fakes. The file on disk carries the token
// only in its encrypted form.
//
// The plan the app acts on is the cached answer from the last successful
// /v1/me, trusted for GRACE_MS after it was fetched. A laptop that has been
// offline for a week is still Pro; one that has been offline for a month is
// Free until it can ask again. Nothing here downgrades a user because a
// request happened to fail.

const fs = require('fs');
const path = require('path');
const os = require('os');

// The production account service. VOXDEN_ACCOUNT_URL in the environment
// overrides it for a staging or local instance; nothing else does.
const DEFAULT_BASE_URL = 'https://account.voxden.app/v1';
const GRACE_MS = 7 * 24 * 3600e3;
const REFRESH_EVERY_MS = 6 * 3600e3;
const REQUEST_TIMEOUT_MS = 15e3;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : '';
}

function networkErrorCode(err) {
  return (err && err.cause && err.cause.code) || (err && err.code) || '';
}

function hostOf(baseUrl) {
  try { return new URL(baseUrl).host; } catch (_) { return ''; }
}

function friendlyNetworkError(err, baseUrl) {
  const name = err && err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'The account service did not answer in time. Check your connection and try again.';
  const host = hostOf(baseUrl);
  const code = networkErrorCode(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Could not reach the account service'
      + (host ? ' at ' + host : '')
      + '. The host name could not be found. For local cloud, run npm run server and npm run start:local-cloud.';
  }
  if (code === 'ECONNREFUSED') {
    return 'Could not reach the account service'
      + (host ? ' at ' + host : '')
      + '. Nothing is listening there. If you are developing locally, run npm run server.';
  }
  return 'Could not reach the account service. Check your connection and try again.';
}

class AccountManager {
  constructor(options) {
    const opts = options || {};
    this.file = opts.file;
    // An explicit URL (env, tests, start:local-cloud) wins. Otherwise a
    // previous successful session remembers which service issued the token,
    // so `npm start` does not silently send a local Pro session to production.
    this.explicitBaseUrl = opts.baseUrl != null && String(opts.baseUrl).trim() !== '';
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.encrypt = opts.encrypt || null;
    this.decrypt = opts.decrypt || null;
    this.now = opts.now || (() => Date.now());
    this.graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : GRACE_MS;
    this.device = String(opts.device || os.hostname() || 'Windows PC').slice(0, 120);
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.state = { email: '', token: '', account: null, fetchedAt: 0 };
    this.pendingEmail = '';
    this.lastError = '';
    this.busy = '';
    this.tokenProtected = !!(this.encrypt && this.decrypt);
    this.billing = null;
    this.auth = null;
    this.checkoutPending = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return; }
    if (!raw || typeof raw !== 'object') return;
    let token = '';
    try {
      if (raw.tokenCipher && this.decrypt) token = this.decrypt(Buffer.from(raw.tokenCipher, 'base64'));
      else if (raw.tokenPlain && !this.decrypt) token = String(raw.tokenPlain);
    } catch (_) {
      // A token this PC can no longer decrypt is a token that is gone.
      token = '';
    }
    this.state = {
      email: normalizeEmail(raw.email),
      token: token && this.state ? String(token) : '',
      account: raw.account && typeof raw.account === 'object' ? raw.account : null,
      fetchedAt: Number(raw.fetchedAt) || 0,
    };
    if (!this.state.token) this.state.account = null;
    if (!this.explicitBaseUrl && raw.baseUrl) {
      const saved = String(raw.baseUrl).replace(/\/+$/, '');
      if (saved) this.baseUrl = saved;
    }
  }

  save() {
    if (!this.file) return;
    const out = {
      email: this.state.email,
      account: this.state.account,
      fetchedAt: this.state.fetchedAt,
      baseUrl: this.baseUrl,
    };
    if (this.state.token) {
      if (this.encrypt) out.tokenCipher = Buffer.from(this.encrypt(this.state.token)).toString('base64');
      else out.tokenPlain = this.state.token;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  changed() {
    try { this.onChange(this.snapshot()); } catch (_) {}
  }

  signedIn() {
    return !!(this.state.token && this.state.email);
  }

  // What the app should act on right now.
  snapshot() {
    const t = this.now();
    const account = this.state.account;
    const age = account ? t - this.state.fetchedAt : Infinity;
    const stale = this.signedIn() && (!account || age > this.graceMs);
    let plan = 'free';
    if (this.signedIn() && account && !stale) {
      plan = String(account.plan || 'free');
      if (plan !== 'free' && account.planExpiresAt && Date.parse(account.planExpiresAt) <= t) plan = 'free';
    }
    return {
      signedIn: this.signedIn(),
      email: this.state.email,
      pendingEmail: this.pendingEmail,
      plan,
      planExpiresAt: plan === 'free' ? null : (account && account.planExpiresAt) || null,
      cloud: plan === 'free' ? { hoursUsed: 0, hoursCap: 0, periodEnd: null } : (account && account.cloud) || null,
      // The free plan's weekly word allowance, as the service last stated it.
      // Not an entitlement that expires with the plan, so a stale cache still
      // reports it; null means this PC has never been told, and src/quota.js
      // falls back to its own figure.
      freeWeeklyWords: account && Number(account.freeWeeklyWords) > 0 ? Math.round(Number(account.freeWeeklyWords)) : null,
      checkedAt: this.state.fetchedAt || 0,
      stale,
      busy: this.busy,
      lastError: this.lastError,
      tokenProtected: this.tokenProtected,
      baseUrl: this.baseUrl,
      billing: this.billing,
      auth: this.auth || null,
      checkoutPending: this.checkoutPending ? Object.assign({}, this.checkoutPending) : null,
    };
  }

  async request(route, options) {
    const opts = options || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.auth && this.state.token) headers.Authorization = 'Bearer ' + this.state.token;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let res;
    try {
      res = await this.fetch(this.baseUrl + route, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error(friendlyNetworkError(err, this.baseUrl)), { network: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body = null;
    if (res.status !== 204) {
      try { body = await res.json(); } catch (_) { body = null; }
    }
    if (!res.ok) {
      const message = body && body.error ? String(body.error) : 'The account service returned ' + res.status + '.';
      throw Object.assign(new Error(message), { status: res.status });
    }
    return body || {};
  }

  async requestCode(email) {
    const clean = normalizeEmail(email);
    if (!clean) throw new Error('Enter a valid email address.');
    this.busy = 'code';
    this.lastError = '';
    this.changed();
    try {
      await this.request('/auth/code', { method: 'POST', body: { email: clean } });
      this.pendingEmail = clean;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    } finally {
      this.busy = '';
      this.changed();
    }
  }

  async verifyCode(email, code) {
    const clean = normalizeEmail(email || this.pendingEmail);
    const digits = String(code || '').replace(/\D/g, '');
    if (!clean) throw new Error('Enter a valid email address.');
    if (digits.length !== 6) throw new Error('Enter the six-digit code from the email.');
    this.busy = 'verify';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/auth/verify', {
        method: 'POST', body: { email: clean, code: digits, device: this.device },
      });
      if (!result.token) throw new Error('The account service did not return a session.');
      this.state = {
        email: clean, token: String(result.token),
        account: result.account || null, fetchedAt: this.now(),
      };
      this.pendingEmail = '';
      this.save();
    } catch (err) {
      this.lastError = err.message;
      throw err;
    } finally {
      this.busy = '';
      this.changed();
    }
  }

  // Which sign-in routes the service offers besides the emailed code. Cached
  // once known; the answer only changes when the service is reconfigured.
  async authOptions() {
    if (this.auth) return this.auth;
    const result = await this.request('/auth/options');
    const google = result && result.google && result.google.clientId ? String(result.google.clientId) : '';
    this.auth = { google: !!google, googleClientId: google };
    this.changed();
    return this.auth;
  }

  // The tail of a Google sign-in: the code from the browser goes to the
  // service, which trades it with Google and answers with the same session
  // shape as a verified email code.
  async signInWithGoogle(grant) {
    const g = grant || {};
    if (!g.code || !g.codeVerifier || !g.redirectUri) throw new Error('Google sign-in did not finish. Try again.');
    this.busy = 'google';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/auth/google', {
        method: 'POST', body: { code: g.code, codeVerifier: g.codeVerifier, redirectUri: g.redirectUri, device: this.device },
      });
      if (!result.token || !result.account || !result.account.email) throw new Error('The account service did not return a session.');
      this.state = {
        email: normalizeEmail(result.account.email), token: String(result.token),
        account: result.account, fetchedAt: this.now(),
      };
      this.pendingEmail = '';
      this.save();
    } catch (err) {
      this.lastError = err.message;
      throw err;
    } finally {
      this.busy = '';
      this.changed();
    }
  }

  // Ask the service what this account is entitled to. A network failure keeps
  // the cached answer; a 401 means the session is gone and the PC is signed
  // out. Returns the snapshot either way, so callers never have to catch.
  async refresh(options) {
    const opts = options || {};
    if (!this.signedIn()) return this.snapshot();
    const age = this.now() - this.state.fetchedAt;
    if (!opts.force && this.state.account && age < REFRESH_EVERY_MS) return this.snapshot();
    this.busy = 'refresh';
    this.changed();
    try {
      const result = await this.request('/me', { auth: true });
      this.state.account = result.account || this.state.account;
      this.state.fetchedAt = this.now();
      this.lastError = '';
      this.save();
    } catch (err) {
      if (err.status === 401) {
        this.state = { email: '', token: '', account: null, fetchedAt: 0 };
        this.lastError = 'You were signed out. Sign in again to keep your plan on this PC.';
        this.save();
      } else {
        this.lastError = err.message;
      }
    } finally {
      this.busy = '';
      this.changed();
    }
    return this.snapshot();
  }

  // A report from the Help menu. Signed in or not; the token, when there is
  // one, lets the service attach the sender's account.
  async sendFeedback(report) {
    await this.request('/feedback', { method: 'POST', auth: true, body: report });
  }

  async signOut() {
    const hadToken = !!this.state.token;
    if (hadToken) {
      this.busy = 'signout';
      this.changed();
      try {
        await this.request('/auth/signout', { method: 'POST', auth: true });
      } catch (_) {
        // The token is forgotten here whether or not the service heard; a
        // revocation that did not land expires on its own.
      }
    }
    this.state = { email: '', token: '', account: null, fetchedAt: 0 };
    this.pendingEmail = '';
    this.lastError = '';
    this.busy = '';
    this.save();
    this.changed();
    return this.snapshot();
  }

  cancelPending() {
    this.pendingEmail = '';
    this.lastError = '';
    this.changed();
  }

  // --- billing ------------------------------------------------------------
  // The app never sees a card. Checkout is a URL the service creates and the
  // system browser opens; the plan flips when the provider's webhook lands,
  // and the app notices by refreshing /me while a checkout is pending.

  async billingOptions() {
    const result = await this.request('/billing/options');
    this.billing = Object.assign({}, this.billing || {}, { options: Array.isArray(result.options) ? result.options : [] });
    this.changed();
    return this.billing.options;
  }

  async checkout(provider, plan) {
    if (!this.signedIn()) throw new Error('Sign in first.');
    this.busy = 'checkout';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/billing/checkout', { method: 'POST', auth: true, body: { provider, plan } });
      if (!result.url) throw new Error('The payment page could not be opened.');
      this.checkoutPending = { provider: result.provider, plan: result.plan, startedAt: this.now() };
      return result.url;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    } finally {
      this.busy = '';
      this.changed();
    }
  }

  // What the service knows about the subscription behind the plan.
  async billingStatus() {
    if (!this.signedIn()) return null;
    return this.applyBilling(await this.request('/billing', { auth: true }));
  }

  // Stop renewal. The service answers with the subscription as it now
  // stands: paid through its period end, renewing no more.
  async cancelSubscription() {
    if (!this.signedIn()) throw new Error('Sign in first.');
    this.busy = 'cancel';
    this.lastError = '';
    this.changed();
    try {
      return this.applyBilling(await this.request('/billing/cancel', { method: 'POST', auth: true }));
    } finally {
      this.busy = '';
      this.changed();
    }
  }

  applyBilling(result) {
    this.billing = Object.assign({}, this.billing || {}, { subscription: result.subscription || null });
    if (result.account) {
      this.state.account = result.account;
      this.state.fetchedAt = this.now();
      this.save();
    }
    this.changed();
    return this.billing.subscription;
  }

  // A pending checkout ends when the plan turns Pro or after twenty minutes.
  checkoutSettled() {
    if (!this.checkoutPending) return true;
    const snap = this.snapshot();
    if (snap.plan === 'pro' || this.now() - this.checkoutPending.startedAt > 20 * 60e3) {
      this.checkoutPending = null;
      this.changed();
      return true;
    }
    return false;
  }

  // The raw session token, for the one caller that speaks to the relay on
  // this account's behalf. Main-process only; it never crosses to a renderer.
  token() {
    return this.state.token || '';
  }

  // The relay answers every clip with the running total, which is fresher
  // than the last /me. Fold it into the cache so the panel and the next
  // should-try-cloud decision see it without another round trip.
  noteCloudUsage(cloud) {
    if (!cloud || !this.state.account) return;
    this.state.account = Object.assign({}, this.state.account, { cloud: Object.assign({}, this.state.account.cloud || {}, cloud) });
    try { this.save(); } catch (_) {}
    this.changed();
  }
}

module.exports = { AccountManager, normalizeEmail, DEFAULT_BASE_URL, GRACE_MS, REFRESH_EVERY_MS };
