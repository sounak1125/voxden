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
const ASIDE_BOUNDARY_SOURCE = '[,;:\u2013\u2014-]';
const ASIDE_PHRASE_SOURCE = '(?:you know|i mean|kind of|sort of|like)';

// Only unambiguous contractions: "I'd" and "it's" can expand to two
// different verbs. Whole-word matches also avoid corrupting names.
const CONTRACTIONS = {
  "won't": 'will not', "can't": 'cannot', "shan't": 'shall not',
  "I'm": 'I am', "you're": 'you are', "we're": 'we are', "they're": 'they are',
  "I've": 'I have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "I'll": 'I will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will',
  "he'll": 'he will', "she'll": 'she will', "it'll": 'it will',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "shouldn't": 'should not', "wouldn't": 'would not', "couldn't": 'could not',
  "mustn't": 'must not', "needn't": 'need not', "let's": 'let us',
};

const STANDARD_WORDING = {
  gonna: 'going to', wanna: 'want to', gotta: 'got to', kinda: 'kind of',
  sorta: 'sort of', lemme: 'let me', gimme: 'give me', yep: 'yes', nope: 'no',
};
const EVERYDAY_WORDING = {
  'in order to': 'to', 'at this point in time': 'right now',
  'at your earliest convenience': 'when you can',
  'with regard to': 'about', 'in regard to': 'about', 'regarding': 'about',
  'please let me know': 'let me know', 'please inform me': 'let me know',
  'please do not hesitate to': 'feel free to',
  'do not hesitate to': 'feel free to', 'I would like to': 'I want to',
};
const ACTION_VERBS = '(?:be|do|go|send|share|check|call|join|meet|start|finish|help|try|take|make|have|get|see|ask|use|look|read|write|watch|keep|leave|bring|buy|pick|need|want|wait|tell|give|run|update|review|add|move|change|fix)';
const REQUEST_VERBS = '(?:send|share|check|review|confirm|update|help|join|call|let me know)';

function styleRequests(text, tone) {
  // Change politeness only for clear requests at a sentence boundary. Leave
  // ability questions ("Can you swim?") and quoted/embedded questions alone.
  const start = '(^|[.!?]\\s+|\\n)';
  const request = tone === 'formal' ? '(?:can|could|would) you(?: please)?'
    : tone === 'casual' ? '(could|can|would) you please' : '(?:could|would|can) you';
  return text.replace(new RegExp(start + request + '[ \\t]+(?=' + REQUEST_VERBS + '\\b)', 'gi'),
    (_, boundary, verb) => boundary + (tone === 'formal' ? 'Could you please ' : tone === 'casual' ? matchCase(verb, verb.toLowerCase()) + ' you ' : 'can you '));
}

function matchCase(original, replacement) {
  if (/^[A-Z]/.test(original)) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function replacePhrases(text, phrases) {
  let s = text;
  for (const [phrase, replacement] of Object.entries(phrases)) {
    const pattern = escapeRegExp(phrase).replace(/ /g, '[ \\t]+').replace(/'/g, "['’]");
    s = s.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'giu'),
      value => matchCase(value, replacement));
  }
  return s;
}

