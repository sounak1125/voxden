'use strict';
const assert = require('assert');
const path = require('path');
const dict = require('../src/dictionary');

// Guards the seed that actually ships (package.json extraResources).
// src/main.js ensureData() copies it verbatim into a new user's
// data/dictionary.json on first launch, so whatever is in here lands on other
// people's machines and feeds Whisper's initial_prompt via promptFrom().
//
// It ships EMPTY on purpose: every install starts with a clean dictionary and
// learns from its own user, one accepted suggestion at a time. Nothing is
// preloaded, for new
// users or for the maintainer.
//
// The checks below are deliberately written to survive that file being
// repopulated later. They are close to vacuous while it is empty, and they
// start doing real work the moment somebody adds a default pack.
const seedPath = path.join(__dirname, 'vocabulary-seed.json');
const { phrases } = dict.load(seedPath);

// 1. Ships empty.
assert.deepStrictEqual(phrases, [], 'the shipped seed must stay empty');

// 2. Nothing personal, ever. Names, private project names and health terms
//    belong in a local untracked pack, not in a public default.
const BANNED = /sounak|so knock|sunak|sownak|dobby|dobie|margo|mango|sakhi|sucky|soggy|mogfx|mo gfx|mogul fx|moe graphics|refboard|ref board|rev board|red board|deskpets|desk pets|disk pets|desk bets|seqsort|sec sort|seek sort|sex sort|sequel sort|cinegrade|cine grade|cinnagrade|scene grade|thakumar|thakur|taku mar|jarvis|java's|pcos|peacocks|rakshasa|rock shasa|byangoma|bang goma|subhrajit|sub trees|aishwarya|priyanka|debashish|navya/i;
for (const p of phrases) {
  assert.ok(!BANNED.test(p.from), 'personal term in shipped seed: ' + p.from);
  assert.ok(!BANNED.test(p.to), 'personal term in shipped seed: ' + p.to);
}

// 3. Ordinary English survives. Each sentence below was broken by a rule that
//    once shipped: "his field" and "big field" mapped to Higgsfield, "lower a"
//    to LoRA, "sole character" to Soul Character, "entropic" to Anthropic,
//    "single owner" to single oner, "frames per second" to fps. Any default
//    pack added later has to leave all of them alone.
const UNTOUCHABLE = [
  'I will get the file later',
  'Laura called me this morning',
  'she brought a bouquet of roses',
  'the owner of the studio',
  'he is a leader in his field',
  'they played in a big field',
  'lower a flag to half mast',
  'the sole character in the play',
  'an entropic system loses order',
  'a single owner vehicle',
  'it runs at sixty frames per second',
  "Java's type system is verbose",
];
let fail = 0;
for (const line of UNTOUCHABLE) {
  const got = dict.applyDictionary(line, phrases);
  if (got !== line) {
    fail++;
    console.error('FAIL  ordinary English was rewritten\n  in:  ' + line + '\n  out: ' + got);
  }
}

// 3b. The seed is not the only thing that ships. Source files ship too, and a
//     personal term can reach them the same way it reaches the seed -- a word
//     list, a default, a comment, a test fixture. Scan them with the same list.
//     Only the public repo slug and the exact announcement credit are exempt;
//     the rest of each line is still scanned. This file is exempt because it
//     has to carry the list itself. Seed entries never receive these exemptions.
const fs = require('fs');
const REPO_SLUG = /sounak1125\/voxden/g;
const ANNOUNCEMENTS = path.join('src', 'announcements.js');
function hasPersonalTerm(rel, line) {
  let scanned = line.replace(REPO_SLUG, '');
  if (rel === ANNOUNCEMENTS) scanned = scanned.replace(/\bMade by Sounak\b/g, '');
  return BANNED.test(scanned);
}
assert.ok(!hasPersonalTerm(ANNOUNCEMENTS, 'A Made by Sounak credit on the finish page.'));
assert.ok(hasPersonalTerm(path.join('src', 'app.js'), 'Made by Sounak'));
assert.ok(hasPersonalTerm(ANNOUNCEMENTS, 'made by Sounak'));
assert.ok(hasPersonalTerm(ANNOUNCEMENTS, 'Made by Sounak1125'));
assert.ok(hasPersonalTerm(ANNOUNCEMENTS, 'Made by Sounak; Sounak'));
assert.ok(hasPersonalTerm(ANNOUNCEMENTS, 'Made by Sounak; Jarvis'));
assert.ok(hasPersonalTerm(ANNOUNCEMENTS, 'sounak1125/voxden; Jarvis'));
assert.ok(BANNED.test('Made by Sounak'), 'the public credit must still be banned in seed entries');
const sourceFiles = [];
for (const dir of ['src', 'scripts']) {
  for (const name of fs.readdirSync(path.join(__dirname, '..', dir))) {
    if (!name.endsWith('.js') || name === 'test-vocabulary.js') continue;
    sourceFiles.push(path.join(dir, name));
  }
}
for (const rel of sourceFiles) {
  const lines = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!hasPersonalTerm(rel, line)) return;
    fail++;
    console.error('FAIL  personal term in shipped source\n  ' + rel + ':' + (i + 1)
      + '\n  ' + line.trim().slice(0, 120));
  });
}
console.log('scanned ' + sourceFiles.length + ' source files for personal terms');

// 4. promptFrom() caps the acoustic hint at 64 unique `to` values.
const prompt = dict.promptFrom(phrases, []);
const terms = prompt ? prompt.split(', ') : [];
assert.ok(terms.length <= 64, 'prompt must stay within 64 terms');

console.log('seed entries: ' + phrases.length + ', prompt terms: ' + terms.length + '/64');
console.log(fail ? fail + ' failing case(s)' : 'all vocabulary cases pass');
process.exit(fail ? 1 : 0);
