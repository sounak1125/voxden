'use strict';
// The feedback report shape: what is accepted, what is refused, and the
// GitHub fallback link.
const assert = require('assert');
const feedback = require('../src/feedback');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const diagnostics = { version: '2.1.2', os: 'Windows 10.0.26200', engine: 'qwen3-asr', device: 'cuda', cloud: false, plan: 'free', language: 'en' };

eq('a bug with a message is accepted', feedback.prepare({ kind: 'bug', message: '  The flow bar vanished.\r\n' }, diagnostics),
  { ok: true, body: { kind: 'bug', message: 'The flow bar vanished.', diagnostics } });
eq('kinds are case-insensitive', feedback.prepare({ kind: ' Idea ', message: 'x', includeDetails: false }).body.kind, 'idea');
eq('an unknown kind is refused', feedback.prepare({ kind: 'rant', message: 'x' }).ok, false);
eq('an empty message is refused with a reason', feedback.prepare({ kind: 'bug', message: '   ' }).error, 'Write a few words first.');
eq('a message over the limit is refused', feedback.prepare({ kind: 'bug', message: 'a'.repeat(4001) }).ok, false);
eq('details stay out when the user turns them off', feedback.prepare({ kind: 'other', message: 'x', includeDetails: false }, diagnostics).body.diagnostics, undefined);
eq('an email is normalised and kept', feedback.prepare({ kind: 'bug', message: 'x', email: ' Me@Example.COM ' }).body.email, 'me@example.com');
eq('a bad email is refused', feedback.prepare({ kind: 'bug', message: 'x', email: 'nope' }).ok, false);
eq('an empty email is simply absent', 'email' in feedback.prepare({ kind: 'bug', message: 'x', email: '' }).body, false);

eq('diagnostics read as short lines', feedback.diagnosticsText(diagnostics),
  'Voxden 2.1.2\nWindows 10.0.26200\nRecognizer: qwen3-asr on cuda\nDictation language: en\nPlan: free');
eq('cloud dictation names the cloud, not the local engine', feedback.diagnosticsText({ engine: 'whisper', cloud: true }), 'Recognizer: Voxden Cloud');

const url = new URL(feedback.issueUrl({ kind: 'bug', message: 'Paste lands twice\nin Slack', diagnostics }));
eq('the issue link goes to the repo', url.origin + url.pathname, 'https://github.com/sounak1125/voxden/issues/new');
eq('the title carries the kind and first line', url.searchParams.get('title'), '[Bug] Paste lands twice');
eq('the body carries the message and the details', url.searchParams.get('body'),
  'Paste lands twice\nin Slack\n\n---\nVoxden 2.1.2\nWindows 10.0.26200\nRecognizer: qwen3-asr on cuda\nDictation language: en\nPlan: free');
eq('no details means no rule', new URL(feedback.issueUrl({ kind: 'idea', message: 'Dark icons' })).searchParams.get('body'), 'Dark icons');

process.stdout.write('all ' + checks + ' feedback checks passed\n');
