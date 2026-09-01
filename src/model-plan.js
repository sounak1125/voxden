'use strict';

// What this machine actually needs to download, and what is merely on offer.
//
// Setup used to be all-or-nothing: SpeechModelsManager.install() took no
// argument and fetched every pack that was not present, and setupDictation
// called it alongside the Whisper download unconditionally. A first-run user
// was told "up to 11.0 GB" before they had dictated a word, and most of it was
// insurance:
//
//   Whisper large-v3        3.10 GB   only if you pick Whisper
//   Qwen3-ASR 1.7B          4.70 GB   only if you pick Qwen
//   Parakeet TDT int8       0.66 GB   the CPU fast path
//   Parakeet TDT float32    2.51 GB   the DirectML fast path
//
// The two Parakeet packs are the same 0.6B model at two precisions and exactly
// one of them ever loads: parakeet_quantization() in the sidecar picks int8 on
// the CPU and float32 on a GPU. On the runtime Voxden ships -- ONNX Runtime's
// DirectML build -- there is no CUDA execution provider at all, so the float32
// weights are reachable only when the user has explicitly chosen the AMD or
// Intel processor. Fetching them on every install bought nothing.
//
// This module is the single answer to "what does this configuration need".
// It is pure: it takes the settings, the hardware, the sizes and what is
// already on disk, and returns a plan. Nothing here downloads anything.

const ENGINE_MODELS = Object.freeze({
  whisper: 'whisper',
  'qwen3-asr': 'qwen3-asr',
  // Resolved by device, because the two Parakeet packs are alternatives.
  parakeet: null,
});

const COMPONENTS = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper large-v3',
    manager: 'model',
    summary: 'Accurate fallback. Recognises every language Voxden offers.',
  }),
  'qwen3-asr': Object.freeze({
    id: 'qwen3-asr',
    name: 'Qwen3-ASR 1.7B',
    manager: 'speech',
    summary: 'Best with names and accents, and the strongest multilingual engine.',
  }),
  parakeet: Object.freeze({
    id: 'parakeet',
    name: 'Parakeet TDT 0.6B',
    manager: 'speech',
    summary: 'Fast English dictation on the CPU.',
  }),
  'parakeet-fp32': Object.freeze({
    id: 'parakeet-fp32',
    name: 'Parakeet TDT 0.6B (GPU)',
    manager: 'speech',
    summary: 'Fast English dictation on an AMD or Intel GPU.',
  }),
});

const COMPONENT_IDS = Object.freeze(Object.keys(COMPONENTS));

// Which Parakeet precision this configuration can actually load.
//
// Mirrors onnx_providers() and parakeet_quantization() in the sidecar: the
// float32 weights are used only when a non-CPU execution provider is chosen,
// and on the shipped DirectML runtime that means the user picked "AMD or Intel
// GPU" by hand. Anything else -- auto, CUDA on a runtime with no CUDA provider,
// or plain CPU -- loads the int8 build.
function parakeetPackFor(device) {
  return String(device || 'auto').trim().toLowerCase() === 'directml'
    ? 'parakeet-fp32'
    : 'parakeet';
}

function modelForEngine(engine, device) {
  const id = String(engine || 'whisper').trim().toLowerCase();
  if (id === 'parakeet') return parakeetPackFor(device);
  return ENGINE_MODELS[id] || 'whisper';
}

// Whether the fast English path is worth offering at all.
//
// It is a separate download rather than part of setup, so it only makes sense
// to offer where it would actually be used: English dictation, on an engine
// that is not already Parakeet.
function fastPathOffered(engine, language) {
  if (String(engine || '').trim().toLowerCase() === 'parakeet') return false;
  return String(language || 'en').trim().toLowerCase() === 'en';
}

// Whether the float32 Parakeet weights should be shown to this machine.
//
// Only once the hardware that can use them is both present and selected.
// Offering 2.51 GB to somebody whose runtime will never load it is the
// specific waste this whole module exists to stop.
function gpuWeightsOffered(device, gpu) {
  const chosen = String(device || 'auto').trim().toLowerCase();
  if (chosen === 'directml') return true;
  // Auto or CUDA never reach DirectML in the sidecar, so the weights are only
  // worth mentioning as something the processor setting would unlock -- and
  // only when there is a card to unlock it with.
  const plan = gpu || {};
  return chosen === 'auto' && plan.device === 'directml' && !!plan.vendor;
}

function bytesFor(id, sizes) {
  const value = Number((sizes || {})[id]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// The plan for one configuration.
//
//   required  what the current engine cannot run without
//   optional  what is on offer, and why
//   missing   required components that are not on disk yet
//
// `installed` is a map of id -> boolean. `sizes` is id -> download bytes,
// taken from the managers rather than hardcoded here, so the catalog stays the
// one place the numbers live.
function plan(options) {
  const opts = options || {};
  const engine = String(opts.engine || 'whisper').trim().toLowerCase();
  const device = String(opts.device || 'auto').trim().toLowerCase();
  const installed = opts.installed || {};
  const sizes = opts.sizes || {};
  const required = modelForEngine(engine, device);
  const fastPack = parakeetPackFor(device);

  const items = [];
  for (const id of COMPONENT_IDS) {
    const component = COMPONENTS[id];
    const isInstalled = !!installed[id];
    let role = 'hidden';
    let reason = '';

    if (id === required) {
      role = 'required';
      reason = 'The engine you chose needs it.';
    } else if (id === 'parakeet-fp32' && !gpuWeightsOffered(device, opts.gpu)) {
      // Not merely optional -- not shown. The runtime cannot load it.
      role = 'hidden';
      reason = 'Only used when the processor is set to AMD or Intel GPU.';
    } else if (id === fastPack && fastPathOffered(engine, opts.language)) {
      role = 'optional';
      reason = 'Adds a faster English path for short dictations.';
    } else if (id === 'parakeet' || id === 'parakeet-fp32') {
      role = 'hidden';
      reason = 'The fast English path does not apply to this configuration.';
    } else {
      role = 'optional';
      reason = 'Another engine you can switch to later.';
    }

    items.push({
      id,
      name: component.name,
      summary: component.summary,
      manager: component.manager,
      bytes: bytesFor(id, sizes),
      installed: isInstalled,
      role,
      reason,
    });
  }

  const pick = (role) => items.filter((i) => i.role === role).map((i) => i.id);
  const missing = items.filter((i) => i.role === 'required' && !i.installed).map((i) => i.id);
  const sum = (list) => list.reduce((n, i) => n + i.bytes, 0);

  return {
    engine,
    device,
    required: pick('required'),
    optional: pick('optional'),
    hidden: pick('hidden'),
    missing,
    items,
    // What a first run has to fetch before dictation works. The runtime is not
    // counted here: it ships inside the installer, and the caller adds it when
    // it does not.
    requiredBytes: sum(items.filter((i) => i.role === 'required' && !i.installed)),
    optionalBytes: sum(items.filter((i) => i.role === 'optional' && !i.installed)),
    ready: missing.length === 0,
  };
}

// Everything that would have to be downloaded for a configuration to work,
// used when the user changes engine or processor. Returns [] when the switch
// costs nothing, which is what lets the UI switch silently in the common case
// and offer a download only when there is one.
function missingFor(options) {
  return plan(options).missing;
}

module.exports = {
  COMPONENTS,
  COMPONENT_IDS,
  parakeetPackFor,
  modelForEngine,
  fastPathOffered,
  gpuWeightsOffered,
  plan,
  missingFor,
};
