'use strict';

// What this PC can actually do for Qwen3-ASR 1.7B.
//
// The Whisper cuBLAS pack and Parakeet DirectML are different products. This
// file answers only Qwen: CUDA PyTorch on NVIDIA, native Windows ROCm PyTorch
// on AMD's published list, and CPU Qwen everywhere else. The UI setting is an
// input, never the result. The sidecar's probe is what may later confirm a
// GPU backend; until that happens the plan stays on CPU Qwen.
//
// AMD's Windows ROCm PyTorch list is short and official. Treating every
// DirectX 12 Radeon as supported would be a lie, and DirectML is not a Qwen
// production path here.

const os = require('os');
const gpu = require('./gpu');
const catalog = require('./qwen-accel-catalog.json');

const BACKENDS = Object.freeze(['cpu', 'cuda', 'rocm']);

const BACKEND_LABELS = Object.freeze({
  cpu: 'CPU Qwen',
  cuda: 'Qwen CUDA acceleration',
  rocm: 'Qwen ROCm acceleration',
});

const COMPUTE_TYPES = Object.freeze({
  cpu: 'float32',
  cuda: 'float16',
  cudaBf16: 'bfloat16',
  rocm: 'float16',
});

// AMD Software: PyTorch on Windows Edition 7.2.1, 26 March 2026.
// https://www.amd.com/en/resources/support-articles/release-notes/RN-AMDGPU-WINDOWS-PYTORCH-7-2-1.html
//
// Order is longest / most specific first so "9070 XT" does not become "9070"
// and "7900 XTX" does not become a generic 7900.
const AMD_ROCM_WINDOWS_PRODUCTS = Object.freeze([
  { id: 'rx-9070-xt', arch: 'gfx1201', re: /radeon\s+(?:rx\s+)?9070\s+xt\b/i, name: 'AMD Radeon RX 9070 XT' },
  { id: 'rx-9070', arch: 'gfx1201', re: /radeon\s+(?:rx\s+)?9070\b/i, name: 'AMD Radeon RX 9070' },
  { id: 'r9700', arch: 'gfx1201', re: /(?:ai\s+pro\s+)?r9700\b/i, name: 'AMD Radeon AI PRO R9700' },
  { id: 'rx-9060-xt', arch: 'gfx1200', re: /radeon\s+(?:rx\s+)?9060\s+xt\b/i, name: 'AMD Radeon RX 9060 XT' },
  { id: 'rx-7900-xtx', arch: 'gfx1100', re: /radeon\s+(?:rx\s+)?7900\s+xtx\b/i, name: 'AMD Radeon RX 7900 XTX' },
  { id: 'w7900-dual', arch: 'gfx1100', re: /pro\s+w7900\s+dual/i, name: 'AMD Radeon PRO W7900 Dual Slot' },
  { id: 'w7900', arch: 'gfx1100', re: /pro\s+w7900\b/i, name: 'AMD Radeon PRO W7900' },
  { id: 'ai-max-395', arch: 'gfx1151', re: /ryzen\s+ai\s+max\+?\s*395\b/i, name: 'AMD Ryzen AI Max+ 395' },
  { id: 'ai-max-390', arch: 'gfx1151', re: /ryzen\s+ai\s+max\+?\s*390\b/i, name: 'AMD Ryzen AI Max 390' },
  { id: 'ai-max-385', arch: 'gfx1151', re: /ryzen\s+ai\s+max\+?\s*385\b/i, name: 'AMD Ryzen AI Max 385' },
  { id: 'ai-9-hx-475', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+hx\s+475\b/i, name: 'AMD Ryzen AI 9 HX 475' },
  { id: 'ai-9-hx-470', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+hx\s+470\b/i, name: 'AMD Ryzen AI 9 HX 470' },
  { id: 'ai-9-465', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+465\b/i, name: 'AMD Ryzen AI 9 465' },
  { id: 'ai-9-hx-375', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+hx\s+375\b/i, name: 'AMD Ryzen AI 9 HX 375' },
  { id: 'ai-9-hx-370', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+hx\s+370\b/i, name: 'AMD Ryzen AI 9 HX 370' },
  { id: 'ai-9-365', arch: 'gfx1151', re: /ryzen\s+ai\s+9\s+365\b/i, name: 'AMD Ryzen AI 9 365' },
]);

