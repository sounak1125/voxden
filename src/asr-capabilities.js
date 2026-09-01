'use strict';

// What each speech engine can actually do.
//
// This file exists because the pipeline used to accept a vocabulary request
// and throw it away. src/main.js built a prompt out of the user's dictionary
// and wrote it into every sidecar request; QwenBackend.transcribe opened with
// `del prompt` and ParakeetBackend.transcribe with `del prompt, language`. The
// terms a user had typed in by hand reached the model on exactly one of the
// three engines, and nothing anywhere said so.
//
// The fix is not "wire the prompt into every backend" -- Parakeet genuinely
// has no context input. The fix is to state, in one place, what each engine
// honours, and to make every caller either use the stated mechanism or say out
// loud that it could not. Anything that silently drops a capability is a bug
// against this file.
//
// The Python side has its own copy of the same table (ENGINE_CAPABILITIES in
// sidecar/transcribe.py) because the sidecar must answer --check before any
// JavaScript has run. scripts/test-asr-capabilities.js asserts the two agree.

// Vocabulary mechanisms, by what the engine's own API calls them:
//
//   initial_prompt  faster-whisper. Text prepended to the decoder as if it had
//                   already been transcribed. Whisper's prompt buffer is
//                   n_text_ctx/2 - 1 = 223 tokens and the tail is what gets
//                   dropped, so the budget below leaves headroom rather than
//                   filling it exactly.
//   context         qwen_asr >= 0.0.6. transcribe(audio, context=...) puts the
//                   string in the system message of the chat template. This is
//                   the mechanism Qwen3-ASR documents for contextual biasing,
//                   and it takes far more text than Whisper's prompt.
//   null            No context input at all. onnx-asr exposes recognize(path)
//                   and nothing else; the Parakeet TDT graph has no biasing
//                   entry point. Vocabulary for this engine has to be applied
//                   after recognition, from the audio-derived transcript.
const ENGINE_CAPABILITIES = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    vocabulary: Object.freeze({
      supported: true,
      mechanism: 'initial_prompt',
      maxTerms: 48,
      maxTokens: 180,
      note: 'Whisper takes vocabulary as an initial prompt, capped near 200 tokens.',
    }),
    // Whisper large-v3 recognises about a hundred languages. This is the
    // intersection Voxden offers, which is what routing may rely on.
    languages: Object.freeze(['en', 'hi', 'de', 'fr', 'es', 'pt', 'it', 'nl']),
    autoDetectLanguage: true,
    segments: true,
    // avg_logprob and no_speech_prob per segment. This is the only engine that
    // reports anything about its own confidence, which is why uncertain-span
    // rechecking is gated on it.
    confidence: true,
    timestamps: true,
  }),
  'qwen3-asr': Object.freeze({
    id: 'qwen3-asr',
    vocabulary: Object.freeze({
      supported: true,
      mechanism: 'context',
      maxTerms: 96,
      maxTokens: 600,
      note: 'Qwen3-ASR takes vocabulary as a context system message.',
    }),
    languages: Object.freeze(['en', 'hi', 'de', 'fr', 'es', 'pt', 'it', 'nl']),
    autoDetectLanguage: true,
    segments: false,
    confidence: false,
    // Only with a forced aligner loaded, which Voxden does not ship.
    timestamps: false,
  }),
  parakeet: Object.freeze({
    id: 'parakeet',
    vocabulary: Object.freeze({
      supported: false,
      mechanism: null,
      maxTerms: 0,
      maxTokens: 0,
      note: 'Parakeet has no context input; vocabulary is applied after recognition.',
    }),
    languages: Object.freeze(['en']),
    autoDetectLanguage: false,
    segments: true,
    confidence: false,
    timestamps: true,
  }),
});

const ENGINE_IDS = Object.freeze(Object.keys(ENGINE_CAPABILITIES));

function normalizeEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENGINE_CAPABILITIES, id) ? id : 'whisper';
}

function capabilitiesFor(engine) {
  return ENGINE_CAPABILITIES[normalizeEngine(engine)];
}

function supportsVocabulary(engine) {
  return capabilitiesFor(engine).vocabulary.supported;
}

function vocabularyMechanism(engine) {
  return capabilitiesFor(engine).vocabulary.mechanism;
}

function vocabularyBudget(engine) {
  const vocab = capabilitiesFor(engine).vocabulary;
  return { maxTerms: vocab.maxTerms, maxTokens: vocab.maxTokens, mechanism: vocab.mechanism };
}

function supportsLanguage(engine, language) {
  const id = String(language || 'en').trim().toLowerCase();
  return capabilitiesFor(engine).languages.includes(id);
}

// How a vocabulary request is going to be honoured on a given engine.
//
//   'context' / 'initial_prompt'  the engine is told the terms before decoding
//   'repair'                      the engine cannot be told, so the terms are
//                                 matched against what it heard afterwards
//   'none'                        there is no vocabulary to apply
//
// 'repair' is a real route, not a shrug: src/repair.js works on the phonetics
// of what the engine returned, which is audio-derived evidence. It is weaker
// than biasing the decoder and the diagnostics say so, but it is the honest
// answer for an engine with no context input.
function vocabularyRoute(engine, termCount) {
  if (!Number(termCount)) return 'none';
  return supportsVocabulary(engine) ? vocabularyMechanism(engine) : 'repair';
}

