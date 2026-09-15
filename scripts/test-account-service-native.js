'use strict';
// Two actual packaged main/preload startups with the same disposable profile:
// select local service, then launch normally before any successful sign-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  (async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-service-native-'));
    let requests = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/v1/auth/options');
      requests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ google: { clientId: 'fixture.apps.googleusercontent.com' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/v1';
    try {
      for (const phase of ['configure', 'restart']) {
        await new Promise((resolve, reject) => {
          const env = { ...process.env };
          delete env.VOXDEN_ACCOUNT_URL;
          const child = spawn(require('electron'), [__filename, '--phase=' + phase, '--profile=' + profile, '--base=' + base, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(phase + ' failed: ' + code)));
        });
      }
      assert(requests >= 2);
      assert(!fs.existsSync(path.join(profile, 'data/account.json')), 'test never signs in or needs a saved account');
      console.log('Packaged account service: sign-in discovery works on first launch and normal restart without an environment override or account token.');
    } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, globalShortcut, session } = require('electron');
  const arg = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
  const resources = arg('resources');
  const root = resources ? path.join(resources, 'app.asar') : path.join(__dirname, '..');
  if (resources) Object.defineProperty(process, 'resourcesPath', { value: resources });
  app.setPath('userData', arg('profile'));
  app.disableHardwareAcceleration();
  Object.defineProperty(app, 'isPackaged', { value: true });
  app.getVersion = () => require(path.join(root, 'package.json')).version;
  if (arg('phase') === 'configure') process.env.VOXDEN_ACCOUNT_URL = arg('base');
  else delete process.env.VOXDEN_ACCOUNT_URL;
  app.setLoginItemSettings = () => {};
  globalShortcut.register = () => true;
  globalShortcut.unregister = () => {};
  globalShortcut.unregisterAll = () => {};
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  require(path.join(root, 'src/updater')).startUpdater = () => {};
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  });
  require(path.join(root, 'src/main'));
  const deadline = setTimeout(() => { console.error('Account service startup timed out'); app.exit(1); }, 20000);
  app.whenReady().then(async () => {
    let win;
    for (let i = 0; i < 100; i++) {
      win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/app.html'));
      if (win && !win.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(win);
    const result = await win.webContents.executeJavaScript('window.voxden.accountAuthOptions()');
    assert.equal(result.account.baseUrl, arg('base'));
    assert.equal(result.account.signedIn, false);
    assert.equal(result.account.lastError, '');
    assert.equal(result.account.auth.google, true);
    clearTimeout(deadline);
    app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