// Names that look like Radeon 7000-series parts AMD did not list for Windows
// ROCm PyTorch 7.2.1. Detected so the UI can say "unsupported" rather than
// "unknown".
const AMD_EXPLICITLY_UNSUPPORTED = Object.freeze([
  { re: /radeon\s+(?:rx\s+)?7900\s+xt\b/i, name: 'AMD Radeon RX 7900 XT' },
  { re: /radeon\s+(?:rx\s+)?7900\s+gre\b/i, name: 'AMD Radeon RX 7900 GRE' },
  { re: /radeon\s+(?:rx\s+)?7800/i, name: 'AMD Radeon RX 7800 series' },
  { re: /radeon\s+(?:rx\s+)?7700/i, name: 'AMD Radeon RX 7700 series' },
  { re: /radeon\s+(?:rx\s+)?7600/i, name: 'AMD Radeon RX 7600 series' },
  { re: /radeon\s+(?:rx\s+)?7500/i, name: 'AMD Radeon RX 7500 series' },
  { re: /radeon\s+(?:rx\s+)?6\d{3}/i, name: 'AMD Radeon RX 6000 series' },
  { re: /radeon\s+(?:rx\s+)?5\d{3}/i, name: 'AMD Radeon RX 5000 series' },
  { re: /vega|polaris|navy\s+flounder|sienna/i, name: 'legacy AMD GPU' },
]);

function catalogFor(kind) {
  const id = String(kind || '').trim().toLowerCase();
  return id === 'rocm' ? catalog.rocm : catalog.cuda;
}

function backendLabel(backend) {
  const id = String(backend || 'cpu').trim().toLowerCase();
  return BACKEND_LABELS[id] || BACKEND_LABELS.cpu;
}

function windowsBuild(release) {
  const parts = String(release == null ? os.release() : release).split('.');
  const build = Number(parts[2]);
  return Number.isFinite(build) ? build : 0;
}

function isWindows11(release) {
  return windowsBuild(release) >= 22000;
}

function gpuNameOf(device, renderer) {
  if (device && typeof device === 'object') {
    const named = device.deviceName || device.description || device.name || device.gpuDescription;
    if (named) return String(named).trim();
  }
  const text = String(renderer || '');
  const angle = /\(([^,]+),\s*([^,)]+)/.exec(text);
  if (angle) {
    return angle[2].replace(/\s+Direct3D.*$/i, '').replace(/\s+\(.*\)$/, '').trim();
  }
  return text.replace(/^ANGLE\s+/i, '').trim();
}

function primaryDevice(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const vendors = gpu.vendorsPresent(list);
  const vendor = vendors[0] || '';
  if (!vendor) return { vendor: '', device: null };
  const device = list.find((item) => gpu.vendorOf(item && item.vendorId) === vendor) || list[0] || null;
  return { vendor, device };
}

function matchAmdProduct(name) {
  const text = String(name || '');
  if (!text) return null;
  for (const product of AMD_ROCM_WINDOWS_PRODUCTS) {
    if (product.re.test(text)) return product;
  }
  return null;
}

function matchUnsupportedAmd(name) {
  const text = String(name || '');
  if (!text) return null;
  for (const item of AMD_EXPLICITLY_UNSUPPORTED) {
    if (item.re.test(text)) return item;
  }
  return null;
}

function parseDriverNumber(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const match = /(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]) || 0;
  const minor = Number(match[2]) || 0;
  return major + minor / 1000;
}

function nvidiaDriverOk(driverVersion, minDriver) {
  const have = parseDriverNumber(driverVersion);
  const need = parseDriverNumber(minDriver || catalog.cuda.minNvidiaDriver);
  if (!have || !need) return { ok: true, unknown: true };
  // Windows DCH versions look like 32.0.15.xxxx and are not comparable to
  // NVIDIA's 570.xx marketing number. Treat those as unknown and let the
  // sidecar probe decide.
  if (have > 0 && have < 100 && String(driverVersion).split('.').length >= 4) {
    return { ok: true, unknown: true };
  }
  return { ok: have + 1e-9 >= need, unknown: false };
}

