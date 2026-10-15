'use strict';

// The app keeps the cloud model warm while the user records (src/main.js,
// keepCloudWarm), but only when it would otherwise go idle: every warm-up is a
// billed second, and the pieces sent during a recording keep the model warm on
// their own. main.js only loads in the Windows and Mac harness, so the block is
// lifted out and run here against a fake clock and recorder state.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

function liftBlock(src, label) {
  const start = src.indexOf('const CLOUD_KEEP_WARM_MS');
  const end = src.indexOf('\nfunction advanceRecordingSession()');
  assert(start > 0 && end > start, 'keepCloudWarm block found in ' + label);
  return { start, end, code: src.slice(start, end) };
}
const lifted = liftBlock(source, 'main.js');
const block = lifted.code;

function harness(code) {
  let clock = 0, nextId = 0;
  const intervals = new Map();
  const warmTimes = [], warmArgs = [];
  const context = vm.createContext({
    Date: { now: () => clock },
    setInterval: (fn, ms) => { const id = { n: ++nextId, unref() {} }; intervals.set(id, { fn, ms, due: clock + ms }); return id; },
    clearInterval: id => intervals.delete(id),
    mode: 'arming', recordingSessionToken: 1,
    settings: { cloudTranscription: true },
    // main.js reads the relay's lanes from the account; none by default.
    cloudDictationConfig: () => null,
  });
  context.cloudTranscriber = { warm: options => { warmTimes.push(clock); warmArgs.push(options); return Promise.resolve(true); } };
  vm.runInContext(code || block, context);
  return {
    context,
    intervals,
    warmTimes,
    warmArgs,
    now: () => clock,
    // let and const at the top of the block are not properties of the context.
    read: expr => vm.runInContext(expr, context),
    inFlight: () => vm.runInContext('cloudRequestsInFlight', context),
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of intervals) if (t.due <= until && (!next || t.due < next[1].due)) next = [id, t];
        if (!next) break;
        clock = next[1].due;
        next[1].due += next[1].ms;
        next[1].fn();
      }
      clock = until;
    },
    // The system clock moved (NTP, a manual change): timers keep their pace.
    jump(ms) {
      clock += ms;
      for (const t of intervals.values()) t.due += ms;
    },
  };
}

function gaps(times) {
  return times.slice(1).map((t, i) => t - times[i]);
}

// --- constants ---------------------------------------------------------------
{
  const h = harness();
  h.context.keepCloudWarm(1);
  assert.strictEqual([...h.intervals.values()][0].ms, 1000, 'checks every second');
  assert.strictEqual(h.read('CLOUD_KEEP_WARM_MS'), 1000);
  assert.strictEqual(h.read('CLOUD_KEEP_WARM_IDLE_MS'), 3000);
  assert.strictEqual(h.read('CLOUD_KEEP_WARM_MAX_MS'), 10 * 60e3);
}

// --- idle recording: pings are spaced at least three seconds apart -----------
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.advance(2900);
  assert.strictEqual(h.warmTimes.length, 0, 'nothing before three idle seconds');
  h.context.mode = 'recording';
  h.advance(57100); // to 60 s
  assert.strictEqual(h.warmTimes[0], 3000, 'the first one when three seconds have passed');
  assert.strictEqual(h.warmTimes.length, 20, 'one every three seconds of silence');
  assert(gaps(h.warmTimes).every(g => g >= 3000 && g <= 4000), 'spaced three to four seconds apart: ' + gaps(h.warmTimes));
}

// --- no ping while a request is in flight ------------------------------------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.context.noteCloudRequestStart();
  assert.strictEqual(h.inFlight(), 1);
  h.advance(30000);
  assert.strictEqual(h.warmTimes.length, 0, 'a slow request keeps its own model warm; no ping beside it');
  h.context.noteCloudRequestEnd();
  assert.strictEqual(h.inFlight(), 0);
  h.advance(2900);
  assert.strictEqual(h.warmTimes.length, 0, 'and none within three seconds of it finishing');
  h.advance(1100); // 4.0 s after the end
  assert.strictEqual(h.warmTimes.length, 1, 'one once the model has sat idle that long');
  assert.strictEqual(h.warmTimes[0], 33000, 'at the first check three seconds after the end');
}

// --- overlapping requests ----------------------------------------------------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.context.noteCloudRequestStart();
  h.context.noteCloudRequestStart();
  h.context.noteCloudRequestEnd();
  h.advance(20000);
  assert.strictEqual(h.warmTimes.length, 0, 'one of two still running means no ping');
  h.context.noteCloudRequestEnd();
  h.advance(3000);
  assert.strictEqual(h.warmTimes.length, 1, 'the last one ending frees the clock');
}

