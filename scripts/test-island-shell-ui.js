'use strict';

// The Island shell, in the real app.html over the real preload. What cannot be
// read from the stylesheet is the part made of live layout: that the island
// never touches the logo or the buttons at the right at any width the window
// can have, in any plan, that it is centred when there is room, that the
// labels it drops stay readable to a screen reader, and that the header is as
// tall as the native caption overlay Windows paints into it.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fitViewport } = require('./fit-viewport');
const { computeInsights } = require('../src/insights');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const overlayHeights = [...mainSource.matchAll(/(?:titleBarOverlay:\s*\{[^}]*|setTitleBarOverlay\(\{[^}]*)height:\s*(\d+)/g)].map(m => Number(m[1]));
assert.deepStrictEqual(overlayHeights, [60, 60], 'both native caption overlays are 60px tall');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-island-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Island shell UI timed out'); app.exit(1); }, 120000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });

const errors = [];
const pro = { signedIn: true, email: 'sam@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
  cloud: { creditsUsed: 118, creditsCap: 900, creditsRemaining: 782, hoursCap: 15, periodEnd: '2026-12-01T00:00:00.000Z' },
  checkedAt: Date.now(), profile: { firstName: 'Sam', lastName: '' } };
const free = { signedIn: true, email: 'sam@example.com', plan: 'free', cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null },
  checkedAt: Date.now(), profile: { firstName: 'Sam', lastName: '' } };
const base = {
  appTheme: 'voxden', displayName: 'Sam', shortcutLabel: 'Ctrl+Win', localModelChosen: true,
  entries: Array.from({ length: 6 }, (_, i) => ({ id: 'e' + i, ts: Date.now() - i * 3600000, text: 'Send the notes before standup.', durationMs: 9000 })),
  phrases: [], pendingPhrases: [], notifications: [], writingStyles: {}, flowBarStyle: 'island', flowBarMotion: 'full',
  appVersion: '2.1.2', updateStatus: 'idle',
};
// The three states of the cloud slot: the Pro meter, the Free meter with the
// upsell beside it, and an account with nothing to show (signed out, model not
// chosen yet) so the divider has nothing to divide.
const scenarios = {
  pro: { ...base, account: pro },
  free: { ...base, account: free,
    freeWords: { cap: 3000, used: 1760, remaining: 1240, percent: 59, exhausted: false, resetsOn: '2026-12-01' } },
  signedOut: { ...base, account: { ...free, signedIn: false } },
  bare: { ...base, account: { ...free, signedIn: false }, localModelChosen: false },
};
let snapshot = scenarios.pro;

