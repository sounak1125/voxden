'use strict';
// Opt-in integration check: installs actual models under temp/, then exercises
// every backend with network access disabled. Never touches user's receipts.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { AsrRuntimeManager } = require('../src/asr-runtime');
const { AsrModelManager } = require('../src/asr-model');
const { SpeechModelsManager } = require('../src/speech-models');
const run = promisify(execFile);

async function main() {
  const root = path.resolve(__dirname, '../temp/speech-smoke');
  const cacheRoot = path.join(process.env.APPDATA, 'Voxden', 'models');
  let last = '';
  const progress = state => {
    const key = state.message + ':' + Math.floor((state.progress || 0) / 10);
    if (key !== last) { last = key; console.log(state.message, state.progress + '%'); }
  };
  const runtime = new AsrRuntimeManager({ root: path.join(root, 'asr-runtime'),
    bundledRoot: path.resolve(__dirname, '../dist-runtime-v3'), onProgress: progress });
  const whisper = new AsrModelManager({ root: path.join(root, 'asr-models'), cacheRoot, onProgress: progress });
  const extras = new SpeechModelsManager({ root: path.join(root, 'asr-models/extras'), cacheRoot, onProgress: progress });
  await runtime.install();
  await whisper.install();
  await extras.install();
  const sample = path.join(root, 'speech.wav');
  if (!fs.existsSync(sample)) {
    const response = await fetch('https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_en.wav');
    if (!response.ok) throw new Error('Could not obtain public speech sample');
    fs.writeFileSync(sample, Buffer.from(await response.arrayBuffer()));
  }
  for (const engine of ['whisper', 'qwen3-asr', 'parakeet']) {
    const env = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PATH: path.join(process.env.SystemRoot, 'System32'),
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', VOXDEN_OFFLINE: '1', HF_HUB_DISABLE_XET: '1',
      HF_HOME: path.join(root, 'empty-hub'), VOXDEN_MODEL_DIR: path.join(root, 'models'),
      VOXDEN_MODEL: whisper.installed().path, VOXDEN_DEVICE: engine === 'qwen3-asr' ? 'cuda' : 'cpu',
      VOXDEN_TORCH_DEVICE: 'cpu', VOXDEN_ASR_ENGINE: engine,
      VOXDEN_QWEN_ASR_MODEL: extras.directory('qwen3-asr'),
      VOXDEN_PARAKEET_INT8_DIR: extras.directory('parakeet'),
      VOXDEN_PARAKEET_FP32_DIR: extras.directory('parakeet-fp32') };
    const code = [
      'import sys, json',
      'sys.path.insert(0, ' + JSON.stringify(path.resolve(__dirname, '../sidecar')) + ')',
      'import transcribe as t',
      'b = t.load_selected_backend()',
      'produced = b.transcribe(' + JSON.stringify(sample) + ', prompt="Voxden", language="en")',
      'record = produced if isinstance(produced, dict) else {"text": produced, "engine": t._runtime.get("engine"), "vocabulary": ""}',
      'text = str(record.get("text") or "").strip()',
      'assert text, "empty transcript"',
      'runtime_engine = t._runtime.get("engine")',
      'actual = record.get("engine") or runtime_engine',
      'print(json.dumps({"runtime": runtime_engine, "engine": actual, "vocabulary": record.get("vocabulary") or "", "chars": len(text)}))',
    ].join('; ');
    const result = await run(runtime.installed().pythonPath, ['-I', '-c', code], { env, timeout: 300000, windowsHide: true });
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    const expectedRuntime = engine === 'whisper' ? 'faster-whisper' : engine;
    if (parsed.runtime !== expectedRuntime) {
      throw new Error('Silent fallback to ' + parsed.runtime + ': ' + result.stdout);
    }
    if (engine !== 'whisper' && parsed.engine !== engine) {
      throw new Error('Sidecar reported ' + parsed.engine + ' instead of ' + engine);
    }
    if (engine === 'qwen3-asr' && parsed.vocabulary !== 'context') {
      throw new Error('Qwen did not honour context=: ' + JSON.stringify(parsed));
    }
    if (engine === 'parakeet' && parsed.vocabulary !== 'unsupported') {
      throw new Error('Parakeet pretended to accept vocabulary: ' + JSON.stringify(parsed));
    }
    if (engine === 'whisper' && parsed.vocabulary !== 'initial_prompt') {
      throw new Error('Whisper did not honour initial_prompt: ' + JSON.stringify(parsed));
    }
    console.log('OFFLINE TRANSCRIPTION', JSON.stringify(parsed));
  }
  console.log('Complete speech setup and all offline engine smoke checks passed:', root);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
