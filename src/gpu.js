'use strict';

// What a machine can do about GPU dictation, and what it costs to get there.
//
// The three vendors are not symmetric, and flattening them would be the lie.
// NVIDIA needs a download: CTranslate2 wants cuBLAS, and no Voxden runtime has
// ever carried it, so Whisper falls to the CPU on every machine that has not
// installed CUDA itself. AMD and Intel need nothing downloaded -- DirectML is
// already in the base runtime -- but they can only accelerate Parakeet,
// because CTranslate2 has no backend for them. Qwen on AMD uses a separate
// Windows ROCm PyTorch pack, and only for GPUs on AMD's published list.
//
// What is symmetric is the shape of the answer, so the UI renders one thing:
// which card is here, which processor setting it wants, whether a download
// stands in the way, and which engines actually get faster.

// PCI vendor ids. These are what a GPU reports about itself, and the only
// identifier that survives a driver update or a marketing rename.
const VENDOR_IDS = Object.freeze({
  4318: 'nvidia',   // 0x10DE
  4098: 'amd',      // 0x1002
  4130: 'amd',      // 0x1022, on some integrated parts
  32902: 'intel',   // 0x8086
  4203: 'apple',    // 0x106B, the GPU on the same die as an Apple silicon CPU
});

const VENDOR_LABELS = Object.freeze({
  nvidia: 'NVIDIA GPU',
  amd: 'AMD GPU',
  intel: 'Intel GPU',
  apple: 'Apple silicon',
});

// Best first. NVIDIA outranks the rest because it is the only one that can
// carry Whisper, which is a 22x difference rather than a marginal one; a
// laptop with an Intel iGPU beside a GeForce should be planning for the
// GeForce. Intel comes last because an integrated part is the one most likely
// to lose to the CPU it shares a die with.
//
// Apple is ranked last of all, and never because it won: it is here so that a
// Mac's GPU is named rather than dropped, not so that it can be planned for.
// Nothing Voxden ships reaches it -- CTranslate2 has no Metal backend, ONNX
// Runtime's CoreML provider is not in the bundled build, and torch MPS is
// untested against these models -- so it is never a pack vendor and every
// Apple plan is a CPU plan.
const VENDOR_ORDER = Object.freeze(['nvidia', 'amd', 'intel', 'apple']);

function vendorOf(vendorId) {
  const id = Number(vendorId);
  return Object.prototype.hasOwnProperty.call(VENDOR_IDS, id) ? VENDOR_IDS[id] : '';
}

function vendorsPresent(devices) {
  const found = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    const vendor = vendorOf(device && device.vendorId);
    if (vendor && !found.includes(vendor)) found.push(vendor);
  }
  return VENDOR_ORDER.filter((vendor) => found.includes(vendor));
}

// The plan for this machine. `packInstalled` is whether the CUDA pack is
// already on disk, which only changes the NVIDIA answer. `platform` decides
// whether any of this is on offer at all: the packs are Windows builds --
// cuBLAS DLLs, a Windows CUDA PyTorch, a Windows ROCm PyTorch -- and there is
// no Mac equivalent of any of them to download.
function gpuPlan(devices, packInstalled, platform) {
  const os = String(platform === undefined ? process.platform : platform);
  // A Mac is a CPU machine as far as this build is concerned, whatever the
  // adapter list says. Answering from the platform rather than the device list
  // means the plan is the same on an M1 that reports its GPU and on one that
  // does not.
  if (os === 'darwin') {
    return {
      vendor: 'apple',
      vendors: ['apple'],
      label: VENDOR_LABELS.apple,
      device: 'cpu',
      needsPack: false,
      // Not ready, because there is nothing for a GPU to be ready for. The UI
      // reads this as "no acceleration here", which is the truth.
      ready: false,
      accelerates: '',
      packsOffered: false,
    };
  }
  // Only Windows has packs to fetch. Everything else gets the same plan with
  // the offer switched off, so a caller cannot start a download that has no
  // build behind it.
  const packsOffered = os === 'win32';
  const vendors = vendorsPresent(devices);
  // Apple silicon off darwin is not a configuration that exists; if an adapter
  // ever claims 0x106B here it is not something to plan around either, because
  // no pack and no runtime in this build can reach it.
  const vendor = vendors[0] === 'apple' ? '' : (vendors[0] || '');
  if (!vendor) {
    return {
      vendor: '',
      vendors,
      label: '',
      device: 'cpu',
      needsPack: false,
      ready: false,
      accelerates: '',
      packsOffered,
    };
  }
  if (vendor === 'nvidia') {
    return {
      vendor,
      vendors,
      label: VENDOR_LABELS[vendor],
      device: 'cuda',
      // The pack is the whole difference between a GeForce that dictates in
      // under half a second and one that has never been used at all.
      needsPack: !packInstalled,
      ready: !!packInstalled,
      // Whisper, and only Whisper.
      //
      // This said "Whisper and Parakeet", which is not true of anything Voxden
      // ships. The pack is two files -- cublas64_12.dll and cublasLt64_12.dll
      // -- and cuBLAS is what CTranslate2 wants. Parakeet goes through ONNX
      // Runtime, and the bundled build reports exactly
      // ['DmlExecutionProvider', 'CPUExecutionProvider']: there is no CUDA
      // execution provider for cuBLAS to serve. Qwen goes through PyTorch.
      // The bundled torch is 2.11.0+cpu; Qwen CUDA is a separate pack, not
      // this cuBLAS download. Telling an NVIDIA owner this download
      // accelerates their engines when it cannot is how somebody spends
      // 553 MB and gets nothing.
      accelerates: 'Whisper',
      packsOffered,
    };
  }
  return {
    vendor,
    vendors,
    label: VENDOR_LABELS[vendor],
    device: 'directml',
    // DirectML ships in the base runtime, so there is nothing to fetch. The
    // asymmetry is real and saying so is better than inventing a download to
    // make the three look alike.
    needsPack: false,
    ready: true,
    accelerates: 'Parakeet',
    packsOffered,
  };
}

module.exports = {
  VENDOR_IDS,
  VENDOR_LABELS,
  VENDOR_ORDER,
  vendorOf,
  vendorsPresent,
  gpuPlan,
};
