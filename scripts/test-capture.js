'use strict';

const assert = require('assert');
const { rectangle, pixelCrop, annotationLayout } = require('../src/capture-geometry');
const { capturePng } = require('../src/screen-capture');
const { createClipboardPaste } = require('../src/clipboard-paste');
const harness = require('./asr-test-harness');

async function main() {
  assert.deepStrictEqual(rectangle({ x: 350, y: 240 }, { x: -20, y: 10 }, { width: 300, height: 200 }),
    { x: 0, y: 10, width: 300, height: 190 });
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
    const crop = pixelCrop({ x: 80, y: 40, width: 320, height: 200 },
      { x: -1920, y: -300, width: 1280, height: 800 }, { width: 1280 * scale, height: 800 * scale });
    assert.deepStrictEqual(crop, { x: 80 * scale, y: 40 * scale, width: 320 * scale, height: 200 * scale });
  }
  assert.deepStrictEqual(pixelCrop({ x: 90, y: 90, width: 40, height: 40 },
    { width: 100, height: 100 }, { width: 151, height: 149 }), { x: 135, y: 134, width: 16, height: 15 });
  for (const rect of [null, {}, { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 1, height: 1 }, { x: 1000, y: 0, width: 20, height: 20 }]) {
    assert.strictEqual(pixelCrop(rect, { width: 100, height: 100 }, { width: 200, height: 200 }), null);
  }
  console.log('ok selection clamps to a display and crops correctly at mixed DPI, including negative monitor origins');
  for (const box of [{ x: 0, y: 0, width: 1024, height: 640 }, { x: 990, y: 600, width: 30, height: 30 },
    { x: 0, y: 10, width: 10, height: 10 }, { x: 100, y: 120, width: 400, height: 250 }]) {
    const layout = annotationLayout(box, { width: 1024, height: 640 });
    for (const part of [layout.toolbar, layout.hint]) {
      assert(part.x >= 0 && part.y >= 0 && part.x + part.width <= 1024 && part.y + part.height <= 640);
    }
  }
  console.log('ok in-place annotation tools fit at display edges and with a full-screen selection');

  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(100, 16); png.writeUInt32BE(80, 20);
  const native = { createFromBuffer: () => ({ isEmpty: () => false }) };
  const data = 'data:image/png;base64,' + png.toString('base64');
  assert(capturePng(data, { width: 100, height: 80 }, native).hash);
  assert.throws(() => capturePng(data, { width: 101, height: 80 }, native), /size changed/);
  assert.throws(() => capturePng('data:image/jpeg;base64,AAAA', { width: 100, height: 80 }, native), /PNG/);
  assert.throws(() => capturePng('data:image/png;base64,AAAA', { width: 100, height: 80 }, native), /could not be read/);
  png.writeUInt32BE(1000000, 16);
  assert.throws(() => capturePng('data:image/png;base64,' + png.toString('base64'), { width: 1000000, height: 80 }, native), /size changed/);
  console.log('ok exported PNGs must match the selected image before decoding');

  let content = { text: 'original clipboard', html: '<b>original clipboard</b>' }, scheduled;
  const formats = { text: 'text/plain', html: 'text/html', image: 'image/png' };
  const clipboard = {
    availableFormats: () => Object.keys(content).map(key => formats[key]),
    readBuffer: format => Buffer.from(String(content[Object.keys(formats).find(key => formats[key] === format)])),
    readText: () => content.text, readHTML: () => content.html, readImage: () => content.image,
    write: next => { content = { ...next }; }, writeText: text => { content = { text }; },
    writeImage: image => { content = { image }; },
  };
  const paste = createClipboardPaste(clipboard, { delay: fn => { scheduled = fn; return 1; }, cancel: () => {} });
  await paste.pasteImage('marked image', async () => assert.strictEqual(content.image, 'marked image'));
  scheduled();
  assert.deepStrictEqual(content, { text: 'original clipboard', html: '<b>original clipboard</b>' });
  await paste.pasteImage('marked image', async () => {});
  clipboard.writeText('new user copy'); scheduled();
  assert.deepStrictEqual(content, { text: 'new user copy' });
  await assert.rejects(paste.pasteImage('marked image', async () => { throw new Error('focus failed'); }), /focus failed/);
  scheduled(); assert.strictEqual(content.text, 'new user copy');
  console.log('ok image insertion restores rich clipboard content and preserves newer user copies, including failures');

  const h = harness();
  try {
    h.run(`var pasted = [], captureTexts = [];
      pasteDictation = async text => pasted.push(text);
      settings.autoSend = { personal: 'enter', work: 'enter', email: 'enter' };
      screenCapture = { sessionId: 7, active: true, speechState: () => {},
        complete: async (text, id) => { if (id !== 7) return false; captureTexts.push(text); return true; } };
      captureVoiceSession = 7; mode = 'transcribing';`);
    await h.run("onTranscript('Please change this button.')");
    assert.strictEqual(h.run('captureTexts.length'), 1);
    assert.strictEqual(h.run('pasted.length'), 0);
    assert.strictEqual(h.run('history.entries.length'), 0);
    assert.strictEqual(h.run('mode'), 'success');
    h.run("captureVoiceSession = 6; mode = 'transcribing';");
    await h.run("onTranscript('This belongs to a cancelled screenshot.')");
    assert.strictEqual(h.run('captureTexts.length'), 1);
    assert.strictEqual(h.run('pasted.length'), 0);
    h.run("screenCapture = null; captureVoiceSession = null; mode = 'transcribing';");
    await h.run("onTranscript('Ordinary dictation still pastes.')");
    assert.strictEqual(h.run('pasted.length'), 1);
    assert.strictEqual(h.run('history.entries.length'), 1);
    console.log('ok stopping capture speech invokes automatic completion; stale captures cannot paste; ordinary dictation still works');

    h.run(`var releaseCapture;
      screenCapture = { sessionId: 8, active: true, speechState: () => {},
        complete: () => new Promise(resolve => releaseCapture = resolve) };
      captureVoiceSession = 8; mode = 'transcribing';`);
    const pending = h.run("onTranscript('A cancelled screenshot.')");
    h.run("flashCancel(); captureVoiceSession = null; recordingSessionToken++; mode = 'recording'; releaseCapture(true);");
    await pending;
    assert.strictEqual(h.run('mode'), 'recording', 'late paste completion must not finish a newer recording');

    h.run(`screenCapture = { sessionId: 9, active: true, canRecord: true, speechState: () => {} };
      asrIsDisabled = () => false; sidecarState = 'ready'; requestSidecarStart = () => {};
      pauseBackgroundMedia = async () => {}; settings.dictateMode = 'ptt'; mode = 'idle';
      startRecording(false);`);
    assert.strictEqual(h.run('pttLocked'), true, 'automatic capture recording is tap-locked in push-to-talk mode');
    h.run("mode = 'recording'; pttPress();");
    assert.strictEqual(h.run('mode'), 'transcribing', 'one shortcut press stops automatic capture recording');
    console.log('ok cancellation ignores late completions and the normal shortcut stops Capture in push-to-talk mode');

    h.run(`screenCapture.speechState = state => {
      if (state.mode === 'error') globalShortcut.register('Escape', () => {});
    };
    abandonDictation('test-recorder-crash');`);
    assert.strictEqual(h.run('captureVoiceSession'), null);
    assert(h.shortcuts.has('Escape'), 'Capture retains Escape cancellation after the recorder crashes');
    console.log('ok an interrupted recorder releases speech ownership and leaves Capture cancellable');
  } finally { h.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