// --- a request sent or finished resets the three seconds ---------------------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.advance(3000);
  assert.deepStrictEqual(h.warmTimes, [3000], 'idle ping');
  h.advance(1000); // 4.0 s
  h.context.noteCloudRequestStart(); // piece sent at 4.0 s
  h.advance(500);
  h.context.noteCloudRequestEnd(); // answered at 4.5 s
  h.advance(2400); // 6.9 s: before 4.5 + 3
  assert.deepStrictEqual(h.warmTimes, [3000], 'nothing within three seconds of the request');
  h.advance(1100); // 8.0 s: the first check at or after 7.5 s
  assert.deepStrictEqual(h.warmTimes, [3000, 8000], 'then one, counted from the request ending');
  h.advance(2900);
  assert.deepStrictEqual(h.warmTimes, [3000, 8000], 'the ping itself restarts the three seconds');
  h.advance(100);
  assert.deepStrictEqual(h.warmTimes, [3000, 8000, 11000]);
}

// --- a request that fails counts as finished: the pair always balances -------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.context.noteCloudRequestStart();
  h.advance(5000);
  h.context.noteCloudRequestEnd(); // thrown, timed out or aborted: still ends
  h.advance(2900);
  assert.strictEqual(h.warmTimes.length, 0, 'a failure stamps the clock like a success');
  h.advance(1100);
  assert.strictEqual(h.warmTimes.length, 1);
}

// --- the in-flight count never goes below zero -------------------------------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.context.noteCloudRequestEnd();
  h.context.noteCloudRequestEnd();
  assert.strictEqual(h.inFlight(), 0, 'unmatched ends leave zero, not minus two');
  h.context.noteCloudRequestStart();
  assert.strictEqual(h.inFlight(), 1);
  h.advance(20000);
  assert.strictEqual(h.warmTimes.length, 0, 'so one real request in flight still blocks the ping');
  h.context.noteCloudRequestEnd();
  assert.strictEqual(h.inFlight(), 0);
}

// --- the record-start warm-up counts as activity -----------------------------
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.advance(2000);
  h.context.warmCloudNow();
  assert.deepStrictEqual(h.warmTimes, [2000], 'warmCloudNow asks the relay');
  h.advance(2900); // 4.9 s
  assert.deepStrictEqual(h.warmTimes, [2000], 'no ping one to three seconds after it');
  h.advance(100); // 5.0 s: three seconds after
  assert.deepStrictEqual(h.warmTimes, [2000, 5000]);
}
{
  // The order main.js uses: the warm-up as the microphone opens, then the timer.
  const h = harness();
  h.advance(50000);
  h.context.warmCloudNow();
  h.context.keepCloudWarm(1);
  h.context.mode = 'recording';
  h.advance(2900);
  assert.deepStrictEqual(h.warmTimes, [50000], 'nothing within three seconds of the start warm-up');
  h.advance(100);
  assert.deepStrictEqual(h.warmTimes, [50000, 53000]);
}

// --- warmCloudNow never rejects and never needs a transcriber -----------------
async function warmCloudNowChecks() {
  const h = harness();
  h.context.cloudTranscriber.warm = () => Promise.reject(new Error('relay down'));
  assert.strictEqual(await h.context.warmCloudNow(), false, 'a failed warm-up resolves, never rejects');
  h.context.cloudTranscriber.warm = () => { throw new Error('thrown outright'); };
  assert.strictEqual(await h.context.warmCloudNow(), false, 'and so does one that throws');
  h.context.cloudTranscriber = null;
  assert.strictEqual(await h.context.warmCloudNow(), false, 'without a transcriber there is nothing to ask');
  h.context.cloudTranscriber = { warm: () => Promise.resolve(true) };
  assert.strictEqual(await h.context.warmCloudNow(), true, 'the answer is passed on');
}

// --- lanes: the warm-up asks for the body lane only when the relay runs them --
{
  const h = harness();
  h.context.warmCloudNow();
  h.context.cloudDictationConfig = () => ({ lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 });
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.advance(3000);
  h.context.cloudDictationConfig = () => { throw new Error('account store unreadable'); };
  h.advance(4000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.warmArgs)), [{ lane: '' }, { lane: 'body' }],
    'no lanes: today\'s warm-up; lanes: the body lane; and a failing account read sends nothing rather than throwing');
}

// --- stop conditions ---------------------------------------------------------
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.context.mode = 'recording';
  h.advance(10000);
  assert.strictEqual(h.warmTimes.length, 3, 'warm-ups continue while arming and recording');
  h.context.mode = 'transcribing';
  h.advance(1000);
  assert.strictEqual(h.intervals.size, 0, 'stops once the user stops');
  h.advance(30000);
  assert.strictEqual(h.warmTimes.length, 3, 'and sends nothing after');
}
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.context.mode = 'idle';
  h.advance(10000);
  assert.strictEqual(h.warmTimes.length, 0, 'a cancelled recording sends nothing');
  assert.strictEqual(h.intervals.size, 0);
}
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.context.recordingSessionToken = 2; // cancelled, and a new dictation began
  h.advance(5000);
  assert.strictEqual(h.warmTimes.length, 0, 'an old recording never warms for a new one');
  assert.strictEqual(h.intervals.size, 0);
}
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.advance(3000);
  h.context.settings.cloudTranscription = false;
  h.advance(5000);
  assert.strictEqual(h.warmTimes.length, 1, 'turning Cloud off mid-recording stops the warm-ups');
  assert.strictEqual(h.intervals.size, 0);
}
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.advance(3000);
  h.context.cloudTranscriber = null;
  h.advance(5000);
  assert.strictEqual(h.warmTimes.length, 1, 'losing the transcriber stops them too');
  assert.strictEqual(h.intervals.size, 0);
}
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.advance(60 * 60e3);
  assert.strictEqual(h.warmTimes.length, 199, 'a forgotten recording warms for ten minutes at most');
  assert(h.warmTimes[h.warmTimes.length - 1] < 10 * 60e3, 'and never at or after the cap');
  assert.strictEqual(h.intervals.size, 0);
}
{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.context.keepCloudWarm(1);
  assert.strictEqual(h.intervals.size, 1, 'starting again replaces the timer instead of stacking one');
}