// Auto and Accurate must keep a vocabulary-capable primary. Explicit Fast is
// the one setting that is allowed to trade in-model biasing for speed.
function shouldRequireInModelVocabulary(requestedQuality) {
  return String(requestedQuality || '').trim().toLowerCase() !== 'fast';
}

// Whether a fast-path swap is allowed to happen for this request.
//
// The old prefersFastAsr sent an "accurate" dictation to Parakeet whenever
// Whisper was stuck on the CPU. That is a good trade for speed and a bad one
// for a user whose dictionary is the reason they asked for accuracy: the
// request was accepted and the terms were dropped on the floor.
//
// Now the swap still happens -- Parakeet is several times faster and the
// latency is real -- but the loss is named. Callers that must not lose
// in-model biasing pass requireInModelVocabulary and get the primary back.
//
// `termCount` is counted before any engine-specific prompt is built. Deciding
// the engine from an already-empty Parakeet prompt is how Auto-with-a-
// dictionary used to throw the whole list away and then stay on Parakeet
// because the sidecar only bounced back to Qwen when it saw a nonempty prompt.
function planRoute(options) {
  const opts = options || {};
  const primary = normalizeEngine(opts.engine);
  const fast = opts.fastEngine ? normalizeEngine(opts.fastEngine) : null;
  const language = String(opts.language || 'en').trim().toLowerCase();
  const termCount = Math.max(0, Number(opts.termCount) || 0);
  const quality = String(opts.quality || '').trim().toLowerCase();
  const device = String(opts.device || '').trim().toLowerCase();
  const requireInModel = !!opts.requireInModelVocabulary;

  const plan = {
    engine: primary,
    fallbackFrom: null,
    reason: '',
    vocabularyVia: vocabularyRoute(primary, termCount),
    lostCapabilities: [],
    degraded: false,
  };

  if (!supportsLanguage(primary, language)) {
    plan.lostCapabilities.push('language:' + language);
    plan.degraded = true;
    plan.reason = engineLabel(primary) + ' does not recognise this language.';
  }

  const wantsFast = quality === 'fast'
    || (quality === 'accurate' && device === 'cpu' && opts.preferFastOnCpu !== false);
  if (!fast || fast === primary || !wantsFast) return plan;
  if (!supportsLanguage(fast, language)) return plan;
  if (requireInModel && termCount && !supportsVocabulary(fast)) {
    plan.reason = 'Kept ' + engineLabel(primary) + ' so your dictionary reaches the model.';
    return plan;
  }

  plan.engine = fast;
  plan.fallbackFrom = primary;
  plan.vocabularyVia = vocabularyRoute(fast, termCount);
  if (termCount && !supportsVocabulary(fast) && supportsVocabulary(primary)) {
    plan.lostCapabilities.push('vocabulary:in-model');
    plan.degraded = true;
    plan.reason = engineLabel(fast) + ' has no context input, so your dictionary is '
      + 'applied to the transcript instead of to the model.';
  } else if (!plan.reason) {
    plan.reason = quality === 'fast'
      ? engineLabel(fast) + ' was used for speed.'
      : engineLabel(fast) + ' was used because ' + engineLabel(primary) + ' has no GPU here.';
  }
  return plan;
}

const ENGINE_LABELS = Object.freeze({
  whisper: 'Whisper',
  'qwen3-asr': 'Qwen3-ASR',
  parakeet: 'Parakeet',
});

function engineLabel(engine) {
  return ENGINE_LABELS[normalizeEngine(engine)] || 'the speech engine';
}

// A one-line, user-facing account of what the engine did and what it cost.
// Shown next to the transcript rather than buried in a log, because a silent
// capability loss is the thing this whole file exists to prevent.
function describeRoute(plan, options) {
  const opts = options || {};
  const p = plan || {};
  const parts = [engineLabel(p.engine)];
  if (opts.device) parts.push('on the ' + opts.device);
  let text = parts.join(' ');
  if (p.vocabularyVia === 'context' || p.vocabularyVia === 'initial_prompt') {
    text += ' · dictionary sent to the model';
  } else if (p.vocabularyVia === 'repair') {
    text += ' · dictionary applied after recognition';
  }
  if (p.reason) text += ' · ' + p.reason;
  return text;
}

// The short line shown next to a finished dictation. Longer routing reasons
// stay in the diagnostics record; this is what a person can read at a glance.
function summarizeRoute(plan, options) {
  const opts = options || {};
  const p = plan || {};
  let name = engineLabel(p.engine);
  if (String(opts.quality || '').trim().toLowerCase() === 'fast'
      && normalizeEngine(p.engine) === 'parakeet') {
    name += ' Fast';
  }
  const via = p.vocabularyVia;
  if (via === 'context' || via === 'initial_prompt') {
    const n = Number(opts.termsSent) || 0;
    return n > 0
      ? name + ' · dictionary sent to the model · ' + n + (n === 1 ? ' term' : ' terms')
      : name + ' · dictionary sent to the model';
  }
  if (via === 'repair') return name + ' · dictionary applied after recognition';
  return name;
}

module.exports = {
  ENGINE_CAPABILITIES,
  ENGINE_IDS,
  normalizeEngine,
  capabilitiesFor,
  supportsVocabulary,
  vocabularyMechanism,
  vocabularyBudget,
  supportsLanguage,
  vocabularyRoute,
  shouldRequireInModelVocabulary,
  planRoute,
  engineLabel,
  describeRoute,
  summarizeRoute,
};
