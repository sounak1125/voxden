'use strict';
// Exercise real profile states in an isolated renderer. The old unlocked
// gradient only appeared after Learning, so checking the empty card missed it.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-profile-appearance-')));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  const win = new BrowserWindow({ show: false, width: 1298, height: 986,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  await cdp.sendCommand('DOM.enable');
  await cdp.sendCommand('CSS.enable');
  const { root } = await cdp.sendCommand('DOM.getDocument');
  const { nodeId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#voice-understanding' });
  const state = value => cdp.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: value });
  const appearance = () => run(`(() => {
    const el = document.getElementById('voice-understanding'), c = getComputedStyle(el);
    const ring = el.querySelector('.voice-ring-progress');
    return { image: c.backgroundImage, background: c.backgroundColor, border: c.borderColor,
      shadow: c.boxShadow, transform: c.transform, before: getComputedStyle(el, '::before').content,
      chip: getComputedStyle(el.querySelector('.voice-name')).backgroundColor,
      // The inline target, not the computed value: the arc draws in to it.
      offset: parseFloat(ring.style.strokeDashoffset),
      dash: parseFloat(getComputedStyle(ring).strokeDasharray),
      percent: el.querySelector('#vu-pct').textContent,
      ring: getComputedStyle(ring).stroke,
      filter: getComputedStyle(ring).filter };
  })()`);
  // The card rests on the surface and answers a hover with the slightly lifted
  // one; its edge stays a hairline in the same two steps.
  const palette = {
    voxden: { background: 'rgb(25, 29, 32)', hover: 'rgb(31, 36, 39)', ring: 'rgb(156, 243, 196)', shadow: 'none' },
    white: { background: 'rgb(255, 255, 255)', hover: 'rgb(249, 251, 250)', ring: 'rgb(23, 107, 70)', shadow: 'rgba(24, 48, 36, 0.05) 0px 1px 2px 0px' },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 260));
  for (const theme of ['voxden', 'white']) {
    await run(`document.documentElement.dataset.appTheme = '${theme}'; true`);
    for (const profile of ['learning', 'personalized', 'attuned', 'fluent', 'expert']) {
      await state([]);
      await run(`renderUnderstanding({ understandingProfile: '${profile}', understandingPercent: ${profile === 'expert' ? 100 : 50} }); true`);
      await settle();
      const normal = await appearance();
      assert.equal(normal.image, 'none', theme + '/' + profile + ' has no legacy mint gradient');
      assert.equal(normal.background, palette[theme].background);
      assert.equal(normal.ring, palette[theme].ring);
      assert.equal(normal.shadow, palette[theme].shadow);
      assert.equal(normal.filter, 'none');
      // The ring is the progress: its arc is the percent of a 19px-radius
      // circle, and the stage name beside it is plain text, not a chip.
      const percent = profile === 'expert' ? 100 : 50;
      assert.equal(normal.percent, percent + '%');
      assert.ok(Math.abs(normal.dash - 119.38) < .05 && Math.abs(normal.offset - 119.38 * (1 - percent / 100)) < .05,
        theme + '/' + profile + ' ring arc matches the percent: ' + JSON.stringify(normal));
      assert.equal(normal.chip, 'rgba(0, 0, 0, 0)', theme + '/' + profile + ' stage name has no chip');
      assert.equal(normal.before, 'none');
      assert.equal(normal.transform, 'none');
      // Entering and leaving repeatedly lands on the same two looks every time.
      let hovered = null;
      for (const hover of [true, false, true, false]) {
        await state(hover ? ['hover'] : []);
        await settle();
        const now = await appearance();
        if (!hover) assert.deepEqual(now, normal, theme + '/' + profile + ' returns to rest after the pointer leaves');
        else {
          assert.equal(now.background, palette[theme].hover, theme + '/' + profile + ' lifts to the hover surface');
          hovered = hovered || now;
          assert.deepEqual(now, hovered, theme + '/' + profile + ' hovers the same way every time');
        }
      }
      await state(['focus-visible']);
      assert.ok(await run(`parseFloat(getComputedStyle(document.getElementById('voice-understanding')).outlineWidth) >= 1.5`), 'keyboard focus stays visible');
    }
  }
  console.log('PASS: All five voice profile levels in both themes rest on the surface, lift the same way on hover, preserve ring colors and keyboard focus.');
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