function packSnapshot(kind, installed, healthy, verified) {
  const spec = catalogFor(kind);
  return {
    kind,
    id: spec.id,
    version: spec.version,
    downloadBytes: spec.downloadBytes,
    downloadSize: spec.downloadSize,
    installedSize: spec.installedSize,
    torch: spec.torch,
    python: spec.python,
    installed: !!installed,
    healthy: !!healthy,
    verified: !!verified,
  };
}

function emptyPlan(overrides) {
  return Object.assign({
    backend: 'cpu',
    selectedDevice: 'auto',
    vendor: '',
    vendors: [],
    gpuName: '',
    gpuArch: '',
    driverVersion: '',
    os: process.platform,
    windowsBuild: windowsBuild(),
    windows11: isWindows11(),
    supported: false,
    recommendedPack: '',
    pack: packSnapshot('cuda', false, false, false),
    rocmPack: packSnapshot('rocm', false, false, false),
    usePackPython: false,
    computeType: COMPUTE_TYPES.cpu,
    probePassed: false,
    initPassed: false,
    sessionBlocked: false,
    verified: false,
    reason: 'No supported Qwen accelerator on this PC.',
    fallbackReason: '',
    uiStatus: 'hidden',
    uiLabel: BACKEND_LABELS.cpu,
  }, overrides || {});
}

