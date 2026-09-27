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
    return { image: c.backgroundImage, background: c.backgroundColor, border: c.borderColor,
      shadow: c.boxShadow, transform: c.transform, transition: c.transitionDuration,
      before: getComputedStyle(el, '::before').display,
      glow: el.querySelector('.vu-glow') ? getComputedStyle(el.querySelector('.vu-glow')).display : 'none',
      chip: getComputedStyle(el.querySelector('.vu-profile')).backgroundColor,
      // The inline target, not the computed value: the arc eases to it.
      offset: parseFloat(el.querySelector('.vu-ring-progress').style.strokeDashoffset),
      dash: parseFloat(getComputedStyle(el.querySelector('.vu-ring-progress')).strokeDasharray),
      percent: el.querySelector('#vu-pct').textContent,
      ring: getComputedStyle(el.querySelector('.vu-ring-progress')).stroke,
      filter: getComputedStyle(el.querySelector('.vu-ring-progress')).filter };
  })()`);
  for (const theme of ['voxden', 'white']) {
    await run(`document.documentElement.dataset.appTheme = '${theme}'; true`);
    for (const profile of ['learning', 'personalized', 'attuned', 'fluent', 'expert']) {
      await state([]);
      await run(`renderUnderstanding({ understandingProfile: '${profile}', understandingPercent: ${profile === 'expert' ? 100 : 50} }); true`);
      const normal = await appearance();
      assert.equal(normal.image, 'none', theme + '/' + profile + ' has no legacy mint gradient');
      assert.equal(normal.background, theme === 'white' ? 'rgb(255, 255, 255)' : 'rgb(25, 27, 30)');
      assert.equal(normal.ring, theme === 'white' ? 'rgb(23, 107, 70)' : 'rgb(156, 243, 196)');
      assert.equal(normal.shadow, 'none');
      assert.equal(normal.filter, 'none');
      assert.equal(normal.glow, 'none');
      // The ring is the progress: its arc is the percent of a 43px-radius
      // circle, and the stage name beside it is plain text, not a chip.
      const percent = profile === 'expert' ? 100 : 50;
      assert.equal(normal.percent, percent + '%');
      assert.ok(Math.abs(normal.dash - 270.2) < .05 && Math.abs(normal.offset - 270.2 * (1 - percent / 100)) < .05,
        theme + '/' + profile + ' ring arc matches the percent: ' + JSON.stringify(normal));
      assert.equal(normal.chip, 'rgba(0, 0, 0, 0)', theme + '/' + profile + ' stage name has no chip');
      assert.equal(normal.before, 'none');
      assert.equal(normal.transform, 'none');
      assert.equal(normal.transition, '0s');
      // Repeated entry/exit checks the actual computed background image, not
      // just backgroundColor, and samples while old transitions would run.
      for (const hover of [true, false, true, false]) {
        await state(hover ? ['hover'] : []);
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        assert.deepEqual(await appearance(), normal, theme + '/' + profile + ' is steady across pointer entry/exit');
      }
      await state(['focus-visible']);
      assert.ok(await run(`parseFloat(getComputedStyle(document.getElementById('voice-understanding')).outlineWidth) >= 1.5`), 'keyboard focus stays visible');
    }
  }
  console.log('PASS: All five voice profile levels in both themes stay flat through hover entry/exit, preserve ring colors and keyboard focus.');
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
