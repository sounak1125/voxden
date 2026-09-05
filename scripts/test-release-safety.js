'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const harness = require('./asr-test-harness');
const atomic = require('../src/atomic-store');
const { createClipboardPaste } = require('../src/clipboard-paste');
let checks = 0;
async function test(name, work) {
  const h = harness();
  try {
    h.context.audio = wav(2);
    await work(h);
    checks++;
    console.log('ok ' + name);
  } finally { h.close(); }
}
function wav(seconds) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  await test('B01 cancelled retry cannot paste or create history, even after a new session', async h => {
    h.run("corpus.parkRetry(audio); var resolveRetry; sidecarTranscribe = () => new Promise(r => resolveRetry = r); var pasted = []; pasteDictation = async text => pasted.push(text);");
    const retry = h.run('retryLast()');
    h.run("flashCancel(); recordingSessionToken++; mode = 'recording'; resolveRetry('old result');");
    await retry;
    assert.strictEqual(h.run('pasted.length'), 0);
    assert.strictEqual(h.run('history.entries.length'), 0);
    assert.strictEqual(h.run('mode'), 'recording');
  });
  await test('B02 failed recognition retries the current recording', async h => {
    h.run("corpus.parkRetry(Buffer.from('previous audio')); sidecarTranscribe = async () => { throw new Error('speech engine timeout'); };");
    await assert.rejects(h.handlers.get('transcribe-local')(null, wav(3)), /timeout/);
    assert.deepStrictEqual(fs.readFileSync(h.run('corpus.retryPath()')), wav(3));
  });
  await test('B03 retention off and deletion remove retry copies', async h => {
    h.run('settings.keepRecordings = false; settings.keepTrainingAudio = false; parkCompletedClip(audio);');
    assert.strictEqual(h.run('corpus.hasRetry()'), false);
    assert.strictEqual(h.run('corpus.recordings().length'), 0);
    h.run("settings.keepRecordings = true; parkCompletedClip(audio); addHistoryEntry('saved words');");
    const id = h.run('history.entries[0].id');
    await h.handlers.get('history-delete')(null, id);
    assert.strictEqual(h.run('corpus.hasRetry()'), false);
    h.run('parkCompletedClip(audio); settings.keepRecordings = false; pruneRecordings();');
    assert.strictEqual(h.run('corpus.hasRetry()'), false);
    h.run('settings.keepRecordings = true; parkCompletedClip(audio); settings.keepRecordings = false;');
    const retryFile=h.run('corpus.retryPath()');
    const unlink=fs.unlinkSync;
    fs.unlinkSync=file=>{if(file===retryFile)throw Object.assign(new Error('Locked'),{code:'EPERM'});return unlink(file);};
    try {
      h.run('pruneRecordings()');
      assert.strictEqual(h.run('snapshot().canRetry'),false);
      assert(h.run('snapshot().recordingsError'));
    } finally {fs.unlinkSync=unlink;}
    h.run('pruneRecordings()');
    assert.strictEqual(h.run('snapshot().recordingsError'),'');
  });
  await test('B05 vocabulary rename preserves the original on invalid input, collision, and disk failure', async h => {
    const upsert = h.handlers.get('dict-upsert');
    assert((await upsert(null, 'Kubernetes', 'Kubernetes', { kind: 'word' })).ok);
    assert(!(await upsert(null, '$invalid', '$invalid', { kind: 'word', renameFrom: 'Kubernetes' })).ok);
    assert.strictEqual(h.run('dictionary.phrases[0].from'), 'Kubernetes');
    assert((await upsert(null, 'PostgreSQL', 'PostgreSQL', { kind: 'word' })).ok);
    assert(!(await upsert(null, 'PostgreSQL', 'PostgreSQL', { kind: 'word', renameFrom: 'Kubernetes' })).ok);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === h.run('DICT_FILE')) throw new Error('Disk failure');
      return rename(from, to);
    };
    try { assert(!(await upsert(null, 'Kubernetess', 'Kubernetess', { kind: 'word', renameFrom: 'Kubernetes' })).ok); }
    finally { fs.renameSync = rename; }
    h.run('loadStores()');
    assert(h.run("dictionary.phrases.some(p => p.from === 'Kubernetes')"));
    assert((await upsert(null, 'Kubernetess', 'Kubernetess', { kind: 'word', renameFrom: 'Kubernetes' })).ok);
    h.run('loadStores()');
    assert(!h.run("dictionary.phrases.some(p => p.from === 'Kubernetes')"));
    assert(h.run("dictionary.phrases.some(p => p.from === 'Kubernetess')"));
  });
  await test('B06 history retry preserves newer edits and deleted entries', async h => {
    h.run("history.entries = [{id:'entry',text:'original'}]; corpus.park(audio); corpus.claim('entry'); var resolveRetry; sidecarTranscribe = () => new Promise(r => resolveRetry = r);");
    const retry = h.run("retryEntry('entry')");
    await h.handlers.get('history-edit')(null, 'entry', 'My manual correction');
    h.run("resolveRetry('Automatic replacement');");
    assert.strictEqual((await retry).ok, false);
    assert.strictEqual(h.run('history.entries[0].text'), 'My manual correction');
    const retryDeleted = h.run("retryEntry('entry')");
    await h.handlers.get('history-delete')(null, 'entry');
    h.run("resolveRetry('Deleted replacement');");
    assert.strictEqual((await retryDeleted).ok, false);
    assert.strictEqual(h.run('history.entries.length'), 0);
  });
  await test('B08 partial writes preserve committed history and damaged JSON recovers', async h => {
    h.run("history.entries = [{id:'kept',text:'committed'}]; saveHistory();");
    const file = h.run('HIST_FILE');
    const previous = fs.readFileSync(file);
    const write = fs.writeFileSync;
    fs.writeFileSync = (target, body, ...args) => {
      if (typeof target === 'number') {
        write(target, String(body).slice(0, 12), ...args);
        throw Object.assign(new Error('No space'), { code: 'ENOSPC' });
      }
      return write(target, body, ...args);
    };
    try { assert.throws(() => atomic.writeJson(file, { entries: [] }), /No space/); }
    finally { fs.writeFileSync = write; }
    assert.deepStrictEqual(fs.readFileSync(file), previous);
    fs.writeFileSync(file, '{broken');
    h.run('loadStores()');
    assert.strictEqual(h.run('history.entries[0].text'), 'committed');
    h.run('history.entries = []; saveHistory();');
    assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak')).entries.length, 0);
  });
  await test('B09 failed paste keeps the recognized text and shows failure', async h => {
    h.run("pasteDictation = async () => { throw new Error('Paste failed'); }; mode = 'transcribing';");
    await h.run("onTranscript('Words worth keeping')");
    assert.strictEqual(h.run('mode'), 'error');
    assert.strictEqual(h.run('history.entries[0].text'), 'Words worth keeping');
  });
  await test('B10 cancelled setup restarts an existing runtime', async h => {
    h.run("asrRuntimeManager = {installed: () => ({pythonPath: 'installed-python'}), snapshot: () => ({installed: true})}; var restarts = 0; restartSidecar = () => restarts++;");
    await h.run("runAsrOperation('install', async () => { asrRuntimeState = {status:'cancelled'}; })");
    assert.strictEqual(h.run('restarts'), 1);
  });
  await test('B11 intentional GPU restart does not disable acceleration', async h => {
    h.run("spawnSidecarServe({ py:'mock-python', env:{}, cpuManaged: false, accelKind: 'cuda' });");
    h.run('restartSidecar();');
    await tick();
    assert.strictEqual(h.run('qwenAccelSessionBlock'), null);
    h.run("spawnSidecarServe({ py:'mock-python', env:{}, cpuManaged: false, accelKind: 'cuda' }); sidecar.emit('exit', 1);");
    assert.strictEqual(h.run('qwenAccelSessionBlock.backend'), 'cuda');
  });
  await test('B12 failed training deletion remains visible and retryable', async h => {
    h.run("corpus.park(audio); corpus.claim('trained'); corpus.promote('trained', {text:'training words'});");
    const audio = h.run("corpus.recordingPath('trained')");
    const unlink = fs.unlinkSync;
    fs.unlinkSync = file => {
      if (file === audio) throw Object.assign(new Error('Locked'), {code:'EPERM'});
      return unlink(file);
    };
    let result;
    try { result = await h.handlers.get('training-clear')(); }
    finally { fs.unlinkSync = unlink; }
    assert(result.trainingError);
    assert.strictEqual(result.training.pairs, 1);
    assert(fs.existsSync(audio));
    assert.strictEqual((await h.handlers.get('training-clear')()).training.pairs, 0);
    assert(!fs.existsSync(audio));
  });
  await test('B13-B17 complete transcript pipeline preserves languages, tokens, formatting, and verbatim speech', async h => {
    for (const [language, raw] of [['pt','Preciso de um documento.'], ['de','Er ist hier.']]) {
      h.context.raw = raw; h.context.language = language;
      assert.strictEqual(h.run("settings.dictationLanguage=language; composeTranscript(raw,'formal','accurate').text"), raw);
    }
    h.run("settings.dictationLanguage='en'");
    for (const tone of ['formal','casual','veryCasual']) {
      h.context.tone = tone;
      const result = h.run("composeTranscript('Visit github.com or email Test@Example.com; amount 1,234.56',tone,'accurate').text");
      for (const token of ['github.com','Test@Example.com','1,234.56']) assert(result.includes(token), result);
      assert(h.run("composeTranscript('Hello insert new paragraph world',tone,'accurate').text").includes('\n\n'));
    }
    assert.strictEqual(h.run(`composeTranscript("I'd already finished.",'formal','accurate').text`), "I'd already finished.");
    assert.strictEqual(h.run(`composeTranscript("It's been a long day.",'formal','accurate').text`), "It's been a long day.");
    h.run('settings.verbatimMode=true');
    for (const raw of ['You','Subscribe','Thank you for watching','The end']) {
      h.context.raw = raw;
      assert.strictEqual(h.run("composeTranscript(raw,'formal','accurate').text"), raw);
    }
  });
  await test('B18 retries and live dictation share duration-based timeouts', async h => {
    h.context.audio = wav(120);
    h.run("history.entries=[{id:'long',text:'Words'}]; corpus.park(audio); corpus.claim('long'); var timeouts=[]; sidecarTranscribe=async (file,opts)=>{timeouts.push(opts.timeoutMs);return 'Words';};");
    assert((await h.run("retryEntry('long')")).ok);
    await h.handlers.get('transcribe-local')(null, h.context.audio);
    assert.strictEqual(h.run('timeouts[0]'), 980000);
    assert.strictEqual(h.run('timeouts[0] === timeouts[1]'), true);
  });
  await test('B19 lifetime history survives more than 400 entries and restart', async h => {
    h.run("history.entries=Array.from({length:400},(_,i)=>({id:'old'+i,text:'one word',ts:Date.now()-i})); addHistoryEntry('new word'); loadStores();");
    assert.strictEqual(h.run('history.entries.length'), 401);
    assert.strictEqual(h.run('dict.countWordsInHistory(history.entries)'), 802);
  });
  await test('B23 helper timeout preserves successful media-pause receipts', async h => {
    h.run('settings.soundsEnabled=false; psServersAllowed=false;');
    const begin = h.run('pauseBackgroundMedia()');
    await tick();
    const pause = h.launches.find(x => x.callback && x.args[1].includes('media-pause'));
    pause.callback(new Error('Timeout after one pause'), 'player-a\n');
    await begin;
    const end = h.run('resumeBackgroundMedia()');
    await tick();
    const resume = h.launches.find(x => x.callback && x.args[1].includes('media-resume'));
    assert(resume && resume.args[1].includes('player-a'));
    resume.callback(null, '');
    await end;
  });
  await test('B23 persistent helper streams receipts before completion or timeout', async h => {
    h.run('settings.soundsEnabled=false;');
    const begin = h.run('pauseBackgroundMedia()');
    await tick();
    const server = h.run('psServers[0]');
    const id = server.pending.id;
    server.proc.stdout.emit('data', JSON.stringify({id,partial:true,out:'player-streamed'})+'\n');
    assert.strictEqual(server.pending.receipts[0], 'player-streamed');
    h.run("psRetireServer(psServers[0], 'timeout')");
    await begin;
    h.run('psServersAllowed=false');
    const end = h.run('resumeBackgroundMedia()');
    await tick();
    const resume=h.launches.find(x=>x.callback && x.args[1].includes('media-resume'));
    assert(resume.args[1].includes('player-streamed'));
    resume.callback(null,'');
    await end;
  });
  await clipboardTests();
  await updaterTests();
  console.log('All ' + checks + ' release safety groups passed');
}

