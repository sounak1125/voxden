'use strict';

// The Polish page in the real renderer and preload, with main's polish
// handlers stood in: the price shown before anything is sent, a polish from
// typed text and from a recent dictation, the changes view, and the Pro and
// signed-out locks. Screenshots go to temp/ui-review with --screenshots;
// --white renders the White theme.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { polishQuote } = require('../src/polish');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-polish-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Polish UI timed out'); app.exit(1); }, 90000);
const white = process.argv.includes('--white');
const shots = process.argv.includes('--screenshots');
const now = Date.now();
const pro = { signedIn: true, plan: 'pro', email: 'alex@example.com',
  cloud: { creditsUsed: 58, creditsCap: 900, creditsRemaining: 842, hoursUsed: 0.97, hoursCap: 15, reset: 'month', periodEnd: '2026-10-12T00:00:00.000Z' } };
let snapshot = {
  appTheme: white ? 'white' : 'voxden',
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space',
  writingStyles: { personal: 'veryCasual', work: 'casual', email: 'formal', other: 'casual' },
  notifications: [], pendingPhrases: [], phrases: [],
  account: pro,
  entries: [
    { id: 'one', ts: now, exe: 'claude.exe', text: 'um so I was thinking we should uh ship the new flow bar this week, you know, and then test it with like five users before the release' },
    { id: 'two', ts: now - 3600000, exe: 'slack.exe', text: 'hey can you check the invoice numbers again I think the the total is off by a bit' },
    { id: 'three', ts: now - 86400000, exe: 'chrome.exe', text: 'Thank you for the thoughtful feedback. I will send the updated proposal tomorrow morning.' },
  ],
};

