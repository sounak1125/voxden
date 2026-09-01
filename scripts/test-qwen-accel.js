'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const accel = require('../src/qwen-accel');
const caps = require('../src/asr-capabilities');
const vocab = require('../src/vocabulary');
const asr = require('../src/asr');

const NVIDIA = { vendorId: 4318, deviceName: 'NVIDIA GeForce RTX 4070', driverVersion: '572.16' };
const AMD_7900_XTX = { vendorId: 4098, deviceName: 'AMD Radeon RX 7900 XTX', driverVersion: '32.0.2.2002' };
const AMD_7900_XT = { vendorId: 4098, deviceName: 'AMD Radeon RX 7900 XT', driverVersion: '32.0.2.2002' };
const AMD_7800 = { vendorId: 4098, deviceName: 'AMD Radeon RX 7800 XT', driverVersion: '32.0.2.2002' };
const INTEL = { vendorId: 32902, deviceName: 'Intel Arc A770', driverVersion: '31.0.101' };

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

eq('nvidia vendor from gpu name helper', accel.gpuNameOf(NVIDIA), 'NVIDIA GeForce RTX 4070');
eq('7900 XTX is on the Windows ROCm list', accel.matchAmdProduct('AMD Radeon RX 7900 XTX').id, 'rx-7900-xtx');
eq('9070 XT is on the Windows ROCm list', accel.matchAmdProduct('Radeon RX 9070 XT').id, 'rx-9070-xt');
ok('7900 XT is not on the Windows ROCm list', !accel.matchAmdProduct('AMD Radeon RX 7900 XT'));
ok('7800 XT is explicitly unsupported', !!accel.matchUnsupportedAmd('AMD Radeon RX 7800 XT'));
ok('Windows 11 is build 22000+', accel.isWindows11('10.0.22631'));
ok('Windows 10 is not Windows 11', !accel.isWindows11('10.0.19045'));

function resolve(overrides) {
  return accel.resolve(Object.assign({
    platform: 'win32',
    windowsRelease: '10.0.22631',
    engine: 'qwen3-asr',
    device: 'auto',
    language: 'en',
    cudaPack: { installed: false, healthy: false, verified: false },
    rocmPack: { installed: false, healthy: false, verified: false },
  }, overrides));
}

eq('1. NVIDIA without pack stays CPU and offers CUDA', resolve({ devices: [NVIDIA] }).backend, 'cpu');
eq('1b. NVIDIA without pack recommends cuda', resolve({ devices: [NVIDIA] }).recommendedPack, 'cuda');
eq('1c. NVIDIA without pack is an offer', resolve({ devices: [NVIDIA] }).uiStatus, 'offer');

const nvidiaReady = resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: true },
  sidecar: { backend: 'cuda', probePassed: true, initPassed: true, computeType: 'float16' },
});
eq('2. NVIDIA + healthy CUDA pack + sidecar probe is cuda', nvidiaReady.backend, 'cuda');
ok('2b. and it is verified', nvidiaReady.verified);
eq('2c. UI label is Qwen CUDA acceleration', nvidiaReady.uiLabel, 'Qwen CUDA acceleration');

const nvidiaBf16 = resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: true },
  sidecar: { backend: 'cuda', probePassed: true, initPassed: true, computeType: 'bfloat16', bf16: true },
});
eq('18. CUDA BF16 is selected when the sidecar reports it', nvidiaBf16.computeType, 'bfloat16');
eq('17. CUDA FP16 is the default verified compute type', nvidiaReady.computeType, 'float16');

const amdReady = resolve({
  devices: [AMD_7900_XTX],
  rocmPack: { installed: true, healthy: true, verified: true },
  sidecar: { backend: 'rocm', probePassed: true, initPassed: true, computeType: 'float16' },
});
eq('3. supported AMD + healthy ROCm pack + sidecar probe is rocm', amdReady.backend, 'rocm');
eq('19. ROCm uses FP16', amdReady.computeType, 'float16');
eq('3b. UI label is Qwen ROCm acceleration', amdReady.uiLabel, 'Qwen ROCm acceleration');

eq('4. unsupported AMD 7900 XT stays CPU', resolve({ devices: [AMD_7900_XT] }).backend, 'cpu');
ok('4b. and says the GPU is not on AMD’s list', /not on AMD/i.test(resolve({ devices: [AMD_7900_XT] }).reason));
eq('4c. 7800 XT is unsupported', resolve({ devices: [AMD_7800] }).uiStatus, 'unsupported');
ok('4d. DirectML is not claimed as Qwen acceleration', !/DirectML is a Qwen/i.test(resolve({ devices: [AMD_7800] }).reason));

