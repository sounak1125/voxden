'use strict';

// Actual renderers and preload, with simulated device and playback responses.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const project = path.join(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-release-ui-')));
app.disableHardwareAcceleration();
const releases = {};
const entries = [
  {id:'a',ts:Date.now(),text:'First recording',audio:true},
  {id:'b',ts:Date.now()-1000,text:'Second recording',audio:true},
];
const payload = { entries,phrases:[],notifications:[],keepRecordings:true,engineStatus:'ready',asrEngine:'qwen3-asr',asrDevice:'cpu' };
ipcMain.handle('app-load',()=>payload);
ipcMain.handle('history-audio',(_e,id)=>new Promise(resolve=>{releases[id]=resolve;}));
let failures=0;
ipcMain.on('capture-failed',()=>{failures++;});
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{console.error('Renderer regression timeout');app.exit(2);},20000);
const windowOptions={show:false,webPreferences:{preload:path.join(project,'src/preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}};

app.whenReady().then(async()=>{
  const win=new BrowserWindow({...windowOptions,width:1120,height:760});
  await win.loadFile(path.join(project,'src/app.html'));
  const run=code=>win.webContents.executeJavaScript(code);
  await delay(200);
  const mic=await run(`micDevices=[{kind:'audioinput',deviceId:'mic-a',label:'USB microphone'}];
    defaultMicId='mic-a';renderMicSelect({microphone:'mic-a'});
    ({value:settingInputs.microphone.value,index:settingInputs.microphone.selectedIndex})`);
  assert.strictEqual(mic.value,'mic-a'); assert(mic.index>=0);
  console.log('ok B21 explicit microphone remains selected when it becomes default');

  await run(`window.testAudio=[];window.Audio=class extends EventTarget {
    constructor(url){super();this.url=url;this.paused=true;this.duration=5;this.currentTime=0;testAudio.push(this)}
    play(){this.paused=false;return Promise.resolve()} pause(){this.paused=true}
  }; true`);
  const click=id=>run(`document.querySelector('.card[data-id="${id}"] .card-menu [role=menuitem]').click();true`);
  await click('a');await click('b');await delay(50);
  releases.b({ok:true,bytes:Buffer.alloc(44),seconds:5});await delay(30);
  releases.a({ok:true,bytes:Buffer.alloc(44),seconds:5});await delay(30);
  assert.deepStrictEqual(await run('testAudio.map(a=>a.paused)'),[false]);
  assert.strictEqual(await run('activePlayer.id'),'b');
  await run('stopActivePlayer();true');
  assert.deepStrictEqual(await run('testAudio.map(a=>a.paused)'),[true]);
  await click('a');await delay(30);await run('stopActivePlayer();true');
  releases.a({ok:true,bytes:Buffer.alloc(44),seconds:5});await delay(30);
  assert.strictEqual(await run('testAudio.length'),1);
  console.log('ok B20 only latest playback starts; stopping cancels a pending load');

  const historySize=await run(`window.largeHistory=Array.from({length:805},(_,i)=>({id:'older'+i,text:i===804?'unique oldest words':'older words',ts:Date.now()-i*1000}));
    renderFeed({},largeHistory);document.querySelectorAll('#groups .card').length`);
  assert.strictEqual(historySize,400);
  await run("document.getElementById('history-show-more').click();true");
  assert.strictEqual(await run("document.querySelectorAll('#groups .card').length"),800);
  assert.strictEqual(await run("query='unique oldest';renderFeed({},largeHistory);document.querySelectorAll('#groups .card').length"),1);
  assert.strictEqual(await run("document.querySelector('#groups .card').dataset.id"),'older804');
  console.log('ok B19 older history remains searchable without rendering every card at once');
  const update=await run(`renderUpdateStatus({version:'2.1.0',packaged:true,status:'ready',availableVersion:'2.1.1',installError:'Installer failed. Retry.'});
    ({hidden:updateRestartBtn.hidden,disabled:updateRestartBtn.disabled,hint:updateStatusHintEl.textContent})`);
  assert.strictEqual(update.hidden,false);assert.strictEqual(update.disabled,false);assert(update.hint.includes('Installer failed'));
  console.log('ok B22 failed installation offers a visible retry');

  const overlay=new BrowserWindow({...windowOptions,width:260,height:84});
  await overlay.loadFile(path.join(project,'src/overlay.html'));
  const capture=code=>overlay.webContents.executeJavaScript(code);
  await capture(`window.testGum=[];navigator.mediaDevices.getUserMedia=()=>new Promise((r,j)=>testGum.push({r,j}));
    window.testTracks=[];window.makeStream=id=>{const track={id,stopped:false,stop(){this.stopped=true}};testTracks.push(track);return {getTracks:()=>[track]}};
    window.AudioContext=class {constructor(){this.state='running';this.sampleRate=48000}
      createMediaStreamSource(){return {connect(){},disconnect(){}}}
      createAnalyser(){return {connect(){},disconnect(){},getFloatTimeDomainData(){},getByteFrequencyData(){}}}
      createScriptProcessor(){return {connect(){},disconnect(){}}}
      createMediaStreamDestination(){return {connect(){},disconnect(){}}}
      close(){return Promise.resolve()}};
    startWaveLoop=()=>{};startCapture('whisper');true`);
  overlay.webContents.send('state',{mode:'cancel'});await delay(30);
  await capture("startCapture('whisper');testGum[1].r(makeStream('new-session'));true");await delay(30);
  await capture("testGum[0].j(new Error('old request rejected'));true");await delay(30);
  assert.strictEqual(await capture('capturing'),true);
  assert.strictEqual(failures,0);
  assert.strictEqual(await capture("mediaStream.getTracks()[0].id"),'new-session');
  overlay.webContents.send('state',{mode:'cancel'});await delay(30);
  await capture("startCapture('whisper');true");
  overlay.webContents.send('state',{mode:'cancel'});await delay(30);
  await capture("startCapture('whisper');testGum[3].r(makeStream('latest-session'));true");await delay(30);
  await capture("testGum[2].r(makeStream('stale-success'));true");await delay(30);
  assert.strictEqual(await capture('capturing'),true);
  assert.strictEqual(await capture('mediaStream.getTracks()[0].id'),'latest-session');
  assert.strictEqual(await capture("testTracks.find(t=>t.id==='stale-success').stopped"),true);
  assert.strictEqual(await capture("testTracks.find(t=>t.id==='latest-session').stopped"),false);
  console.log('ok B07 stale microphone rejection and success cannot damage a newer capture');
  await capture('capturing=false;captureGen++;teardownAudio();true');
  overlay.destroy();win.destroy();clearTimeout(deadline);app.quit();
}).catch(err=>{console.error(err);clearTimeout(deadline);app.exit(1);});
