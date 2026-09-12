'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-onboarding-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
let win, release, calls = [], errors = [];
let payload = { version: 'test', entries: [], phrases: [], writingStyles: {},
  asrEngine: 'parakeet', asrDevice: 'auto', localModelChosen: false,
  engineStatus: 'unavailable', asrRuntimeWouldHelp: true,
  account: { signedIn: false, plan: 'free' },
  asrRuntime: { installed: true, bundled: true }, asrRuntimeState: { status: 'idle' },
  asrModel: { installed: false, downloadBytes: 3.1e9 },
  speechModels: { packs: [{ id: 'parakeet', downloadBytes: 670480039 }, { id: 'qwen3-asr', downloadBytes: 4.7e9 }] },
  modelPlan: require('../src/model-plan').plan({ engine: 'parakeet', sizes: { parakeet: 670480039 }, installed: {} }),
};
ipcMain.handle('app-load', () => payload);
ipcMain.handle('local-model-setup', (_e, engine) => {
  calls.push(engine);
  payload = { ...payload, asrEngine: engine, localModelChosen: true, asrOperation: 'install', asrRuntimeState: { status: 'downloading', progress: 25, message: 'Downloading your model…' } };
  win.webContents.send('history-updated', payload);
  return new Promise(resolve => { release = next => { payload = next; resolve(next); }; });
});
ipcMain.handle('asr-runtime-cancel', () => {
  payload = { ...payload, asrOperation: null, asrRuntimeState: { status: 'cancelled', message: 'Cancelled. Download again to resume.' } };
  release(payload); return payload;
});
ipcMain.handle('settings-set', (_e, patch) => (payload = { ...payload, ...patch }));
ipcMain.handle('account-billing-options', () => payload);
const deadline = setTimeout(() => { console.error('Onboarding UI timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1120, height: 760, show: false, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/Content-Security-Policy/.test(event.message)) errors.push(event.message); });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => new Promise(r => setTimeout(r, 250));
  const waitFor = async code => { for (let i=0;i<100;i++) { if (await js(code)) return; await new Promise(r=>setTimeout(r,30)); } throw Error('Timed out: '+code); };
  const click = async selector => {
    assert(await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return !e.disabled && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), selector+' is reachable');
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  await waitFor("document.getElementById('model-welcome').open");
  assert.equal(await js("document.querySelector('[name=welcome-model]:checked').value"), 'parakeet');
  assert.equal(await js("document.querySelectorAll('[name=welcome-model]').length"), 3);
  assert.equal(await js("document.getElementById('sidebar-pro').hidden"), true);
  if (process.argv.includes('--screenshots')) {
    const output = path.resolve(__dirname, '../temp'); fs.mkdirSync(output, {recursive:true});
    await settle();
    fs.writeFileSync(path.join(output,'onboarding.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(800,600);
    await settle();
    assert(await js("document.getElementById('model-welcome').scrollWidth <= document.getElementById('model-welcome').clientWidth"), 'no horizontal overflow at 800px');
    await click('#model-welcome-start');
    await settle();
    assert(await js("(()=>{const e=document.getElementById('model-welcome-later'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), 'cancel stays reachable as progress appears');
    fs.writeFileSync(path.join(output,'onboarding-small.png'), (await win.webContents.capturePage()).toPNG());
    await click('#model-welcome-later');
    await waitFor("!document.getElementById('model-welcome-start').disabled");
    calls=[]; win.setContentSize(1120,760);
  }
  await click('[name=welcome-model][value="qwen3-asr"]');
  await click('#model-welcome-start');
  await waitFor("document.getElementById('model-welcome-start').disabled");
  assert.deepEqual(calls,['qwen3-asr']);
  assert(await js("document.getElementById('model-welcome-choices').disabled"));
  await click('#model-welcome-later');
  await waitFor("!document.getElementById('model-welcome-start').disabled");
  assert(await js("document.getElementById('model-welcome-status').textContent.includes('Cancelled')"));
  await click('[name=welcome-model][value="whisper"]');
  await click('#model-welcome-start');
  await waitFor("document.getElementById('model-welcome-start').disabled");
  release({ ...payload, asrOperation: null, asrRuntimeState: { status:'error', message:'Network unavailable. Try again.' } });
  await waitFor("document.getElementById('model-welcome-status').textContent.includes('Network unavailable')");
  await click('[name=welcome-model][value="parakeet"]');
  await click('#model-welcome-start');
  await waitFor("document.getElementById('model-welcome-start').disabled");
  release({ ...payload, asrOperation: null, engineStatus:'standby', asrRuntimeWouldHelp:false,
    modelPlan:{ ...payload.modelPlan, ready:true, missing:[] }, asrRuntimeState:{status:'installed'} });
  await waitFor("document.getElementById('model-welcome-start').textContent === 'Start dictating'");
  await click('#model-welcome-start');
  assert(!await js("document.getElementById('model-welcome').open"));
  await click('#sidebar-pro-upgrade');
  assert(await js("!document.querySelector('.settings-panel[data-cat=billing]').hidden"));
  if (process.argv.includes('--screenshots')) {
    await js('closeSettings()');
    await settle();
    fs.writeFileSync(path.resolve(__dirname,'../temp/pro-sidebar.png'),(await win.webContents.capturePage()).toPNG());
  }
  payload = {...payload,account:{signedIn:true,plan:'pro'}};
  win.webContents.send('history-updated',payload);
  await waitFor("document.getElementById('sidebar-pro').hidden");
  await win.reload();
  await new Promise(r=>setTimeout(r,200));
  assert(!await js("document.getElementById('model-welcome').open"),'returning users skip welcome');
  assert.deepEqual(errors,[]);
  console.log('Passed onboarding selection, progress, cancellation, retry, persistence, billing navigation and Pro visibility.');
  clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(err=>{console.error(err);clearTimeout(deadline);app.exit(1);});