function contractEveryday(text) {
  // Negative verbs are safe even at the end of a sentence. Positive auxiliary
  // contractions need a complement: "That's where I am" must stay intact.
  const negative = Object.fromEntries(Object.entries(CONTRACTIONS)
    .filter(([, expanded]) => / not$/.test(expanded) || expanded === 'cannot')
    .map(([short, expanded]) => [expanded, short]));
  let s = replacePhrases(text, negative);
  s = s.replace(/\b(I am|you are|we are|they are|I will|you will|we will|they will|he will|she will|it will)(?=[ \t]+[a-z]+\b)/gi,
    (value, phrase, offset) => {
      const rest = s.slice(offset + value.length);
      // Preserve emphasis and comparisons/ellipses: "I am too", "than we are".
      if (/^[ \t]+(?:too|also|either|though|as|than|and|or|but)\b/i.test(rest)) return value;
      const prefix = s.slice(0, offset);
      if (/\b(?:than|as)[ \t]+$/i.test(prefix)) return value;
      const key = phrase.toLowerCase().replace(/[ \t]+/g, ' ');
      const pair = Object.entries(CONTRACTIONS).find(([, expanded]) => expanded.toLowerCase() === key);
      return pair ? matchCase(value, pair[0]) : value;
    });
  return s;
}

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
//
// A speaker strings them together as often as not -- "this thing, I mean,
// like, can you help" -- and removing one phrase at a time consumes both of
// its commas, leaving the next phrase without the punctuation that identified
// it as an aside. So a whole run of them has to match at once.
function removeAsides(text, source) {
  const run = source + '(?:\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*' + source + ')*';
  const paired = new RegExp(
    '\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*\\b' + run + '\\b\\s*'
      + ASIDE_BOUNDARY_SOURCE + '\\s*',
    'gi'
  );
  const leading = new RegExp(
    '(^|[.!?]\\s+)\\b' + run + '\\b\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*',
    'gi'
  );
  const trailing = new RegExp(
    '\\s*' + ASIDE_BOUNDARY_SOURCE + '\\s*\\b' + run
      + '\\b(?=\\s*(?:[.!?]|$))',
    'gi'
  );
  let s = String(text || '');
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

// Filler removal does not depend on tone. Tone decides how a sentence is
// spelled -- its capitals, its punctuation, its word choice -- and "um" is not
// a word the speaker chose. A casual message is a short message, not a less
// tidy one. Verbatim mode is the switch for keeping every filler.
function stripFillers(text) {
  let s = String(text || '');
  if (!s) return '';
  s = removeVocalFillers(s, BASIC_FILLER_SOURCE);
  s = removeAsides(s, ASIDE_PHRASE_SOURCE);
  return tidyAfterFillerRemoval(s);
}

function applyFormal(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  // An opening "So," or "Well," is a spoken throat-clear that formal writing
  // does without. The comma is what identifies it: "So far, I am enjoying
  // this" and "So long as it holds" open with the sentence itself, and
  // dropping the first word there leaves "Far, I am enjoying this".
  s = s.replace(/^(?:well|so),\s+/i, '');
  s = replacePhrases(s, STANDARD_WORDING);
  s = replacePhrases(s, CONTRACTIONS);
  s = replacePhrases(s, { yeah: 'yes' });
  s = styleRequests(s, 'formal');
  s = s.replace(/(^|[.!?]\s+|\n)(?:hey|hi)\b(,?)([ \t]*)/gi,
    (_, boundary, comma, space) => boundary + 'Hello' + (comma || space ? ', ' : ''));
  s = s.replace(/(^|[.!?]\s+|\n)thanks\b(?=$|[,.!?]|[ \t]+(?:for|so much)\b)/gi, '$1Thank you');

  s = collapseSpaces(s);
  if (s && /[\p{L}\p{N}\uE001]$/u.test(s)) s += '.';
  s = sentenceCase(s);
  return s;
}

function applyVeryCasual(text) {
  let s = applyCasual(text);
  if (!s) return '';
  // "Going to London" describes travel, so only shorten it before a known
  // action verb. Never add slang, emoji, or a new claim to arbitrary prose.
  s = s.replace(new RegExp('\\b[Gg]oing to(?=[ \\t]+' + ACTION_VERBS + '\\b)', 'g'),
    value => matchCase(value, 'gonna'));
  s = s.replace(new RegExp('\\b[Ww]ant to(?=[ \\t]+' + ACTION_VERBS + '\\b)', 'g'),
    value => matchCase(value, 'wanna'));
  s = replacePhrases(s, { 'a little bit': 'a bit', 'thank you so much': 'thanks so much' });
  s = styleRequests(s, 'veryCasual');
  s = s.replace(/(^|[.!?]\s+|\n)(?:hello|hi)\b/gi, '$1Hey');
  // Lowercase familiar sentence starters, not every word: Alex, Monday,
  // NASA, iPhone and dictionary spellings must keep their capitalization.
  s = s.replace(/(^|[.!?]\s+|\n)(Hey|Hello|Thanks|Please|Let|Could|Would|We|You|They|He|She|It|The|This|That|Yes|No|Yeah|Okay|Sure|Just|So|Well)\b/g,
    (_, boundary, word) => boundary + word.toLowerCase());
  return s.replace(/(?<!\.)\.$/, '').trim();
}

function applyCasual(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = replacePhrases(s, STANDARD_WORDING);
  s = replacePhrases(s, EVERYDAY_WORDING);
  s = contractEveryday(s);
  s = styleRequests(s, 'casual');
  s = s.replace(/(^|[.!?]\s+|\n)(?:hello|hey)\b/gi, '$1Hi');
  s = s.replace(/(^|[.!?]\s+|\n)thank you\b/gi, '$1Thanks');
  return sentenceCase(s);
}

function sentenceCase(text) {
  return text.replace(/\bi\b/g, 'I')
    .replace(/(^|[.!?]\s+|\n)([a-z][\p{L}\p{N}_]*)/gu,
      (_, boundary, word) => boundary + (/[A-Z]/.test(word) ? word : word[0].toUpperCase() + word.slice(1)));
}

function withStyleTokens(text, transform, protectedTerms = []) {
  return require('./cleanup').withStructuredTokens(text, value => {
    const tokens = [];
    const protect = token => '\uE200' + (tokens.push(token) - 1) + '\uE201';
    let s = value.replace(/```[\s\S]*?```|`[^`\n]+`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]+'(?!\w)|(?:[A-Za-z]:\\|\\\\|\/)[^\s]+|[@#][\w]+|\b(?:Ctrl|Alt|Shift|Win|Cmd)(?:\+[\w]+)+/g, protect);
    for (const term of [...new Set(protectedTerms.filter(t => typeof t === 'string' && t.trim()))].sort((a, b) => b.length - a.length)) {
      s = s.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(term) + '(?![\\p{L}\\p{N}_])', 'gu'), protect);
    }
    return transform(s).replace(/\uE200(\d+)\uE201/g, (_, i) => tokens[Number(i)]);
  });
}

function toneForCategory(category, writingStyles) {
  const styles = normalizeWritingStyles(writingStyles);
  const cat = CATEGORIES.includes(category) ? category : 'other';
  return styles[cat] || DEFAULT_WRITING_STYLES[cat];
}

// Apply wording and typography after filler removal and optional proofreading.
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
  return applyStyleWithTone(text, tone);
}

function applyStyleWithTone(text, tone, language = 'en', protectedTerms = []) {
  if (!/^en(?:-|$)/i.test(language)) return collapseSpaces(text);
  const safeTone = STYLES.includes(tone) ? tone : 'casual';
  return withStyleTokens(text, value => {
    const raw = stripFillers(value.trim());
    return finalizeStyle(raw, safeTone);
  }, protectedTerms);
}

module.exports = {
  STYLES,
  CATEGORIES,
  DEFAULT_WRITING_STYLES,
  DICTATION_QUALITIES,
  normalizeWritingStyles,
  normalizeDictationQuality,
  classifyTarget,
  isFastDictationTarget,
  dictationPath,
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
