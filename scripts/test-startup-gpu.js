'use strict';

const assert = require('assert');
const { startSidecarAfterGpuDetection } = require('../src/startup-gpu');

(async () => {
  let releaseDetection;
  let started = false;
  let probeOnly = false;
  let notified = false;
  const detection = new Promise((resolve) => { releaseDetection = resolve; });
  const operation = startSidecarAfterGpuDetection(
    () => detection,
    (checkOnly) => { started = true; probeOnly = checkOnly; },
    () => { notified = true; },
    { probeOnly: true }
  );

  await Promise.resolve();
  assert.strictEqual(started, false, 'sidecar must not start before GPU detection');
  assert.strictEqual(notified, false, 'UI must not publish the unresolved plan');
  releaseDetection();
  await operation;
  assert.strictEqual(started, true, 'sidecar starts after GPU detection');
  assert.strictEqual(probeOnly, true, 'cold startup requests only a lightweight probe');
  assert.strictEqual(notified, true, 'resolved GPU plan is published');
  console.log('GPU-aware startup ordering passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