const POLISHED = 'So I was thinking we should ship the new flow bar this week, and then test it with five users before the release.';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  const calls = [];
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(text)) errors.push(text);
  });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_e, patch) => { snapshot = { ...snapshot, ...patch }; return snapshot; });
  ipcMain.handle('polish-quote', (_e, text) => polishQuote(String(text || ''), snapshot.account));
  const spend = (credits) => {
    const cloud = { ...snapshot.account.cloud, creditsUsed: snapshot.account.cloud.creditsUsed + credits };
    cloud.creditsRemaining = cloud.creditsCap - cloud.creditsUsed;
    snapshot = { ...snapshot, account: { ...snapshot.account, cloud } };
    win.webContents.send('history-updated', snapshot);
  };
  const TIGHTENED = 'We should ship the new flow bar this week, then test it with five users before release.';
  ipcMain.handle('polish-text', async (_e, text, mode) => {
    calls.push(['text', text, mode]);
    await new Promise((r) => setTimeout(r, 250));
    spend(0.25);
    return { ok: true, text: mode === 'tighten' ? TIGHTENED : POLISHED, credits: 0.25, mode };
  });
  const INVOICE = 'Hey, can you check the invoice numbers again? I think the total is off by a bit.';
  ipcMain.handle('polish-entry', async (_e, id, mode) => {
    calls.push(['entry', id, mode]);
    await new Promise((r) => setTimeout(r, 250));
    // As main does: the dictation keeps its words, the polish rides beside them.
    snapshot = { ...snapshot, entries: snapshot.entries.map((e) => (e.id === id ? { ...e, polished: { text: INVOICE, at: Date.now(), credits: 0.25 } } : e)) };
    spend(0.25);
    return { ok: true, text: INVOICE, credits: 0.25, placed: 'none' };
  });
  const copies = [];
  ipcMain.handle('history-copy', (_e, id, which) => { copies.push([id, which || 'dictation']); return true; });

  await win.loadFile(path.join(__dirname, '../src/app.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = (code) => win.webContents.executeJavaScript(code).catch((error) => { console.error('Renderer evaluation:', code, errors); throw error; });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const shoot = async (name) => {
    if (!shots) return;
    await pause(700);
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'polish-' + (white ? 'white-' : '') + name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const type = async (value) => {
    await evaluate(`(() => { const el = document.getElementById('polish-input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await pause(300);
  };

  await pause(600);
  assert.ok(await evaluate(`!!document.querySelector('#nav-polish .nav-pro')`), 'the sidebar lists Polish with a Pro tag');
  await click('#nav-polish');
  await pause(300);
  assert.strictEqual(await evaluate(`document.getElementById('view-polish').hidden`), false, 'Polish opens');
  assert.strictEqual(await evaluate(`document.getElementById('polish-lock').hidden`), true, 'Pro sees no lock');
  assert.strictEqual(await evaluate(`getComputedStyle(document.querySelector('#nav-polish .nav-pro')).display`), 'none', 'nor the Pro tag in the sidebar');
  assert.strictEqual(await text('polish-balance'), '842 credits left', 'the balance shows in the toolbar');
  assert.strictEqual(await evaluate(`document.querySelectorAll('.polish-recent').length`), 3, 'three recent dictations to start from');
  assert.strictEqual(await evaluate(`document.getElementById('polish-run').disabled`), true, 'nothing to polish yet');
  await shoot('pro-empty');

  await type(snapshot.entries[0].text);
  assert.strictEqual(await text('polish-run-cost'), '0.25 credits', 'the price is on the button before anything is sent');
  assert.strictEqual(await text('polish-words'), '28 words');
  assert.strictEqual(await evaluate(`document.getElementById('polish-run').disabled`), false);
  await shoot('pro-typed');
  await click('#polish-run');
  await pause(80);
  assert.strictEqual(await evaluate(`document.getElementById('polish-studio').dataset.state`), 'busy', 'the studio shows it is working');
  assert.strictEqual(await text('polish-run-label'), 'Polishing…');
  await pause(500);
  assert.strictEqual(await text('polish-output'), POLISHED, 'the polished words land on the paper');
  assert.strictEqual(await text('polish-status'), 'Used 0.25 credits');
  assert.strictEqual(await text('polish-balance'), '841.75 credits left', 'the balance follows');
  assert.deepStrictEqual(calls[0], ['text', snapshot.entries[0].text, 'polish'], 'typed text is polished as text');
  assert.strictEqual(await text('polish-note-title'), 'Polished');
  assert.strictEqual(await evaluate(`document.getElementById('polish-copy').hidden`), false);
  await shoot('pro-result');
  await click('#polish-changes');
  await pause(100);
  assert.ok(await evaluate(`document.querySelectorAll('#polish-output del').length > 0 && document.querySelectorAll('#polish-output ins').length === 0`),
    'changes mark what came out; a new capital or full stop is not a change');
  await shoot('pro-changes');
  await click('#polish-changes');

  await click('.polish-recent:nth-child(2)');
  await pause(300);
  assert.strictEqual(await evaluate(`document.querySelector('.polish-recent:nth-child(2)').getAttribute('aria-pressed')`), 'true', 'a recent dictation fills the words');
  await click('#polish-run');
  await pause(600);
  assert.deepStrictEqual(calls[1], ['entry', 'two', 'polish'], 'a picked dictation is polished as that entry');
  assert.strictEqual(await text('polish-status'), 'Used 0.25 credits · saved to this dictation');

  // Grammar and Tighten sit beside Polish, at the same price, and say which
  // one the result came from.
  await type('so I was thinking we should uh ship the new flow bar this week and then test it with five users');
  const modeButtons = await evaluate(`[...document.querySelectorAll('.polish-actions .polish-mode')].map((b) => [b.dataset.mode, b.textContent.trim(), b.disabled, b.title])`);
  assert.deepStrictEqual(modeButtons, [['grammar', 'Grammar', false, '0.25 credits, the same as Polish'], ['tighten', 'Tighten', false, '0.25 credits, the same as Polish']]);
  await click('#polish-tighten');
  await pause(80);
  assert.deepStrictEqual(await evaluate(`[document.querySelector('#polish-tighten .polish-mode-label').textContent, document.getElementById('polish-run-label').textContent, document.getElementById('polish-run').disabled]`),
    ['Tightening…', 'Polish', true], 'the pressed button says it is working, and nothing else can start');
  await pause(500);
  assert.deepStrictEqual(calls[2], ['text', 'so I was thinking we should uh ship the new flow bar this week and then test it with five users', 'tighten']);
  assert.deepStrictEqual([await text('polish-note-title'), await text('polish-output')], ['Tightened', TIGHTENED]);
  await shoot('pro-tightened');

  // The Dictation page: the polished dictation keeps its own words, with the
  // polish under them in gold behind an arrow, and copy is all it offers.
  await click('#nav-dictation');
  await pause(400);
  const card = await evaluate(`(() => {
    const card = document.querySelector('#groups .card[data-id="two"]');
    const line = card && card.querySelector('.card-polished');
    const box = (el) => el.getBoundingClientRect();
    return line ? {
      said: card.querySelector('.text').textContent,
      polished: line.querySelector('.card-polished-text').textContent,
      label: line.querySelector('.card-polished-label').textContent,
      gold: getComputedStyle(line.querySelector('.card-polished-text')).color,
      editable: line.querySelector('.card-polished-text').isContentEditable,
      players: line.querySelectorAll('.card-player, audio').length,
      arrowLeft: box(line.querySelector('.card-polished-arrow')).left - box(card.querySelector('.text')).left,
      rightEdge: box(line.querySelector('.card-polished-panel')).right - box(card.querySelector('.text')).right,
      below: box(line).top >= box(card.querySelector('.text')).bottom,
      others: document.querySelectorAll('#groups .card-polished').length,
    } : null;
  })()`);
  assert.ok(card, 'a polished dictation carries its polished line');
  assert.strictEqual(card.said, snapshot.entries[1].text, 'the card still shows the words that were said');
  assert.strictEqual(card.polished, INVOICE, 'with the polished version under them');
  assert.strictEqual(card.label, 'Polished');
  assert.strictEqual(card.gold, white ? 'rgb(133, 96, 23)' : 'rgb(241, 210, 122)', 'in Pro gold');
  assert.ok(!card.editable && card.players === 0, 'text only: nothing to edit or play');
  assert.ok(card.below && Math.abs(card.arrowLeft) < 1, 'the arrow leaves from under the start of the words');
  assert.ok(Math.abs(card.rightEdge) < 1.5, 'and the panel ends where the words do: ' + card.rightEdge);
  assert.strictEqual(card.others, 1, 'only the polished dictation has one');
  snapshot = { ...snapshot, entries: snapshot.entries.map((e) => (e.id === 'three' ? { ...e, polished: { text: e.text, at: Date.now(), credits: 0.25, mode: 'grammar' } } : e)) };
  win.webContents.send('history-updated', snapshot);
  await pause(300);
  assert.strictEqual(await evaluate(`document.querySelector('#groups .card[data-id="three"] .card-polished-label').textContent`), 'Grammar fixed', 'a card names the mode its result came from');
  await shoot('dictation-polished');
  await evaluate(`document.querySelector('#groups .card[data-id="two"] .card-polished-copy').click(); true`);
  await pause(120);
  assert.deepStrictEqual(copies.pop(), ['two', 'polished'], 'its button copies the polished words');
  assert.strictEqual(await evaluate(`document.querySelector('#groups .card[data-id="two"] .card-polished-label').textContent`), 'Copied');
  await evaluate(`document.querySelector('#groups .card[data-id="two"] .card-polished-panel').click(); true`);
  await pause(80);
  assert.deepStrictEqual(copies.pop(), ['two', 'polished'], 'so does a click on the polish');
  await evaluate(`document.querySelector('#groups .card[data-id="two"] .card-meta').click(); true`);
  await pause(80);
  assert.deepStrictEqual(copies.pop(), ['two', 'dictation'], 'the rest of the card still copies the dictation');
  await click('#nav-polish');
  await pause(200);

  // Not enough credits: the button says why before a click.
  snapshot = { ...snapshot, account: { ...pro, cloud: { ...pro.cloud, creditsUsed: 899.9, creditsRemaining: 0.1 } } };
  win.webContents.send('history-updated', snapshot);
  await pause(200);
  await type('one more thing to polish before the meeting');
  assert.strictEqual(await evaluate(`document.getElementById('polish-run').disabled`), true);
  assert.match(await text('polish-error'), /Not enough cloud credits left\. This polish needs 0\.25 credits\./);

  snapshot = { ...snapshot, account: { signedIn: true, plan: 'free', email: 'alex@example.com' } };
  win.webContents.send('history-updated', snapshot);
  await pause(300);
  assert.strictEqual(await evaluate(`document.getElementById('polish-lock').hidden`), false, 'a free account sees the Pro card');
  assert.strictEqual(await text('polish-lock-title'), 'Polish is part of Pro');
  assert.strictEqual(await evaluate(`document.getElementById('polish-input').disabled`), true);
  const tag = await evaluate(`(() => {
    const box = sel => document.querySelector(sel).getBoundingClientRect();
    const l = box('#nav-polish .nav-label'), t = box('#nav-polish .nav-pro'), item = box('#nav-polish');
    const side = document.querySelector('.sidebar');
    side.classList.add('is-collapsed');
    const collapsed = getComputedStyle(document.querySelector('#nav-polish .nav-pro')).display;
    side.classList.remove('is-collapsed');
    return { level: Math.abs((l.top + l.bottom) / 2 - (t.top + t.bottom) / 2), gap: t.left - l.right, inside: t.right <= item.right, collapsed };
  })()`);
  assert.ok(tag.level < 2 && tag.gap >= 4 && tag.gap <= 12 && tag.inside, 'a free account sees the Pro tag after the label on its row: ' + JSON.stringify(tag));
  assert.strictEqual(tag.collapsed, 'none', 'the collapsed rail leaves the tag out');
  // Behind the card, an example of what Polish does, not the box as it was.
  const example = await evaluate(`({ before: document.getElementById('polish-input').value, after: document.getElementById('polish-output').textContent })`);
  assert.match(example.before, /^um so I was thinking/);
  assert.match(example.after, /^I was thinking we should ship the new flow bar this week/);
  await shoot('free-locked');
  await click('#polish-lock-action');
  await pause(300);
  assert.deepStrictEqual(await evaluate(`({ settings: !document.getElementById('settings-overlay').hidden,
    billing: !document.querySelector('.settings-panel[data-cat="billing"]').hidden })`),
  { settings: true, billing: true }, 'Upgrade to Pro opens Plans & billing');
  await evaluate('closeSettings(); true');
  await pause(200);
  snapshot = { ...snapshot, account: { signedIn: false } };
  win.webContents.send('history-updated', snapshot);
  await pause(200);
  assert.strictEqual(await text('polish-lock-title'), 'Sign in to polish');
  // Upgrading brings back what was in the box, and no example.
  snapshot = { ...snapshot, account: pro };
  win.webContents.send('history-updated', snapshot);
  await pause(200);
  assert.strictEqual(await evaluate(`document.getElementById('polish-input').value`), 'one more thing to polish before the meeting');
  assert.notStrictEqual(await text('polish-output'), example.after, 'the example is gone');

  assert.deepStrictEqual(errors, [], 'no renderer errors');
  clearTimeout(deadline);
  console.log('Polish UI: price before sending, typed and dictation polish, changes, balance, credit and plan locks passed.');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
