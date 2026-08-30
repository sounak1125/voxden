'use strict';

// Which Whisper model the sidecar should load.
//
// A fine-tune produced by training/finetune.py lands in models/voxden-tuned as
// a CTranslate2 directory. faster-whisper accepts a directory path anywhere it
// accepts a model name, so switching between the stock model and a personal one
// is purely a matter of what string goes into VOXDEN_MODEL.

const fs = require('fs');
const path = require('path');

const TUNED_MODEL_DIR = 'voxden-tuned';
const DEFAULT_MODEL = 'large-v3';

// A converted model is only usable once every file faster-whisper opens is
// present. A half-finished conversion must not be picked up.
const REQUIRED_FILES = ['model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json'];

function tunedModelInfo(modelsDir) {
  if (!modelsDir) return null;
  const dir = path.join(modelsDir, TUNED_MODEL_DIR);
  let weights = null;
  for (const name of REQUIRED_FILES) {
    let stat = null;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch (_) {
      return null;
    }
    if (name === 'model.bin') weights = stat;
  }
  return { path: dir, builtAt: weights.mtimeMs, bytes: weights.size };
}

// `hostedPath` is the model Voxden downloaded from its own release. It ranks
// below a personal fine-tune, which the user opted into, and above the bare
// model name, which sends faster-whisper to Hugging Face -- so a hosted model
// is used when present and nothing breaks when it is not.
function resolveModel(modelsDir, settings, env, hostedPath) {
  const override = (env || {}).VOXDEN_MODEL;
  if (override) return override;
  const tuned = tunedModelInfo(modelsDir);
  if (tuned && (settings || {}).useTunedModel !== false) return tuned.path;
  if (hostedPath) return hostedPath;
  return DEFAULT_MODEL;
}

function usingTunedModel(modelsDir, settings, env, hostedPath) {
  const tuned = tunedModelInfo(modelsDir);
  return Boolean(tuned) && resolveModel(modelsDir, settings, env, hostedPath) === tuned.path;
}

module.exports = {
  TUNED_MODEL_DIR,
  DEFAULT_MODEL,
  REQUIRED_FILES,
  tunedModelInfo,
  resolveModel,
  usingTunedModel,
};
