'use strict';

// Opt-in, sequential desktop checks with disposable profiles, synthetic audio,
// and local mock services. No real global mouse, successful OS paste, paid
// service, or physical microphone test is implied by this batch.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist-test-report/desktop-readiness');
fs.mkdirSync(output, { recursive: true });
const nodeTests = [
  'cloud-recovery', 'general-settings-main', 'energy-orb', 'orb-performance',
  'performance-main', 'system-settings-main', 'power-lifecycle', 'account-service-native',
];
const electronTests = [
  'app-theme-native', 'app-theme-ui', 'auto-dictionary-ui', 'capture-ui', 'changelog-ui',
  'dashboard-performance-ui', 'flow-animation-lifecycle-ui', 'flow-bar-audio-ui',
  'flow-bar-main', 'flow-bar-ui', 'flow-frame-recovery-main', 'flow-motion-overlay-ui',
  'flow-motion-preference-ui', 'flow-styles-ui', 'history-retention-ui', 'history-ui',
  'island-flow-ui', 'media-ui', 'notifications-ui', 'onboarding-ui', 'packaged-startup',
  'performance-native', 'polish-ui', 'recovery-ui', 'refinement-ui', 'release-ui',
  'speech-ui', 'system-settings-native', 'system-settings-overlay-ui', 'system-settings-ui',
  'voice-profile-appearance', 'waveform-ui',
];
const commands = [
  ...nodeTests.map(name => [process.execPath, name, []]),
  ...electronTests.map(name => [require('electron'), name, []]),
  [require('electron'), 'refinement-ui', ['--white']],
  [require('electron'), 'packaged-startup', ['--existing-profile']],
  [require('electron'), 'permission-boundary', ['--native']],
];
const results = [];
for (const [executable, name, flags] of commands) {
  const label = name + (flags.length ? '-' + flags.join('-').replace(/^-+/, '') : '');
  const started = Date.now();
  const result = spawnSync(executable, [path.join(root, 'scripts', 'test-' + name + '.js'), ...flags], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  });
  const log = (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.stack : '');
  fs.writeFileSync(path.join(output, label + '.log'), log);
  const entry = { name: label, status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status, signal: result.signal, durationMs: Date.now() - started,
    skips: log.split(/\r?\n/).filter(line => /\bskip(?:ped|ping)?\b/i.test(line)) };
  results.push(entry);
  console.log(entry.status.toUpperCase(), label, (entry.durationMs / 1000).toFixed(1) + 's');
  if (entry.status === 'failed') console.error(log.split(/\r?\n/).slice(-30).join('\n'));
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
const failed = results.filter(item => item.status === 'failed').length;
console.log(`Desktop readiness: ${results.length - failed}/${results.length} passed; see ${output}`);
process.exitCode = failed ? 1 : 0;
