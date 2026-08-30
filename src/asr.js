'use strict';

const ASR_ENGINES = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper large-v3',
    description: 'Fastest startup and the most mature fallback.',
  }),
  'qwen3-asr': Object.freeze({
    id: 'qwen3-asr',
    name: 'Qwen3-ASR 1.7B',
    description: 'Higher accuracy for accents and multilingual speech.',
  }),
  voxtral: Object.freeze({
    id: 'voxtral',
    name: 'Voxtral Mini 3B',
    description: 'Strong punctuation and multilingual transcription; uses more memory.',
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

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

function parseEngineProgress(previousBuffer, chunk) {
  const combined = stripAnsi(String(previousBuffer || '') + String(chunk || ''));
  const matches = [];
  const patterns = [
    {
      regex: /Fetching\s+\d+\s+files:\s*(\d{1,3})%/gi,
      phase: 'downloading',
    },
    {
      regex: /Loading checkpoint shards:\s*(\d{1,3})%/gi,
      phase: 'loading',
    },
    {
      regex: /(?:^|[\r\n])([^\r\n:]{1,100}):\s*(\d{1,3})%\|/g,
      phase: 'downloading',
      percentGroup: 2,
      detailGroup: 1,
    },
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(combined)) !== null) {
      const percent = Math.max(0, Math.min(100, Number(match[pattern.percentGroup || 1])));
      if (!Number.isFinite(percent)) continue;
      const detail = pattern.detailGroup
        ? String(match[pattern.detailGroup] || '').trim().slice(-64)
        : '';
      if (pattern.detailGroup && /^(Fetching\s+\d+\s+files|Loading checkpoint shards)$/i.test(detail)) {
        continue;
      }
      matches.push({ index: match.index, phase: pattern.phase, percent, detail });
    }
  }

  matches.sort((a, b) => a.index - b.index);
  const progress = matches.length ? matches[matches.length - 1] : null;
  return {
    buffer: combined.slice(-2048),
    progress,
  };
}

module.exports = {
  ASR_ENGINES,
  ASR_DEVICES,
  normalizeAsrEngine,
  normalizeAsrDevice,
  engineName,
  parseEngineProgress,
};
