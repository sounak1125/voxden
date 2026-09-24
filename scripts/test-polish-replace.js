'use strict';

// Polish putting its words where the dictation went: main.js replaceLastPaste,
// run for real inside the main-process harness. The test plays the Win32
// helper and the text field: select-back moves the field's selection and
// copies it, paste puts the clipboard over the selection. The clipboard is a
// model of Electron's, so nothing touches the real one.

const assert = require('assert');
const mainHarness = require('./asr-test-harness');
const { readRestorable } = require('../src/clipboard-paste');

const tick = () => new Promise(resolve => setImmediate(resolve));
const DICTATION = 'um so basically what I wanted to say is that the new flow bar feels a lot faster now and I think we should ship it this week, you know, but before that we need to test it on a few more machines, especially the older laptops with the slower CPUs, because the last time we shipped something like this it broke on those and we had to roll it back okay';
const POLISHED = 'The new flow bar feels a lot faster, and I think we should ship it this week. Before that, we need to test it on a few more machines.';
const EARLIER = 'Hello there. ';
const SCREENSHOT = { png: 'a screenshot the user copied' };

let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log('ok', name);
}

// Electron's clipboard, by format.
function fakeClipboard(state) {
  const clip = {
    state: state || {},
    availableFormats: () => Object.keys(clip.state),
    readText: () => clip.state['text/plain'] || '',
    readHTML: () => clip.state['text/html'] || '',
    readRTF: () => clip.state['text/rtf'] || '',
    readImage: () => clip.state['image/png'],
    readBookmark: () => ({ title: clip.state['text/bookmark'] || '', url: clip.state['text/plain'] || '' }),
    readBuffer: format => Buffer.from(JSON.stringify(clip.state[format] === undefined ? '' : clip.state[format])),
    clear: () => { clip.state = {}; },
    writeText: text => { clip.state = { 'text/plain': text }; },
    writeImage: image => { clip.state = { 'image/png': image }; },
    write: data => {
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

// A text box holding `text` with the caret at its end. `lag` makes its first
// copy trail the keys by that many characters, the way Claude's editor copies
// its own idea of the selection.
function fakeField(clip, text, lag = 0) {
  const field = { text, start: text.length, end: text.length, copies: 0, requests: [] };
  const copy = () => {
    field.copies++;
    const from = field.copies === 1 ? Math.min(field.end, field.start + lag) : field.start;
    clip.state = { 'text/plain': field.text.slice(from, field.end) };
  };
  field.handle = req => {
    field.requests.push(req.action);
    if (req.action === 'get') return '1';
    if (req.action === 'select-back') {
      field.start = Math.max(0, field.end - Number(req.keys));
      copy();
      return 'VOXDEN_SENT';
    }
    if (req.action === 'copy-keys') { copy(); return 'VOXDEN_SENT'; }
    if (req.action === 'paste') {
      const pasted = clip.readText();
      field.text = field.text.slice(0, field.start) + pasted + field.text.slice(field.end);
      field.start = field.end = field.start + pasted.length;
      return 'VOXDEN_OK';
    }
    if (req.action === 'collapse-right') { field.start = field.end; return 'VOXDEN_OK'; }
    return '';
  };
  return field;
}

// Runs replaceLastPaste to the end: answers every helper request through the
// field, and fires the short timers (polling, the clipboard's return) that the
// harness otherwise holds. Helper timeouts are seconds long and never fire.
async function replace(h, field, oldText, newText) {
  h.context.replaceArgs = [oldText, newText];
  let done = false;
  let result;
  h.run('replaceLastPaste(...replaceArgs)').then(value => { done = true; result = value; });
  let answered = 0;
  for (let i = 0; i < 2000; i++) {
    await tick();
    const server = h.launches.find(l => Array.isArray(l.args[1]) && l.args[1].includes('serve'));
    const written = server ? server.proc.stdin.written : [];
    while (answered < written.length) {
      const req = JSON.parse(written[answered++]);
      server.proc.stdout.emit('data', JSON.stringify({ id: req.id, out: field.handle(req) }) + '\n');
    }
    for (const [id, timer] of [...h.timers]) {
      if (timer.delay > 1000) continue;
      h.timers.delete(id);
      timer.fn();
    }
    if (done && !h.timers.size) break;
    if (done && [...h.timers.values()].every(t => t.delay > 1000)) break;
  }
  assert.ok(done, 'replaceLastPaste finished');
  return result;
}

function setup(clip, field) {
  const h = mainHarness({ clipboard: clip });
  h.context.diagEvents = [];
  h.context.pasteTarget = { text: DICTATION };
  h.run(`
    diagLog = (event, fields) => diagEvents.push(Object.assign({ event }, fields));
    lastPaste = { entryId: 'e1', text: pasteTarget.text, hwnd: '4242', exe: 'claude.exe', ts: Date.now() };
  `);
  return h;
}

// Entries made inside the harness's realm, as plain data from this one.
const outcomes = h => JSON.parse(JSON.stringify(h.context.diagEvents.filter(e => e.event === 'polish-replace')));

async function main() {
  await test('readRestorable reads what one clipboard write can put back, and refuses only copied files', async () => {
    assert.deepStrictEqual(readRestorable(fakeClipboard({ 'image/png': SCREENSHOT })), { image: SCREENSHOT });
    assert.deepStrictEqual(readRestorable(fakeClipboard({ 'text/plain': 'a', 'text/html': '<b>a</b>' })),
      { text: 'a', html: '<b>a</b>' });
    assert.deepStrictEqual(readRestorable(fakeClipboard({})), {});
    assert.strictEqual(readRestorable(fakeClipboard({ 'text/plain': 'x', 'text/uri-list': 'file:///C:/a.mp4' })), null);
    assert.deepStrictEqual(readRestorable(fakeClipboard({ 'text/plain': 'code', 'vscode-editor-data': '{}' })),
      { text: 'code' }, "an editor's extra copy is left out, not a reason to refuse");
  });

  await test('a screenshot on the clipboard: the dictation is still replaced, and the screenshot comes back', async () => {
    const clip = fakeClipboard({ 'image/png': SCREENSHOT });
    const field = fakeField(clip, EARLIER + DICTATION);
    const h = setup(clip, field);
    try {
      assert.strictEqual(await replace(h, field, DICTATION, POLISHED), true);
      assert.strictEqual(field.text, EARLIER + POLISHED);
      assert.deepStrictEqual(outcomes(h).map(e => e.why), ['replaced']);
      assert.deepStrictEqual(clip.state, { 'image/png': SCREENSHOT });
      assert.strictEqual(clip.readImage(), SCREENSHOT, 'the same image, not a copy of something else');
    } finally { await h.close(); }
  });

  await test("a copy that trails the keys is asked again, not taken for another text (Claude's editor)", async () => {
    const clip = fakeClipboard({ 'text/plain': 'the user\u2019s own copy', 'text/html': '<i>own</i>' });
    const field = fakeField(clip, EARLIER + DICTATION, 22);
    const h = setup(clip, field);
    try {
      assert.strictEqual(await replace(h, field, DICTATION, POLISHED), true);
      assert.strictEqual(field.text, EARLIER + POLISHED);
      const [done] = outcomes(h);
      assert.strictEqual(done.why, 'replaced');
      assert.strictEqual(done.copies, 2);
      assert.deepStrictEqual(clip.state, { 'text/plain': 'the user\u2019s own copy', 'text/html': '<i>own</i>' });
    } finally { await h.close(); }
  });

  await test('words typed after the dictation: nothing is replaced, the caret goes back, the screenshot stays', async () => {
    const clip = fakeClipboard({ 'image/png': SCREENSHOT });
    const field = fakeField(clip, EARLIER + DICTATION + ' and more');
    const h = setup(clip, field);
    try {
      assert.strictEqual(await replace(h, field, DICTATION, POLISHED), false);
      assert.strictEqual(field.text, EARLIER + DICTATION + ' and more');
      assert.strictEqual(field.start, field.end, 'the selection is collapsed');
      assert.strictEqual(field.end, field.text.length, 'the caret is back at the end');
      assert.ok(field.requests.includes('collapse-right'));
      assert.deepStrictEqual(outcomes(h).map(e => e.why), ['mismatch']);
      assert.deepStrictEqual(clip.state, { 'image/png': SCREENSHOT });
    } finally { await h.close(); }
  });

  await test('copied files cannot be put back: no key is sent and the clipboard is left alone', async () => {
    const files = { 'text/uri-list': 'file:///C:/clip.mp4' };
    const clip = fakeClipboard(Object.assign({}, files));
    const field = fakeField(clip, EARLIER + DICTATION);
    const h = setup(clip, field);
    try {
      assert.strictEqual(await replace(h, field, DICTATION, POLISHED), false);
      assert.deepStrictEqual(field.requests.filter(a => a !== 'get'), []);
      assert.deepStrictEqual(outcomes(h), [{ event: 'polish-replace', why: 'clipboard', formats: ['text/uri-list'] }]);
      assert.deepStrictEqual(clip.state, files);
    } finally { await h.close(); }
  });

  await test("a dictation's clipboard still waiting to come back is put back before Polish borrows it", async () => {
    const clip = fakeClipboard({ 'image/png': SCREENSHOT });
    const field = fakeField(clip, EARLIER);
    const h = setup(clip, field);
    try {
      // The dictation's own paste: its words on the clipboard, and the
      // screenshot due back on a timer that never fires here.
      h.context.pasteDone = (text) => { field.text += text; field.start = field.end = field.text.length; };
      await h.run(`
        clipboardPaste = createClipboardPaste(clipboard, { delay: () => 0, cancel: () => {} });
        clipboardPaste.paste(pasteTarget.text, async () => pasteDone(clipboard.readText()));
      `);
      assert.deepStrictEqual(clip.state, { 'text/plain': DICTATION });
      assert.strictEqual(await replace(h, field, DICTATION, POLISHED), true);
      assert.strictEqual(field.text, EARLIER + POLISHED);
      assert.deepStrictEqual(clip.state, { 'image/png': SCREENSHOT });
    } finally { await h.close(); }
  });

  console.log('All ' + checks + ' polish replace checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
