'use strict';

// The service as it is actually started: server/index.js as a child process
// with the environment the container gives it. Missing email is rejected;
// a mocked provider then accepts a real sign-in. Grant.js and backup.js use the same
// database file. Everything the other tests reach through createApp, this
// reaches through the front door.

const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-smoke-'));
const db = path.join(root, 'voxden.sqlite');
const port = 20000 + Math.floor(Math.random() * 20000);
const serverDir = path.join(__dirname, '..', 'server');
const env = Object.assign({}, process.env, { PORT: String(port), VOXDEN_DB: db, NODE_OPTIONS: '--no-warnings' });
env.GEOIP = 'off';
delete env.RESEND_API_KEY;
delete env.OPENROUTER_API_KEY;
delete env.GOOGLE_CLIENT_ID;
delete env.GOOGLE_CLIENT_SECRET;
// This fixture exercises an unconfigured service even on a developer PC
// that has payment providers configured for its separate local instance.
for (const key of Object.keys(env)) {
  if (/^(RAZORPAY_|LEMONSQUEEZY_)/i.test(key)) delete env[key];
}

async function main() {
  let out = '';
  let child;
  const start = (args, childEnv) => {
    out = '';
    child = spawn(process.execPath, args, { cwd: serverDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  start(['index.js'], env);
  const waitFor = async (re, ms) => {
    const until = Date.now() + (ms || 10000);
    while (Date.now() < until) {
      const m = re.exec(out);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for ' + re + '\n--- output ---\n' + out);
  };
  try {
    const listening = await waitFor(/listening on :(\d+) \(([^)]*)\)/);
    eq('the entry point starts on the configured port', Number(listening[1]), port);
    eq('and says what it is configured with', listening[2], 'email off, cloud off');
    const base = 'http://127.0.0.1:' + port;
    const health = await fetch(base + '/healthz');
    eq('healthz answers', [health.status, await health.json()], [200, { ok: true }]);

    const unavailable = await fetch(base + '/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'smoke@example.com' }) });
    eq('missing email configuration never pretends to send a code', [unavailable.status, (await unavailable.json()).code], [503, 'email_unconfigured']);
    eq('no plaintext code log is created', fs.existsSync(path.join(root, 'sign-in-codes.log')), false);
    await stop();
    const fixture = path.join(root, 'mail-fixture.cjs');
    fs.writeFileSync(fixture, [
      "globalThis.fetch = async (url, init) => {",
      "  if (String(url) !== 'https://api.resend.com/emails') throw new Error('Unexpected external request');",
      "  const payload = JSON.parse(init.body);",
      "  process.stdout.write('[test-mail] ' + payload.subject.slice(0, 6) + '\\n');",
      "  return { ok: true };",
      "};"
    ].join('\n'));
    start(['--require', fixture, 'index.js'], { ...env, RESEND_API_KEY: 'fixture-key' });
    await waitFor(/listening on/);
    const code = await fetch(base + '/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'smoke@example.com' }) });
    eq('a code is accepted', code.status, 204);
    const mail = await waitFor(/\[test-mail\] (\d{6})/);
    const verify = await fetch(base + '/v1/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'smoke@example.com', code: mail[1], device: 'smoke' }) });
    const session = await verify.json();
    eq('the code accepted by the test provider signs in', [verify.status, session.account.plan], [200, 'free']);

    const granted = execFileSync(process.execPath, ['grant.js', 'smoke@example.com', 'pro', '2027-01-01'], { cwd: serverDir, env, encoding: 'utf8' });
    eq('grant.js finds the user in the same database', granted.trim(), 'smoke@example.com is now pro until 2027-01-01T00:00:00.000Z');
    const me = await fetch(base + '/v1/me', { headers: { Authorization: 'Bearer ' + session.token } });
    eq('and the running service sees the grant at once', (await me.json()).account.plan, 'pro');
    const options = await fetch(base + '/v1/billing/options');
    eq('with no payment keys nothing is offered', await options.json(), { region: null, options: [] });
    const cloud = await fetch(base + '/v1/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' }, body: '{}' });
    eq('with no model key the relay says so', [cloud.status, (await cloud.json()).code], [503, 'unconfigured']);

    const backup = execFileSync(process.execPath, ['backup.js'], { cwd: serverDir, env, encoding: 'utf8' });
    const written = /backup written: (.*\.sqlite)/.exec(backup);
    assert.ok(written, backup);
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(written[1], { readOnly: true });
    // Rows come back as null-prototype objects; compare them as plain data.
    eq('backup.js takes a readable snapshot while the service runs',
      JSON.parse(JSON.stringify(copy.prepare('SELECT email, plan FROM users').all())), [{ email: 'smoke@example.com', plan: 'pro' }]);
    copy.close();
  } finally {
    await stop();
    // Windows releases the killed process's database handles a moment after
    // the exit event. Cleanup is best effort; a leftover temp dir is not a
    // failed service.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (_) {}
  }
  process.stdout.write('all ' + checks + ' account service smoke checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
