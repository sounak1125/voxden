'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AccountManager, DEFAULT_BASE_URL, normalizeServiceUrl } = require('../src/account');
const { checkAccountService } = require('./check-account-service');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-service-'));
  const file = path.join(root, 'account.json');
  const routes = [];
  const server = http.createServer((req, res) => {
    routes.push(req.url);
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth/options') return res.end(JSON.stringify({ google: { clientId: 'test.apps.googleusercontent.com' } }));
    if (req.url === '/v1/auth/verify') return res.end(JSON.stringify({ token: 'fixture-token', account: { email: 'test@example.test', plan: 'pro' } }));
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  try {
    new AccountManager({ file, baseUrl });
    assert(!fs.existsSync(file), 'no sign-in or token needed to remember the server');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'account-service.json'))), { baseUrl });
    let restarted = new AccountManager({ file });
    assert.equal(restarted.baseUrl, baseUrl, 'normal restart before signing in stays on the selected service');
    assert.equal((await restarted.authOptions()).google, true);
    await restarted.requestCode('test@example.test');
    await restarted.verifyCode('test@example.test', '123456');
    assert(restarted.signedIn());
    const other = new AccountManager({ file, baseUrl: DEFAULT_BASE_URL });
    assert.equal(other.signedIn(), false, 'changing servers does not forward a session token or cached Pro plan');
    assert.equal(other.snapshot().plan, 'free');
    restarted = new AccountManager({ file, baseUrl });
    await restarted.signOut();
    assert.equal(new AccountManager({ file }).baseUrl, baseUrl, 'sign-out preserves service selection');
    fs.unlinkSync(file);
    assert.equal(new AccountManager({ file }).baseUrl, baseUrl, 'a missing sign-in file does not lose local test configuration');
    fs.writeFileSync(path.join(root, 'account-service.json'), '{broken');
    assert.equal(new AccountManager({ file }).baseUrl, DEFAULT_BASE_URL, 'invalid configuration is ignored');
    const fresh = new AccountManager({ file: path.join(root, 'fresh', 'account.json') });
    assert.equal(fresh.baseUrl, DEFAULT_BASE_URL, 'a customer install never automatically connects to localhost');
    assert(!fs.existsSync(fresh.serviceFile), 'default startup does not create a local override');
    assert(routes.includes('/v1/auth/options') && routes.includes('/v1/auth/code') && routes.includes('/v1/auth/verify'));
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      const offline = new AccountManager({ fetchImpl: async () => { throw new Error('fetch failed', { cause: { code } }); } });
      await assert.rejects(() => offline.requestCode('test@example.test'), error => error.network && error.code === code);
      assert(!/npm|localhost|account\.voxden\.app|host name|develop/i.test(offline.lastError));
    }
    for (const value of ['http://public.example/v1', 'https://user:password@example.test/v1', 'file:///tmp/account', 'https://example.test/v1?token=x']) {
      assert.equal(normalizeServiceUrl(value), '');
    }
    const checked = [];
    const ready = async (url, options) => {
      checked.push(String(url));
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => url.pathname === '/healthz' ? { ok: true } : { google: { clientId: 'test.apps.googleusercontent.com' }, email: { configured: true } } };
    };
    const previousOverride = process.env.VOXDEN_ACCOUNT_URL;
    try {
      process.env.VOXDEN_ACCOUNT_URL = baseUrl;
      await checkAccountService({ fetchImpl: ready });
      assert(checked.every(url => url.startsWith('https://account.voxden.app/')), 'local environment cannot satisfy the public release check');
    } finally {
      if (previousOverride === undefined) delete process.env.VOXDEN_ACCOUNT_URL;
      else process.env.VOXDEN_ACCOUNT_URL = previousOverride;
    }
    await assert.rejects(() => checkAccountService({ fetchImpl: async () => { throw new Error('DNS unavailable'); } }), /DNS unavailable/);
    await assert.rejects(() => checkAccountService({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
    await assert.rejects(() => checkAccountService({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, google: null }) }) }), /Google sign-in/);
    await assert.rejects(() => checkAccountService({ baseUrl }), /HTTPS/);
    for (const email of [undefined, { configured: false }]) {
      await assert.rejects(() => checkAccountService({ fetchImpl: async () => ({
        ok: true, json: async () => ({ ok: true, google: { clientId: 'test' }, email })
      }) }), /Email sign-in/);
    }
    console.log('Account service: fresh-profile restart, sign-in, sign-out, token isolation, clean network errors and public release checks passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
