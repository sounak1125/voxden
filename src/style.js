'use strict';

const STYLES = ['formal', 'casual', 'veryCasual'];
const CATEGORIES = ['personal', 'work', 'email', 'other'];

const DEFAULT_WRITING_STYLES = {
  personal: 'veryCasual',
  work: 'casual',
  email: 'formal',
  other: 'casual',
};

const EXE_RULES = {
  personal: [
    'whatsapp.exe', 'discord.exe', 'telegram.exe', 'signal.exe',
    'instagram.exe', 'messenger.exe', 'snapchat.exe', 'reddit.exe',
    'wechat.exe', 'line.exe', 'viber.exe', 'skype.exe',
  ],
  work: [
    'slack.exe', 'teams.exe', 'ms-teams.exe', 'zoom.exe', 'webex.exe',
    'notion.exe', 'linear.exe', 'asana.exe', 'clickup.exe', 'trello.exe',
    'jira.exe', 'atlassian.exe', 'figma.exe', 'monday.exe',
  ],
  email: [
    'outlook.exe', 'thunderbird.exe', 'superhuman.exe', 'mailbird.exe',
    'mailspring.exe', 'postbox.exe', 'emclient.exe',
  ],
};

const TITLE_RULES = {
  email: [
    'gmail', 'mail.google', 'inbox', 'outlook', 'outlook.live', 'outlook.office',
    'yahoo mail', 'proton mail', 'protonmail', 'icloud mail', 'superhuman',
    'compose mail', 'new message',
  ],
  work: [
    'slack', 'microsoft teams', 'teams |', 'linkedin', 'zoom meeting', 'zoom workplace',
    'google meet', 'meet.google', 'webex', 'notion', 'jira', 'linear', 'asana',
    'clickup', 'trello', 'figma', 'monday.com', 'confluence',
  ],
  personal: [
    'whatsapp', 'discord', 'instagram', 'facebook messenger', 'messenger',
    'telegram', 'signal', 'snapchat', 'reddit', 'twitter', 'x.com', 'messages',
    'imessage', 'wechat', 'line -', 'viber',
  ],
};

const BROWSER_EXES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe',
  'vivaldi.exe', 'applicationframehost.exe', 'arc.exe', 'wavebox.exe',
]);

const BASIC_FILLER_SOURCE = '(?:um+|uh+|er+|ah+|hmm+|uhh+|erm+|uh-huh)';
const HARSH_FILLER_SOURCE = '(?:um+|uh+|er+)';
const ASIDE_BOUNDARY_SOURCE = '[,;:\u2013\u2014-]';

