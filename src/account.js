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
// overrides it for a staging or local instance. Explicit selections are saved
// separately from sign-in, so a restart before authentication keeps them.
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

function normalizeServiceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/+$/, '');
  } catch (_) { return ''; }
}

function friendlyNetworkError(err) {
  const name = err && err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'The account service did not answer in time. Check your connection and try again.';
  const code = networkErrorCode(err);
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return "Could not reach Voxden's account service. Please try again in a moment.";
  }
  return 'Could not reach the account service. Check your connection and try again.';
}

const STORAGE_ERROR = 'Could not unlock secure sign-in storage. Allow Keychain access and try again.';
const STORAGE_TIMEOUT_ERROR = 'Secure sign-in storage did not answer. Allow Keychain access, then retry.';
// How long a saved session may wait for the Keychain before the sign-in screen
// offers Retry and Forget. A consent dialog can sit unanswered or never appear.
const UNLOCK_TIMEOUT_MS = 60 * 1000;

// macOS Keychain can wait for consent indefinitely. Even the synchronous
// availability probe can block Electron's main thread, before a window exists.
// Keep Windows' DPAPI path unchanged; a Mac never falls back to plaintext.
function accountStorageOptions(storage, platform) {
  if (platform === 'darwin') {
    const available = async () => {
      if (!storage || typeof storage.isAsyncEncryptionAvailable !== 'function'
        || !(await storage.isAsyncEncryptionAvailable())) throw new Error(STORAGE_ERROR);
    };
    return {
      requireEncryption: true,
      encryptAsync: async text => { await available(); return storage.encryptStringAsync(text); },
      decryptAsync: async buffer => { await available(); return storage.decryptStringAsync(buffer); },
    };
  }
  const available = !!(storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable());
  return {
    encrypt: available ? text => storage.encryptString(text) : null,
    decrypt: available ? buffer => storage.decryptString(Buffer.from(buffer)) : null,
  };
}

