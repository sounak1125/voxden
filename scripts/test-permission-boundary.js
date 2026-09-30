'use strict';

// Exercise the actual callbacks, including their actual URL classifier. Run
// under Electron with --native to check Chromium's fake microphone separately.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const SRC = path.resolve(__dirname, '../src');
const source = fs.readFileSync(process.env.VOXDEN_PERMISSION_TEST_MAIN || path.join(SRC, 'main.js'), 'utf8');
const classifier = source.match(/function isAppPage\(url\) \{[\s\S]*?\n\}/);
const start = source.indexOf('    // The microphone, and nothing else,');
const end = source.indexOf('    const appMenu =', start);
assert(classifier && start >= 0 && end > start, 'permission callback source boundaries exist');

function handlers() {
  const result = {};
  vm.runInNewContext(classifier[0] + '\n' + source.slice(start, end), {
    path, require, URL, __dirname: SRC,
    ses: {
      setPermissionRequestHandler: fn => { result.request = fn; },
      setPermissionCheckHandler: fn => { result.check = fn; },
    },
  });
  return result;
}

const ownUrl = pathToFileURL(path.join(SRC, 'permission-fixture.html')).href;
const foreignFile = pathToFileURL(path.join(SRC, '..', 'outside-permission-fixture.html')).href;

function unit() {
  const { request, check } = handlers();
  const own = { getURL: () => ownUrl };
  let count = 0;
  function verify(expected, wc, permission, details, label) {
    const checkDetails = details && { ...details };
    if (checkDetails && Array.isArray(details.mediaTypes)) {
      checkDetails.mediaType = details.mediaTypes.length === 1 ? details.mediaTypes[0] : 'unknown';
    }
    let result;
    let calls = 0;
    request(wc, permission, value => { result = value; calls++; }, details);
    assert.strictEqual(calls, 1, label + ': request callback called once');
    assert.strictEqual(result, expected, label + ': request');
    assert.strictEqual(check(wc, permission, 'file://', checkDetails), expected, label + ': check');
    count++;
  }
  const audio = { requestingUrl: ownUrl, isMainFrame: true, mediaTypes: ['audio'] };
  verify(true, own, 'media', audio, 'own page microphone');
  verify(true, own, 'media', { mediaTypes: ['audio'] }, 'missing frame URL uses real WebContents URL');
  for (const types of [[], ['video'], ['audio', 'video'], ['unknown']]) {
    verify(false, own, 'media', { ...audio, mediaTypes: types }, 'reject media ' + JSON.stringify(types));
  }
  for (const details of [undefined, null, {}, { requestingUrl: ownUrl }, { mediaTypes: 'audio' }]) {
    verify(false, own, 'media', details, 'reject unspecified media type');
  }
  for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write',
    'display-capture', 'usb', 'hid', 'serial', 'fileSystem', 'openExternal', 'unknown']) {
    verify(false, own, permission, audio, 'reject ' + permission);
  }
  for (const url of [foreignFile, 'https://example.invalid/', 'about:blank', '',
    pathToFileURL(path.join(SRC + '-other', 'index.html')).href]) {
    verify(false, own, 'media', { ...audio, requestingUrl: url || 'about:blank' }, 'foreign requesting frame');
    verify(false, { getURL: () => url }, 'media', { mediaTypes: ['audio'] }, 'foreign file-origin fallback');
    verify(false, { getURL: () => url }, 'media', audio, 'foreign top-level page');
  }
  verify(false, own, 'media', { ...audio, isMainFrame: false }, 'subframe cannot inherit microphone');
  verify(false, own, 'media', { mediaTypes: ['audio'], isMainFrame: false }, 'unknown subframe cannot use fallback');
  verify(false, null, 'media', audio, 'worker has no app document');
  verify(false, {}, 'media', audio, 'missing WebContents URL');
  assert.strictEqual(check(null, 'media', 'file://', { mediaType: 'audio' }), false, 'file origin alone is not authority');
  console.log('Permission boundary: ' + count + ' request/check scenarios passed.');
}

async function native() {
  const { app, BrowserWindow, session } = require('electron');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  // No fake-ui switch: the real permission callbacks must decide each request.
  const watchdog = setTimeout(() => { console.error('Native permission test timed out'); app.exit(1); }, 45000);
  let win;
  try {
    await app.whenReady();
    const ses = session.fromPartition('permission-boundary-' + process.pid);
    const actual = handlers();
    const checks = [];
    ses.setPermissionCheckHandler((...args) => {
      checks.push({ permission: args[1], type: args[3] && args[3].mediaType });
      return actual.check(...args);
    });
    ses.setPermissionRequestHandler(actual.request);
    // Render a blank fixture at app/foreign file URLs without executing the app
    // or creating files. Permission decisions still see Chromium's real URLs.
    ses.protocol.handle('file', () => new Response('<!doctype html><title>Permission fixture</title>', {
      headers: { 'content-type': 'text/html' },
    }));
    win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(ownUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const before = await navigator.mediaDevices.enumerateDevices();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const tracks = stream.getTracks().map(t => ({ kind: t.kind, label: t.label }));
      stream.getTracks().forEach(t => t.stop());
      const after = await navigator.mediaDevices.enumerateDevices();
      let camera = 'allowed';
      try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); }
      catch (error) { camera = error.name; }
      const clipboard = await navigator.permissions.query({ name: 'clipboard-read' });
      return { before: before.filter(d => d.kind === 'audioinput').length,
        after: after.filter(d => d.kind === 'audioinput' && d.label).length,
        tracks, camera, clipboard: clipboard.state };
    })()`);
    assert(result.before > 0 && result.after > 0, 'audio enumeration remains available');
    assert.strictEqual(result.tracks.length, 1);
    assert.strictEqual(result.tracks[0].kind, 'audio');
    assert.match(result.tracks[0].label, /fake/i, 'only Chromium synthetic audio was captured');
    assert.strictEqual(result.camera, 'NotAllowedError');
    assert.strictEqual(result.clipboard, 'denied');
    assert(checks.some(c => c.permission === 'media' && c.type === 'audio'), 'native audio check observed');
    await win.loadURL(foreignFile);
    const foreign = await win.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => { s.getTracks().forEach(t => t.stop()); return 'allowed'; }, e => e.name)`);
    assert.strictEqual(foreign, 'NotAllowedError', 'foreign file cannot capture microphone');
    console.log('Native permission boundary: fake microphone enumeration/capture passed; camera, clipboard and foreign-file capture denied.');
  } finally {
    clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }
}

unit();
if (process.argv.includes('--native')) native().catch(error => {
  console.error(error);
  require('electron').app.exit(1);
});
