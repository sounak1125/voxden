'use strict';

const ASR_ENGINES = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper large-v3',
    advertisedSize: '~3 GB',
    description: 'Fastest startup and the most mature fallback.',
  }),
  'qwen3-asr': Object.freeze({
    id: 'qwen3-asr',
    name: 'Qwen3-ASR 1.7B',
    advertisedSize: '~3.4 GB',
    description: 'Higher accuracy for accents and multilingual speech.',
  }),
  parakeet: Object.freeze({
    id: 'parakeet',
    name: 'Parakeet TDT 0.6B',
    advertisedSize: '~0.6 GB',
    description: 'Fast English dictation without loading Whisper or Qwen.',
  }),
});

const ASR_DEVICES = Object.freeze(['auto', 'cuda', 'directml', 'cpu']);

// What each device is called in front of a user. One DirectX 12 backend
// covers AMD and Intel both, so the label names the two rather than the API:
// nobody picking a processor knows what DirectML is, and everybody knows
// which badge is on their machine.
const DEVICE_LABELS = Object.freeze({
  cuda: 'NVIDIA GPU',
  directml: 'AMD or Intel GPU',
  cpu: 'CPU',
});

function normalizeAsrEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ASR_ENGINES, id) ? id : 'whisper';
}

function normalizeAsrDevice(value) {
  const id = String(value || '').trim().toLowerCase();
  return ASR_DEVICES.includes(id) ? id : 'auto';
}

// 'auto' lands here too, before the sidecar has reported what it resolved to.
// CPU is the honest guess: it is where every engine starts and where all of
// them stay if no GPU answers.
function deviceLabel(value) {
  return DEVICE_LABELS[String(value || '').trim().toLowerCase()] || 'CPU';
}

// Whether a dictation the user asked to be accurate should still be recognised
// by Parakeet.
//
// No Voxden download has ever carried cuBLAS, so ctranslate2 finds no CUDA on
// any machine that has not installed it separately -- which is nearly all of
// them -- and Whisper large-v3 runs on the CPU there whatever card is fitted.
// Measured on a 24-thread desktop, a nine-second clip took 8.7s through
// Whisper and 1.87s through Parakeet. A four-core laptop multiplies the first
// number and barely touches the second, which is where the minute-long waits
// come from.
//
// This picks the recogniser and nothing else. How much correction the text
// gets is a separate question, and an accurate dictation keeps all of it: the
// user asked for a careful result, not a smaller feature set. Conflating the
// two is what made "fast" mean both a cheaper model and no sentence
// correction, and only one of those is worth doing here.
function prefersFastAsr(engine) {
  const info = engine || {};
  // Parakeet has to actually be loaded. Without it, asking for the fast path
  // just narrows Whisper's beam -- speed bought by giving up accuracy rather
  // than by moving the work to a model that does not need it, which is a
  // different bargain than the one being made here.
  if (String(info.fastEngine || '') !== 'parakeet') return false;
  // A GPU makes Whisper quick enough that there is nothing to trade away.
  if (String(info.device || '') !== 'cpu') return false;
  // Parakeet is English-only. dictationLanguage is pinned to 'en' today, so
  // this is a guard for the day it is not.
  return String(info.language || 'en').trim().toLowerCase() === 'en';
}

function engineName(value) {
  return ASR_ENGINES[normalizeAsrEngine(value)].name;
}

function engineOptionLabel(value) {
  const engine = ASR_ENGINES[normalizeAsrEngine(value)];
  return engine.name + ' \u00b7 ' + engine.advertisedSize;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function isParentProgressLabel(detail) {
  return /^(Fetching\s+\d+\s+files|Loading checkpoint shards)$/i.test(String(detail || '').trim());
}

function lastMatch(regex, text) {
  regex.lastIndex = 0;
  let found = null;
  let match;
  while ((match = regex.exec(text)) !== null) found = match;
  regex.lastIndex = 0;
  return found;
}

function parseEngineProgress(previousBuffer, chunk) {
  const combined = stripAnsi(String(previousBuffer || '') + String(chunk || ''));
  const markerRe = /VOXDEN_PROGRESS\s+(\d{1,3})\s+([^\r\n]*)/g;
  const fetchingRe = /Fetching\s+(\d+)\s+files:\s*(\d{1,3})%(?:\|[^\r\n]*?\|\s*(\d+)\s*\/\s*(\d+))?/gi;
  const loadingRe = /Loading checkpoint shards:\s*(\d{1,3})%/gi;
  const fileRe = /(?:^|[\r\n])([^\r\n:]{1,120}):\s*(\d{1,3})%\|/g;

  const loadingMatch = lastMatch(loadingRe, combined);
  const fetchingMatch = lastMatch(fetchingRe, combined);
  let fileMatch = null;
  let fileScan;
  while ((fileScan = fileRe.exec(combined)) !== null) {
    const detail = String(fileScan[1] || '').trim();
    if (isParentProgressLabel(detail)) continue;
    fileMatch = fileScan;
  }

  let markerMatch = null;
  let markerScan;
  while ((markerScan = markerRe.exec(combined)) !== null) {
    const detail = String(markerScan[2] || '').trim();
    if (isParentProgressLabel(detail)) continue;
    markerMatch = markerScan;
  }

  const loadingIndex = loadingMatch ? loadingMatch.index : -1;
  const downloadIndex = Math.max(
    fetchingMatch ? fetchingMatch.index : -1,
    fileMatch ? fileMatch.index : -1,
    markerMatch ? markerMatch.index : -1
  );

  if (loadingMatch && loadingIndex >= downloadIndex) {
    const percent = clampPercent(loadingMatch[1]);
    return {
      buffer: combined.slice(-4096),
      progress: percent == null ? null : {
        index: loadingMatch.index,
        phase: 'loading',
        percent,
        detail: '',
      },
    };
  }

  const filePercent = fileMatch ? clampPercent(fileMatch[2]) : null;
  const markerPercent = markerMatch ? clampPercent(markerMatch[1]) : null;
  const fetchingPercent = fetchingMatch ? clampPercent(fetchingMatch[2]) : null;
  const percents = [filePercent, markerPercent, fetchingPercent].filter((value) => value != null);
  if (!percents.length) {
    return { buffer: combined.slice(-4096), progress: null };
  }

  const percent = Math.max.apply(null, percents);
  const detail = markerMatch
    ? String(markerMatch[2] || '').trim().slice(-64)
    : (fileMatch ? String(fileMatch[1] || '').trim().slice(-64) : '');
  const index = Math.max(
    fileMatch ? fileMatch.index : -1,
    markerMatch ? markerMatch.index : -1,
    fetchingMatch ? fetchingMatch.index : -1
  );
  return {
    buffer: combined.slice(-4096),
    progress: {
      index,
      phase: 'downloading',
      percent,
      detail,
    },
  };
}

module.exports = {
  ASR_ENGINES,
  ASR_DEVICES,
  DEVICE_LABELS,
  normalizeAsrEngine,
  normalizeAsrDevice,
  deviceLabel,
  prefersFastAsr,
  engineName,
  engineOptionLabel,
  parseEngineProgress,
};
