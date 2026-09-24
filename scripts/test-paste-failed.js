'use strict';

// A dictation that could not be pasted: main.js onTranscript, run for real
// inside the main-process harness. The words still go to history, and the
// flow bar log says why -- the clipboard, a window that would not come
// forward, a helper that never answered -- without the words or the window
// title. The test plays Electron's clipboard and the long-lived PowerShell
// helper, so nothing touches the real clipboard or sends a key.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mainHarness = require('./asr-test-harness');

const tick = () => new Promise(resolve => setImmediate(resolve));
const WORDS = 'send the quarterly numbers to the board before friday';
const TITLE = 'Layoffs plan draft.docx - Word';
const USER_COPY = { 'text/plain': 'a copy the user made', 'text/html': '<i>a copy</i>' };
// The helper exits instead of answering.
const DIES = Symbol('dies');

let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log('ok', name);
}

// Electron's clipboard, by format. Every write is counted.
function fakeClipboard(state) {
  const clip = {
    state: state || {},
    writes: 0,
    availableFormats: () => Object.keys(clip.state),
    readText: () => clip.state['text/plain'] || '',
    readHTML: () => clip.state['text/html'] || '',
    readRTF: () => clip.state['text/rtf'] || '',
    readImage: () => clip.state['image/png'],
    readBookmark: () => ({ title: clip.state['text/bookmark'] || '', url: clip.state['text/plain'] || '' }),
    readBuffer: format => Buffer.from(JSON.stringify(clip.state[format] === undefined ? '' : clip.state[format])),
    clear: () => { clip.writes++; clip.state = {}; },
    writeText: text => { clip.writes++; clip.state = { 'text/plain': text }; },
    writeImage: image => { clip.writes++; clip.state = { 'image/png': image }; },
    write: data => {
      clip.writes++;
      const next = {};
      if ('text' in data) next['text/plain'] = data.text;
      if ('html' in data) next['text/html'] = data.html;
      if ('rtf' in data) next['text/rtf'] = data.rtf;
      if ('image' in data) next['image/png'] = data.image;
      if ('bookmark' in data) next['text/bookmark'] = data.bookmark;
      clip.state = next;
    },
  };
  return clip;
}

// A dictation into Word that has finished recognizing. The clipboard's return
// after a paste waits for restoreLater(), which only the test calls.
function setup(clip) {
  const h = mainHarness({ clipboard: clip });
  h.context.words = WORDS;
  h.context.title = TITLE;
  h.run(`
    var restoreLater = null;
    clipboardPaste = createClipboardPaste(clipboard, { delay: fn => { restoreLater = fn; return 1; }, cancel: () => {} });
    prepareCorrectionLearning = async () => null;
    lastHwnd = '4242';
    lastTarget = { hwnd: '4242', exe: 'winword.exe', title };
    mode = 'transcribing';
  `);
  return h;
}

// Runs onTranscript to the end. The helper server gets its hello answered,
// and the paste gets `answer`; DIES makes the helper exit instead.
async function dictate(h, answer) {
  const finished = h.run('onTranscript(words)');
  let done = false;
  finished.then(() => { done = true; }, () => { done = true; });
  let answered = 0;
  for (let i = 0; i < 200 && !done; i++) {
    await tick();
    const server = h.launches.find(l => Array.isArray(l.args[1]) && l.args[1].includes('serve'));
    const written = server ? server.proc.stdin.written : [];
    while (answered < written.length) {
      const line = written[answered++];
      if (!line.startsWith('{')) continue;
      const req = JSON.parse(line);
      if (req.action === 'paste' && answer === DIES) { server.proc.kill(); continue; }
      const out = req.action === 'paste' ? answer : '1';
      server.proc.stdout.emit('data', JSON.stringify({ id: req.id, out }) + '\n');
    }
  }
  assert.ok(done, 'onTranscript finished');
  await finished;
}

// Every action main asked any helper for.
const requests = h => h.launches.flatMap(l => l.proc.stdin.written)
  .filter(line => line.startsWith('{')).map(line => JSON.parse(line).action);

function logText(h) {
  const file = path.join(h.run('DATA'), 'flow-bar.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// The flow bar log's paste-failed lines as written, without their timestamps.
// Neither the words nor the window title may be anywhere in that file.
function failures(h) {
  const text = logText(h);
  assert.ok(!/quarterly/i.test(text), 'the dictation is not in the log');
  assert.ok(!/layoffs/i.test(text), 'the window title is not in the log');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(e => e.event === 'paste-failed')
    .map(({ ts, ...rest }) => {
      assert.ok(!Number.isNaN(Date.parse(ts)), 'timestamped');
      return rest;
    });
}

function assertKept(h) {
  assert.strictEqual(h.run('history.entries.length'), 1);
  assert.match(h.run('history.entries[0].text'), /quarterly numbers to the board before friday/i);
  assert.strictEqual(h.run('mode'), 'error');
}

async function main() {
  await test('copied files on the clipboard: the words go to history, the log names the formats, the clipboard is left alone', async () => {
    const files = { 'text/uri-list': 'file:///C:/clip.mp4' };
    const clip = fakeClipboard(Object.assign({}, files));
    const h = setup(clip);
    try {
      await dictate(h, 'VOXDEN_OK');
      assertKept(h);
      assert.deepStrictEqual(failures(h), [{ event: 'paste-failed',
        reason: 'Clipboard contains content that cannot be safely restored', exe: 'winword.exe', formats: ['text/uri-list'] }]);
      assert.ok(!requests(h).includes('paste'), 'no paste key was sent');
      assert.deepStrictEqual(clip.state, files);
      assert.strictEqual(clip.writes, 0);
    } finally { await h.close(); }
  });

  // A helper that never answered and a window that would not come forward
  // must not read the same.
  const answers = [
    { name: 'an empty answer', answer: '', why: 'no answer' },
    { name: 'a helper that exits first', answer: DIES, why: 'no answer' },
    { name: 'a window that would not come forward', answer: 'Paste target could not be focused',
      why: 'target could not be focused' },
    { name: 'anything else, cut short', answer: 'Cannot convert value "abc" to type "System.Int64". Error: "Input string was not in a correct format."',
      why: 'answered ' + JSON.stringify('Cannot convert value "abc" to type "Syst') },
  ];
  for (const { name, answer, why } of answers) {
    await test('the helper pastes nothing, ' + name + ': the words go to history, the log says "' + why + '"', async () => {
      const clip = fakeClipboard(Object.assign({}, USER_COPY));
      const h = setup(clip);
      try {
        await dictate(h, answer);
        assertKept(h);
        const reason = 'Paste helper failed: ' + why;
        assert.ok(reason.length <= 80);
        assert.deepStrictEqual(failures(h), [{ event: 'paste-failed', reason, exe: 'winword.exe' }]);
        assert.deepStrictEqual(requests(h).filter(a => a === 'paste'), ['paste']);
        // The user's own copy comes back once the words have had their chance.
        h.run('restoreLater()');
        assert.deepStrictEqual(clip.state, USER_COPY);
      } finally { await h.close(); }
    });
  }

  console.log('All ' + checks + ' paste failure checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
