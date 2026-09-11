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

const DEFAULT_BASE_URL = 'https://account.voxden.app/v1';
const GRACE_MS = 7 * 24 * 3600e3;
const REFRESH_EVERY_MS = 6 * 3600e3;
const REQUEST_TIMEOUT_MS = 15e3;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : '';
}

function friendlyNetworkError(err) {
  const name = err && err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'The account service did not answer in time. Check your connection and try again.';
  return 'Could not reach the account service. Check your connection and try again.';
}

class AccountManager {
  constructor(options) {
    const opts = options || {};
    this.file = opts.file;
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
  }

  save() {
    if (!this.file) return;
    const out = {
      email: this.state.email,
      account: this.state.account,
      fetchedAt: this.state.fetchedAt,
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
      checkedAt: this.state.fetchedAt || 0,
      stale,
      busy: this.busy,
      lastError: this.lastError,
      tokenProtected: this.tokenProtected,
      baseUrl: this.baseUrl,
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
      throw Object.assign(new Error(friendlyNetworkError(err)), { network: true });
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
}

module.exports = { AccountManager, normalizeEmail, DEFAULT_BASE_URL, GRACE_MS, REFRESH_EVERY_MS };
