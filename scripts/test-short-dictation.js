'use strict';

const assert = require('assert');
const { performance } = require('perf_hooks');
const vocabulary = require('../src/vocabulary');
const { dedupeRepeats } = require('../src/cleanup');
const { CloudTranscriber } = require('../src/cloud');

const entry = (from, to, options = {}) => ({ id: from, rules: [{ from, to, ...options }] });
const cases = [
  ['ſend', 'send', 'Send', {}, 'Send'],
  ['Kelvin', 'kelvin', 'Kelvin', {}, 'Kelvin'],
  ['ς', 'σ', 'sigma', {}, 'sigma'],
  ['CAFÉ', 'cafe\u0301', 'coffee', {}, 'coffee'],
  ['alpha\n\t beta', 'alpha beta', 'Name', {}, 'Name'],
  ['c++', 'c++', 'C++', {}, 'C++'],
  ['a.b', 'a.b', 'Name', {}, 'Name'],
  ['axb', 'a.b', 'Name', {}, 'axb'],
  ['PrefixNameSuffix', 'Name', 'Other', {}, 'PrefixNameSuffix'],
  ['name', 'Name', 'Other', { caseSensitive: true }, 'name'],
  ['Name', 'Name', 'Other', { caseSensitive: true }, 'Other'],
  ['नमसतेजी', 'नमसते', 'नमस्ते', { script: 'deva' }, 'नमसतेजी'],
  ['我爱北京', '北京', '上海', { script: 'hani' }, '我爱上海'],
];
for (const [text, from, to, options, expected] of cases) {
  assert.strictEqual(vocabulary.applyEntries(text, [entry(from, to, options)]).text, expected);
}
assert.strictEqual(vocabulary.applyEntries('first alias', [entry('first alias', 'alias'), entry('alias', 'Name')]).text, 'Name',
  'prefilter checks the current text so a replacement can feed a later rule');
assert.strictEqual(dedupeRepeats('ſend ſend now', ['send send']), 'ſend ſend now');
assert.strictEqual(dedupeRepeats('Bora Bora is is nice', ['Bora Bora']), 'Bora Bora is nice');

// A fresh dictionary with hundreds of irrelevant terms must keep ordinary
// short speech unchanged. Report cold time separately from repeated calls.
const absent = Array.from({ length: 300 }, (_, i) => entry('synthetic name ' + i, 'SyntheticName' + i));
const started = performance.now();
assert.deepStrictEqual(vocabulary.applyEntries('Please send it today.', absent), { text: 'Please send it today.', hits: 0, applied: [] });
console.log('Cold 300-term short-sentence dictionary pass: ' + (performance.now() - started).toFixed(1) + ' ms');

async function main() {
  let finish, calls = 0, clock = 100;
  const diagnostics = [];
  const client = new CloudTranscriber({ token: () => 'test-token', now: () => clock,
    fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    onWarm: value => diagnostics.push(value),
  });
  const first = client.warm(), second = client.warm();
  assert.strictEqual(calls, 1, 'overlapping warm-ups share one request');
  assert.strictEqual(first, second);
  clock = 140; finish({ ok: true, status: 204 });
  assert.strictEqual(await first, true);
  assert.deepStrictEqual(diagnostics, [{ accepted: true, status: 204, requestMs: 40 }]);
  const next = client.warm();
  assert.strictEqual(calls, 2, 'later recordings can warm again');
  finish({ ok: false, status: 503 });
  assert.strictEqual(await next, false);
  assert.strictEqual(diagnostics.at(-1).accepted, false);
  const failing = new CloudTranscriber({ token: () => 'test-token', fetchImpl: async () => { throw new Error('offline'); },
    onWarm: () => { throw new Error('diagnostics unavailable'); } });
  assert.strictEqual(await failing.warm(), false, 'warm-up and diagnostic failures never prevent recording');
  console.log('Short-sentence Unicode, boundaries, replacements, repetition and warm-up checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
