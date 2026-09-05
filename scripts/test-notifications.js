'use strict';

// The bell must never lie about what is new. Two failures are the ones that
// matter: telling a fresh install about every feature the app has ever had,
// and bringing back a notification the user already cleared. Both come out of
// src/announcements.js, so both are pinned here.

const announcements = require('../src/announcements');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

const CATALOG = [
  { id: 'old', since: '1.0.8', kind: 'feature', title: 'Old news', body: 'Shipped ages ago.' },
  { id: 'skipped', since: '1.0.9', kind: 'model', title: 'Skipped release', body: 'Landed in between.' },
  { id: 'current', since: '1.0.10', kind: 'engine', title: 'This build', body: 'Shipped now.', action: { settings: 'general' } },
  { id: 'future', since: '1.1.0', kind: 'feature', title: 'Not yet', body: 'Has not shipped.' },
];

const T0 = 1_700_000_000_000;

// Guard the real release catalog, not just delivery rules with invented rows.
const releaseVersion = require('../package.json').version;
const releaseRows = announcements.CATALOG.filter(row => row.since === releaseVersion);
const releaseIds = releaseRows.map(row => row.id).sort();
const releaseNotes = fs.readFileSync(path.join(__dirname, '../release-notes/current.md'), 'utf8');
check('the running release has announcements', releaseRows.length > 0, true);
check('catalog ids are unique', new Set(announcements.CATALOG.map(row => row.id)).size, announcements.CATALOG.length);
for (const row of releaseRows) {
  check(row.id + ' uses the same words in release notes', releaseNotes.includes('**' + row.title + '** — ' + row.body), true);
}
for (const [label, state] of [
  ['fresh install', null],
  ['upgrade from 1.0.22', { seenVersion: '1.0.22', items: {} }],
  ['earlier local 2.1.0 build', { seenVersion: '2.1.0', items: {} }],
]) {
  const delivered = announcements.deliver(state, { version: releaseVersion, now: T0 }).state;
  check(label + ' receives the current highlights', announcements.list(delivered).map(row => row.id).sort(), releaseIds);
  check(label + ' has an unread badge', announcements.unreadCount(announcements.list(delivered)), releaseIds.length);
  const clearedRelease = announcements.clearAll(delivered).state;
  check(label + ' does not resurrect cleared highlights', announcements.list(announcements.deliver(clearedRelease, { version: releaseVersion, now: T0 + 1 }).state), []);
}

for (const id of ['qwen-recommended', 'qwen-gpu-acceleration']) {
  check(id + ' links to Speech engines', announcements.CATALOG.find(entry => entry.id === id).action.settings, 'speech-engines');
}
const muteOtherAudio = announcements.CATALOG.find(entry => entry.id === 'mute-other-audio-1-0-22') || {};
check('1.0.22 announces muting other audio', muteOtherAudio.since, '1.0.22');
check('1.0.22 audio announcement links to General', muteOtherAudio.action && muteOtherAudio.action.settings, 'general');
check('1.0.19 recordings link to privacy', announcements.CATALOG.find(entry => entry.id === 'dictation-recordings').action.settings, 'privacy');
check('1.0.19 settings split links to General', announcements.CATALOG.find(entry => entry.id === 'settings-split-1-0-19').action.settings, 'general');
check('1.0.19 announces the retired local packs', !!announcements.CATALOG.find(entry => entry.id === 'local-correction-retired'), true);
check('1.0.19 announces smoother startup', !!announcements.CATALOG.find(entry => entry.id === 'smoother-startup-1-0-19'), true);

function ids(items) {
  return items.map((item) => item.id);
}

function deliver(state, version, now) {
  return announcements.deliver(state, { catalog: CATALOG, version, now });
}

// --- Versions order by number, not by string ------------------------------

check('1.0.9 is older than 1.0.10', announcements.compareVersions('1.0.9', '1.0.10'), -1);
check('equal versions compare equal', announcements.compareVersions('1.0.10', '1.0.10'), 0);
check('a missing segment counts as zero', announcements.compareVersions('1.1', '1.1.0'), 0);
check('a prerelease tail is ignored', announcements.compareVersions('1.0.14-beta.1', '1.0.14'), 0);
check('nonsense sorts below everything', announcements.compareVersions('', '1.0.1'), -1);

// --- A fresh install is told what shipped in this build, and nothing else ---

const fresh = deliver(null, '1.0.10', T0);
check('a fresh store only hears about the running version',
  ids(announcements.list(fresh.state, CATALOG)), ['current']);
check('the fresh store records the version it caught up to', fresh.state.seenVersion, '1.0.10');
check('an unshipped entry stays out', !!fresh.state.items.future, false);

// --- Restarting the same build says nothing new ----------------------------

const restarted = deliver(fresh.state, '1.0.10', T0 + 1000);
check('a restart changes nothing', restarted.changed, false);
check('a restart does not re-deliver',
  ids(announcements.list(restarted.state, CATALOG)), ['current']);