// The one resolver. Inputs are facts: OS, GPU, packs, probes, session state,
// the user's engine/device/language. The backend is never copied from the
// processor dropdown.
function resolve(options) {
  const opts = options || {};
  const selectedDevice = String(opts.device || 'auto').trim().toLowerCase();
  const engine = String(opts.engine || '').trim().toLowerCase();
  const language = String(opts.language || 'en').trim().toLowerCase();
  const platform = String(opts.platform || process.platform);
  const release = opts.windowsRelease;
  const devices = opts.devices || [];
  const renderer = opts.renderer || '';
  const { vendor, device } = primaryDevice(devices);
  const vendors = gpu.vendorsPresent(devices);
  const gpuName = gpuNameOf(device, renderer);
  const driverVersion = String((device && (device.driverVersion || device.driver)) || opts.driverVersion || '');
  const cudaPack = opts.cudaPack || {};
  const rocmPack = opts.rocmPack || {};
  const sessionFailure = opts.sessionFailure || null;
  const sidecar = opts.sidecar || {};
  const forceCpu = opts.forceCpu === true || selectedDevice === 'cpu';

  const base = emptyPlan({
    selectedDevice,
    vendor,
    vendors,
    gpuName,
    driverVersion,
    os: platform,
    windowsBuild: windowsBuild(release),
    windows11: isWindows11(release),
    pack: packSnapshot('cuda', cudaPack.installed, cudaPack.healthy, cudaPack.verified),
    rocmPack: packSnapshot('rocm', rocmPack.installed, rocmPack.healthy, rocmPack.verified),
  });

  const sessionBlocked = !!(sessionFailure && sessionFailure.backend && sessionFailure.backend !== 'cpu');
  base.sessionBlocked = sessionBlocked;

  const sidecarBackend = String(sidecar.backend || '').trim().toLowerCase();
  const sidecarVerified = sidecarBackend === 'cuda' || sidecarBackend === 'rocm';

  function cpu(reason, extra) {
    return Object.assign({}, base, {
      backend: 'cpu',
      usePackPython: false,
      computeType: COMPUTE_TYPES.cpu,
      verified: false,
      probePassed: false,
      initPassed: false,
      reason,
      fallbackReason: extra && extra.fallbackReason || (sessionBlocked ? String(sessionFailure.reason || '') : ''),
      uiLabel: BACKEND_LABELS.cpu,
    }, extra || {});
  }

  if (platform !== 'win32') {
    return cpu('Qwen GPU acceleration is packaged for Windows only.', { uiStatus: 'hidden' });
  }

  if (forceCpu) {
    return cpu('CPU Qwen was selected.', {
      uiStatus: vendor ? 'offer' : 'hidden',
      supported: vendor === 'nvidia' || !!matchAmdProduct(gpuName),
      recommendedPack: vendor === 'nvidia' ? 'cuda' : (matchAmdProduct(gpuName) ? 'rocm' : ''),
    });
  }

  if (sessionBlocked) {
    const blocked = String(sessionFailure.backend);
    const why = String(sessionFailure.reason || 'The GPU backend failed earlier in this session.');
    return cpu('CPU Qwen is in use because ' + backendLabel(blocked) + ' failed this session.', {
      fallbackReason: why,
      uiStatus: 'fallback',
      supported: true,
      recommendedPack: blocked === 'rocm' ? 'rocm' : 'cuda',
    });
  }

  if (vendor === 'nvidia') {
    const driver = nvidiaDriverOk(driverVersion, catalog.cuda.minNvidiaDriver);
    const vramMb = Number(opts.vramMb);
    const vramOk = !Number.isFinite(vramMb) || vramMb <= 0 || vramMb >= catalog.cuda.minVramMb;
    const hardwareOk = driver.ok && vramOk;
    base.supported = hardwareOk;
    base.recommendedPack = 'cuda';
    base.gpuArch = String(opts.gpuArch || '');

    if (!hardwareOk && !driver.unknown) {
      return cpu(
        'This NVIDIA driver is too old for the pinned CUDA PyTorch build. Qwen stays on CPU Qwen.',
        { uiStatus: 'unsupported', supported: false }
      );
    }
    if (!vramOk) {
      return cpu(
        'This NVIDIA GPU does not report enough VRAM for Qwen3-ASR 1.7B. Qwen stays on CPU Qwen.',
        { uiStatus: 'unsupported', supported: false }
      );
    }
    if (!cudaPack.installed) {
      return cpu(
        'NVIDIA GPU detected. Qwen CUDA acceleration is a separate download; without it Qwen3-ASR runs as CPU Qwen. The Whisper cuBLAS pack does not accelerate Qwen.',
        { uiStatus: 'offer', supported: true }
      );
    }
    if (cudaPack.installed && !cudaPack.healthy) {
      return cpu(
        'The Qwen CUDA pack is installed but not healthy. Qwen stays on CPU Qwen until it is repaired.',
        { uiStatus: 'fallback', fallbackReason: cudaPack.failureReason || 'invalid pack', supported: true }
      );
    }
    // Pack files are present. Still CPU in the plan until the sidecar reports
    // a real CUDA backend. usePackPython lets main.js start the isolated
    // interpreter so that probe can happen.
    const ready = sidecarVerified && sidecarBackend === 'cuda';
    if (ready) {
      const bf16 = sidecar.bf16 === true || sidecar.computeType === 'bfloat16';
      return Object.assign({}, base, {
        backend: 'cuda',
        usePackPython: true,
        computeType: bf16 ? COMPUTE_TYPES.cudaBf16 : COMPUTE_TYPES.cuda,
        verified: true,
        probePassed: sidecar.probePassed !== false,
        initPassed: sidecar.initPassed !== false,
        reason: 'Qwen CUDA acceleration is active on this NVIDIA GPU.',
        uiStatus: 'verified',
        uiLabel: BACKEND_LABELS.cuda,
      });
    }
    return Object.assign({}, base, {
      backend: 'cpu',
      usePackPython: true,
      computeType: COMPUTE_TYPES.cpu,
      verified: false,
      reason: 'Qwen CUDA acceleration is installed and will be used only after the sidecar verifies GPU execution.',
      uiStatus: cudaPack.verified ? 'installed' : 'installed',
      uiLabel: BACKEND_LABELS.cpu,
    });
  }

  if (vendor === 'amd') {
    const product = matchAmdProduct(gpuName);
    const rejected = matchUnsupportedAmd(gpuName);
    if (!isWindows11(release)) {
      return cpu(
        'Native Windows ROCm PyTorch requires Windows 11. This AMD GPU stays on CPU Qwen. DirectML still accelerates Parakeet only.',
        {
          uiStatus: 'unsupported',
          gpuArch: rejected ? '' : '',
        }
      );
    }
    if (!product) {
      const named = rejected ? rejected.name : (gpuName || 'this AMD GPU');
      return cpu(
        named
          + ' is not on AMD’s Windows ROCm PyTorch compatibility list, so Qwen3-ASR stays on CPU Qwen. DirectML still accelerates Parakeet only. Not every AMD GPU is supported.',
        { uiStatus: 'unsupported', gpuArch: '' }
      );
    }
    base.supported = true;
    base.recommendedPack = 'rocm';
    base.gpuArch = product.arch;
    if (!rocmPack.installed) {
      return cpu(
        product.name
          + ' can use Qwen ROCm acceleration, a separate download. Without it Qwen3-ASR runs as CPU Qwen. DirectML is not a Qwen path.',
        { uiStatus: 'offer', gpuArch: product.arch, supported: true }
      );
    }
    if (rocmPack.installed && !rocmPack.healthy) {
      return cpu(
        'The Qwen ROCm pack is installed but not healthy. Qwen stays on CPU Qwen until it is repaired.',
        {
          uiStatus: 'fallback',
          fallbackReason: rocmPack.failureReason || 'invalid pack',
          gpuArch: product.arch,
          supported: true,
        }
      );
    }
    const ready = sidecarVerified && sidecarBackend === 'rocm';
    if (ready) {
      return Object.assign({}, base, {
        backend: 'rocm',
        usePackPython: true,
        computeType: COMPUTE_TYPES.rocm,
        verified: true,
        probePassed: sidecar.probePassed !== false,
        initPassed: sidecar.initPassed !== false,
        reason: 'Qwen ROCm acceleration is active on ' + product.name + '.',
        uiStatus: 'verified',
        uiLabel: BACKEND_LABELS.rocm,
        gpuArch: product.arch,
      });
    }
    return Object.assign({}, base, {
      backend: 'cpu',
      usePackPython: true,
      computeType: COMPUTE_TYPES.cpu,
      verified: false,
      gpuArch: product.arch,
      reason: 'Qwen ROCm acceleration is installed and will be used only after the sidecar verifies GPU execution.',
      uiStatus: 'installed',
      uiLabel: BACKEND_LABELS.cpu,
    });
  }

  if (vendor === 'intel') {
    return cpu(
      'Intel GPUs have no Qwen PyTorch path in Voxden. Qwen3-ASR stays on CPU Qwen. DirectML still accelerates Parakeet only.',
      { uiStatus: 'unsupported' }
    );
  }

  return cpu('No supported GPU was detected. Qwen3-ASR runs as CPU Qwen.', { uiStatus: 'hidden' });
}

