'use strict';

const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');

(async () => {
  const h = harness();
  try {
    h.context.states = [];
    h.run(`
      showOverlay = () => {};
      overlayWin = { isDestroyed: () => false,
        webContents: { send: (channel, value) => { if (channel === 'state') states.push(value); } } };
    `);
    assert.strictEqual(h.run('settings.flowBarMotion'), 'system', 'existing profiles follow Windows by default');
    const set = h.handlers.get('settings-set');
    for (const mode of ['idle', 'arming', 'recording', 'transcribing']) {
      h.run(`mode = '${mode}'; recordingSessionToken = 7;`);
      for (const choice of ['full', 'reduced', 'system']) {
        const result = await set({}, { flowBarMotion: choice });
        assert.strictEqual(result.flowBarMotion, choice, 'settings returns the persisted preference');
        assert.strictEqual(h.context.states.at(-1).flowBarMotion, choice, 'the live overlay receives the preference');
        assert.strictEqual(h.run('mode'), mode, 'motion changes preserve an active dictation');
        assert.strictEqual(h.run('recordingSessionToken'), 7);
        assert.strictEqual(JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8')).flowBarMotion, choice);
        h.run('loadSettings()');
        assert.strictEqual(h.run('settings.flowBarMotion'), choice, 'the choice survives a restart');
      }
    }
    await set({}, { flowBarMotion: 'full' });
    assert.strictEqual((await set({}, { flowBarMotion: null })).flowBarMotion, 'full', 'malformed patches preserve the last choice');
    assert.strictEqual((await set({}, { flowBarMotion: 'unknown' })).flowBarMotion, 'system', 'unknown modes normalize safely');
    const file = h.run('SETTINGS_FILE');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.flowBarMotion;
    fs.writeFileSync(file, JSON.stringify(raw));
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.flowBarMotion'), 'system', 'old profiles require no manual migration');
    console.log('flow motion: preference persistence, legacy profiles, live state delivery and active capture preservation passed');
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