const extraCatalog = CATALOG.concat([
  { id: 'late', since: '1.0.10', kind: 'feature', title: 'Late news', body: 'Added in a rebuild.' },
]);
const late = announcements.deliver(fresh.state, { catalog: extraCatalog, version: '1.0.10', now: T0 + 2000 });
check('a same-version rebuild still delivers new catalog rows',
  ids(announcements.list(late.state, extraCatalog)).sort(), ['current', 'late']);
check('older catalog rows stay out of a same-version rebuild', !!late.state.items.old, false);

// --- Updating delivers everything between the two versions -----------------

const before = deliver(null, '1.0.8', T0).state;
check('the installed build is the only news on install',
  ids(announcements.list(before, CATALOG)), ['old']);

// The user skips 1.0.9 entirely and lands on 1.0.10, so both are new to them.
const after = deliver(before, '1.0.10', T0 + 5000).state;
check('a skipped release is still delivered',
  ids(announcements.list(after, CATALOG)).sort(), ['current', 'old', 'skipped']);
check('the store follows the running version', after.seenVersion, '1.0.10');

// --- Reading, clearing, and staying cleared --------------------------------

check('everything delivered starts unread',
  announcements.unreadCount(announcements.list(after, CATALOG)), 3);

const read = announcements.markAllRead(after);
check('marking read reports the change', read.changed, true);
check('nothing is unread afterwards',
  announcements.unreadCount(announcements.list(read.state, CATALOG)), 0);
check('marking read twice is a no-op', announcements.markAllRead(read.state).changed, false);
check('read notifications stay in the list',
  ids(announcements.list(read.state, CATALOG)).sort(), ['current', 'old', 'skipped']);

const dropped = announcements.clearOne(read.state, 'old');
check('clearing one removes it',
  ids(announcements.list(dropped.state, CATALOG)).sort(), ['current', 'skipped']);
check('clearing an unknown id is a no-op', announcements.clearOne(dropped.state, 'nope').changed, false);

// This is the regression the tombstone exists for: a cleared notification must
// not walk back in the next time the catalog is folded into the store.
const afterClear = deliver(dropped.state, '1.0.10', T0 + 9000).state;
check('a cleared notification does not come back',
  ids(announcements.list(afterClear, CATALOG)).sort(), ['current', 'skipped']);

const emptied = announcements.clearAll(afterClear);
check('clear all empties the panel', announcements.list(emptied.state, CATALOG), []);
check('clear all twice is a no-op', announcements.clearAll(emptied.state).changed, false);
check('clearing survives the next delivery',
  announcements.list(deliver(emptied.state, '1.0.10', T0 + 12000).state, CATALOG), []);

// --- Runtime notifications share the same store ----------------------------

const entry = announcements.updateReadyEntry('1.0.11');
check('the update entry is keyed by version', entry.id, 'update-ready:1.0.11');

const noted = announcements.note(emptied.state, entry, T0 + 20000);
check('a runtime notification arrives unread',
  announcements.list(noted.state, CATALOG).map((i) => [i.id, i.kind, i.unread]),
  [['update-ready:1.0.11', 'update', true]]);
check('the same event twice only notifies once',
  announcements.note(noted.state, entry, T0 + 21000).changed, false);
check('an entry with no title is not a notification',
  announcements.note(noted.state, { id: 'x', title: '  ' }, T0).changed, false);
check('an update with no version raises nothing', announcements.updateReadyEntry(''), null);

// A runtime notification carries its own words, so it survives a build whose
// catalog knows nothing about it.
check('a runtime notification does not need the catalog',
  announcements.list(noted.state, []).map((i) => i.title), ['Voxden 1.0.11 is ready']);

// --- Newest first ----------------------------------------------------------

check('the newest notification is first',
  ids(announcements.list(announcements.note(after, entry, T0 + 30000).state, CATALOG))[0],
  'update-ready:1.0.11');

// --- A store file that has been edited or corrupted ------------------------

check('a garbage store reads as empty',
  announcements.normalizeState('nope'), { seenVersion: '', items: {} });
check('a record with no timestamp is dropped',
  announcements.normalizeState({ items: { a: { read: true } } }).items, {});
check('a garbage store still delivers',
  ids(announcements.list(deliver('nope', '1.0.10', T0).state, CATALOG)), ['current']);
check('an unknown kind falls back to feature',
  announcements.list({ items: { a: { ts: T0, inline: { kind: 'nonsense', title: 'Hi' } } } }, [])
    .map((i) => i.kind),
  ['feature']);
check('a stored id with no catalog row is not drawn blank',
  announcements.list({ items: { ghost: { ts: T0 } } }, CATALOG), []);

// --- deliver() does not mutate what it was given ---------------------------

const original = deliver(null, '1.0.8', T0).state;
const snapshot = JSON.stringify(original);
announcements.clearAll(original);
announcements.markAllRead(original);
announcements.note(original, entry, T0);
deliver(original, '1.0.10', T0);
check('callers keep the state they passed in', JSON.stringify(original), snapshot);

if (failed) {
  console.error('\n' + failed + ' notification test(s) failed');
  process.exit(1);
}
console.log('\nall notification tests passed');
