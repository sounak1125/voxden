'use strict';

// Real settings IPC and disk persistence in a temporary profile. Windows,
// microphone devices, account services and helper processes remain inert.
const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  const h = harness();
  const states = [];
  try {
    h.context.testGeneralState = (_channel, state) => states.push(plain(state));
    h.run(`
      accountPlan = () => 'pro';
      settings.cloudTranscription = true;
      settings.alwaysShowFlowBar = false;
      overlayWin = { isDestroyed: () => false, webContents: { send: testGeneralState } };
    `);
    const set = h.handlers.get('settings-set');
    const patches = [
      { dictateMode: 'ptt' }, { dictateMode: 'toggle' },
      { dictationQuality: 'fast' }, { dictationQuality: 'accurate' }, { dictationQuality: 'auto' },
      { microphone: 'test-usb-microphone' }, { microphone: 'default' },
      { dictationLanguages: ['hi'] }, { dictationLanguages: ['en', 'hg'] }, { dictationLanguages: ['en'] },
      { autoAddToDictionary: false }, { autoAddToDictionary: true },
    ];
    for (const patch of patches) {
      const [key, value] = Object.entries(patch)[0];
      const snapshot = plain(await set(null, patch));
      const saved = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      assert.deepStrictEqual(snapshot[key], value, key + ' returns the confirmed value');
      assert.deepStrictEqual(saved[key], value, key + ' is written to the settings file');
      h.run('loadSettings()');
      assert.deepStrictEqual(plain(h.run('settings.' + key)), value, key + ' survives reloading settings');
      if (['dictateMode', 'dictationQuality', 'microphone'].includes(key)) {
        assert.deepStrictEqual(states.at(-1)[key], value, key + ' reaches the recording overlay');
      }
      if (key === 'dictateMode') assert.strictEqual(h.run('isPtt()'), value === 'ptt');
      if (key === 'dictationQuality') assert.strictEqual(h.run('planDictationRoute({ ranked: [] }).requested'), value);
      if (key === 'dictationLanguages') {
        assert.strictEqual(h.run('engineLanguage()'), value.length > 1 ? 'auto' : value[0]);
        assert.strictEqual(h.run('wantsHinglish()'), value.includes('hg'));
      }
    }
    console.log('General settings: 12 preference changes persisted, reloaded, and reached recording mode, microphone, quality and language routing.');
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
