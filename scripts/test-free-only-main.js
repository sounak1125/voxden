'use strict';

// A build with no account service is free-only: no account manager, no word
// cap, no Voxden Cloud, and nothing that waits on a server that is not there.

const assert = require('assert');
const mainHarness = require('./asr-test-harness');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
const plain = (value) => JSON.parse(JSON.stringify(value));

async function main() {
  const h = mainHarness({ accountUrl: '' });
  try {
    const call = (channel, ...args) => h.handlers.get(channel)(null, ...args);
    eq('no account manager, cloud transcriber or polish client is made',
      plain(h.run('[accountManager, cloudTranscriber, polishClient]')), [null, null, null]);
    const snap = plain(h.run('snapshot()'));
    eq('the dashboard is told the build is free-only', [snap.freeOnly, snap.account], [true, null]);
    eq('nobody is asked to sign in', snap.signInRequired, false);
    eq('there is no weekly word meter', snap.freeWords, null);
    eq('and no dictation is charged to one', h.run('chargeFreeWords("one two three"); freeWordsMeter()'), null);
    eq('the next clip is not headed for the cloud', snap.cloudReady, false);

    // A Cloud setting left on from a Pro month is switched off as settings load.
    h.run('settings.cloudTranscription = true; saveSettings(); loadStores();');
    eq('a Cloud setting left on is switched off', h.run('settings.cloudTranscription'), false);
    eq('and stays off on disk', h.run('loadSettings(); settings.cloudTranscription'), false);

    eq('Polish is not offered', h.run('polishOffer("tidy this up please")'), null);
    const feedback = await call('feedback-send', { kind: 'bug', message: 'The bar did not appear after I pressed the shortcut.' });
    eq('feedback points at GitHub instead of a server', [feedback.ok, feedback.fallback], [false, true]);
    const code = await call('account-code', 'me@example.com');
    eq('a sign-in attempt is refused, not sent', !!(code && code.account === null), true);

    // The same main process with a service named has accounts again.
    const withService = mainHarness();
    try {
      const s = plain(withService.run('snapshot()'));
      eq('a build pointed at a service still has accounts', [s.freeOnly, !!s.account, s.signInRequired], [false, true, true]);
      eq('and talks to that service', withService.run('accountManager.baseUrl'), 'http://127.0.0.1:8787/v1');
    } finally { await withService.close(); }
  } finally { await h.close(); }
  process.stdout.write('all ' + checks + ' free-only checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