app.whenReady().then(async () => {
  ipcMain.on('app-theme-get', event => { event.returnValue = snapshot.appTheme; });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('insights-get', (_e, range) => computeInsights(snapshot.entries, { range }));
  ipcMain.handle('notifications-read', () => snapshot);
  ipcMain.handle('account-billing-options', () => snapshot);
  ipcMain.handle('settings-set', (_e, patch) => (snapshot = { ...snapshot, ...patch }));
  const win = new BrowserWindow({ show: false, width: 1200, height: 780, useContentSize: true,
    backgroundColor: '#101113', titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#a3ada6', height: 60 },
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), additionalArguments: ['--voxden-theme-bootstrap'],
      contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(20); }
    assert.fail(expression);
  };
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await waitFor('!!lastPayload');
  const show = async (name, theme = 'voxden') => {
    snapshot = { ...scenarios[name], appTheme: theme };
    win.webContents.send('history-updated', snapshot);
    await run(`window.VoxdenAppTheme.apply(${JSON.stringify(theme)}); true`);
    await pause(150);
  };
  const resize = async (width, height = 700) => {
    assert.ok(await fitViewport(win, width, height), 'the page is ' + width + 'px wide');
    await pause(120);
  };

  // --- The markup: five sections, no rail ------------------------------------
  await resize(1200, 780);
  await show('pro');
  const markup = await run(`({
    sections: [...document.querySelectorAll('#island > .island-link')].map(b => [b.id, b.dataset.view, b.textContent.replace(/\\s+/g, ' ').trim()]),
    label: document.getElementById('island').getAttribute('aria-label'), tag: document.getElementById('island').tagName,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(b => b.id),
    sidebar: !!document.querySelector('.sidebar, #sidebar, #sidebar-toggle, #sidebar-credits, #sidebar-pro'),
    buttons: [...document.querySelectorAll('#island button, .titlebar-end button')].every(b => b.tagName === 'BUTTON' && b.type === 'button'),
    names: ['nav-settings', 'nav-help', 'notif-btn', 'account-btn'].map(id => document.getElementById(id).getAttribute('aria-label') || document.getElementById(id).title),
  })`);
  assert.deepStrictEqual(markup.sections, [['nav-dictation', 'dictation', 'Dictation'], ['nav-dictionary', 'dictionary', 'Dictionary'],
    ['nav-writing-style', 'writing-style', 'Writing style'], ['nav-polish', 'polish', 'Polish PRO'], ['nav-insights', 'insights', 'Insights']]);
  assert.strictEqual(markup.tag, 'NAV');
  assert.strictEqual(markup.label, 'Sections');
  assert.deepStrictEqual(markup.current, ['nav-dictation'], 'the section on screen is the current page');
  assert.strictEqual(markup.sidebar, false, 'no sidebar markup is left in the page, hidden or not');
  assert.strictEqual(markup.buttons, true, 'every control in the header is a real button');
  assert.ok(markup.names.every(Boolean), 'the header buttons are named: ' + markup.names);

  // --- The frame: height, drag, and the panel under it -------------------------
  const frame = await run(`(() => {
    const box = s => document.querySelector(s).getBoundingClientRect();
    const region = s => getComputedStyle(document.querySelector(s)).webkitAppRegion;
    const main = getComputedStyle(document.querySelector('main'));
    return { bar: box('.titlebar').height, drag: region('.titlebar'), island: region('#island'),
      controls: [...document.querySelectorAll('.titlebar-end > *')].map(el => getComputedStyle(el).webkitAppRegion),
      mainTop: box('main').top, mainLeft: box('main').left, mainRight: box('main').right, width: innerWidth,
      radii: main.borderTopLeftRadius + ' ' + main.borderTopRightRadius, edge: main.borderTopColor + ' ' + main.borderLeftColor,
      island40: box('#island').height, islandTop: box('#island').top };
  })()`);
  assert.strictEqual(frame.bar, 60, 'the header is as tall as the native caption overlay');
  assert.strictEqual(frame.drag, 'drag');
  assert.strictEqual(frame.island, 'no-drag', 'the island is not part of the drag strip');
  assert.deepStrictEqual([...new Set(frame.controls)], ['no-drag'], 'neither are the buttons at the right');
  assert.deepStrictEqual([frame.mainTop, frame.mainLeft, frame.mainRight], [60, 0, frame.width], 'the panel starts under the header and spans the window');
  assert.strictEqual(frame.radii, '20px 20px');
  assert.strictEqual(frame.edge, 'rgba(255, 255, 255, 0.06) rgba(255, 255, 255, 0.06)', 'a hairline edge on the dark panel');
  assert.deepStrictEqual([frame.island40, frame.islandTop], [40, 10], 'a 40px capsule with 10px above it');

  // --- Colour: the same capsule in both themes ------------------------------------
  for (const theme of ['voxden', 'white']) {
    await show('pro', theme);
    const look = await run(`(() => { const c = s => getComputedStyle(document.querySelector(s));
      return { island: c('#island').backgroundColor, edge: c('#island').borderTopColor, active: c('.island-link.is-active').backgroundColor,
        text: c('.island-link:not(.is-active)').color, icon: c('.island-link.is-active .island-icon').color,
        edgeOfPanel: c('main').borderTopColor, ringTrack: c('.island-ring-track').stroke, ring: c('.island-ring-arc').stroke,
        avatar: c('#account-btn').boxShadow }; })()`);
    assert.deepStrictEqual([look.island, look.edge, look.active, look.text, look.icon],
      ['rgb(0, 0, 0)', 'rgba(255, 255, 255, 0.3)', 'rgb(44, 44, 46)', 'rgba(235, 235, 245, 0.68)', 'rgb(156, 243, 196)'], theme + ' capsule');
    assert.deepStrictEqual([look.ringTrack, look.ring], ['rgb(38, 48, 44)', 'rgb(156, 243, 196)'], theme + ' ring');
    assert.ok(look.avatar.includes('201, 162, 75'), theme + ' gives a Pro avatar its gold ring: ' + look.avatar);
    assert.strictEqual(look.edgeOfPanel, theme === 'white' ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 255, 255, 0.06)', theme + ' panel edge');
  }
  await show('pro');

  // --- Which section is lit --------------------------------------------------------
  await run(`setView('insights'); true`);
  assert.deepStrictEqual(await run(`[...document.querySelectorAll('[aria-current="page"]')].map(b => b.id)`), ['nav-insights']);
  await run(`openSettings(); true`);
  assert.deepStrictEqual(await run(`[...document.querySelectorAll('[aria-current="page"]')].map(b => b.id)`), ['nav-settings'], 'Settings takes the highlight while its sheet is up');
  assert.strictEqual(await run(`document.getElementById('nav-settings').classList.contains('is-active') && !document.querySelector('.island-link.is-active')`), true);
  await run(`document.getElementById('nav-polish').click(); true`);
  assert.deepStrictEqual(await run(`[settingsOpen, document.getElementById('nav-polish').getAttribute('aria-current')]`), [false, 'page'], 'a section closes Settings and lights itself');
  await run(`setView('help'); true`);
  assert.deepStrictEqual(await run(`[...document.querySelectorAll('[aria-current="page"]')].map(b => b.id)`), ['nav-help'], 'the guide lights Help');
  await run(`setView('dictation'); true`);

  // --- Panels hang under the header -----------------------------------------------
  await run(`openNotifications(); true`);
  const panel = await run(`(() => { const r = document.getElementById('notif-panel').getBoundingClientRect(); return [r.top, innerWidth - r.right]; })()`);
  assert.ok(panel[0] >= 60 && panel[1] >= 8, 'the notification panel opens under the header, inside the window: ' + panel);
  await run(`closeNotifications(); true`);
  await run(`document.getElementById('account-btn').hidden = false; openAccountMenu(); true`);
  const menu = await run(`(() => { const m = document.getElementById('account-menu').getBoundingClientRect(), b = document.getElementById('account-btn').getBoundingClientRect();
    return m.top >= b.bottom && m.right <= innerWidth; })()`);
  assert.strictEqual(menu, true, 'the account sheet drops below the avatar');
  await run(`closeAccountMenu(); true`);

  // --- Keyboard focus -----------------------------------------------------------
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
  const { root } = await dbg.sendCommand('DOM.getDocument');
  for (const selector of ['#nav-dictionary', '#island-credits', '#nav-settings', '#nav-help', '#notif-btn', '#account-btn']) {
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
    const ring = await run(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return [c.outlineStyle, c.outlineWidth, c.outlineColor]; })()`);
    assert.deepStrictEqual(ring, ['solid', '2px', 'rgb(156, 243, 196)'], selector + ' shows a mint focus ring');
    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  }
  dbg.detach();

  // --- Room: nothing touches anything, at any width, in any plan -----------------------
  const measure = () => run(`(() => {
    const bar = document.querySelector('.titlebar');
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
    const island = rect(document.getElementById('island'));
    const lockup = rect(bar.querySelector('.brand-lockup'));
    const buttons = [...bar.querySelectorAll('.titlebar-end > :not([hidden])')].map(rect);
    const parts = [...document.querySelectorAll('#island > :not([hidden])')].filter(el => getComputedStyle(el).display !== 'none').map(rect);
    const links = [...document.querySelectorAll('.island-link')].map(link => {
      const label = link.querySelector('.island-label'), c = getComputedStyle(label);
      return { name: link.textContent.replace(/\\s+/g, ' ').trim(), hidden: c.position === 'absolute' && c.width === '1px', width: link.getBoundingClientRect().width };
    });
    return { rung: [...bar.classList].filter(n => /^fit-\\d$/.test(n)).length, width: innerWidth, island, lockup, buttons, parts, links,
      overflow: document.documentElement.scrollWidth > innerWidth,
      endLeft: Math.min(...buttons.map(b => b.left)), lockupRight: lockup.right };
  })()`);
  const states = [];
  for (const platform of ['win32', 'darwin']) {
    await run(platform === 'darwin' ? `document.documentElement.dataset.platform = 'darwin'; true` : `delete document.documentElement.dataset.platform; true`);
    for (const scenario of Object.keys(scenarios)) {
      await show(scenario);
      await run(`document.getElementById('model-welcome').open && document.getElementById('model-welcome').close(); true`);
      let previousRung = -1;
      for (const width of [1400, 1200, 1000, 900, 860, 800, 760, 700, 660, 640]) {
        await resize(width);
        const m = await measure();
        const where = platform + '/' + scenario + '/' + width + 'px (rung ' + m.rung + ')';
        states.push(where);
        assert.ok(!m.overflow, where + ': the page does not scroll sideways');
        assert.ok(m.island.left >= m.lockupRight + 8, where + ': the island clears the logo: ' + m.island.left + ' vs ' + m.lockupRight);
        assert.ok(m.island.right <= m.endLeft - 8, where + ': the island clears the buttons at the right: ' + m.island.right + ' vs ' + m.endLeft);
        assert.ok(m.parts.every(p => p.left >= m.island.left && p.right <= m.island.right && p.top >= m.island.top && p.bottom <= m.island.bottom),
          where + ': everything in the island is inside it');
        assert.deepStrictEqual(m.links.map(link => link.name), ['Dictation', 'Dictionary', 'Writing style', 'Polish PRO', 'Insights'],
          where + ': every section keeps its name for a screen reader');
        assert.ok(m.rung >= previousRung, where + ': a narrower window never brings a label back');
        previousRung = m.rung;
        if (m.rung === 0) {
          assert.ok(m.links.every(link => !link.hidden), where + ': at full width every label shows');
        }
        // Centred whenever the logo and the buttons at the right leave the room
        // for it, and otherwise moved off centre by exactly what it takes to
        // keep a 12px gap from whichever of them is in the way.
        const centre = (m.island.left + m.island.right) / 2;
        const centredLeft = m.width / 2 - m.island.width / 2;
        if (centredLeft >= m.lockupRight + 12 && centredLeft + m.island.width <= m.endLeft - 12) {
          assert.ok(Math.abs(centre - m.width / 2) <= 1, where + ': with the room, the island is centred in the window: ' + centre);
        } else {
          assert.ok(Math.abs(m.island.left - (m.lockupRight + 12)) <= 1 || Math.abs(m.island.right - (m.endLeft - 12)) <= 1,
            where + ': without it the island sits a gutter from its neighbour: ' + JSON.stringify([m.lockupRight, m.island.left, m.island.right, m.endLeft]));
        }
        if (width === 640) {
          assert.ok(m.lockup.right <= m.island.left, where + ': the logo is clear at the minimum width');
        }
      }
    }
  }
  assert.ok(states.length === 2 * 4 * 10);

  // The widest island, with every label, is what fits at the default window.
  await run(`delete document.documentElement.dataset.platform; true`);
  await show('pro');
  await resize(1200, 780);
  assert.strictEqual((await measure()).rung, 0, 'the default window shows every label');
  // A narrow window with the gold dot standing in for the Pro tag.
  await show('free');
  await resize(640);
  const narrow = await run(`(() => { const dot = document.querySelector('#nav-polish .nav-pro').getBoundingClientRect(); const link = document.getElementById('nav-polish').getBoundingClientRect();
    return { dot: dot.width <= 8, inside: dot.right <= link.right && dot.top >= link.top, named: document.getElementById('nav-polish').textContent.replace(/\\s+/g, ' ').trim() }; })()`);
  assert.deepStrictEqual(narrow, { dot: true, inside: true, named: 'Polish PRO' }, 'icon-only Polish keeps its tag as a dot and its name');

  // Reduced motion hands every property a ten-microsecond transition
  // (refinement.css); measuring right after a class change must not see it.
  await dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await show('free');
  const settled = [];
  for (const width of [1200, 760, 1000, 640, 900, 860]) {
    await resize(width);
    await pause(60);
    const before = await measure();
    await run('fitIsland(); true');
    const after = await measure();
    settled.push([width, before.rung, after.rung]);
    assert.strictEqual(before.rung, after.rung, 'under reduced motion the fit at ' + width + 'px is already what a second look finds');
    assert.ok(!after.overflow && after.island.right <= after.endLeft - 8, 'and it clears the buttons at ' + width + 'px');
  }
  // The worst case for it: the narrowest rung has been on screen for a while,
  // then fitIsland() goes straight back to the widest and reads at once.
  await resize(1400);
  await run('setIslandRung(0); true');
  await pause(150);
  const wide = await run(`document.getElementById('island').offsetWidth`);
  await run('setIslandRung(3); true');
  await pause(150);
  const tight = await run(`document.getElementById('island').offsetWidth`);
  const back = await run(`(() => { setIslandRung(0); return document.getElementById('island').offsetWidth; })()`);
  await run('fitIsland(); true');
  assert.ok(tight < wide, 'the narrow rungs do narrow the island');
  assert.strictEqual(back, wide, 'read the instant a class changes, the island is already the width it settles to');
  await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  dbg.detach();

  assert.deepStrictEqual(errors, [], 'no renderer errors');
  console.log('Island shell: markup, frame, themes, current page, panels, focus rings and room at ' + states.length + ' widths and plans passed.');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