async function clipboardTests() {
  let value = { 'text/plain':'before', 'text/html':'<b>before</b>' };
  let scheduled;
  const clipboard = {
    availableFormats: () => Object.keys(value),
    readBuffer: format => Buffer.from(value[format]),
    readText: () => value['text/plain'] || '', readHTML: () => value['text/html'] || '',
    writeText: text => { value = {'text/plain':text}; },
    write: data => { value = {}; if ('text' in data) value['text/plain']=data.text; if ('html' in data) value['text/html']=data.html; },
  };
  const paste = createClipboardPaste(clipboard, { delay: fn => { scheduled=fn;return 1; }, cancel:()=>{} });
  await paste.paste('dictation', async()=>{}); scheduled();
  assert.deepStrictEqual(value, {'text/plain':'before','text/html':'<b>before</b>'});
  await paste.paste('dictation', async()=>{});
  clipboard.writeText('new user copy'); scheduled();
  assert.strictEqual(clipboard.readText(),'new user copy');
  await paste.paste('first',async()=>{});
  await paste.paste('second',async()=>{}); scheduled();
  assert.strictEqual(clipboard.readText(),'new user copy');
  value={'application/custom':'keep me'};
  await assert.rejects(paste.paste('dictation',async()=>{}), /safely restored/);
  assert.strictEqual(value['application/custom'],'keep me');
  checks++; console.log('ok B04 clipboard restoration preserves rich content, newer copies, and unsupported formats');
}

async function updaterTests() {
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async()=>({});
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/updater.js'),'utf8'), {
    module, setInterval:()=>1, clearInterval:()=>{},
    require: name => name==='electron' ? {app:{isPackaged:true,getVersion:()=> '2.1.0'}} : {autoUpdater},
  });
  const updater=module.exports;
  updater.startUpdater({});
  autoUpdater.emit('update-downloaded',{version:'2.1.1'});
  autoUpdater.quitAndInstall=()=>autoUpdater.emit('error',new Error('installer failed'));
  assert.strictEqual(updater.installNow().ok,false);
  assert.strictEqual(updater.getUpdateStatus().status,'ready');
  assert(updater.getUpdateStatus().installError);
  autoUpdater.quitAndInstall=()=>{};
  assert.strictEqual(updater.installNow().ok,true);
  autoUpdater.emit('error',new Error('late failure'));
  assert.strictEqual(updater.getUpdateStatus().status,'ready');
  assert(updater.getUpdateStatus().installError);
  assert.strictEqual(updater.installNow().ok,true);
  checks++; console.log('ok B22 synchronous and asynchronous installer errors allow retry');
}

main().catch(err=>{console.error(err);process.exitCode=1;});
