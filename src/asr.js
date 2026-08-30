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

const ASR_DEVICES = Object.freeze(['auto', 'cuda', 'cpu']);

function normalizeAsrEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ASR_ENGINES, id) ? id : 'whisper';
}

function normalizeAsrDevice(value) {
  const id = String(value || '').trim().toLowerCase();
  return ASR_DEVICES.includes(id) ? id : 'auto';
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
  normalizeAsrEngine,
  normalizeAsrDevice,
  engineName,
  engineOptionLabel,
  parseEngineProgress,
};
