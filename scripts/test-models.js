'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const models = require('../src/models');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-models-'));
const tunedDir = path.join(root, models.TUNED_MODEL_DIR);

function writeModel(files) {
  fs.mkdirSync(tunedDir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(tunedDir, name), 'x');
}

// --- nothing installed --------------------------------------------------

check('no tuned model found', models.tunedModelInfo(root), null);
check('falls back to the stock model', models.resolveModel(root, {}, {}), 'large-v3');
check('not using a tuned model', models.usingTunedModel(root, {}, {}), false);
check('a missing models dir is safe', models.tunedModelInfo(null), null);

// --- a half-finished conversion must not be picked up --------------------

writeModel(['model.bin']);
check('partial conversion is ignored', models.tunedModelInfo(root), null);
check('partial conversion does not win', models.resolveModel(root, {}, {}), 'large-v3');

// --- a complete conversion ----------------------------------------------

writeModel(models.REQUIRED_FILES);
const info = models.tunedModelInfo(root);
check('complete conversion is found', Boolean(info), true);
check('reports the directory', info.path, tunedDir);
check('reports a build time', info.builtAt > 0, true);

check('a tuned model is preferred', models.resolveModel(root, {}, {}), tunedDir);
check('and is reported as in use', models.usingTunedModel(root, {}, {}), true);

// --- the setting --------------------------------------------------------

check(
  'the setting can turn it off',
  models.resolveModel(root, { useTunedModel: false }, {}),
  'large-v3'
);
check(
  'turned off is not in use',
  models.usingTunedModel(root, { useTunedModel: false }, {}),
  false
);
check(
  'an absent setting means on',
  models.resolveModel(root, { soundsEnabled: true }, {}),
  tunedDir
);

// --- the environment override -------------------------------------------

check(
  'VOXDEN_MODEL beats the tuned model',
  models.resolveModel(root, {}, { VOXDEN_MODEL: 'medium' }),
  'medium'
);
check(
  'an override is not reported as tuned',
  models.usingTunedModel(root, {}, { VOXDEN_MODEL: 'medium' }),
  false
);
check(
  'an override pointing at the tuned dir still counts',
  models.usingTunedModel(root, { useTunedModel: false }, { VOXDEN_MODEL: tunedDir }),
  true
);

// --- the model Voxden hosts itself ------------------------------------------
const hosted = path.join(root, 'hosted', 'whisper-large-v3');
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-models-'));

check('the hosted model is used when nothing else applies', models.resolveModel(bare, {}, {}, hosted), hosted);
check('without a hosted model the bare name is used', models.resolveModel(bare, {}, {}, null), 'large-v3');
check('a personal fine-tune outranks the hosted model', models.resolveModel(root, { useTunedModel: true }, {}, hosted), tunedDir);
check('the hosted model is used when the fine-tune is off', models.resolveModel(root, { useTunedModel: false }, {}, hosted), hosted);
check('VOXDEN_MODEL still beats the hosted model', models.resolveModel(root, {}, { VOXDEN_MODEL: 'medium.en' }, hosted), 'medium.en');
check('the hosted model is not reported as tuned', models.usingTunedModel(root, { useTunedModel: false }, {}, hosted), false);

fs.rmSync(bare, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all model tests passed');
