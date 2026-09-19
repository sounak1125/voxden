'use strict';

// Run the shipped overlay and preload while only the audio device is fake.
// Device failures and delayed callbacks can then be reproduced without opening
// the user's microphone, waiting for ASR, or depending on their audio driver.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-audio-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
// The second fixture uses Chromium's real capture graph with a local synthetic
// input. No default system microphone or speaker is used by either fixture.
const fakeWav = Buffer.alloc(44 + 48000 * 2);
fakeWav.write('RIFF', 0); fakeWav.writeUInt32LE(fakeWav.length - 8, 4);
fakeWav.write('WAVEfmt ', 8); fakeWav.writeUInt32LE(16, 16);
fakeWav.writeUInt16LE(1, 20); fakeWav.writeUInt16LE(1, 22);
fakeWav.writeUInt32LE(48000, 24); fakeWav.writeUInt32LE(96000, 28);
fakeWav.writeUInt16LE(2, 32); fakeWav.writeUInt16LE(16, 34);
fakeWav.write('data', 36); fakeWav.writeUInt32LE(fakeWav.length - 44, 40);
for (let i = 0; i < 48000; i++) {
  const t = i / 48000;
  const envelope = .6 + .4 * Math.sin(2 * Math.PI * 3 * t);
  const sample = envelope * (.25 * Math.sin(2 * Math.PI * 220 * t) + .12 * Math.sin(2 * Math.PI * 440 * t));
  fakeWav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
}
const fakeAudioPath = path.join(profile, 'synthetic-input.wav');
fs.writeFileSync(fakeAudioPath, fakeWav);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeAudioPath);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const deadline = setTimeout(() => { console.error('Flow bar audio UI timed out'); app.exit(1); }, 30000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 260, height: 96, frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    },
  });
  const errors = [];
  const failures = [];
  let ready = 0;
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(text)) errors.push(text);
  });
  ipcMain.on('capture-failed', (event, message) => {
    if (event.sender === win.webContents) failures.push(message);
  });
  ipcMain.on('capture-ready', event => {
    if (event.sender === win.webContents) ready += 1;
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await run(`soundsEnabled = false;
    window.audioTest = (() => {
      const fake = { config: {}, streams: [], contexts: [], requests: [], nodes: [], timers: new Map(), clock: 100, nextTimer: 0 };
      addEventListener('unhandledrejection', event => { console.error('Unhandled audio rejection: ' + event.reason); });
      Object.defineProperty(performance, 'now', { value: () => fake.clock, configurable: true });
      window.setInterval = (callback, ms) => {
        const id = ++fake.nextTimer; fake.timers.set(id, { callback, ms }); return id;
      };
      window.clearInterval = id => fake.timers.delete(id);
      function stream(kind) {
        const track = { onended: null, stops: 0, stop() { this.stops++; } };
        const result = { kind, track, getTracks: () => [track], getAudioTracks: () => [track] };
        fake.streams.push(result);
        return result;
      }
      function node(kind, context) {
        if (fake.config.fail === kind) throw new Error('Simulated ' + kind + ' failure');
        const result = { kind, context, disconnects: 0, connections: [],
          connect(other) {
            if (fake.config.fail === 'connect') throw new Error('Simulated connection failure');
            this.connections.push(other);
          },
          disconnect() { this.disconnects++; },
        };
        if (kind === 'analyser') Object.assign(result, {
          fftSize: 1024, frequencyBinCount: 512,
          getFloatTimeDomainData: data => data.fill(0),
          getByteFrequencyData: data => data.fill(0),
        });
        if (kind === 'sink') result.stream = stream('sink');
        fake.nodes.push(result);
        return result;
      }
      window.AudioContext = class {
        constructor() {
          if (fake.config.fail === 'constructor') throw new Error('Simulated device initialization failure');
          this.state = fake.config.resume ? 'suspended' : 'running';
          this.sampleRate = 48000;
          this.closes = 0;
          this.behavior = { ...fake.config };
          fake.contexts.push(this);
        }
        resume() {
          if (this.behavior.resume === 'reject') return Promise.reject(new Error('Simulated resume failure'));
          if (this.behavior.resume === 'pending') return new Promise(resolve => { this.releaseResume = () => { this.state = 'running'; resolve(); }; });
          this.state = 'running'; return Promise.resolve();
        }
        close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }
        createMediaStreamSource() { return node('source', this); }
        createAnalyser() { return node('analyser', this); }
        createScriptProcessor() { return node('processor', this); }
        createMediaStreamDestination() { return node('sink', this); }
      };
      navigator.mediaDevices.getUserMedia = options => {
        const request = { options, config: { ...fake.config } }; fake.requests.push(request);
        if (request.config.micError) return Promise.reject(new DOMException('Simulated microphone error', request.config.micError));
        if (request.config.micPending) return new Promise(resolve => { request.release = () => { request.stream = stream('mic'); resolve(request.stream); }; });
        request.stream = stream('mic'); return Promise.resolve(request.stream);
      };
      fake.pcm = (callback = processor && processor.onaudioprocess, length = 4096) => {
        if (!callback) throw new Error('Expected an audio callback');
        callback({ inputBuffer: { getChannelData: () => new Float32Array(length).fill(.01) } });
        stopWaveLoop();
      };
      fake.snapshot = () => ({
        capturing, hudMode, generation: captureGen, chunks: dsPcmChunks.length,
        hasGraph: !!(mediaStream || audioCtx || sourceNode || analyser || processor || captureSink),
        timers: fake.timers.size,
        streams: fake.streams.map(s => ({ kind: s.kind, stops: s.track.stops, endedDetached: s.track.onended === null })),
        contexts: fake.contexts.map(c => ({ closes: c.closes, state: c.state })),
        nodes: fake.nodes.map(n => ({ kind: n.kind, disconnects: n.disconnects, callbackDetached: n.kind !== 'processor' || n.onaudioprocess === null })),
      });
      fake.configure = config => {
        fake.config = config; fake.streams = []; fake.contexts = []; fake.requests = []; fake.nodes = [];
      };
      return fake;
    })(); true`);
  // A timeout turn also flushes the renderer->main IPC channel. rAF cannot be
  // used for this: inactive transparent windows may receive no compositor frames.
  const flush = () => pause(20);
  async function state(payload) {
    win.webContents.send('state', { soundsEnabled: false, alwaysShowFlowBar: true, engine: 'whisper', engineStatus: 'ready', ...payload });
    await flush();
  }
  async function reset(config = {}) {
    await state({ mode: 'cancel' });
    await state({ mode: 'idle' });
    assert.strictEqual(await run('audioTest.timers.size'), 0, 'cancelling releases the PCM watchdog');
    await run('audioTest.configure(' + JSON.stringify(config) + '); true');
    failures.length = 0;
    ready = 0;
  }
  async function start() {
    await state({ mode: 'arming', prepareOnly: false });
  }
  async function assertReleased(label) {
    const actual = await run('audioTest.snapshot()');
    assert.strictEqual(actual.capturing, false, label + ' clears capturing');
    assert.strictEqual(actual.hasGraph, false, label + ' drops graph references');
    assert.strictEqual(actual.timers, 0, label + ' clears the PCM watchdog');
    assert.strictEqual(actual.chunks, 0, label + ' drops unfinished PCM');
    assert.ok(actual.streams.every(s => s.stops === 1 && s.endedDetached), label + ' stops every microphone and sink track once');
    assert.ok(actual.contexts.every(c => c.closes === 1), label + ' closes every opened audio context once');
    assert.ok(actual.nodes.every(n => n.disconnects === 1 && n.callbackDetached), label + ' disconnects every node and detaches callbacks');
    return actual;
  }

  for (const fail of ['constructor', 'source', 'analyser', 'processor', 'sink', 'connect']) {
    await reset({ fail });
    await start();
    assert.strictEqual(failures.length, 1, fail + ' reports exactly one capture failure');
    assert.match(failures[0], /audio could not start/i);
    assert.strictEqual(ready, 0, fail + ' never claims the microphone is recording');
    assert.strictEqual((await assertReleased(fail)).hudMode, 'error');
  }
  await reset({ resume: 'reject' });
  await start();
  assert.strictEqual(failures.length, 1, 'resume rejection reports one failure');
  await assertReleased('resume rejection');

  for (const micError of ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError']) {
    await reset({ micError });
    await start();
    assert.strictEqual(failures.length, 1, micError + ' reports one failure');
    assert.match(failures[0], /^(NotAllowedError|SecurityError)$/.test(micError) ? /allow microphone access/i : /microphone unavailable/i);
    assert.strictEqual(ready, 0, micError + ' cannot report recording');
    await assertReleased(micError);
  }

  await reset();
  await start();
  assert.strictEqual(await run('hudMode'), 'arming', 'opening a graph alone must not display Recording');
  assert.strictEqual(ready, 0, 'no capture-ready before the first PCM buffer');
  await run('audioTest.pcm(undefined, 0); true');
  await flush();
  assert.strictEqual(ready, 0, 'empty PCM buffers are not readiness');
  await run('audioTest.pcm(); true');
  await flush();
  assert.strictEqual(ready, 1, 'the first PCM frame confirms readiness');
  assert.strictEqual(await run('hudMode'), 'recording', 'Recording corresponds to delivered audio');
  await run('audioTest.pcm(); audioTest.pcm(); true');
  await flush();
  assert.strictEqual(ready, 1, 'later PCM does not send duplicate readiness');
  assert.strictEqual(await run('dsPcmChunks.length'), 3, 'PCM reaches the local speech-engine buffer');
  await run('audioTest.oldCallback = processor.onaudioprocess; audioTest.oldEnded = mediaStream.track.onended; mediaStream.track.onended(); true');
  await flush();
  assert.strictEqual(failures.length, 1, 'a disconnected input reports a failure');
  assert.match(failures[0], /disconnected/i);
  await assertReleased('input disconnected');
  await run('audioTest.pcm(audioTest.oldCallback); audioTest.oldEnded(); true');
  await flush();
  assert.strictEqual(failures.length, 1, 'queued device callbacks cannot report the same failure twice');
  assert.strictEqual(ready, 1, 'queued PCM cannot revive a failed capture');

  await reset();
  await start();
  await run('audioTest.oldCallback = processor.onaudioprocess; audioTest.oldEnded = mediaStream.track.onended; true');
  await state({ mode: 'cancel' });
  await assertReleased('cancelled capture');
  await start();
  await run('audioTest.pcm(audioTest.oldCallback); audioTest.oldEnded(); true');
  await flush();
  assert.strictEqual(ready, 0, 'old PCM cannot mark a new capture ready');
  assert.strictEqual(failures.length, 0, 'old device end cannot fail a new capture');
  assert.strictEqual(await run('capturing && dsPcmChunks.length === 0'), true, 'the new capture survives with an empty buffer');
  await run('audioTest.pcm(); true');
  await flush();
  assert.strictEqual(ready, 1, 'only the new capture can report readiness');

  await reset({ micPending: true });
  await start();
  assert.strictEqual(await run('audioTest.requests.length'), 1);
  await state({ mode: 'cancel' });
  await run('audioTest.config = {}; true');
  await start();
  await run('audioTest.requests[0].release(); true');
  await flush();
  assert.strictEqual(await run('audioTest.requests[0].stream.track.stops'), 1, 'late getUserMedia stream is closed');
  assert.strictEqual(await run('mediaStream === audioTest.requests[1].stream && mediaStream.track.stops === 0'), true,
    'late getUserMedia cannot replace or stop the new microphone');
  assert.strictEqual(failures.length, 0, 'an obsolete microphone promise is discarded quietly');
  await run('audioTest.pcm(); true');
  await flush();
  assert.strictEqual(ready, 1, 'the replacement microphone records normally');

  await reset({ resume: 'pending' });
  await start();
  assert.strictEqual(ready, 0, 'pending audio resume remains in arming');
  await state({ mode: 'cancel' });
  await run('audioTest.config = {}; true');
  await start();
  await run('audioTest.contexts[0].releaseResume(); true');
  await flush();
  assert.strictEqual(await run('audioCtx === audioTest.contexts[1] && mediaStream === audioTest.requests[1].stream'), true,
    'an obsolete resume cannot attach its graph to the replacement capture');
  assert.strictEqual(await run('audioTest.contexts[0].closes'), 1, 'cancel already closed the obsolete context');
  assert.strictEqual(ready, 0);
  await run('audioTest.pcm(); true');
  await flush();
  assert.strictEqual(ready, 1);

  await reset();
  await start();
  await run('audioTest.pcm(); audioTest.clock += 10001; [...audioTest.timers.values()].forEach(t => t.callback()); true');
  await flush();
  assert.strictEqual(failures.length, 1, 'PCM stopping after recording began reports a failure');
  assert.match(failures[0], /stopped responding/i);
  await assertReleased('stalled PCM');

  await reset();
  await start();
  await run('processor.onaudioprocess({ inputBuffer: { getChannelData() { throw new Error("Device callback failed"); } } }); true');
  await flush();
  assert.strictEqual(failures.length, 1, 'malformed audio callback fails safely');
  assert.match(failures[0], /read microphone audio/i);
  await assertReleased('audio callback failure');

  // Re-loading discards every fake JS node and timer. Capture now goes through
  // real getUserMedia, AudioContext, ScriptProcessor and WAV encoding, while a
  // fake ASR response keeps this an audio/overlay test instead of a model test.
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  await run('soundsEnabled = false; true');
  failures.length = 0;
  ready = 0;
  const transcripts = [];
  const transcriptions = [];
  let ended = 0;
  let confirms = 0;
  ipcMain.on('capture-ended', event => { if (event.sender === win.webContents) ended += 1; });
  ipcMain.on('hud-confirm', event => {
    if (event.sender !== win.webContents) return;
    confirms += 1;
    win.webContents.send('state', { mode: 'stop', engine: 'whisper', engineStatus: 'ready', soundsEnabled: false });
  });
  ipcMain.handle('transcribe-local', (_event, wav) => {
    const data = Buffer.from(wav);
    transcriptions.push(data);
    return 'Synthetic microphone works.';
  });
  ipcMain.on('transcript', (event, text) => {
    if (event.sender !== win.webContents) return;
    transcripts.push(text);
    win.webContents.send('state', { mode: 'success', text, soundsEnabled: false });
  });
  await start();
  const waitUntil = async (predicate, label) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (await predicate()) return;
      await pause(40);
    }
    assert.fail(label + '; capture failures: ' + failures.join('; '));
  };
  await waitUntil(async () => ready === 1 && await run('dsPcmChunks.reduce((sum, pcm) => sum + pcm.length, 0) >= OUT_RATE * .7'),
    'the real graph must produce PCM and announce recording');
  assert.strictEqual(await run('hudMode'), 'recording');
  assert.strictEqual(await run('audioCtx instanceof AudioContext && processor instanceof ScriptProcessorNode'), true,
    'the complete pipeline uses native Web Audio nodes');
  const gate = await run('speechGateApi().analyseSpeech(mergePcm(dsPcmChunks), { sampleRate: OUT_RATE })');
  assert.ok(gate.speech, 'the real fake-device PCM must pass the unmodified speech gate: ' + JSON.stringify(gate));
  const finishPoint = await run(`(() => {
    const r = btnConfirm.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...finishPoint });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...finishPoint, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...finishPoint, button: 'left', clickCount: 1 });
  await waitUntil(() => transcripts.length === 1, 'clicking Island Stop must complete transcription');
  assert.strictEqual(confirms, 1, 'the actual Stop click emits exactly one confirm IPC');
  assert.strictEqual(ended, 1, 'stop releases the microphone before transcription completes');
  assert.strictEqual(transcriptions.length, 1, 'the full recording is submitted once');
  assert.strictEqual(transcriptions[0].toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(transcriptions[0].readUInt32LE(24), 16000, 'the live recording is encoded at the ASR sample rate');
  assert.ok(transcriptions[0].length > 44 + 16000 * .7 * 2, 'the encoded clip contains the real PCM');
  assert.deepStrictEqual(transcripts, ['Synthetic microphone works.']);
  await state({ mode: 'idle' });
  assert.strictEqual(await run('hudMode === "idle" && !capturing && !mediaStream && !audioCtx && !processor && !captureWatch'), true,
    'a full Stop/transcribe/result cycle returns to idle without live audio resources');
  assert.deepStrictEqual(failures, [], 'the native synthetic microphone must not fail');
  assert.deepStrictEqual(errors, [], 'device failures must not produce unhandled renderer errors');
  console.log('real overlay audio: device faults, readiness, stale callbacks, stall recovery and native synthetic Stop/transcribe cycle passed');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