function shouldUseAccelPython(plan, engine) {
  const p = plan || {};
  if (String(engine || '').trim().toLowerCase() !== 'qwen3-asr') return false;
  return !!p.usePackPython && (p.recommendedPack === 'cuda' || p.recommendedPack === 'rocm');
}

function contextKey(text) {
  return String(text || '').normalize('NFC').trim();
}

function sidecarDiagnostics(msg) {
  const m = msg || {};
  const backend = String(m.backend || '').trim().toLowerCase();
  return {
    backend: backend === 'cuda' || backend === 'rocm' || backend === 'cpu' ? backend : String(m.backend || ''),
    computeType: String(m.compute_type || m.computeType || ''),
    gpuName: String(m.gpu_name || m.gpuName || ''),
    gpuArch: String(m.gpu_arch || m.gpuArch || ''),
    torchVersion: String(m.torch_version || m.torchVersion || ''),
    packId: String(m.pack_id || m.packId || ''),
    packVersion: String(m.pack_version || m.packVersion || ''),
    probePassed: !!(m.probe_passed || m.probePassed),
    initPassed: !!(m.init_passed || m.initPassed),
    fallbackReason: String(m.fallback_reason || m.fallbackReason || ''),
    audioSec: Number(m.audio_sec || m.audioSec) || 0,
    recognitionSec: Number(m.recognition_sec || m.recognitionSec) || 0,
    rtf: Number(m.rtf) || 0,
    contextSha256: String(m.context_sha256 || m.contextSha256 || ''),
    sdpa: String(m.sdpa || ''),
  };
}

module.exports = {
  BACKENDS,
  BACKEND_LABELS,
  COMPUTE_TYPES,
  AMD_ROCM_WINDOWS_PRODUCTS,
  AMD_EXPLICITLY_UNSUPPORTED,
  catalog,
  catalogFor,
  backendLabel,
  windowsBuild,
  isWindows11,
  gpuNameOf,
  matchAmdProduct,
  matchUnsupportedAmd,
  nvidiaDriverOk,
  resolve,
  shouldUseAccelPython,
  contextKey,
  sidecarDiagnostics,
};
