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

if (process.argv.includes('--native-child')) {
  const { app, safeStorage } = require('electron');
  const [name, profile] = process.argv.slice(-2);
  app.setName(name);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const synthetic = 'voxden-synthetic-compatibility-fixture';
    assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true, 'native encryption is available');
    const modern = await safeStorage.encryptStringAsync(synthetic);
    assert.equal(safeStorage.decryptString(modern), synthetic, 'async ciphertext is readable by the legacy sync API');
    const legacy = safeStorage.encryptString(synthetic);
    const restored = await safeStorage.decryptStringAsync(legacy);
    assert.equal(restored.result, synthetic, 'legacy ciphertext is readable by the async API');
    const file = path.join(profile, 'account.json');
    const baseUrl = 'https://fixture.invalid/v1';
    fs.writeFileSync(file, JSON.stringify({ baseUrl, email: 'fixture@example.com',
      account: { plan: 'pro' }, fetchedAt: Date.now(), tokenCipher: legacy.toString('base64') }));
    const manager = new AccountManager({ file, ...accountStorageOptions(safeStorage, 'darwin') });
    assert.equal(manager.snapshot().storageState, 'pending');
    await manager.ready;
    assert.equal(manager.token(), synthetic, 'production manager restores legacy native ciphertext');
    assert.equal(manager.snapshot().plan, 'pro');
    manager.fetch = async () => ({ ok: true, status: 200,
      json: async () => ({ token: synthetic + '-new', account: { plan: 'pro' } }) });
    await manager.verifyCode('fixture@example.com', '123456');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.tokenPlain, undefined);
    assert.equal(safeStorage.decryptString(Buffer.from(saved.tokenCipher, 'base64')), synthetic + '-new',
      'new production account file remains readable by the legacy sync API');
    const restarted = new AccountManager({ file, ...accountStorageOptions(safeStorage, 'darwin') });
    await restarted.ready;
    assert.equal(restarted.token(), synthetic + '-new', 'native async session survives restart');
    console.log('PASS native Mac Keychain: sync-to-async, async-to-sync, production persistence and restart');
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else if (process.platform !== 'darwin') {
  console.log('SKIP native Mac Keychain compatibility: requires macOS');
} else {
  const name = 'Voxden Storage Test ' + randomUUID();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-native-storage-'));
  let passed = false;
  try {
    const result = spawnSync(require('electron'), [__filename, '--native-child', name, profile], {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }, encoding: 'utf8', timeout: 90000,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, detached: true,
    });
    // The detached group belongs only to this fixture, including any Electron
    // subprocesses left behind when the parent-enforced timeout killed main.
    if (result.pid) { try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error('Native storage child failed:', result.error.message);
    passed = result.status === 0;
    process.exitCode = passed ? 0 : 1;
  } finally {
    // Delete only this fixture's random service/account, never a Voxden or
    // Electron user credential. No password retrieval flags are used.
    const cleanup = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', name + ' Safe Storage', '-a', name],
      { encoding: 'utf8', timeout: 5000 });
    if (cleanup.error || (cleanup.status !== 0 && (passed || cleanup.status !== 44))) {
      console.error('Could not remove the fixture Keychain entry:', cleanup.error ? cleanup.error.message : cleanup.stderr);
      process.exitCode = 1;
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
