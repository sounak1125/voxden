'use strict';

// What a machine can do about GPU dictation, and what it costs to get there.
//
// The three vendors are not symmetric, and flattening them would be the lie.
// NVIDIA needs a download: CTranslate2 wants cuBLAS, and no Voxden runtime has
// ever carried it, so Whisper falls to the CPU on every machine that has not
// installed CUDA itself. AMD and Intel need nothing downloaded -- DirectML is
// already in the base runtime -- but they can only accelerate Parakeet,
// because CTranslate2 has no backend for them and PyTorch has no ROCm wheel
// for Windows.
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
});

const VENDOR_LABELS = Object.freeze({
  nvidia: 'NVIDIA GPU',
  amd: 'AMD GPU',
  intel: 'Intel GPU',
});

// Best first. NVIDIA outranks the rest because it is the only one that can
// carry Whisper, which is a 22x difference rather than a marginal one; a
// laptop with an Intel iGPU beside a GeForce should be planning for the
// GeForce. Intel comes last because an integrated part is the one most likely
// to lose to the CPU it shares a die with.
const VENDOR_ORDER = Object.freeze(['nvidia', 'amd', 'intel']);

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
// already on disk, which only changes the NVIDIA answer.
function gpuPlan(devices, packInstalled) {
  const vendors = vendorsPresent(devices);
  const vendor = vendors[0] || '';
  if (!vendor) {
    return {
      vendor: '',
      vendors,
      label: '',
      device: 'cpu',
      needsPack: false,
      ready: false,
      accelerates: '',
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
      accelerates: 'Whisper and Parakeet',
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
