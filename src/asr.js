'use strict';

const ASR_ENGINES = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper large-v3',
    advertisedSize: '~3 GB',
    description: 'Fastest startup and the most mature fallback.',
  }),
  'whisper-turbo': Object.freeze({
    id: 'whisper-turbo',
    name: 'Whisper large-v3 turbo',
    advertisedSize: '~1.6 GB',
    description: 'Whisper with a distilled decoder: half the download, same vocabulary support.',
  }),
  'qwen3-asr': Object.freeze({
    id: 'qwen3-asr',
    name: 'Qwen3-ASR 1.7B',
    advertisedSize: '~4.7 GB',
    description: 'Higher accuracy for names, accents and 52 languages.',
  }),
  parakeet: Object.freeze({
    id: 'parakeet',
    name: 'Parakeet v3',
    advertisedSize: '~0.6 GB',
    description: 'Small and fast multilingual dictation. The default.',
  }),
});

// The engine a fresh install starts on. Parakeet is a 0.7 GB download that
// dictates within minutes; Qwen is 4.7 GB and offered as an upgrade in
// Settings once the user has seen dictation work. A settings file that names
// an engine keeps it -- this only decides the first run and garbage values.
const DEFAULT_ASR_ENGINE = 'parakeet';

const ASR_DEVICES = Object.freeze(['auto', 'cuda', 'directml', 'cpu']);

// The languages dictation is offered in.
//
// Local engines always hear English. Extra languages belong to Voxden Cloud
// this menu is the cloud recognizer's 60-language table, plus
// Hinglish as a Voxden overlay. Hinglish is Hindi to the recognizer and Latin letters
// to the user; Hindi keeps the script. The two cannot both be on.
function dictationLanguageEntry(id, name, native, engine) {
  return Object.freeze({ id, name, native: native || name, engine: engine || id });
}