eq('5. Intel stays CPU Qwen', resolve({ devices: [INTEL] }).backend, 'cpu');
ok('5b. Intel reason names CPU Qwen', /CPU Qwen/.test(resolve({ devices: [INTEL] }).reason));
eq('6. no GPU stays CPU', resolve({ devices: [] }).backend, 'cpu');
eq('6b. no GPU hides the Qwen card', resolve({ devices: [] }).uiStatus, 'hidden');

eq('7. missing CUDA pack does not use pack python', resolve({ devices: [NVIDIA] }).usePackPython, false);
eq('8. valid CUDA pack uses pack python before sidecar verify', resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: false },
}).usePackPython, true);
eq('8b. but backend stays CPU until sidecar verifies', resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: false },
}).backend, 'cpu');
ok('10. invalid CUDA receipt is not healthy', resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: false, verified: false, failureReason: 'invalid receipt' },
}).uiStatus === 'fallback');
eq('9. valid ROCm pack on listed GPU uses pack python', resolve({
  devices: [AMD_7900_XTX],
  rocmPack: { installed: true, healthy: true, verified: false },
}).usePackPython, true);

eq('16. actual device is sidecar backend, not the dropdown', nvidiaReady.backend, 'cuda');
eq('16b. selecting GPU without a pack does not become cuda', resolve({
  devices: [NVIDIA],
  device: 'cuda',
}).backend, 'cpu');

eq('20. CUDA init failure session guard stays CPU', resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: true },
  sessionFailure: { backend: 'cuda', reason: 'init failed' },
}).backend, 'cpu');
eq('21. ROCm init failure session guard stays CPU', resolve({
  devices: [AMD_7900_XTX],
  rocmPack: { installed: true, healthy: true, verified: true },
  sessionFailure: { backend: 'rocm', reason: 'init failed' },
}).backend, 'cpu');
eq('22. simulated OOM session guard stays CPU', resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: true },
  sidecar: { backend: 'cuda', probePassed: true, initPassed: true },
  sessionFailure: { backend: 'cuda', reason: 'CUDA out of memory' },
}).backend, 'cpu');
ok('23. session guard exposes the fallback reason', /out of memory/i.test(resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: true },
  sessionFailure: { backend: 'cuda', reason: 'CUDA out of memory' },
}).fallbackReason));

eq('CPU setting forces CPU even with a healthy pack', resolve({
  devices: [NVIDIA],
  device: 'cpu',
  cudaPack: { installed: true, healthy: true, verified: true },
  sidecar: { backend: 'cuda', probePassed: true, initPassed: true },
}).backend, 'cpu');

ok('Windows 10 AMD cannot use ROCm', resolve({
  devices: [AMD_7900_XTX],
  windowsRelease: '10.0.19045',
  rocmPack: { installed: true, healthy: true, verified: true },
}).backend === 'cpu');

const terms = [
  vocab.makeEntry('Voxden', { aliases: ['vox den'], language: 'en' }),
  vocab.makeEntry('नमस्ते', { aliases: ['namaste'], language: 'hi' }),
  vocab.makeEntry('Café', { aliases: ['cafe'], language: 'en' }),
];
const cpuCtx = vocab.contextFor(terms, { engine: 'qwen3-asr', language: 'en' });
const cudaCtx = vocab.contextFor(terms, { engine: 'qwen3-asr', language: 'en' });
const rocmCtx = vocab.contextFor(terms, { engine: 'qwen3-asr', language: 'en' });
eq('25. CPU/CUDA/ROCm context strings are identical', cpuCtx.text, cudaCtx.text);
eq('25b. ROCm matches CPU context', cpuCtx.text, rocmCtx.text);
ok('28. Unicode terms reach context', cpuCtx.text.includes('नमस्ते') && cpuCtx.text.includes('Café'));
ok('29. aliases are not put in the model context', !cpuCtx.text.toLowerCase().includes('vox den'));
eq('25c. context mechanism is context', cpuCtx.mechanism, 'context');

const newest = vocab.makeEntry('BrandNewToken', { language: 'en', updatedAt: Date.now() });
const ranked = vocab.rank(terms.concat([newest]), {
  language: 'en',
  recentTerms: new Set(['brandnewtoken']),
});
const nextCtx = vocab.contextFor(ranked, { engine: 'qwen3-asr', language: 'en' });
ok('26. a newly added word is in the next context', nextCtx.text.includes('BrandNewToken'));

