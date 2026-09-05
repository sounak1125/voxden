'use strict';

// Exercise the real renderer and preload without opening the user's store or
// microphone. Optional screenshots are written to the ignored temp directory.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyStyleWithTone } = require('../src/style');
const { computeInsights } = require('../src/insights');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-refinement-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Refinement UI timed out'); app.exit(1); }, 45000);
const now = Date.now();
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space',
  writingStyles: { personal: 'veryCasual', work: 'casual', email: 'formal', other: 'casual' },
  autoSend: {}, notifications: [], pendingPhrases: [],
  entries: [
    { id: 'one', ts: now, text: 'Let’s keep the next version simple. A little more space, a clearer message, and a flow that feels effortless.', durationMs: 9500, targetExe: 'slack.exe', category: 'work' },
    { id: 'two', ts: now - 3600000, text: 'Hey, I’ll be there in ten minutes. Could you grab us a table by the window?', durationMs: 7400, targetExe: 'whatsapp.exe', category: 'personal' },
    { id: 'three', ts: now - 86400000, text: 'Thank you for the thoughtful feedback. I will send the updated proposal tomorrow morning.', durationMs: 7100, targetExe: 'outlook.exe', category: 'email' },
    { id: 'old', ts: now - 20 * 86400000, text: 'A small thought from a few weeks ago.', durationMs: 4000 },
  ],
  phrases: [
    { from: 'Voxden', to: 'Voxden', kind: 'word', source: 'manual' },
    { from: 'fig ma', to: 'Figma', kind: 'replacement', source: 'learned' },
    { from: 'Anthropic', to: 'Anthropic', kind: 'word', source: 'manual' },
    { from: 'notion', to: 'Notion', kind: 'replacement', source: 'learned' },
  ],
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 760, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  const saves = [];
  let toggles = 0;
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(text)) errors.push(text);
  });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('toggle', () => { toggles++; return { mode: 'idle' }; });
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    snapshot = { ...snapshot, ...patch, writingStyles: { ...snapshot.writingStyles, ...patch.writingStyles }, autoSend: { ...snapshot.autoSend, ...patch.autoSend } };
    return snapshot;
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer evaluation:', code, errors); throw error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  await evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await pause(400);
  const shoot = async name => {
    if (!process.argv.includes('--screenshots')) return;
    await pause(500);
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  assert.strictEqual(await evaluate(`(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size; })()`), true, 'IDs stay unique');
  assert.ok((await text('home-shortcut-keys')).includes('Ctrl'), 'home uses the configured shortcut');
  await shoot('home');
  await click('#voice-demo');
  assert.strictEqual(await evaluate(`document.getElementById('voice-stage').dataset.demo`), 'listening');
  await pause(2250);
  assert.strictEqual(await evaluate(`document.getElementById('voice-stage').dataset.demo`), 'done');
  assert.strictEqual(toggles, 0, 'the visual demo never invokes recording');
  await click('#nav-dictionary');
  assert.strictEqual(await evaluate(`document.getElementById('voice-stage').hasAttribute('data-demo')`), false, 'navigating away cancels the demo');
  assert.strictEqual(await text('dict-total-count'), '4');
  assert.strictEqual(await text('dict-learned-count'), '2');
  await shoot('dictionary');
  await click('#dict-tab-learned');
  assert.strictEqual(await evaluate(`document.querySelectorAll('.dict-row').length`), 2);
  await evaluate(`const searchField = document.getElementById('dict-search'); searchField.value = 'fig'; searchField.dispatchEvent(new Event('input')); true`);
  assert.strictEqual(await evaluate(`document.querySelectorAll('.dict-row').length`), 1, 'search combines with the learned filter');
  assert.strictEqual(await text('dict-result-count'), '1 of 4 entries');
  await click('#dict-add-new');
  assert.strictEqual(await evaluate(`document.getElementById('dict-vocab-overlay').hidden`), false, 'add-word dialog opens');
  await evaluate('closeVocabModal(); true');

  await click('#nav-writing-style');
  await click('[data-preview-cat="email"]');
  await click('[data-preview-tone="veryCasual"]');
  await pause(100);
  assert.strictEqual(snapshot.writingStyles.email, 'veryCasual', 'preview controls save to the selected context');
  assert.strictEqual(await evaluate(`document.querySelector('[data-style-cat="email"] [data-style="veryCasual"]').getAttribute('aria-checked')`), 'true');
  await click('[data-style-cat="work"] [data-style="formal"]');
  await pause(100);
  assert.ok(saves.some(p => p.writingStyles && p.writingStyles.work === 'formal'), 'tone changes go through settings IPC');
  assert.strictEqual(await text('style-preview-output'), applyStyleWithTone("Hey, I'm gonna send the notes when we're done.", 'formal'));
  await click('#set-verbatim');
  await pause(100);
  assert.strictEqual(await text('style-preview-tone'), 'Verbatim');
  assert.strictEqual(await text('style-preview-output'), "Hey, I'm gonna send the notes when we're done.");
  await click('#set-verbatim');
  await pause(100);
  await shoot('writing-style');
  await evaluate(`const toneButton = document.querySelector('[data-style-cat="work"] [data-style="formal"]'); toneButton.focus(); toneButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
  await pause(100);
  assert.strictEqual(snapshot.writingStyles.work, 'casual', 'arrow keys select and save a tone');

  await click('#nav-insights');
  await pause(600);
  await shoot('insights');
  await click('[data-range="7d"]');
  const expected = computeInsights(snapshot.entries, snapshot.phrases, '7d');
  assert.strictEqual(await text('ins-summary-words'), expected.volume.words.toLocaleString(), 'summary follows the selected range');
  assert.strictEqual(await text('ins-summary-sessions'), '3');
  await click('[data-tab="voice"]');
  assert.strictEqual(await evaluate(`document.getElementById('ins-tab-usage').hidden`), true);
  await shoot('voice-insights');

  for (const [width, height] of [[1120, 760], [800, 650], [640, 440]]) {
    win.setContentSize(width, height);
    await pause(120);
    for (const page of ['dictation', 'dictionary', 'writing-style', 'insights']) {
      await click('#nav-' + page);
      await pause(250);
      await evaluate(`document.querySelector('#view-${page} .pane-body').scrollTop = 0; true`);
      const overflow = await evaluate(`(() => { const el = document.querySelector('#view-${page} .pane-body'); return el.scrollWidth - el.clientWidth; })()`);
      assert.ok(overflow <= 1, page + ' must fit at ' + width + 'px, overflow=' + overflow);
      if (page === 'dictation') {
        assert.strictEqual(await evaluate(`document.querySelector('.voice-stage').getBoundingClientRect().bottom <= document.querySelector('.hero-left').getBoundingClientRect().top`), true, 'home stage and library never overlap at ' + width + 'px');
      }
      if (width === 640) await shoot(page + '-compact');
    }
  }
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await click('#nav-dictation');
  await click('#voice-demo');
  assert.strictEqual(await evaluate(`document.getElementById('voice-stage').dataset.demo`), 'done', 'reduced motion gets an immediate, static result');
  await click('#voice-demo');
  assert.strictEqual(await evaluate(`document.getElementById('voice-demo').getAttribute('aria-pressed')`), 'false');
  assert.deepStrictEqual(errors, [], 'renderer stays free of errors');

  const overlay = new BrowserWindow({ show: false, width: 260, height: 84, frame: false, transparent: true, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  await overlay.loadFile(path.join(__dirname, '../src/overlay.html'));
  const overlayEval = code => overlay.webContents.executeJavaScript(code);
  await overlayEval(`alwaysShowFlowBar = true; document.body.classList.add('shown'); setHud('idle'); true`);
  assert.strictEqual(await overlayEval(`parseInt(getComputedStyle(document.documentElement).getPropertyValue('--morph'), 10) === IDLE_FACE_MORPH_MS`), true, 'idle timing stays synchronized with the morph');
  for (const state of ['idle', 'recording', 'transcribing', 'success', 'error']) {
    await overlayEval(`setHud(${JSON.stringify(state)}, ${JSON.stringify(state === 'success' ? 'Words, beautifully written.' : state === 'error' ? 'Please try again' : '')}); true`);
    await pause(350);
    if (process.argv.includes('--screenshots')) {
      fs.writeFileSync(path.join(__dirname, '../temp/ui-review/flow-' + state + '.png'), (await overlay.webContents.capturePage()).toPNG());
    }
  }
  // Sample the painted star path, not the bounding rectangle of a rotated
  // square: its empty corners can extend past a clip without any paint there.
  // Keep a 260x84 CSS-pixel overlay at each scale, as Windows DPI scaling does.
  for (const scale of [1, 1.25, 1.5]) {
    overlay.setContentSize(Math.round(260 * scale), Math.round(84 * scale));
    overlay.webContents.setZoomFactor(scale);
    for (const note of ['', 'Loading speech model', 'Preparing a very long speech model name and loading its transcription engine']) {
      await overlayEval(`label.textContent = ''; setHud('transcribing', ${JSON.stringify(note)}); true`);
      await pause(280);
      const check = await overlayEval(`(() => {
        const capsule = pill.getBoundingClientRect();
        const slot = document.getElementById('dots').getBoundingClientRect();
        const svg = document.querySelector('.generation-star');
        const turn = document.querySelector('.generation-star-turn');
        const path = turn.querySelector('path');
        // Use a temporary CSS transform. Taking control with Animation.play()
        // detaches a CSS animation from its stylesheet lifecycle, which would
        // leave a test-owned animation running after reduced motion is enabled.
        turn.style.animation = 'none';
        let fits = slot.left >= capsule.left + 1 && slot.right <= capsule.right - 1
          && slot.top >= capsule.top + 1 && slot.bottom <= capsule.bottom - 1
          && capsule.left >= 0 && capsule.right <= innerWidth;
        let stable = true;
        const length = path.getTotalLength();
        for (let angle = 0; angle <= 360; angle += 15) {
          turn.style.transform = 'rotate(' + angle + 'deg)';
          const matrix = path.getScreenCTM();
          for (let i = 0; i <= 64; i++) {
            const point = path.getPointAtLength(length * i / 64);
            const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
            fits = fits && screenPoint.x >= slot.left && screenPoint.x <= slot.right
              && screenPoint.y >= slot.top && screenPoint.y <= slot.bottom;
          }
          stable = stable && Math.abs(pill.getBoundingClientRect().width - capsule.width) < .1;
        }
        turn.style.removeProperty('animation');
        turn.style.removeProperty('transform');
        return { fits, stable, starVisible: getComputedStyle(svg).opacity === '1',
          micHidden: getComputedStyle(document.querySelector('.glyph-mic')).opacity === '0' };
      })()`);
      assert.deepStrictEqual(check, { fits: true, stable: true, starVisible: true, micHidden: true }, 'generation stays unclipped and stable at scale ' + scale + ', note length ' + note.length);
    }
  }
  overlay.setContentSize(260, 84);
  overlay.webContents.setZoomFactor(1);
  await overlayEval(`setHud('idle'); nextIdleFaceVariant = 'curious'; startIdleFace(); true`);
  await pause(300);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-curious')`), true);
  await overlayEval(`setHud('recording'); true`);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-curious')`), false, 'recording cancels the curious animation');
  await overlayEval(`setHud('idle'); nextIdleFaceVariant = 'wink'; startIdleFace(); true`);
  await pause(300);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-winking') && document.body.classList.contains('flow-face-open')`), true, 'the new idle variation opens');
  await overlayEval(`setHud('transcribing'); true`);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-winking')`), false, 'active work immediately cancels idle animations');
  overlay.webContents.debugger.attach('1.3');
  await overlay.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await overlayEval(`setHud('idle'); startIdleFace(); true`);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-face')`), false, 'reduced motion disables idle easter eggs');
  await overlayEval(`setHud('transcribing'); true`);
  await pause(150);
  assert.strictEqual(await overlayEval(`getComputedStyle(document.querySelector('.generation-star')).opacity`), '1', 'reduced motion keeps the generation indicator visible');
  const reducedStar = await overlayEval(`(() => { const turn = document.querySelector('.generation-star-turn'); return {
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    css: getComputedStyle(turn).animationName,
    animations: turn.getAnimations().map(a => ({ name: a.animationName, state: a.playState, time: a.currentTime, duration: a.effect.getTiming().duration }))
  }; })()`);
  assert.strictEqual(reducedStar.animations.some(a => a.state === 'running'), false, 'reduced motion stops star rotation: ' + JSON.stringify(reducedStar));
  overlay.destroy();
  clearTimeout(deadline);
  console.log('Refinement UI: demo, dictionary, real style preview, settings, insights ranges, keyboard input, compact layouts, flow states and reduced motion passed.');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
