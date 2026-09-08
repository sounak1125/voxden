'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizePreference, createController } = require('../src/flow-motion');

function fixture(reduced) {
  const subscribers = new Set();
  const media = {
    matches: reduced,
    addEventListener(type, callback) {
      assert.strictEqual(type, 'change');
      subscribers.add(callback);
    },
  };
  const element = { dataset: {} };
  return {
    media, element,
    setSystemReduced(value) {
      media.matches = value;
      for (const callback of subscribers) callback({ matches: value });
    },
  };
}

assert.strictEqual(normalizePreference('full'), 'full');
assert.strictEqual(normalizePreference('reduced'), 'reduced');
for (const value of ['system', undefined, null, '', 'always', 'FULL', true, 0, {}]) {
  assert.strictEqual(normalizePreference(value), 'system', 'unknown or missing saved values follow Windows');
}

for (const initialSystemReduced of [false, true]) {
  const environment = fixture(initialSystemReduced);
  const controller = createController(environment.media, environment.element);
  assert.strictEqual(controller.preference, 'system', 'existing installs retain the accessibility preference');
  assert.strictEqual(controller.systemReduced, initialSystemReduced);
  assert.strictEqual(controller.matches, initialSystemReduced);
  assert.strictEqual(environment.element.dataset.flowMotion, initialSystemReduced ? 'reduced' : 'full');

  const changes = [];
  const observe = function (event) {
    assert.strictEqual(this, controller);
    assert.strictEqual(event.target, controller);
    assert.strictEqual(event.type, 'change');
    assert.strictEqual(environment.element.dataset.flowMotion, event.matches ? 'reduced' : 'full',
      'CSS is updated before Canvas and settings listeners');
    changes.push({ matches: event.matches, preference: event.preference, systemReduced: event.systemReduced });
  };
  controller.addEventListener('change', observe);
  controller.addEventListener('change', observe);
  controller.setPreference('full');
  assert.strictEqual(controller.matches, false, 'explicit animation works even when Windows disables effects');
  assert.strictEqual(environment.element.dataset.flowMotion, 'full');
  assert.strictEqual(changes.length, 1, 're-registering one handler does not notify twice');
  controller.setPreference('full');
  assert.strictEqual(changes.length, 1, 'snapshots containing the unchanged choice do not restart animation');

  environment.setSystemReduced(!initialSystemReduced);
  assert.strictEqual(changes.length, 2, 'Windows changes update the explanation even while overridden');
  assert.strictEqual(controller.matches, false, 'Windows changes preserve an explicit animation choice');
  assert.strictEqual(controller.systemReduced, !initialSystemReduced);
  environment.setSystemReduced(!initialSystemReduced);
  assert.strictEqual(changes.length, 2, 'duplicate Windows events do not restart animation');

  controller.setPreference('reduced');
  assert.strictEqual(controller.matches, true, 'explicit reduced motion works even with Windows effects enabled');
  assert.strictEqual(environment.element.dataset.flowMotion, 'reduced');
  controller.setPreference('invalid');
  assert.strictEqual(controller.preference, 'system');
  assert.strictEqual(controller.matches, !initialSystemReduced, 'returning to System uses the current OS preference');
  environment.setSystemReduced(initialSystemReduced);
  assert.strictEqual(controller.matches, initialSystemReduced, 'System continues following changes');

  controller.removeEventListener('change', observe);
  const count = changes.length;
  controller.setPreference('full');
  assert.strictEqual(changes.length, count, 'preview teardown can unsubscribe');
  let objectNotifications = 0;
  const objectListener = { handleEvent() { objectNotifications++; } };
  controller.addEventListener('change', objectListener);
  controller.setPreference('reduced');
  controller.removeEventListener('change', objectListener);
  controller.setPreference('system');
  assert.strictEqual(objectNotifications, 1, 'listener objects follow the event target contract');
}

const environment = fixture(true);
const browser = { document: { documentElement: environment.element }, matchMedia(query) {
  assert.strictEqual(query, '(prefers-reduced-motion: reduce)');
  return environment.media;
} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/flow-motion.js'), 'utf8'), { window: browser });
assert.ok(browser.VoxdenFlowMotion, 'a head script creates the shared browser controller');
assert.strictEqual(environment.element.dataset.flowMotion, 'reduced', 'CSS receives the OS preference before first paint');
browser.VoxdenFlowMotion.setPreference('full');
assert.strictEqual(environment.element.dataset.flowMotion, 'full');

console.log('Flow motion: safe migration, Windows defaults and runtime changes, explicit overrides, synchronized CSS/Canvas state, listener lifecycle and early browser bootstrap passed.');