const DICTATION_LANGUAGES = Object.freeze([
  dictationLanguageEntry('en', 'English', 'English'),
  dictationLanguageEntry('hg', 'Hinglish', 'Hindi in English letters', 'hi'),
  dictationLanguageEntry('af', 'Afrikaans', 'Afrikaans'),
  dictationLanguageEntry('ar', 'Arabic', 'العربية'),
  dictationLanguageEntry('hy', 'Armenian', 'Հայերեն'),
  dictationLanguageEntry('as', 'Assamese', 'অসমীয়া'),
  dictationLanguageEntry('az', 'Azerbaijani', 'Azərbaycan'),
  dictationLanguageEntry('bn', 'Bengali', 'বাংলা'),
  dictationLanguageEntry('bs', 'Bosnian', 'Bosanski'),
  dictationLanguageEntry('bg', 'Bulgarian', 'Български'),
  dictationLanguageEntry('yue', 'Cantonese', '粵語'),
  dictationLanguageEntry('ca', 'Catalan', 'Català'),
  dictationLanguageEntry('zh', 'Chinese', '中文'),
  dictationLanguageEntry('cs', 'Czech', 'Čeština'),
  dictationLanguageEntry('da', 'Danish', 'Dansk'),
  dictationLanguageEntry('nl', 'Dutch', 'Nederlands'),
  dictationLanguageEntry('et', 'Estonian', 'Eesti'),
  dictationLanguageEntry('fil', 'Filipino', 'Filipino'),
  dictationLanguageEntry('fi', 'Finnish', 'Suomi'),
  dictationLanguageEntry('fr', 'French', 'Français'),
  dictationLanguageEntry('gl', 'Galician', 'Galego'),
  dictationLanguageEntry('de', 'German', 'Deutsch'),
  dictationLanguageEntry('el', 'Greek', 'Ελληνικά'),
  dictationLanguageEntry('gu', 'Gujarati', 'ગુજરાતી'),
  dictationLanguageEntry('he', 'Hebrew', 'עברית'),
  dictationLanguageEntry('hi', 'Hindi', 'हिन्दी'),
  dictationLanguageEntry('hu', 'Hungarian', 'Magyar'),
  dictationLanguageEntry('is', 'Icelandic', 'Íslenska'),
  dictationLanguageEntry('id', 'Indonesian', 'Bahasa Indonesia'),
  dictationLanguageEntry('it', 'Italian', 'Italiano'),
  dictationLanguageEntry('ja', 'Japanese', '日本語'),
  dictationLanguageEntry('kn', 'Kannada', 'ಕನ್ನಡ'),
  dictationLanguageEntry('kk', 'Kazakh', 'Қазақ'),
  dictationLanguageEntry('ko', 'Korean', '한국어'),
  dictationLanguageEntry('lv', 'Latvian', 'Latviešu'),
  dictationLanguageEntry('lt', 'Lithuanian', 'Lietuvių'),
  dictationLanguageEntry('mk', 'Macedonian', 'Македонски'),
  dictationLanguageEntry('ms', 'Malay', 'Bahasa Melayu'),
  dictationLanguageEntry('ml', 'Malayalam', 'മലയാളം'),
  dictationLanguageEntry('mr', 'Marathi', 'मराठी'),
  dictationLanguageEntry('ne', 'Nepali', 'नेपाली'),
  dictationLanguageEntry('nb', 'Norwegian Bokmål', 'Norsk bokmål'),
  dictationLanguageEntry('or', 'Odia', 'ଓଡ଼ିଆ'),
  dictationLanguageEntry('fa', 'Persian', 'فارسی'),
  dictationLanguageEntry('pl', 'Polish', 'Polski'),
  dictationLanguageEntry('pt', 'Portuguese', 'Português'),
  dictationLanguageEntry('pa', 'Punjabi', 'ਪੰਜਾਬੀ'),
  dictationLanguageEntry('ro', 'Romanian', 'Română'),
  dictationLanguageEntry('ru', 'Russian', 'Русский'),
  dictationLanguageEntry('sk', 'Slovak', 'Slovenčina'),
  dictationLanguageEntry('sl', 'Slovenian', 'Slovenščina'),
  dictationLanguageEntry('es', 'Spanish', 'Español'),
  dictationLanguageEntry('sw', 'Swahili', 'Kiswahili'),
  dictationLanguageEntry('sv', 'Swedish', 'Svenska'),
  dictationLanguageEntry('ta', 'Tamil', 'தமிழ்'),
  dictationLanguageEntry('te', 'Telugu', 'తెలుగు'),
  dictationLanguageEntry('th', 'Thai', 'ไทย'),
  dictationLanguageEntry('tr', 'Turkish', 'Türkçe'),
  dictationLanguageEntry('uk', 'Ukrainian', 'Українська'),
  dictationLanguageEntry('ur', 'Urdu', 'اردو'),
  dictationLanguageEntry('vi', 'Vietnamese', 'Tiếng Việt'),
]);

// What an engine is told for a picked language: Hinglish is Hindi to it.
function engineLanguageId(value) {
  const id = String(value || '').trim().toLowerCase();
  const found = DICTATION_LANGUAGES.find((l) => l.id === id);
  return found ? found.engine : 'en';
}

const DICTATION_LANGUAGE_IDS = Object.freeze(DICTATION_LANGUAGES.map((l) => l.id));
const CLOUD_ENGINE_LANGUAGE_IDS = Object.freeze([...new Set(DICTATION_LANGUAGES.map((l) => l.engine))]);

function normalizeDictationLanguage(value) {
  const id = String(value || '').trim().toLowerCase();
  return DICTATION_LANGUAGE_IDS.includes(id) ? id : 'en';
}

function dictationLanguageName(value) {
  const id = normalizeDictationLanguage(value);
  const found = DICTATION_LANGUAGES.find((l) => l.id === id);
  return found ? found.name : 'English';
}

// Up to three languages, the first being the main one. One language is told
// to the engine as before; more than one means the engine detects, and the
// text rules run in English whenever English is on the list.
const MAX_DICTATION_LANGUAGES = 3;

