'use strict';

// The app keeps the cloud model warm while the user records (src/main.js,
// keepCloudWarm). main.js only loads in the Windows and Mac harness, so the
// block is lifted out and run here against a fake clock and recorder state.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const start = source.indexOf('const CLOUD_KEEP_WARM_MS');
const end = source.indexOf('\nfunction advanceRecordingSession()');
assert(start > 0 && end > start, 'keepCloudWarm block found in main.js');
const block = source.slice(start, end);

function harness() {
  let clock = 0, nextId = 0;
  const intervals = new Map();
  const context = vm.createContext({
    Date: { now: () => clock },
    setInterval: (fn, ms) => { const id = { n: ++nextId, unref() {} }; intervals.set(id, { fn, ms, due: clock + ms }); return id; },
    clearInterval: id => intervals.delete(id),
    mode: 'arming', recordingSessionToken: 1, warms: 0,
    settings: { cloudTranscription: true },
  });
  context.cloudTranscriber = { warm: () => { context.warms++; return Promise.resolve(true); } };
  vm.runInContext(block, context);
  return {
    context,
    intervals,
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
  };
}

{
  const h = harness();
  h.context.keepCloudWarm(1);
  assert.strictEqual([...h.intervals.values()][0].ms, 2500, 'asks every 2.5 s');
  h.advance(2400);
  assert.strictEqual(h.context.warms, 0, 'the start already warmed; nothing before the first interval');
  h.context.mode = 'recording';
  h.advance(10000);
  assert.strictEqual(h.context.warms, 4, 'warm-ups repeat while arming and recording');
  h.context.mode = 'transcribing';
  h.advance(2500);
  assert.strictEqual(h.intervals.size, 0, 'stops once the user stops');
  h.advance(30000);
  assert.strictEqual(h.context.warms, 4, 'and sends nothing after');
}

{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.context.recordingSessionToken = 2; // cancelled, and a new dictation began
  h.advance(2500);
  assert.strictEqual(h.context.warms, 0, 'an old recording never warms for a new one');
  assert.strictEqual(h.intervals.size, 0);
}

{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.advance(2500);
  h.context.settings.cloudTranscription = false;
  h.advance(2500);
  assert.strictEqual(h.context.warms, 1, 'turning Cloud off mid-recording stops the warm-ups');
  assert.strictEqual(h.intervals.size, 0);
}

{
  const h = harness();
  h.context.mode = 'recording';
  h.context.keepCloudWarm(1);
  h.advance(60 * 60e3);
  assert.strictEqual(h.context.warms, 239, 'a forgotten recording warms for ten minutes at most');
  assert.strictEqual(h.intervals.size, 0);
}

{
  const h = harness();
  h.context.keepCloudWarm(1);
  h.context.keepCloudWarm(1);
  assert.strictEqual(h.intervals.size, 1, 'starting again replaces the timer instead of stacking one');
}

console.log('ok cloud keep-warm: repeats while recording, stops at stop, cancel, Cloud off and ten minutes, never stacks');
