'use strict';

// Delayed/denied Keychain operations must not block startup, expose plaintext,
// erase existing encrypted credentials, or resurrect a logged-out session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { AccountManager, accountStorageOptions } = require('../src/account');
const harness = require('./asr-test-harness');
const baseUrl = 'https://service.test/v1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-storage-'));
const account = { email: 'fixture@example.com', plan: 'pro', cloud: { hoursCap: 10 } };
const encrypt = token => Buffer.from('fixture:' + token);
const decrypt = buffer => Buffer.from(buffer).toString().replace(/^fixture:/, '');
const record = () => ({ email: account.email, account, fetchedAt: Date.now(), baseUrl,
  tokenCipher: encrypt('old-token').toString('base64') });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, status: 200, json: async () => body });
let checks = 0, fixtures = 0;
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; console.log('ok ' + name); }
function make(options = {}, raw = record()) {
  const file = path.join(root, String(++fixtures), 'account.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (raw) fs.writeFileSync(file, JSON.stringify(raw));
  const manager = new AccountManager({ file, baseUrl, requireEncryption: true,
    encryptAsync: async token => encrypt(token), decryptAsync: async bytes => ({ result: decrypt(bytes), shouldReEncrypt: false }),
    fetchImpl: async () => response({ token: 'new-token', account }), ...options });
  return { manager, file, contents: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
}

async function main() {
  const blocked = deferred();
  let calls = 0;
  const first = make({ decryptAsync: () => blocked.promise, fetchImpl: async () => { calls++; return response({}); } });
  const before = first.contents();
  await turn();
  check('pending secure storage leaves the event loop responsive and account gated',
    [first.manager.snapshot().storageState, first.manager.signedIn(), first.manager.token(), first.manager.snapshot().plan], ['pending', false, '', 'free']);
  check('pending is protected, never described as plaintext', [first.manager.snapshot().tokenProtected, first.manager.snapshot().storageRequired], [true, true]);
  assert.throws(() => first.manager.save(), /secure sign-in/);
  await assert.rejects(first.manager.sendFeedback({ message: 'test' }), /secure sign-in/);
  check('pending state preserves ciphertext and cached Pro metadata and sends no authenticated request', [first.contents(), calls], [before, 0]);
  blocked.reject(new Error('Keychain access denied'));
  await first.manager.ready;
  check('denied storage preserves file and exposes retry state', [first.contents(), first.manager.snapshot().storageState, first.manager.token()], [before, 'error', '']);
  first.manager.decryptAsync = async bytes => ({ result: decrypt(bytes) });
  await first.manager.refresh();
  check('retry restores the saved encrypted session and entitlement', [first.manager.token(), first.manager.snapshot().plan, first.manager.snapshot().storageState], ['old-token', 'pro', 'ready']);
  let encryptions = 0;
  first.manager.encryptAsync = async () => { encryptions++; throw new Error('must not re-encrypt metadata'); };
  first.manager.noteCloudUsage({ hoursUsed: 3 });
  check('metadata saves reuse the matching encrypted token', [encryptions, JSON.parse(first.contents()).tokenCipher], [0, record().tokenCipher]);
  first.manager.state.token = 'different-token';
  assert.throws(() => first.manager.save(), /secure sign-in/);
  check('a changed token cannot reuse unrelated ciphertext', JSON.parse(first.contents()).tokenCipher, record().tokenCipher);

  const pendingLoad = deferred();
  const logout = make({ decryptAsync: () => pendingLoad.promise });
  await turn();
  await logout.manager.signOut();
  pendingLoad.resolve({ result: 'old-token' });
  await logout.manager.ready;
  check('logout while unlocking prevents late restore in memory and on disk',
    [logout.manager.signedIn(), JSON.parse(logout.contents()).tokenCipher, logout.manager.snapshot().storageState], [false, undefined, 'ready']);

  const oldUnlock = deferred();
  const replacement = make({ decryptAsync: () => oldUnlock.promise });
  await turn();
  await replacement.manager.signOut();
  await replacement.manager.verifyCode(account.email, '123456');
  oldUnlock.resolve({ result: 'old-token' });
  await replacement.manager.ready;
  check('an old unlock cannot replace a newer sign-in', replacement.manager.token(), 'new-token');

  const cancelUnlock = deferred();
  const cancelled = make({ decryptAsync: () => cancelUnlock.promise });
  await turn();
  cancelled.manager.cancelPending();
  cancelUnlock.resolve({ result: 'old-token' });
  await cancelled.manager.ready;
  check('cancelling an email form cannot strand saved-session restoration',
    [cancelled.manager.token(), cancelled.manager.snapshot().storageState], ['old-token', 'ready']);

  const signing = deferred();
  const race = make({ encryptAsync: () => signing.promise }, null);
  const verify = race.manager.verifyCode(account.email, '123456');
  const rejected = assert.rejects(verify, /sign-in changed/);
  await turn();
  await race.manager.signOut();
  signing.resolve(encrypt('new-token'));
  await rejected;
  check('logout while encrypting prevents late sign-in persistence', [race.manager.token(), JSON.parse(race.contents()).tokenCipher], ['', undefined]);

  const failingCrypto = deferred();
  const cancelledFailure = make({ encryptAsync: () => failingCrypto.promise }, null);
  const failedVerify = cancelledFailure.manager.verifyCode(account.email, '123456');
  const cancelledRejection = assert.rejects(failedVerify, error => error.code === 'session_changed');
  await turn();
  cancelledFailure.manager.cancelPending();
  failingCrypto.reject(new Error('Keychain denied after cancellation'));
  await cancelledRejection;
  check('late encryption rejection after cancellation cannot publish an error into a newer session',
    [cancelledFailure.manager.lastError, cancelledFailure.manager.busy, cancelledFailure.contents()], ['', '', '']);

  const denied = make({ encryptAsync: async () => { throw new Error('denied'); } });
  await denied.manager.ready;
  const deniedBefore = denied.contents();
  await assert.rejects(denied.manager.verifyCode(account.email, '123456'), /secure sign-in/);
  check('encryption failure preserves the old session and never writes plaintext', [denied.manager.token(), denied.contents()], ['old-token', deniedBefore]);

  const failedWrite = make();
  await failedWrite.manager.ready;
  const writeBefore = failedWrite.contents();
  fs.mkdirSync(failedWrite.file + '.tmp');
  await assert.rejects(failedWrite.manager.verifyCode(account.email, '123456'));
  check('failed atomic write preserves both old token and original file', [failedWrite.manager.token(), failedWrite.contents()], ['old-token', writeBefore]);

  const older = deferred();
  let attempt = 0;
  const newest = make({ encryptAsync: token => ++attempt === 1 ? older.promise : Promise.resolve(encrypt(token)),
    fetchImpl: async () => response({ token: 'token-' + (attempt + 1), account }) }, null);
  const oldSignIn = newest.manager.verifyCode(account.email, '123456');
  const oldRejected = assert.rejects(oldSignIn, /sign-in changed/);
  await turn();
  await newest.manager.signInWithGoogle({ code: 'fixture', codeVerifier: 'fixture', redirectUri: 'http://127.0.0.1/' });
  older.resolve(encrypt('token-1'));
  await oldRejected;
  check('the newest sign-in wins concurrent email/Google encryption', newest.manager.token(), 'token-2');

  const switchingCrypto = deferred(), oldProfile = deferred();
  const switching = make({ encryptAsync: () => switchingCrypto.promise,
    fetchImpl: async url => url.endsWith('/me') ? oldProfile.promise
      : response({ token: 'free-user-token', account: { email: 'free@example.com', plan: 'free' } }) });
  await switching.manager.ready;
  const switchingSignIn = switching.manager.verifyCode('free@example.com', '123456');
  await turn();
  const oldRefresh = switching.manager.refresh({ force: true });
  await turn();
  switchingCrypto.resolve(encrypt('free-user-token'));
  await switchingSignIn;
  oldProfile.resolve(response({ account }));
  await oldRefresh;
  check('refresh started during new sign-in encryption cannot grant the old account plan to the new token',
    [switching.manager.token(), switching.manager.snapshot().email, switching.manager.snapshot().plan,
      JSON.parse(switching.contents()).account.email], ['free-user-token', 'free@example.com', 'free', 'free@example.com']);

  const serviceUnlock = deferred();
  const changedService = make({ decryptAsync: () => serviceUnlock.promise });
  const serviceBefore = changedService.contents();
  await turn();
  changedService.manager.baseUrl = 'https://other.test/v1';
  serviceUnlock.resolve({ result: 'old-token' });
  await changedService.manager.ready;
  check('service changes cannot restore credentials issued elsewhere or strand loading',
    [changedService.manager.token(), changedService.contents(), changedService.manager.storageState], ['', serviceBefore, 'ready']);

  const refreshing = deferred();
  const staleRefresh = make({ fetchImpl: () => refreshing.promise });
  await staleRefresh.manager.ready;
  const refresh = staleRefresh.manager.refresh({ force: true });
  await turn();
  const signout = staleRefresh.manager.signOut();
  refreshing.resolve(response({ account: { ...account, plan: 'pro' } }));
  await Promise.all([refresh, signout]);
  check('late account refresh cannot repopulate signed-out metadata', [staleRefresh.manager.snapshot().plan, JSON.parse(staleRefresh.contents()).account], ['free', null]);

  const plain = { ...record(), tokenPlain: 'legacy-plain' }; delete plain.tokenCipher;
  const migrated = make({}, plain);
  await migrated.manager.ready;
  check('legacy plaintext is migrated before sign-in becomes active', [migrated.manager.token(), JSON.parse(migrated.contents()).tokenPlain,
    decrypt(Buffer.from(JSON.parse(migrated.contents()).tokenCipher, 'base64'))], ['legacy-plain', undefined, 'legacy-plain']);
  const migrationDenied = make({ encryptAsync: async () => { throw new Error('denied'); } }, plain);
  const plainBefore = migrationDenied.contents();
  await migrationDenied.manager.ready;
  check('failed migration neither authenticates nor overwrites the legacy file', [migrationDenied.manager.token(), migrationDenied.contents()], ['', plainBefore]);

  let syncCalls = 0, asyncCalls = 0;
  const storage = { isEncryptionAvailable() { syncCalls++; throw new Error('sync Keychain forbidden'); },
    encryptString() { syncCalls++; throw new Error('sync encrypt forbidden'); },
    decryptString() { syncCalls++; throw new Error('sync decrypt forbidden'); },
    isAsyncEncryptionAvailable: async () => { asyncCalls++; return false; } };
  const unavailable = make(accountStorageOptions(storage, 'darwin'));
  await unavailable.manager.ready;
  check('unavailable Mac encryption fails closed without synchronous API calls', [syncCalls, unavailable.manager.snapshot().storageState], [0, 'error']);
  const missing = make(accountStorageOptions(undefined, 'darwin'), null);
  await assert.rejects(missing.manager.verifyCode(account.email, '123456'), /secure sign-in/);
  check('missing Mac APIs cannot create a plaintext token', missing.contents(), '');
  const individuallyDenied = make(accountStorageOptions({ isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async () => { throw new Error('denied after available'); } }, 'darwin'), null);
  await assert.rejects(individuallyDenied.manager.verifyCode(account.email, '123456'), /secure sign-in/);
  check('operation rejection after availability success also fails closed', individuallyDenied.contents(), '');

  const beforeCold = asyncCalls;
  const cold = harness({ platform: 'darwin', safeStorage: storage });
  try {
    check('real main initPaths returns on cold Mac startup without touching Keychain', [syncCalls, asyncCalls], [0, beforeCold]);
    check('cold main IPC snapshot is available', cold.run('snapshot().account.storageState'), 'ready');
  } finally { await cold.close(); }
  const unlock = deferred();
  const loading = harness({ platform: 'darwin', safeStorage: { ...storage,
    isAsyncEncryptionAvailable: () => unlock.promise }, prepareRoot: dir => {
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'account.json'), JSON.stringify(record()));
      fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ asrEngine: 'parakeet',
        cloudTranscription: true, dictationLanguages: ['hi', 'en'], dictationLanguage: 'hi' }));
    } });
  try {
    await turn();
    check('real main initialization and snapshot work during pending Keychain access',
      [loading.run('snapshot().account.storageState'), loading.run('snapshot().account.signedIn'), syncCalls], ['pending', false, 0]);
    check('pending storage preserves saved Pro language preferences',
      JSON.parse(loading.run('JSON.stringify(settings.dictationLanguages)')), ['hi', 'en']);
    unlock.resolve(false);
    await loading.run('accountManager.ready');
    check('denied storage keeps Pro language preferences on disk and in memory',
      [JSON.parse(loading.run('JSON.stringify(settings.dictationLanguages)')),
        JSON.parse(fs.readFileSync(path.join(loading.root, 'data', 'settings.json'), 'utf8')).dictationLanguages], [['hi', 'en'], ['hi', 'en']]);
  } finally { await loading.close(); }

  const googleCrypto = deferred();
  const google = harness({ platform: 'darwin', safeStorage: { ...storage,
    isAsyncEncryptionAvailable: async () => true, encryptStringAsync: () => googleCrypto.promise } });
  try {
    google.context.fixtureFetch = async url => response(url.endsWith('/auth/options')
      ? { google: { clientId: 'fixture' } } : { token: 'cancelled-google-token', account });
    google.run(`accountManager.fetch = fixtureFetch;
      googleAuth.signIn = () => ({ promise: Promise.resolve({ code: 'fixture', codeVerifier: 'fixture', redirectUri: 'http://127.0.0.1/' }), cancel() {} });`);
    const signIn = google.handlers.get('account-google')(null);
    await turn();
    await google.handlers.get('account-google-cancel')(null);
    googleCrypto.resolve(encrypt('cancelled-google-token'));
    await signIn;
    check('main Google cancel invalidates an accepted grant still awaiting encryption',
      [google.run('accountManager.token()'), fs.existsSync(path.join(google.root, 'data', 'account.json')),
        google.run('accountManager.lastError')], ['', false, '']);
  } finally { await google.close(); }

  // Exercise the production account renderer's pending/error copy and retry
  // selection without a browser dependency; native UI remains a separate test.
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const renderSource = source.slice(source.indexOf('let accountStorageRetry = false;'), source.indexOf('// --- The profile card'));
  const element = () => ({ hidden: false, disabled: false, textContent: '' });
  const elements = { accountSignedOutEl: element(), accountPendingEl: element(), accountSignedInEl: element(),
    accountSendCodeBtn: element(), accountForgetSavedBtn: element(), accountEmailInput: element(), accountErrorEl: element(), hint: element() };
  const context = vm.createContext({ ...elements, document: { getElementById: () => elements.hint } });
  vm.runInContext(renderSource, context);
  context.data = { account: { signedIn: false, storageState: 'pending', storageRequired: true, tokenProtected: true } };
  vm.runInContext('renderAccount(data)', context);
  check('account UI explains pending Keychain access and disables new sign-in',
    [elements.accountSendCodeBtn.disabled, /Keychain/.test(elements.hint.textContent)], [true, true]);
  context.data.account.storageState = 'error'; context.data.account.lastError = 'Retry secure storage';
  vm.runInContext('renderAccount(data)', context);
  check('account UI offers explicit retry while keeping the email disabled',
    [elements.accountSendCodeBtn.disabled, elements.accountSendCodeBtn.textContent, elements.accountEmailInput.disabled], [false, 'Retry secure sign-in', true]);
  console.log(`all ${checks} asynchronous account storage checks passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