function normalizeDictationLanguages(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : String(value).split(','));
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim().toLowerCase();
    if (!DICTATION_LANGUAGE_IDS.includes(id) || out.includes(id)) continue;
    // Hindi and Hinglish are one language to the engine and two ways of
    // writing it to the user; whichever came first stands.
    if ((id === 'hi' && out.includes('hg')) || (id === 'hg' && out.includes('hi'))) continue;
    out.push(id);
    if (out.length === MAX_DICTATION_LANGUAGES) break;
  }
  return out.length ? out : ['en'];
}

function dictationLanguageNames(value) {
  return normalizeDictationLanguages(value).map(dictationLanguageName);
}

function dictationLanguagePolicy(opts) {
  const plan = String((opts && opts.plan) || '').trim().toLowerCase();
  return { plan, cloud: !!(opts && opts.cloud) };
}

// Extra languages are a Pro + Cloud feature. Local engines always hear English.
function dictationLanguageUnlocked(opts) {
  const policy = dictationLanguagePolicy(opts);
  return policy.plan === 'pro' && policy.cloud;
}

function dictationLanguageLimit(opts) {
  return dictationLanguageUnlocked(opts) ? MAX_DICTATION_LANGUAGES : 1;
}

function offeredDictationLanguages(opts) {
  if (!dictationLanguageUnlocked(opts)) {
    return DICTATION_LANGUAGES.filter((l) => l.id === 'en');
  }
  return DICTATION_LANGUAGES;
}

// What to keep on disk. Free is English; Pro keeps any valid cloud selection
// even when Cloud is off, so turning Cloud back on restores it.
function constrainDictationLanguages(list, opts) {
  const policy = dictationLanguagePolicy(opts);
  if (policy.plan !== 'pro') return ['en'];
  return normalizeDictationLanguages(list);
}

// What the recogniser is told. Cloud off is always English. Cloud on sends
// one language, or 'auto' when more than one is selected.
function wireLanguage(list, opts) {
  if (!dictationLanguageUnlocked(opts)) return 'en';
  const ids = [...new Set(normalizeDictationLanguages(list).map(engineLanguageId))];
  return ids.length === 1 ? ids[0] : 'auto';
}

// Codes the relay may forward to the cloud recognizer. Empty and 'auto' mean detect.
function normalizeCloudLanguage(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id || id === 'auto') return '';
  return CLOUD_ENGINE_LANGUAGE_IDS.includes(id) ? id : '';
}

// What each device is called in front of a user. One DirectX 12 backend
// covers AMD and Intel both, so the label names the two rather than the API:
// nobody picking a processor knows what DirectML is, and everybody knows
// which badge is on their machine.
const DEVICE_LABELS = Object.freeze({
  cuda: 'NVIDIA GPU',
  directml: 'AMD or Intel GPU',
  rocm: 'supported AMD GPU',
  cpu: 'CPU',
});

function normalizeAsrEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ASR_ENGINES, id) ? id : DEFAULT_ASR_ENGINE;
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
  // Keep this optional CPU heuristic conservative; explicit routing uses
  // the full v3 capability list.
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
  DEFAULT_ASR_ENGINE,
  ASR_DEVICES,
  DEVICE_LABELS,
  DICTATION_LANGUAGES,
  DICTATION_LANGUAGE_IDS,
  CLOUD_ENGINE_LANGUAGE_IDS,
  normalizeDictationLanguage,
  dictationLanguageName,
  MAX_DICTATION_LANGUAGES,
  normalizeDictationLanguages,
  dictationLanguageNames,
  dictationLanguageUnlocked,
  dictationLanguageLimit,
  offeredDictationLanguages,
  constrainDictationLanguages,
  wireLanguage,
  normalizeCloudLanguage,
  engineLanguageId,
  normalizeAsrEngine,
  normalizeAsrDevice,
  deviceLabel,
  prefersFastAsr,
  engineName,
  engineOptionLabel,
  parseEngineProgress,
};