class AccountManager {
  constructor(options) {
    const opts = options || {};
    this.file = opts.file;
    this.serviceFile = this.file ? path.join(path.dirname(this.file), 'account-service.json') : null;
    // An explicit URL (env, tests, start:local-cloud) wins. Otherwise a
    // previous successful session remembers which service issued the token,
    // so `npm start` does not silently send a local Pro session to production.
    this.explicitBaseUrl = opts.baseUrl != null && String(opts.baseUrl).trim() !== '';
    this.baseUrl = this.explicitBaseUrl ? opts.baseUrl : DEFAULT_BASE_URL;
    if (!normalizeServiceUrl(this.baseUrl)) throw new Error('Use HTTPS for the account service, or HTTP on localhost for local testing.');
    this.baseUrl = normalizeServiceUrl(this.baseUrl);
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.encrypt = opts.encrypt || null;
    this.decrypt = opts.decrypt || null;
    this.encryptAsync = opts.encryptAsync || null;
    this.decryptAsync = opts.decryptAsync || null;
    this.requireEncryption = !!opts.requireEncryption;
    this.unlockTimeoutMs = Number.isFinite(opts.unlockTimeoutMs) && opts.unlockTimeoutMs > 0
      ? opts.unlockTimeoutMs : UNLOCK_TIMEOUT_MS;
    this.credentialEpoch = 0;
    this.sessionRevision = 0;
    this.tokenCipher = '';
    this.cipherToken = '';
    this.pendingRestore = null;
    this.restorePromise = null;
    this.storageState = 'ready';
    this.now = opts.now || (() => Date.now());
    this.graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : GRACE_MS;
    this.device = String(opts.device || os.hostname() || 'Windows PC').slice(0, 120);
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    // What this PC has dictated in the free week it is inside, asked for at
    // refresh time so the service can see how the cap lands. Counts only;
    // main.js supplies it and returns null when there is nothing to say.
    this.freeWords = typeof opts.freeWords === 'function' ? opts.freeWords : null;
    this.state = { email: '', token: '', account: null, fetchedAt: 0 };
    this.pendingEmail = '';
    this.lastError = '';
    this.busy = '';
    this.tokenProtected = this.requireEncryption || !!((this.encrypt && this.decrypt) || (this.encryptAsync && this.decryptAsync));
    this.billing = null;
    this.auth = null;
    this.checkoutPending = null;
    this.load();
    this.ready = this.pendingRestore ? this.restore() : Promise.resolve(this.snapshot());
    if (this.explicitBaseUrl && this.serviceFile) {
      try {
        fs.mkdirSync(path.dirname(this.serviceFile), { recursive: true });
        const tmp = this.serviceFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ baseUrl: this.baseUrl }, null, 2));
        fs.renameSync(tmp, this.serviceFile);
      } catch (_) {
        this.lastError = 'Could not save your sign-in settings. Check available disk space and try again.';
      }
    }
  }

  load() {
    if (!this.file) return;
    let configured = '';
    try { configured = normalizeServiceUrl(JSON.parse(fs.readFileSync(this.serviceFile, 'utf8')).baseUrl); } catch (_) {}
    if (!this.explicitBaseUrl && configured) this.baseUrl = configured;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return; }
    if (!raw || typeof raw !== 'object') return;
    const sessionService = raw.baseUrl ? normalizeServiceUrl(raw.baseUrl) : DEFAULT_BASE_URL;
    if (!sessionService) return;
    if (!this.explicitBaseUrl && !configured) this.baseUrl = sessionService;
    // A staging/local selection must never send a production session token to
    // another service, or keep that other service's cached Pro entitlement.
    if (sessionService !== this.baseUrl) return;
    if (this.requireEncryption || this.decryptAsync) {
      if (raw.tokenCipher || raw.tokenPlain) {
        this.pendingRestore = raw;
        this.tokenProtected = !!raw.tokenCipher;
      }
      return;
    }
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
    if (this.pendingRestore && !this.state.token) throw new Error(STORAGE_ERROR);
    this.persist(this.state, this.tokenCipher);
  }

  persist(state, cipher) {
    if (!this.file) return;
    const out = {
      email: state.email,
      account: state.account,
      fetchedAt: state.fetchedAt,
      baseUrl: this.baseUrl,
    };
    if (state.token) {
      if (this.encryptAsync || this.requireEncryption) {
        if (!cipher || (state === this.state && this.cipherToken !== state.token)) throw new Error(STORAGE_ERROR);
        out.tokenCipher = cipher;
      } else if (this.encrypt) out.tokenCipher = Buffer.from(this.encrypt(state.token)).toString('base64');
      else out.tokenPlain = state.token;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  operation() { return { epoch: this.credentialEpoch, session: this.sessionRevision, baseUrl: this.baseUrl }; }
  current(operation) {
    return operation.epoch === this.credentialEpoch && operation.session === this.sessionRevision
      && operation.baseUrl === this.baseUrl;
  }
  assertCurrent(operation) {
    if (!this.current(operation)) throw Object.assign(new Error('The sign-in changed. Please try again.'), { code: 'session_changed' });
  }

  async restore() {
    if (!this.pendingRestore) return this.snapshot();
    if (this.restorePromise) return this.restorePromise;
    const raw = this.pendingRestore;
    const operation = this.operation();
    this.storageState = 'pending';
    this.lastError = '';
    // Defer native access and notifications until construction has finished.
    const work = Promise.resolve().then(async () => {
      this.changed();
      try {
        let token;
        let cipher = raw.tokenCipher || '';
        let migrate = !cipher;
        if (cipher) {
          if (!this.decryptAsync) throw new Error(STORAGE_ERROR);
          const decrypted = await this.withinUnlockLimit(() => this.decryptAsync(Buffer.from(cipher, 'base64')));
          token = typeof decrypted === 'string' ? decrypted : decrypted.result;
          migrate = !!(decrypted && decrypted.shouldReEncrypt);
        } else token = String(raw.tokenPlain || '');
        this.assertCurrent(operation);
        if (typeof token !== 'string' || !token) throw new Error(STORAGE_ERROR);
        if (migrate) cipher = await this.withinUnlockLimit(() => this.protect(token));
        this.assertCurrent(operation);
        const state = { email: normalizeEmail(raw.email), token,
          account: raw.account && typeof raw.account === 'object' ? raw.account : null,
          fetchedAt: Number(raw.fetchedAt) || 0 };
        if (migrate) this.persist(state, cipher);
        this.state = state;
        operation.session = ++this.sessionRevision;
        this.tokenCipher = cipher;
        this.cipherToken = token;
        this.tokenProtected = true;
        this.pendingRestore = null;
        this.storageState = 'ready';
        this.lastError = '';
      } catch (err) {
        if (this.current(operation)) {
          this.storageState = 'error';
          this.lastError = (err && err.code === 'storage_timeout' ? STORAGE_TIMEOUT_ERROR : STORAGE_ERROR)
            + ' Your saved sign-in has not been removed.';
        } else if (operation.epoch === this.credentialEpoch) {
          // The selected service changed while its old token was unlocking.
          this.pendingRestore = null;
          this.storageState = 'ready';
        }
      } finally {
        if (this.restorePromise === work) this.restorePromise = null;
        if (operation.epoch === this.credentialEpoch) this.changed();
      }
      return this.snapshot();
    });
    this.restorePromise = work;
    return work;
  }

  // Bound a wait on the Keychain. The answer to an abandoned attempt is
  // ignored, and Retry asks again, which a granted permission answers at once.
  withinUnlockLimit(start) {
    let timer;
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(STORAGE_TIMEOUT_ERROR), { code: 'storage_timeout' })),
        this.unlockTimeoutMs);
    });
    let attempt;
    try { attempt = Promise.resolve(start()); } catch (err) { attempt = Promise.reject(err); }
    return Promise.race([attempt, limit]).finally(() => clearTimeout(timer));
  }

  async protect(token) {
    if (!this.encryptAsync) {
      if (this.requireEncryption) throw new Error(STORAGE_ERROR);
      return '';
    }
    try {
      const cipher = Buffer.from(await this.encryptAsync(token));
      if (!cipher.length) throw new Error(STORAGE_ERROR);
      return cipher.toString('base64');
    } catch (_) { throw new Error(STORAGE_ERROR); }
  }

  async acceptSession(state, operation) {
    let cipher;
    try {
      this.assertCurrent(operation);
      cipher = await this.protect(state.token);
      this.assertCurrent(operation);
      // Write first. A denied Keychain or failed disk write keeps the previous
      // session and ciphertext intact instead of partially signing in.
      this.persist(state, cipher);
    } catch (err) {
      this.revokeUnadopted(state.token, operation);
      throw err;
    }
    this.state = state;
    // Requests made with the previous token while this encryption was pending
    // must not apply their profile/entitlement results to the new session.
    operation.session = ++this.sessionRevision;
    this.tokenCipher = cipher;
    this.cipherToken = state.token;
    this.tokenProtected = this.requireEncryption || !!(this.encryptAsync || this.encrypt);
    this.pendingRestore = null;
    this.restorePromise = null;
    this.storageState = 'ready';
    this.pendingEmail = '';
  }

  // The service has already issued this token, and nothing on this device
  // holds it. Ask the service to end it rather than leave a live session that
  // only expires on its own. Best effort, never awaited, and never sent to a
  // different service than the one that issued it.
  revokeUnadopted(token, operation) {
    if (!token || operation.baseUrl !== this.baseUrl) return;
    this.request('/auth/signout', { method: 'POST', token }).catch(() => {});
  }

  forgetSession() {
    this.credentialEpoch++;
    this.sessionRevision++;
    this.state = { email: '', token: '', account: null, fetchedAt: 0 };
    this.tokenCipher = this.cipherToken = '';
    this.pendingRestore = this.restorePromise = null;
    this.storageState = 'ready';
    this.tokenProtected = this.requireEncryption || !!(this.encryptAsync || this.encrypt);
    this.pendingEmail = '';
    this.billing = this.checkoutPending = null;
    this.lastError = this.busy = '';
    this.save();
    this.changed();
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
      // Which prices this account is shown, 'in' or 'global', as the service
      // placed it; null until it has.
      region: account && ['in', 'global'].includes(account.region) ? account.region : null,
      cloud: plan === 'free' ? { hoursUsed: 0, hoursCap: 0, periodEnd: null } : (account && account.cloud) || null,
      // The free plan's weekly word allowance, as the service last stated it.
      // Not an entitlement that expires with the plan, so a stale cache still
      // reports it; null means this PC has never been told, and src/quota.js
      // falls back to its own figure.
      freeWeeklyWords: account && Number(account.freeWeeklyWords) > 0 ? Math.round(Number(account.freeWeeklyWords)) : null,
      // The one-time welcome offer as the service last stated it: the credits a
      // subscriber's first month brings, the monthly figure after it, and
      // whether this account can still have it. Null until it has been told.
      welcomeOffer: account && account.welcomeOffer ? Object.assign({}, account.welcomeOffer) : null,
      checkedAt: this.state.fetchedAt || 0,
      stale,
      busy: this.busy,
      lastError: this.lastError,
      tokenProtected: this.tokenProtected,
      storageState: this.storageState,
      storageRequired: this.requireEncryption,
      baseUrl: this.baseUrl,
      billing: this.billing,
      auth: this.auth || null,
      profile: account && account.profile ? Object.assign({}, account.profile) : null,
      checkoutPending: this.checkoutPending ? Object.assign({}, this.checkoutPending) : null,
    };
  }

  async request(route, options) {
    const opts = options || {};
    const operation = this.operation();
    if (opts.auth && this.pendingRestore) throw new Error(STORAGE_ERROR);
    const headers = { 'Content-Type': 'application/json' };
    const bearer = opts.token || (opts.auth ? this.state.token : '');
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
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
      this.assertCurrent(operation);
      throw Object.assign(new Error(friendlyNetworkError(err), { cause: err }), { network: true, code: networkErrorCode(err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body = null;
    if (res.status !== 204) {
      try { body = await res.json(); } catch (_) { body = null; }
    }
    if (opts.auth || !res.ok) this.assertCurrent(operation);
    if (!res.ok) {
      const message = body && body.error ? String(body.error) : 'The account service returned ' + res.status + '.';
      throw Object.assign(new Error(message), { status: res.status });
    }
    return body || {};
  }

  async requestCode(email) {
    const clean = normalizeEmail(email);
    if (!clean) throw new Error('Enter a valid email address.');
    if (this.storageState === 'pending') throw new Error(STORAGE_ERROR);
    const operation = this.operation();
    this.busy = 'code';
    this.lastError = '';
    this.changed();
    try {
      await this.request('/auth/code', { method: 'POST', body: { email: clean } });
      this.assertCurrent(operation);
      this.pendingEmail = clean;
    } catch (err) {
      if (this.current(operation)) this.lastError = err.message;
      throw err;
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
  }

  async verifyCode(email, code) {
    const clean = normalizeEmail(email || this.pendingEmail);
    const digits = String(code || '').replace(/\D/g, '');
    if (!clean) throw new Error('Enter a valid email address.');
    if (digits.length !== 6) throw new Error('Enter the six-digit code from the email.');
    if (this.storageState === 'pending') throw new Error(STORAGE_ERROR);
    this.credentialEpoch++;
    const operation = this.operation();
    this.busy = 'verify';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/auth/verify', {
        method: 'POST', body: { email: clean, code: digits, device: this.device },
      });
      if (!result.token) throw new Error('The account service did not return a session.');
      await this.acceptSession({
        email: clean, token: String(result.token),
        account: result.account || null, fetchedAt: this.now(),
      }, operation);
    } catch (err) {
      this.assertCurrent(operation);
      if (this.current(operation)) this.lastError = err.message;
      throw err;
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
  }

  // Which sign-in routes the service offers besides the emailed code. A yes
  // is kept; a no is asked again next time, since the service may have been
  // given its Google client since.
  async authOptions() {
    if (this.auth && this.auth.google) return this.auth;
    const operation = this.operation();
    const result = await this.request('/auth/options');
    this.assertCurrent(operation);
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
    if (this.storageState === 'pending') throw new Error(STORAGE_ERROR);
    this.credentialEpoch++;
    const operation = this.operation();
    this.busy = 'google';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/auth/google', {
        method: 'POST', body: { code: g.code, codeVerifier: g.codeVerifier, redirectUri: g.redirectUri, device: this.device },
      });
      if (!result.token || !result.account || !result.account.email) throw new Error('The account service did not return a session.');
      await this.acceptSession({
        email: normalizeEmail(result.account.email), token: String(result.token),
        account: result.account, fetchedAt: this.now(),
      }, operation);
    } catch (err) {
      this.assertCurrent(operation);
      if (this.current(operation)) this.lastError = err.message;
      throw err;
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
  }

  // Ask the service what this account is entitled to. A network failure keeps
  // the cached answer; a 401 means the session is gone and the PC is signed
  // out. Returns the snapshot either way, so callers never have to catch.
  // A saved session whose unlock failed is retried only with retryStorage (the
  // Retry button): a timer or a plan check must not raise the Keychain consent
  // dialog again, or flip the sign-in screen back to "unlocking".
  async refresh(options) {
    const opts = options || {};
    if (this.pendingRestore && (this.storageState !== 'error' || opts.retryStorage)) await this.restore();
    if (!this.signedIn()) return this.snapshot();
    const operation = this.operation();
    const age = this.now() - this.state.fetchedAt;
    if (!opts.force && this.state.account && age < REFRESH_EVERY_MS) return this.snapshot();
    this.busy = 'refresh';
    this.changed();
    try {
      const result = await this.reportAndRead();
      this.assertCurrent(operation);
      this.state.account = result.account || this.state.account;
      this.state.fetchedAt = this.now();
      this.lastError = '';
      this.save();
    } catch (err) {
      if (!this.current(operation)) return this.snapshot();
      if (err.status === 401) {
        this.forgetSession();
        this.lastError = 'You were signed out. Sign in again to keep your plan on this PC.';
        this.changed();
      } else {
        this.lastError = err.message;
      }
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
    return this.snapshot();
  }

  // Ask /me, carrying this PC's free-word count when there is one. An older
  // service has no POST /me and answers 404; that is not a failed refresh, so
  // the plain GET runs instead and the figure is simply not recorded.
  async reportAndRead() {
    let report = null;
    try { report = this.freeWords ? this.freeWords() : null; } catch (_) { report = null; }
    if (!report) return this.request('/me', { auth: true });
    try {
      return await this.request('/me', { method: 'POST', auth: true, body: { freeWords: report } });
    } catch (err) {
      if (err.status !== 404) throw err;
      return this.request('/me', { auth: true });
    }
  }

  // A report from the Help menu. Signed in or not; the token, when there is
  // one, lets the service attach the sender's account.
  async sendFeedback(report) {
    await this.request('/feedback', { method: 'POST', auth: true, body: report });
  }

  // The names on the account, as typed in the app.
  async updateProfile(profile) {
    if (!this.signedIn()) throw new Error('Sign in first.');
    const operation = this.operation();
    const p = profile || {};
    this.busy = 'profile';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/me/profile', {
        method: 'PUT', auth: true, body: { firstName: String(p.firstName || ''), lastName: String(p.lastName || '') },
      });
      this.assertCurrent(operation);
      if (result.account) {
        this.state.account = result.account;
        this.state.fetchedAt = this.now();
        this.save();
      }
    } catch (err) {
      if (this.current(operation)) this.lastError = err.message;
      throw err;
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
    return this.snapshot();
  }

  // Delete the account on the service, then forget it here. Unlike sign-out,
  // this must reach the service: a deletion that did not land is not done.
  async deleteAccount() {
    if (!this.signedIn()) throw new Error('Sign in first.');
    const operation = this.operation();
    this.busy = 'delete';
    this.lastError = '';
    this.changed();
    try {
      await this.request('/me', { method: 'DELETE', auth: true });
      this.assertCurrent(operation);
    } catch (err) {
      if (this.current(operation)) { this.busy = ''; this.lastError = err.message; this.changed(); }
      throw err;
    }
    this.forgetSession();
    return this.snapshot();
  }

  async signOut() {
    // Capture the revocation request before clearing the token, but forget
    // locally immediately. Late network/Keychain results cannot restore it.
    const revoke = this.state.token
      ? this.request('/auth/signout', { method: 'POST', auth: true }).catch(() => {}) : null;
    this.forgetSession();
    if (revoke) await revoke;
    return this.snapshot();
  }

  cancelPending() {
    // Cancel the email/Google attempt, not the unrelated saved-session load.
    if (this.pendingRestore && this.storageState === 'pending') return;
    this.credentialEpoch++;
    this.busy = '';
    this.pendingEmail = '';
    this.lastError = '';
    this.changed();
  }

  // --- billing ------------------------------------------------------------
  // The app never sees a card. Checkout is a URL the service creates and the
  // system browser opens; the plan flips when the provider's webhook lands,
  // and the app notices by refreshing /me while a checkout is pending.

  async billingOptions() {
    // Signed in, the service answers with this account's region's plans only,
    // and with none, plus the reason, where Pro is not sold yet.
    const operation = this.operation();
    const result = await this.request('/billing/options', { auth: this.signedIn() });
    this.assertCurrent(operation);
    this.billing = Object.assign({}, this.billing || {}, {
      options: Array.isArray(result.options) ? result.options : [],
      unavailable: typeof result.unavailable === 'string' ? result.unavailable : '',
    });
    this.changed();
    return this.billing.options;
  }

  // `region` is the price region the offer was shown for. The service holds a
  // placed account to its own region whatever this says.
  async checkout(provider, plan, region) {
    if (!this.signedIn()) throw new Error('Sign in first.');
    const operation = this.operation();
    this.busy = 'checkout';
    this.lastError = '';
    this.changed();
    try {
      const body = region ? { provider, plan, region } : { provider, plan };
      const result = await this.request('/billing/checkout', { method: 'POST', auth: true, body });
      this.assertCurrent(operation);
      if (!result.url) throw new Error('The payment page could not be opened.');
      this.checkoutPending = { provider: result.provider, plan: result.plan, startedAt: this.now() };
      return result.url;
    } catch (err) {
      if (this.current(operation)) this.lastError = err.message;
      throw err;
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
    }
  }

  // What the service knows about the subscription behind the plan.
  async billingStatus() {
    if (!this.signedIn()) return null;
    const operation = this.operation();
    const result = await this.request('/billing', { auth: true });
    this.assertCurrent(operation);
    return this.applyBilling(result);
  }

  // Stop renewal. The service answers with the subscription as it now
  // stands: paid through its period end, renewing no more.
  async cancelSubscription() {
    if (!this.signedIn()) throw new Error('Sign in first.');
    const operation = this.operation();
    this.busy = 'cancel';
    this.lastError = '';
    this.changed();
    try {
      const result = await this.request('/billing/cancel', { method: 'POST', auth: true });
      this.assertCurrent(operation);
      return this.applyBilling(result);
    } finally {
      if (this.current(operation)) { this.busy = ''; this.changed(); }
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

module.exports = { AccountManager, accountStorageOptions, normalizeEmail, normalizeServiceUrl, DEFAULT_BASE_URL, GRACE_MS, REFRESH_EVERY_MS };