// --- a clock set back does not silence the warm-ups --------------------------
{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.advance(20000);
  h.context.noteCloudRequestStart();
  h.context.noteCloudRequestEnd(); // stamped at 20 s
  const before = h.warmTimes.length;
  h.jump(-15000); // the clock now reads 5 s
  h.advance(4000);
  assert.deepStrictEqual(h.warmTimes.slice(before), [9000],
    'a ping follows within a few seconds, not after the old time comes round again');
}

// --- the wiring in main.js ---------------------------------------------------
{
  const outside = source.slice(0, lifted.start) + source.slice(lifted.end);
  assert.strictEqual((source.match(/cloudTranscriber\.transcribe\(/g) || []).length, 1, 'one place sends a clip');
  assert.strictEqual((source.match(/cloudTranscriber\.warm\(/g) || []).length, 1, 'one place asks the relay to warm: warmCloudNow');
  assert(block.includes('cloudTranscriber.warm({ lane })'), 'and it is inside the lifted block');
  assert.strictEqual((outside.match(/warmCloudNow\(\);/g) || []).length, 1, 'the record-start warm-up goes through warmCloudNow');
  const tryStart = source.indexOf('async function tryCloudTranscribe(');
  const tryEnd = source.indexOf('\nasync function transcribeSavedFile(');
  assert(tryStart > 0 && tryEnd > tryStart, 'tryCloudTranscribe found');
  const body = source.slice(tryStart, tryEnd);
  assert(/noteCloudRequestStart\(\);\s*let result;\s*try \{\s*result = await cloudTranscriber\.transcribe\(/.test(body),
    'the request is counted immediately before it is sent');
  assert(/\} finally \{\s*noteCloudRequestEnd\(\);\s*\}/.test(body), 'and its end is counted in a finally');
  assert.strictEqual((body.match(/noteCloudRequestStart\(\)/g) || []).length, 1);
  assert.strictEqual((body.match(/noteCloudRequestEnd\(\)/g) || []).length, 1);
}

// --- ping counts (printed, never asserted) -----------------------------------
// Pings over a 60 s recording under the current rule. The rule before
// 2026-10-13 sent a warm-up every 2.5 s whatever else was going on: 25 a
// minute. "Billed" models the relay: it skips a warm-up while one is in flight
// or when any answer landed within 1.5 s, and a warm-up takes about half a second.
function simulate(code, pieces) {
  const h = harness(code);
  h.context.mode = 'recording';
  h.context.warmCloudNow();
  h.context.keepCloudWarm(1);
  const events = [];
  const answers = [];
  for (const p of pieces) {
    events.push({ t: p.at, fn: () => h.context.noteCloudRequestStart() });
    events.push({ t: p.at + p.took, fn: () => h.context.noteCloudRequestEnd() });
    answers.push(p.at + p.took);
  }
  events.sort((a, b) => a.t - b.t);
  for (const e of events) { h.advance(e.t - h.now()); e.fn(); }
  h.advance(60000 - h.now());
  return { sent: h.warmTimes.length, billed: billedAfterRelay(h.warmTimes, answers) };
}

function billedAfterRelay(warmTimes, answerTimes) {
  let billed = 0, lastWarmDone = -Infinity;
  for (const t of warmTimes) {
    const warmInFlight = lastWarmDone > t;
    let lastAnswer = Math.max(-Infinity, ...answerTimes.filter(a => a <= t));
    if (!warmInFlight) lastAnswer = Math.max(lastAnswer, lastWarmDone);
    if (warmInFlight || t - lastAnswer < 1500) continue;
    billed++;
    lastWarmDone = t + 500;
  }
  return billed;
}

{
  const silence = [];
  const pieces = [];
  for (let at = 5000; at <= 55000; at += 5000) pieces.push({ at, took: 1200 });
  const a = simulate(block, silence);
  const b = simulate(block, pieces);
  console.log('cloud keep-warm pings over a 60 s recording, record-start warm-up included (the old every-2.5 s rule'
    + ' sent 25 in both cases): silence sent ' + a.sent + ', billed ' + a.billed
    + ' | a piece every 5 s taking 1.2 s: sent ' + b.sent + ', billed ' + b.billed);
}

warmCloudNowChecks().then(
  () => console.log('ok cloud keep-warm: pings only when idle for three seconds with nothing in flight, stamped by the start warm-up, stops at stop, cancel, Cloud off and ten minutes, never stacks'),
  err => { console.error(err); process.exitCode = 1; },
);
