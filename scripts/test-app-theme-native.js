'use strict';
// Real Electron main/preload/renderers with a disposable profile. The overlay's
// recording HUD is simulated; this test never requests a real microphone.
const { app, BrowserWindow, session, globalShortcut } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-theme-native-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
const file = path.join(profile, 'data/settings.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ appTheme: 'white', launchAtLogin: false, alwaysShowFlowBar: false, soundsEnabled: false }));
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require('../src/updater').startUpdater = () => {};
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
const captions = [];
const nativeCaption = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function (colors) { captions.push(colors); return nativeCaption.call(this, colors); };
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_w,_p,cb) => cb(false));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Native theme test timed out'); app.exit(1); }, 25000);
const until = async fn => { for(let i=0;i<150;i++){if(await fn())return;await pause(40);}assert.fail('Native windows did not become ready'); };
app.whenReady().then(async () => {
  let dashboard, overlay;
  await until(() => {
    dashboard=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/app.html'));
    overlay=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/overlay.html'));
    return dashboard&&overlay&&!dashboard.webContents.isLoading()&&!overlay.webContents.isLoading();
  });
  const run = code => dashboard.webContents.executeJavaScript(code);
  const bar = code => overlay.webContents.executeJavaScript(code);
  await until(()=>run('!!window.VoxdenThemeSettings'));
  assert.strictEqual(await run('window.voxden.initialAppTheme'), 'white');
  assert.strictEqual(await run('document.documentElement.dataset.appTheme'), 'white');
  assert.strictEqual(dashboard.getBackgroundColor().toLowerCase(), '#f5f7f6');
  await run(`openSettingsTarget('display'); true`);
  for(const style of ['classic','ribbon','orb']) {
    await bar(`alwaysShowFlowBar=true; soundsEnabled=false; setHud('idle'); applyFlowBarStyle('${style}'); setHud('recording'); true`);
    await pause(450);
    const before=await bar(`({mode:hudMode,generation:captureGen,style:flowBarStyle,color:getComputedStyle(pill).backgroundColor})`);
    for(const value of ['voxden','white']) {
      await run(`document.querySelector('.app-theme-card[data-app-theme="${value}"]').click(); true`);
      await until(()=>JSON.parse(fs.readFileSync(file,'utf8')).appTheme===value);
      assert.strictEqual(dashboard.getBackgroundColor().toLowerCase(),value==='white'?'#f5f7f6':'#101113');
      assert.strictEqual(captions.at(-1).symbolColor,value==='white'?'#5F6D64':'#a3ada6');
      assert.deepStrictEqual(await bar(`({mode:hudMode,generation:captureGen,style:flowBarStyle,color:getComputedStyle(pill).backgroundColor})`),before,'theme preserves '+style+' recording HUD');
      assert.strictEqual(await bar(`document.documentElement.hasAttribute('data-app-theme')`),false,'app theme does not reach the floating window');
    }
  }
  const reloaded = new Promise(resolve=>dashboard.webContents.once('did-finish-load',resolve));
  dashboard.webContents.reload(); await reloaded;
  assert.strictEqual(await run('window.voxden.initialAppTheme'), 'white','fresh preload reads the confirmed saved theme');
  const capture=fs.readFileSync(path.join(__dirname,'../src/capture.html'),'utf8');
  assert.ok(!capture.includes('app-theme.'),'capture overlays retain their existing theme');
  console.log('Native theme: saved White startup, live Windows chrome, reload and all three simulated recording HUDs passed.');
  clearTimeout(deadline);app.quit();
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
