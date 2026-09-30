'use strict';

// Real Electron/Keychain compatibility, with synthetic tokens and a uniquely
// named entry. The Node parent bounds even a blocked synchronous legacy API.
// This does not change the default Keychain, unlock it, or broaden any ACL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { AccountManager, accountStorageOptions } = require('../src/account');
const started = Date.now();
function stage(message) {
  // Flush before native calls: a blocked main thread must not strand the
  // last diagnostic in a JS stdout buffer. Never log tokens or ciphertext.
  fs.writeSync(1, `[native-storage +${Date.now() - started}ms] ${message}\n`);
}

function findFixtureEntry(name) {
  // Metadata only: never request or print the Keychain password (-w/-g).
  return spawnSync('/usr/bin/security', ['find-generic-password', '-s', name + ' Safe Storage', '-a', name],
    { encoding: 'utf8', timeout: 5000 });
}

if (process.argv.includes('--native-child')) {
  const { app, safeStorage } = require('electron');
  const [name, profile] = process.argv.slice(-2);
  // The CLI preload must set this before default_app imports this entry. The
  // native Keychain name is captured once; setting it here can be too late.
  assert.equal(app.getName(), name, 'the CLI preload established the isolated application identity');
  assert.equal(app.commandLine.hasSwitch('use-mock-keychain'), false, 'this fixture requires the real Keychain');
  stage('Waiting for Electron app readiness');
  app.whenReady().then(async () => {
    const synthetic = 'voxden-synthetic-compatibility-fixture';
    stage('Checking async encryption availability');
    assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true, 'native encryption is available');
    stage('Encrypting with async API');
    const modern = await safeStorage.encryptStringAsync(synthetic);
    stage('Verifying native encryption created the exact isolated Keychain entry');
    const entry = findFixtureEntry(name);
    if (entry.error) throw entry.error;
    assert.equal(entry.status, 0, 'native encryption must create the fixture service/account, not reuse an Electron or Voxden entry');
    stage('Decrypting async ciphertext with legacy sync API');
    assert.equal(safeStorage.decryptString(modern), synthetic, 'async ciphertext is readable by the legacy sync API');
    stage('Encrypting with legacy sync API');
    const legacy = safeStorage.encryptString(synthetic);
    stage('Decrypting legacy ciphertext with async API');
    const restored = await safeStorage.decryptStringAsync(legacy);
    assert.equal(restored.result, synthetic, 'legacy ciphertext is readable by the async API');
    const file = path.join(profile, 'account.json');
    const baseUrl = 'https://fixture.invalid/v1';
    fs.writeFileSync(file, JSON.stringify({ baseUrl, email: 'fixture@example.com',
      account: { plan: 'pro' }, fetchedAt: Date.now(), tokenCipher: legacy.toString('base64') }));
    stage('Restoring legacy account through production AccountManager');
    const manager = new AccountManager({ file, ...accountStorageOptions(safeStorage, 'darwin') });
    assert.equal(manager.snapshot().storageState, 'pending');
    await manager.ready;
    assert.equal(manager.token(), synthetic, 'production manager restores legacy native ciphertext');
    assert.equal(manager.snapshot().plan, 'pro');
    manager.fetch = async () => ({ ok: true, status: 200,
      json: async () => ({ token: synthetic + '-new', account: { plan: 'pro' } }) });
    stage('Encrypting and persisting a new production account session');
    await manager.verifyCode('fixture@example.com', '123456');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.tokenPlain, undefined);
    stage('Reading persisted account ciphertext with legacy sync API');
    assert.equal(safeStorage.decryptString(Buffer.from(saved.tokenCipher, 'base64')), synthetic + '-new',
      'new production account file remains readable by the legacy sync API');
    stage('Restoring the persisted account on restart');
    const restarted = new AccountManager({ file, ...accountStorageOptions(safeStorage, 'darwin') });
    await restarted.ready;
    assert.equal(restarted.token(), synthetic + '-new', 'native async session survives restart');
    console.log('PASS native Mac Keychain: sync-to-async, async-to-sync, production persistence and restart');
    stage('Quitting Electron');
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else if (process.platform !== 'darwin') {
  console.log('SKIP native Mac Keychain compatibility: requires macOS');
} else {
  const name = 'Voxden Storage Test ' + randomUUID();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-native-storage-'));
  let passed = false;
  let entryWasAbsent = false;
  try {
    stage('Verifying the random fixture Keychain entry does not already exist');
    const before = findFixtureEntry(name);
    if (before.error) throw before.error;
    assert.equal(before.status, 44, 'refuse to use or remove an existing Keychain entry');
    entryWasAbsent = true;
    // Electron's default_app supports --require before its asynchronous app
    // import. Establish the name here, before PostCreateMainMessageLoop fixes
    // KeychainPassword's service/account names. No shared bundle is modified.
    // See Electron v43.7.6 default_app/main.ts and electron_browser_main_parts.cc.
    const preload = path.join(profile, 'identity.cjs');
    fs.writeFileSync(preload, [
      "const { app } = require('electron');",
      "require('node:assert/strict').equal(app.isReady(), false, 'identity must be configured before app readiness');",
      `app.setName(${JSON.stringify(name)});`,
      `app.setPath('userData', ${JSON.stringify(profile)});`,
      'app.disableHardwareAcceleration();',
    ].join('\n') + '\n');
    stage('Launching isolated native child with 90-second watchdog');
    const result = spawnSync(require('electron'), ['--require', preload, __filename, '--native-child', name, profile], {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }, encoding: 'utf8', timeout: 90000,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, detached: true,
    });
    // Preserve stage output even if owned-process cleanup itself fails.
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    stage(`Native child ended: status=${result.status}, signal=${result.signal || 'none'}`);
    if (result.error) console.error('Native storage child failed:', result.error.message);
    // The detached group belongs only to this fixture, including any Electron
    // subprocesses left behind when the parent-enforced timeout killed main.
    stage('Cleaning up the native child process group');
    if (result.pid) { try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    passed = result.status === 0;
    process.exitCode = passed ? 0 : 1;
  } finally {
    // Delete only this fixture's random service/account, never a Voxden or
    // Electron user credential. No password retrieval flags are used.
    if (entryWasAbsent) {
      stage('Removing only this fixture Keychain entry (5-second timeout)');
      const cleanup = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', name + ' Safe Storage', '-a', name],
        { encoding: 'utf8', timeout: 5000 });
      if (cleanup.error || (cleanup.status !== 0 && (passed || cleanup.status !== 44))) {
        console.error('Could not remove the fixture Keychain entry:', cleanup.error ? cleanup.error.message : cleanup.stderr);
        process.exitCode = 1;
      }
      stage(`Keychain cleanup ended: status=${cleanup.status}`);
      const after = findFixtureEntry(name);
      if (after.error || after.status !== 44) {
        console.error('Fixture Keychain entry removal was not confirmed:', after.error ? after.error.message : after.status);
        process.exitCode = 1;
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
    stage('Disposable profile removed');
  }
}
