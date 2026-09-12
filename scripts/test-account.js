'use strict';

// The desktop side of the account, with a fake service and a fake clock.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountManager, GRACE_MS, REFRESH_EVERY_MS, DEFAULT_BASE_URL } = require('../src/account');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-account-'));
const file = path.join(root, 'account.json');
let clock = Date.parse('2026-09-11T09:00:00Z');
const calls = [];
let service = {};
const response = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
});
const fetchImpl = async (url, init) => {
  const route = init.method + ' ' + new URL(url).pathname;
  calls.push({ route, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
  const handler = service[route];
  if (!handler) return response(404, { error: 'Not found.' });
  return handler(init);
};
// "Encryption" the test can see through, to prove the token never sits in the
// file as written.
const encrypt = (s) => Buffer.from('enc:' + s);
const decrypt = (b) => Buffer.from(b).toString().replace(/^enc:/, '');
const changes = [];
const make = () => new AccountManager({
  file, baseUrl: 'https://svc.test/v1/', fetchImpl, encrypt, decrypt,
  now: () => clock, device: 'Test PC', onChange: (s) => changes.push(s.busy),
});

async function main() {
  const m = make();
  eq('a fresh PC is signed out and free', [m.snapshot().signedIn, m.snapshot().plan], [false, 'free']);
  eq('the base URL loses its trailing slash', m.snapshot().baseUrl, 'https://svc.test/v1');
  // The address every release is built against. Changing it is a release
  // decision, so it is pinned here rather than left to drift.
  eq('a build talks to the production account service', DEFAULT_BASE_URL, 'https://account.voxden.app/v1');
  eq('and so does a manager given no base URL', new AccountManager({ fetchImpl, now: () => clock }).snapshot().baseUrl, 'https://account.voxden.app/v1');

  // --- request a code -------------------------------------------------------
  await assert.rejects(() => m.requestCode('nope'), /valid email/);
  service['POST /v1/auth/code'] = () => response(204);
  await m.requestCode(' Me@Example.com ');
  eq('the address is normalised before it leaves', calls.at(-1).body, { email: 'me@example.com' });
  eq('and remembered for the code step', m.snapshot().pendingEmail, 'me@example.com');
  service['POST /v1/auth/code'] = () => response(429, { error: 'Too many codes requested. Wait an hour and try again.' });
  await assert.rejects(() => m.requestCode('me@example.com'), /Too many/);
  eq('the service error is kept for the panel', m.snapshot().lastError, 'Too many codes requested. Wait an hour and try again.');
  service['POST /v1/auth/code'] = () => { throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }); };
  await assert.rejects(() => m.requestCode('me@example.com'), /Could not reach/);
  service['POST /v1/auth/code'] = () => {
    throw Object.assign(new Error('fetch failed'), { name: 'TypeError', cause: { code: 'ENOTFOUND' } });
  };
  await assert.rejects(() => m.requestCode('me@example.com'), /host name could not be found/);

  // --- verify ---------------------------------------------------------------
  await assert.rejects(() => m.verifyCode('', '12'), /six-digit/);
  const account = {
    email: 'me@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
    cloud: { hoursUsed: 0.5, hoursCap: 10, periodEnd: '2026-10-01T00:00:00.000Z' }, serverTime: 'x',
  };
  service['POST /v1/auth/verify'] = (init) => {
    const body = JSON.parse(init.body);
    return body.code === '123456' ? response(200, { token: 'tok-1', account }) : response(400, { error: 'That code is not right. Check the email and try again.' });
  };
  await assert.rejects(() => m.verifyCode(undefined, '000000'), /not right/);
  await m.verifyCode(undefined, '12 34 56');
  eq('the pending address and stripped digits are sent', calls.at(-1).body, { email: 'me@example.com', code: '123456', device: 'Test PC' });
  const signed = m.snapshot();
  eq('signed in as pro', [signed.signedIn, signed.email, signed.plan, signed.cloud.hoursCap], [true, 'me@example.com', 'pro', 10]);
  eq('nothing pending any more', signed.pendingEmail, '');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('the token on disk is encrypted', written.tokenCipher && !('tokenPlain' in written));
  ok('and not readable as written', !JSON.stringify(written).includes('tok-1'));
  eq('the account is cached beside it', written.account.plan, 'pro');
  eq('and so is the service that issued the session', written.baseUrl, 'https://svc.test/v1');

  // --- reload from disk -----------------------------------------------------
  const m2 = make();
  eq('a restart reads the session back', [m2.snapshot().signedIn, m2.snapshot().plan], [true, 'pro']);
  const remembered = new AccountManager({ file, fetchImpl, encrypt, decrypt, now: () => clock, device: 'Test PC' });
  eq('without an override the remembered service URL is reused', remembered.snapshot().baseUrl, 'https://svc.test/v1');
  const forced = new AccountManager({
    file, fetchImpl, encrypt, decrypt, now: () => clock, device: 'Test PC',
    baseUrl: 'http://127.0.0.1:8787/v1',
  });
  eq('an explicit URL still wins over the saved one', forced.snapshot().baseUrl, 'http://127.0.0.1:8787/v1');
  const broken = new AccountManager({ file, fetchImpl, encrypt, decrypt: () => { throw new Error('DPAPI says no'); }, now: () => clock });
  eq('a token this PC cannot decrypt means signed out', broken.snapshot().signedIn, false);

  // --- refresh --------------------------------------------------------------
  let meCalls = 0;
  service['GET /v1/me'] = (init) => {
    meCalls++;
    if (init.headers.Authorization !== 'Bearer tok-1') return response(401, { error: 'Sign in again.' });
    return response(200, { account: Object.assign({}, account, { cloud: { hoursUsed: 2, hoursCap: 10, periodEnd: 'p' } }) });
  };
  await m2.refresh();
  eq('a fresh cache is not refetched', meCalls, 0);
  clock += REFRESH_EVERY_MS + 1;
  await m2.refresh();
  eq('six hours later it is', meCalls, 1);
  eq('with the bearer token', calls.at(-1).headers.Authorization, 'Bearer tok-1');
  eq('and the answer replaces the cache', m2.snapshot().cloud.hoursUsed, 2);
  await m2.refresh({ force: true });
  eq('force refetches at once', meCalls, 2);

  // --- the free week, carried on the plan check ------------------------------
  // A PC inside a free week reports it on the request it was already making.
  // With nothing to report it asks the plain way, and a service too old to
  // have POST /me is not a failed refresh -- the figure is simply not kept.
  const posted = [];
  service['POST /v1/me'] = (init) => {
    posted.push(JSON.parse(init.body));
    return response(200, { account });
  };
  let week = { used: 1840, cap: 3000, periodStart: Date.parse('2026-09-08T09:00:00Z') };
  const reporter = new AccountManager({
    file, baseUrl: 'https://svc.test/v1/', fetchImpl, encrypt, decrypt,
    now: () => clock, device: 'Test PC', freeWords: () => week,
  });
  await reporter.refresh({ force: true });
  eq('a running week rides along with the plan check', posted, [{ freeWords: week }]);
  eq('and the plan still comes back', reporter.snapshot().plan, 'pro');

  week = null;
  const plainBefore = meCalls;
  await reporter.refresh({ force: true });
  eq('with nothing to report it asks the plain way', [posted.length, meCalls - plainBefore], [1, 1]);

  week = { used: 10, cap: 3000, periodStart: Date.parse('2026-09-08T09:00:00Z') };
  delete service['POST /v1/me'];
  const older = await reporter.refresh({ force: true });
  eq('a service too old for the report still refreshes', [older.plan, older.lastError], ['pro', '']);

  const thrower = new AccountManager({
    file, baseUrl: 'https://svc.test/v1/', fetchImpl, encrypt, decrypt,
    now: () => clock, device: 'Test PC', freeWords: () => { throw new Error('meter broke'); },
  });
  eq('a meter that throws does not break the refresh', (await thrower.refresh({ force: true })).plan, 'pro');

  // --- offline grace --------------------------------------------------------
  service['GET /v1/me'] = () => { throw Object.assign(new Error('offline'), { name: 'TypeError' }); };
  clock += 3 * 24 * 3600e3;
  const three = await m2.refresh({ force: true });
  eq('three days offline is still pro', three.plan, 'pro');
  ok('and says why the check failed', /Could not reach/.test(three.lastError));
  eq('but is not stale yet', three.stale, false);
  clock += GRACE_MS;
  const gone = await m2.refresh({ force: true });
  eq('past the grace period the plan is free', gone.plan, 'free');
  eq('and marked stale rather than signed out', [gone.stale, gone.signedIn], [true, true]);
  service['GET /v1/me'] = () => response(200, { account });
  const back = await m2.refresh({ force: true });
  eq('one good answer restores it', [back.plan, back.stale], ['pro', false]);

  // --- an expired plan, and a revoked session -------------------------------
  clock = Date.parse('2027-02-01T00:00:00Z');
  await m2.refresh({ force: true });
  eq('a plan past its date is free even from a fresh answer', m2.snapshot().plan, 'free');
  service['GET /v1/me'] = () => response(401, { error: 'Sign in again.' });
  const out = await m2.refresh({ force: true });
  eq('a 401 signs the PC out', [out.signedIn, out.plan], [false, 'free']);
  ok('and explains it', /signed out/.test(out.lastError));
  eq('the file no longer carries a token', 'tokenCipher' in JSON.parse(fs.readFileSync(file, 'utf8')), false);

  // --- sign out -------------------------------------------------------------
  clock = Date.parse('2026-09-11T09:00:00Z');
  service['POST /v1/auth/verify'] = () => response(200, { token: 'tok-2', account });
  await m2.verifyCode('me@example.com', '123456');
  let revoked = false;
  service['POST /v1/auth/signout'] = () => { revoked = true; return response(204); };
  await m2.signOut();
  eq('sign-out tells the service', revoked, true);
  eq('and forgets everything', [m2.snapshot().signedIn, m2.snapshot().email], [false, '']);
  service['POST /v1/auth/verify'] = () => response(200, { token: 'tok-3', account });
  await m2.verifyCode('me@example.com', '123456');
  service['POST /v1/auth/signout'] = () => { throw Object.assign(new Error('offline'), { name: 'TypeError' }); };
  await m2.signOut();
  eq('an offline sign-out still forgets the token locally', m2.snapshot().signedIn, false);

  ok('every state change was announced', changes.length > 10);
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write('all ' + checks + ' account client checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