const qwenAuto = caps.planRoute({
  engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'en', quality: 'accurate',
  termCount: 3, requireInModelVocabulary: true, device: 'cpu',
});
eq('31. Qwen Auto/Accurate with dictionary stays Qwen', qwenAuto.engine, 'qwen3-asr');
const qwenAccurate = caps.planRoute({
  engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'en', quality: 'accurate',
  termCount: 12, requireInModelVocabulary: true, device: 'cpu',
});
eq('32. Qwen Accurate with dictionary stays Qwen', qwenAccurate.engine, 'qwen3-asr');
eq('33. Hindi never uses Parakeet', caps.planRoute({
  engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'hi', quality: 'fast', termCount: 0,
}).engine, 'qwen3-asr');
eq('34. explicit Fast English still uses Parakeet', caps.planRoute({
  engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'en', quality: 'fast',
  termCount: 0, requireInModelVocabulary: false,
}).engine, 'parakeet');

ok('35. Whisper still has a CPU path in capabilities', caps.supportsLanguage('whisper', 'en'));
ok('36. Whisper CUDA is still a device the UI can select', asr.normalizeAsrDevice('cuda') === 'cuda');
ok('37. Parakeet remains English-only', caps.supportsLanguage('parakeet', 'en') && !caps.supportsLanguage('parakeet', 'hi'));
eq('38. Parakeet DirectML is still a selectable processor', asr.normalizeAsrDevice('directml'), 'directml');
eq('rocm is not a user-facing processor setting', asr.normalizeAsrDevice('rocm'), 'auto');
eq('deviceLabel reports verified ROCm honestly', asr.deviceLabel('rocm'), 'supported AMD GPU');

ok('shouldUseAccelPython only for Qwen', !accel.shouldUseAccelPython(nvidiaReady, 'whisper'));
ok('shouldUseAccelPython for verified CUDA Qwen', accel.shouldUseAccelPython({
  usePackPython: true, recommendedPack: 'cuda',
}, 'qwen3-asr'));

const installedUnverified = resolve({
  devices: [NVIDIA],
  cudaPack: { installed: true, healthy: true, verified: false },
});
eq('46. UI is not verified before the sidecar reports CUDA', installedUnverified.verified, false);
eq('46b. uiStatus is installed, not verified', installedUnverified.uiStatus, 'installed');
eq('46c. the label stays CPU Qwen until verification', installedUnverified.uiLabel, 'CPU Qwen');
ok('46d. the reason does not claim GPU execution', !/is active/i.test(installedUnverified.reason));

const diag = accel.sidecarDiagnostics({
  backend: 'cuda', compute_type: 'bfloat16', gpu_name: 'NVIDIA GeForce RTX 4070',
  gpu_arch: 'sm_89', torch_version: '2.11.0+cu128', pack_id: 'qwen-cuda-win-x64-v1',
  probe_passed: true, init_passed: true, fallback_reason: '',
  audio_sec: 4.2, recognition_sec: 0.9, rtf: 0.214, context_sha256: 'abc',
});
eq('45. history records the actual backend', diag.backend, 'cuda');
eq('45b. history records compute type', diag.computeType, 'bfloat16');
eq('45c. history records GPU name', diag.gpuName, 'NVIDIA GeForce RTX 4070');
eq('45d. CPU fallback reason survives an empty GPU report', accel.sidecarDiagnostics({
  backend: 'cpu', fallback_reason: 'CUDA out of memory',
}).fallbackReason, 'CUDA out of memory');

const persisted = vocab.makeEntry('PersistMe', { language: 'en' });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-dict-'));
const dictFile = path.join(tmpDir, 'dictionary.json');
vocab.saveState(dictFile, {
  entries: [persisted],
  phrases: [{ from: 'PersistMe', to: 'PersistMe' }],
});
const loaded = vocab.loadState(dictFile);
ok('27. dictionary entries survive save/load (app restart)', loaded.entries.some((e) => e.canonical === 'PersistMe'));
fs.rmSync(tmpDir, { recursive: true, force: true });

const applied = vocab.applyEntries('I saw a surface nearby', [vocab.makeEntry('Voxden')], { language: 'en' });
eq('30. a similar-sounding non-dictionary word is not replaced', applied.text, 'I saw a surface nearby');
eq('30b. no false insertion hits', applied.hits, 0);

const hiRanked = vocab.rank(terms, { language: 'hi' });
ok('28b. Hindi dictation keeps Devanagari terms', hiRanked.some((e) => e.canonical === 'नमस्ते'));

const devData = path.join(__dirname, '..', 'data');
const installedData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Voxden', 'data');
ok('39. development and installed profiles are isolated',
  path.normalize(devData).toLowerCase() !== path.normalize(installedData).toLowerCase());

process.stdout.write(checks + ' qwen accel resolver checks passed\n');