const CONTRACTIONS = [
  [/won't/gi, 'will not'],
  [/can't/gi, 'cannot'],
  [/n't/gi, ' not'],
  [/i'm/gi, 'I am'],
  [/you're/gi, 'you are'],
  [/we're/gi, 'we are'],
  [/they're/gi, 'they are'],
  [/i've/gi, 'I have'],
  [/you've/gi, 'you have'],
  [/we've/gi, 'we have'],
  [/they've/gi, 'they have'],
  [/i'll/gi, 'I will'],
  [/you'll/gi, 'you will'],
  [/we'll/gi, 'we will'],
  [/they'll/gi, 'they will'],
  [/isn't/gi, 'is not'],
  [/aren't/gi, 'are not'],
  [/wasn't/gi, 'was not'],
  [/weren't/gi, 'were not'],
  [/haven't/gi, 'have not'],
  [/hasn't/gi, 'has not'],
  [/hadn't/gi, 'had not'],
  [/don't/gi, 'do not'],
  [/doesn't/gi, 'does not'],
  [/didn't/gi, 'did not'],
  [/shouldn't/gi, 'should not'],
  [/wouldn't/gi, 'would not'],
  [/couldn't/gi, 'could not'],
  [/let's/gi, 'let us'],
];

function normalizeExe(exe) {
  const raw = String(exe || '').trim().toLowerCase();
  if (!raw) return '';
  const base = raw.split(/[\\/]/).pop() || raw;
  return base.endsWith('.exe') ? base : base + '.exe';
}

function normalizeWritingStyles(raw) {
  const out = Object.assign({}, DEFAULT_WRITING_STYLES);
  if (!raw || typeof raw !== 'object') return out;
  for (const cat of CATEGORIES) {
    if (STYLES.includes(raw[cat])) out[cat] = raw[cat];
  }
  return out;
}

function exeMatches(exe, patterns) {
  const e = normalizeExe(exe);
  if (!e) return false;
  for (const pattern of patterns) {
    if (e === pattern) return true;
  }
  return false;
}

function titleMatches(title, keywords) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  for (const kw of keywords) {
    if (t.includes(kw)) return true;
  }
  return false;
}

function classifyTarget(exe, title) {
  for (const cat of ['personal', 'work', 'email']) {
    if (exeMatches(exe, EXE_RULES[cat])) return cat;
  }

  const e = normalizeExe(exe);
  const useTitle = !e || BROWSER_EXES.has(e) || e === 'applicationframehost.exe';
  if (useTitle || e) {
    for (const cat of ['email', 'work', 'personal']) {
      if (titleMatches(title, TITLE_RULES[cat])) return cat;
    }
  }

  return 'other';
}

const FAST_CATEGORIES = new Set(['personal', 'work']);
const FAST_AI_EXES = new Set(['chatgpt.exe', 'claude.exe']);
const FAST_AI_TITLES = [
  'chatgpt', 'claude', 'cursor agents', 'cursor chat', 'copilot chat',
];
const DICTATION_QUALITIES = ['auto', 'fast', 'accurate'];

function normalizeDictationQuality(value) {
  const id = String(value || '').trim().toLowerCase();
  return DICTATION_QUALITIES.includes(id) ? id : 'auto';
}

function isFastDictationTarget(target) {
  const info = target || {};
  const exe = normalizeExe(info.exe);
  if (FAST_AI_EXES.has(exe)) return true;
  return titleMatches(info.title, FAST_AI_TITLES);
}

function dictationPath(category, settings, target, durationMs) {
  const quality = normalizeDictationQuality(settings && settings.dictationQuality);
  if (quality === 'fast' || quality === 'accurate') return quality;
  // Auto can favour latency for quick messages, but longer thoughts need the
  // primary model. Explicit Fast and Accurate choices always win.
  if (Number(durationMs) >= 8000) return 'accurate';
  const cat = CATEGORIES.includes(category) ? category : 'other';
  return FAST_CATEGORIES.has(cat) || isFastDictationTarget(target) ? 'fast' : 'accurate';
}

const AUTO_SEND_KEYS = ['off', 'enter', 'ctrl-enter'];
const DEFAULT_AUTO_SEND = {
  personal: 'off',
  work: 'off',
  email: 'off',
  other: 'off',
};

function normalizeAutoSend(raw) {
  const out = Object.assign({}, DEFAULT_AUTO_SEND);
  if (!raw || typeof raw !== 'object') return out;
  for (const cat of CATEGORIES) {
    const id = String(raw[cat] || '').trim().toLowerCase();
    if (AUTO_SEND_KEYS.includes(id)) out[cat] = id;
  }
  return out;
}

function autoSendFor(category, settings) {
  const map = normalizeAutoSend(settings && settings.autoSend);
  const cat = CATEGORIES.includes(category) ? category : 'other';
  return map[cat] || 'off';
}

function collapseSpaces(text) {
  return String(text || '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Filler removal happens after cleanup(), so punctuation produced by Whisper
// is already present. Consume punctuation that belongs to a filler instead of
// leaving artifacts such as "I was, , thinking" or a leading comma.
function removeVocalFillers(text, source) {
  let s = String(text || '');
  const paired = new RegExp(
    '\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*\\b' + source + '\\b\\s*'
      + ASIDE_BOUNDARY_SOURCE + '\\s*',
    'gi'
  );
  const leading = new RegExp(
    '(^|[.!?]\\s+)\\b' + source + '\\b\\s*' + ASIDE_BOUNDARY_SOURCE + '?\\s*',
    'gi'
  );
  const bare = new RegExp('\\b' + source + '\\b', 'gi');
  s = s.replace(paired, ' ');
  s = s.replace(leading, '$1');
  return s.replace(bare, ' ');
}

// Multi-word discourse phrases are ambiguous. Only remove them when
// punctuation marks them as an aside. "I was, you know, thinking" is safe to
// clean; "Do you know the answer?" is not.
function removeDelimitedAside(text, phrase) {
  let s = String(text || '');
  const p = escapeRegExp(phrase).replace(/\\ /g, '\\s+');
  const paired = new RegExp(
    '\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*\\b' + p + '\\b\\s*'
      + ASIDE_BOUNDARY_SOURCE + '\\s*',
    'gi'
  );
  const leading = new RegExp(
    '(^|[.!?]\\s+)\\b' + p + '\\b\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*',
    'gi'
  );
  const trailing = new RegExp(
    '\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*\\b' + p
      + '\\b(?=\\s*(?:[.!?]|$))',
    'gi'
  );
  s = s.replace(paired, ' ');
  s = s.replace(leading, '$1');
  return s.replace(trailing, '');
}

function tidyAfterFillerRemoval(text) {
  let s = collapseSpaces(text);
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  s = s.replace(/(^|[.!?]\s+)[,;:]\s*/g, '$1');
  s = s.replace(/[,;:]\s*([.!?])/g, '$1');
  s = s.replace(/([,;:])(?=[A-Za-z])/g, '$1 ');
  return s.trim();
}

function stripFillers(text, tone) {
  let s = String(text || '');
  if (!s) return '';

  if (tone === 'formal') {
    s = removeVocalFillers(s, BASIC_FILLER_SOURCE);
    for (const phrase of ['you know', 'i mean', 'kind of', 'sort of', 'like']) {
      s = removeDelimitedAside(s, phrase);
    }
    s = s.replace(/^well,?\s+/i, '');
    s = s.replace(/^so,?\s+/i, '');
  } else if (tone === 'casual') {
    s = removeVocalFillers(s, BASIC_FILLER_SOURCE);
  } else if (tone === 'veryCasual') {
    s = removeVocalFillers(s, HARSH_FILLER_SOURCE);
  }

  return tidyAfterFillerRemoval(s);
}

function applyFormal(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  s = s.replace(/^hey\b[,.]?\s*/i, 'Hello, ');
  s = s.replace(/^hi\b[,.]?\s*/i, 'Hello, ');
  s = s.replace(/\bhey\b/gi, 'hello');
  s = s.replace(/\byeah\b/gi, 'yes');
  s = s.replace(/\bgonna\b/gi, 'going to');
  s = s.replace(/\bwanna\b/gi, 'want to');
  s = s.replace(/\bgotta\b/gi, 'got to');
  s = s.replace(/\bkinda\b/gi, 'kind of');
  s = s.replace(/\bsorta\b/gi, 'sort of');
  s = s.replace(/\blemme\b/gi, 'let me');
  s = s.replace(/\bgimme\b/gi, 'give me');

  for (const [re, rep] of CONTRACTIONS) {
    s = s.replace(re, rep);
  }

  s = collapseSpaces(s);
  if (s && !/[.!?]$/.test(s)) s += '.';
  if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function applyVeryCasual(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(/\.+$/, '');
  return s.split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    if (tok === 'I') return 'I';
    return tok.toLowerCase();
  }).join('').trim();
}

function applyCasual(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  if (/^[a-z]/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function toneForCategory(category, writingStyles) {
  const styles = normalizeWritingStyles(writingStyles);
  const cat = CATEGORIES.includes(category) ? category : 'other';
  return styles[cat] || DEFAULT_WRITING_STYLES[cat];
}

// Finish capitalization, contractions, and tone without deleting any more
// words. This is safe to run after a sentence-aware model rewrite.
function finalizeStyle(text, tone) {
  const safeTone = STYLES.includes(tone) ? tone : 'casual';
  const raw = tidyAfterFillerRemoval(String(text || '').trim());
  if (!raw) return '';
  if (safeTone === 'formal') return applyFormal(raw);
  if (safeTone === 'veryCasual') return applyVeryCasual(raw);
  return applyCasual(raw);
}

function applyStyle(text, category, writingStyles) {
  const tone = toneForCategory(category, writingStyles);
  let raw = stripFillers(String(text || '').trim(), tone);
  return finalizeStyle(raw, tone);
}

function applyStyleWithTone(text, tone, language = 'en') {
  if (!/^en(?:-|$)/i.test(language)) return collapseSpaces(text);
  const safeTone = STYLES.includes(tone) ? tone : 'casual';
  return require('./cleanup').withStructuredTokens(text, value => {
    const raw = stripFillers(value.trim(), safeTone);
    return finalizeStyle(raw, safeTone);
  });
}

module.exports = {
  STYLES,
  CATEGORIES,
  DEFAULT_WRITING_STYLES,
  DEFAULT_AUTO_SEND,
  AUTO_SEND_KEYS,
  DICTATION_QUALITIES,
  normalizeWritingStyles,
  normalizeDictationQuality,
  normalizeAutoSend,
  classifyTarget,
  isFastDictationTarget,
  dictationPath,
  autoSendFor,
  stripFillers,
  tidyAfterFillerRemoval,
  toneForCategory,
  finalizeStyle,
  applyStyle,
  applyStyleWithTone,
  applyFormal,
  applyVeryCasual,
  applyCasual,
};
