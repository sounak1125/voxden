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

// macOS has no executable name to read: the helper reports the frontmost app's
// bundle identifier instead. Same four categories, same meaning, keyed by the
// id. Matching is case-insensitive and by whole dotted segment, so
// com.google.Chrome also covers com.google.Chrome.canary while
// com.microsoft.Outlook and com.microsoft.VSCode stay apart.
const BUNDLE_RULES = {
  personal: [
    'net.whatsapp.whatsapp', 'com.hnc.discord', 'ru.keepcoder.telegram',
    'org.whispersystems.signal-desktop', 'com.apple.ichat', 'com.apple.mobilesms',
    'com.facebook.archon', 'com.burbn.instagram', 'com.reddit.reddit',
    'com.tencent.xinwechat', 'jp.naver.line.mac', 'com.viber.osx',
    'com.skype.skype', 'com.toyopagroup.picaboo',
  ],
  work: [
    'com.tinyspeck.slackmacgap', 'com.microsoft.teams', 'com.microsoft.teams2',
    'us.zoom.xos', 'com.cisco.webexmeetingsapp', 'com.webex.meetingmanager',
    'com.notion.id', 'com.linear', 'com.electron.asana', 'com.asana.nativeapp',
    'com.clickup.desktop-app', 'com.atlassian.trello', 'com.atlassian',
    'com.figma.desktop', 'com.monday.monday',
  ],
  email: [
    'com.microsoft.outlook', 'com.apple.mail', 'com.superhuman.electron',
    'com.superhuman.mail', 'org.mozilla.thunderbird', 'com.mailbird.mailbird',
    'com.postbox-inc.postbox', 'com.emclient.mail',
  ],
};

const BROWSER_BUNDLES = new Set([
  'com.apple.safari', 'com.apple.safaritechnologypreview', 'com.google.chrome',
  'org.mozilla.firefox', 'com.brave.browser', 'com.microsoft.edgemac',
  'company.thebrowser.browser', 'com.operasoftware.opera', 'com.vivaldi.vivaldi',
]);

// A tone changes capitals and punctuation, never words: the words on the page
// are the words that were said. What goes is sound, not speech.
//
// Fillers are um, uh and hmm in their longer spellings. Not in capitals --
// UM, UH and HMM are acronyms -- and not joined by a hyphen, because "uh-huh"
// and "mm-hmm" are answers. A trailing ellipsis is part of the filler.
const FILLER = "(?<![\\p{L}\\p{N}_'’-])(?:[Uu](?:m+|h+m*)|[Hh]m+)(?![\\p{L}\\p{N}_'’-])[\\uE301…]?";
// "..." while fillers come out: one character, so a filler takes all of its
// ellipsis or none of it and never leaves a stray "." behind.
const DOTS = '\uE301';
// "you know" is the one spoken aside that goes, and only where punctuation
// marks it off: "I was, you know, thinking". Bare it is part of the sentence
// ("you know I'm right") and stays.
const ASIDE = "(?<![\\p{L}\\p{N}_'’-])[Yy]ou know(?![\\p{L}\\p{N}_'’-])";
const MARK = '[,;:\\u2013\\u2014-]';
const ITEM = '(?:' + FILLER + '|' + ASIDE + ')';
const RUN = ITEM + '(?:\\s*' + MARK + '?\\s*' + ITEM + ')*';
const FILLER_RUN = FILLER + '(?:\\s*' + MARK + '?\\s*' + FILLER + ')*';
const SENTENCE_START = '(^|[.!?]\\s+|\\n)';
// Asides that stay. Next to one of these, one comma of "you know" belongs to
// the neighbour: "I was, you know, like, thinking" -> "I was, like, thinking".
const KEPT_ASIDE = '(?:like|I mean|kind of|sort of)';
// Where a filler came out, until the capital after it has been checked.
const GAP = '\uE300';

// Everyday words the common-word list (src/phonetics.js) leaves out: speech,
// the verbs of a request, and the nouns of apps and prompts. With that list,
// and their -s, -ed, -ing and -ly forms, they are the words Very casual may
// put in lower case at the start of a sentence. Anything else could be a name
// and keeps its capital.
const EVERYDAY_EXTRA = new Set((
  // talk
  'okay ok yeah yep yup nope hey hi hmm wow oh ah alright anyway anyways yo bro dude bye thanks thank '
  + 'sorry please cool nice great awesome perfect fine done sure right wait listen suppose like just so '
  + 'then now here there gonna wanna gotta lemme gimme kinda sorta '
  // adverbs and joins
  + 'actually basically honestly literally really seriously obviously probably definitely apparently '
  + 'currently finally generally mostly usually exactly especially maybe perhaps also else instead '
  + 'otherwise meanwhile besides although unless whatever whichever whoever whenever wherever somehow '
  + 'someone something somewhere somebody anyone anything anywhere anybody everyone everything '
  + 'everywhere everybody nobody noone nothing nowhere neither therefore moreover furthermore '
  + 'hopefully unfortunately luckily initially recently previously manual main sometimes overall '
  + 'according till total complete full simple clear direct easy quick slow '
  // verbs, including the forms that do not follow a rule
  + 'does doing having gave kept shown gone felt knew built ran paid said told thought brought bought '
  + 'analyze analyse implement commit merge deploy rebuild uninstall identify summarize summarise '
  + 'rewrite refactor debug verify confirm replace rename convert format render export release launch '
  + 'resume enable disable ensure exclude adjust decrease optimize simplify sketch schedule organize '
  + 'filter combine attach insert append zoom update create remove delete generate select click '
  + 'scroll paste copy upload download install restart reload refresh test fix build run open close '
  + 'hide show move change keep add give make use try check send share tell ask let '
  // the things apps and prompts are about
  + 'user app file image video button screen feature version prompt shot camera character background '
  + 'color style mode icon logo menu setting option model engine audio mic microphone recording '
  + 'transcript dictionary account payment credit balance sheet section scene frame angle lighting '
  + 'shadow glow border layout theme font width height speed code bug error issue server client '
  + 'database data link website homepage dashboard sidebar header footer title label input output '
  + 'toggle slider checkbox dropdown popup dialog overlay notification chat email project task item '
  + 'stuff electricity subscription pricing category insight precious beautiful pretty cute '
  + 'yes no not').split(' '));

// Common words that are also names people and apps go by. At the start of a
// sentence there is no telling which is meant, so they keep their capital.
const NAME_WORDS = new Set(('mark bill rose grace hope faith joy frank jack max summer ruby lily holly '
  + 'ivy iris violet victor earl guy ray dawn rich pat sue chase hunter mason taylor carter cook baker '
  + 'deep sunny apple windows word excel chrome edge slack teams notion signal discord cursor linear '
  + 'amazon python java swift rust jordan austin paris china india turkey jersey march april june '
  + 'august').split(' '));
// Names that are also modal verbs: "Will you check?" is a question, "Will is
// here" a person. The word after decides.
const MODAL_NAMES = new Set(['will', 'may']);
const AFTER_MODAL = /^\s*(?:i|you|we|they|he|she|it|this|that|there|the|a|an|my|your|our|their|his|her|its|someone|anyone|everyone|something|anything|not)\b/i;

function cleanupModule() {
  return require('./cleanup');
}

function contractionBase(word) {
  const w = word.toLowerCase().replace(/’/g, "'");
  if (w.endsWith("n't")) return { ca: 'can', wo: 'will', sha: 'shall' }[w.slice(0, -3)] || w.slice(0, -3);
  return w.replace(/'(?:s|re|ll|ve|d|m)$/, '');
}

function isKnownWord(word) {
  return require('./phonetics').COMMON_WORDS.has(word) || EVERYDAY_EXTRA.has(word);
}

// The word or a regular form of it: users, fixes, tried, moving, stopped,
// mainly, easily. A stem of one or two letters proves nothing (Ted, Ned).
function isKnownForm(w) {
  if (isKnownWord(w)) return true;
  const stems = [];
  if (w.endsWith('ies') || w.endsWith('ied')) stems.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ily')) stems.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) stems.push(w.slice(0, -2));
  if (w.endsWith('s')) stems.push(w.slice(0, -1));
  if (w.endsWith('ed')) stems.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
  if (w.endsWith('ing')) stems.push(w.slice(0, -3), w.slice(0, -3) + 'e', w.slice(0, -4));
  if (w.endsWith('ly')) stems.push(w.slice(0, -2));
  return stems.some(stem => stem.length > 2 && isKnownWord(stem));
}

// An ordinary English word written with only its first letter capitalised.
// "I" is never one: it is always written that way.
function isEverydayWord(word) {
  if (!/^\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?$/u.test(word) || /^I(?:['’]|$)/.test(word)) return false;
  const base = contractionBase(word);
  if (NAME_WORDS.has(base)) return false;
  return isKnownForm(base);
}

function lowerFirst(word) {
  return word[0].toLowerCase() + word.slice(1);
}

// The target is a bundle id when it is dotted and is not an exe name. That is
// all classifyTarget needs to tell the two platforms apart, so one call site
// can hand it either form.
function asBundleId(target) {
  const raw = String(target || '').trim().toLowerCase();
  if (!raw || !raw.includes('.') || raw.endsWith('.exe')) return '';
  return raw;
}

// A whole dotted segment, so com.google.chrome matches com.google.chrome.canary
// but com.microsoft.teams does not swallow com.microsoft.teams2 -- that one is
// listed in its own right.
function bundleUnder(bundle, prefix) {
  return bundle === prefix || bundle.startsWith(prefix + '.');
}

function bundleMatches(bundle, prefixes) {
  const id = asBundleId(bundle);
  if (!id) return false;
  for (const prefix of prefixes) {
    if (bundleUnder(id, prefix)) return true;
  }
  return false;
}

function isBrowserBundle(bundle) {
  for (const id of BROWSER_BUNDLES) {
    if (bundleUnder(bundle, id)) return true;
  }
  return false;
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

// `target` is a Windows executable name or a macOS bundle id; both describe the
// app the text is going into, and both fall back to the window title.
function classifyTarget(target, title) {
  const bundle = asBundleId(target);
  for (const cat of ['personal', 'work', 'email']) {
    if (bundle ? bundleMatches(bundle, BUNDLE_RULES[cat]) : exeMatches(target, EXE_RULES[cat])) return cat;
  }

  const e = bundle || normalizeExe(target);
  const useTitle = !e || (bundle
    ? isBrowserBundle(bundle)
    : BROWSER_EXES.has(e) || e === 'applicationframehost.exe');
  if (useTitle || e) {
    for (const cat of ['email', 'work', 'personal']) {
      if (titleMatches(title, TITLE_RULES[cat])) return cat;
    }
  }

  return 'other';
}

const FAST_CATEGORIES = new Set(['personal', 'work']);
const FAST_AI_EXES = new Set(['chatgpt.exe', 'claude.exe']);
const FAST_AI_BUNDLES = ['com.openai.chat', 'com.anthropic.claudefordesktop'];
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
  const bundle = asBundleId(info.exe);
  if (bundle) {
    if (bundleMatches(bundle, FAST_AI_BUNDLES)) return true;
  } else if (FAST_AI_EXES.has(normalizeExe(info.exe))) {
    return true;
  }
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

// Filler removal happens after cleanup(), so the engine's punctuation is
// already there. Take the punctuation that belongs to a filler with it rather
// than leave "I was, , thinking" or a leading comma, and take a whole run at
// once -- "um, you know, I think" -- so no comma is left stranded between two.
function removeFillers(text) {
  let s = String(text || '').replace(/\.{3,}/g, DOTS);
  const keptAfter = new RegExp('^' + KEPT_ASIDE + '\\s*' + MARK, 'iu');
  const keptBefore = new RegExp(MARK + '\\s*' + KEPT_ASIDE + '$', 'iu');
  // A filler's own ellipsis closes it off as well as a comma would:
  // "again, uh... add".
  s = s.replace(new RegExp('\\s*' + MARK + '\\s*' + RUN + '(?:\\s*' + MARK + '|(?<=[' + DOTS + '…]))\\s*', 'gu'), (match, offset, whole) => {
    if (keptAfter.test(whole.slice(offset + match.length)) || keptBefore.test(whole.slice(0, offset))) return ', ';
    return ' ' + GAP + ' ';
  });
  // The engine opens a sentence at "You know," with no stop before it --
  // "when it You know, the mouse" -- and the capital marks it off instead.
  s = s.replace(new RegExp('(?<=[\\p{L}\\p{N}])[ \\t]+You know\\s*' + MARK + '\\s*', 'gu'), ' ' + GAP + ' ');
  // At a sentence start "you know" needs its comma to count as an aside
  // ("You know, I think"); a sound goes with or without one.
  s = s.replace(new RegExp(SENTENCE_START + RUN + '\\s*' + MARK + '\\s*', 'gu'), '$1');
  s = s.replace(new RegExp(SENTENCE_START + FILLER_RUN + '\\s*' + MARK + '?\\s*', 'gu'), '$1');
  s = s.replace(new RegExp('\\s*' + MARK + '\\s*' + RUN + '(?=\\s*(?:[.!?]|$))', 'gu'), '');
  s = s.replace(new RegExp('[ \\t]*' + FILLER + '(?:[ \\t]*' + MARK + ')?', 'gu'), ' ' + GAP + ' ');
  return restoreCapitalsAfterGaps(s).replace(new RegExp(DOTS, 'g'), '...');
}

// The engine capitalises the word after a filler as if a sentence started
// there: "should be, you know, Add a section". With the filler gone, an
// everyday word mid-sentence goes back to lower case.
function restoreCapitalsAfterGaps(text) {
  const { endsSentence } = cleanupModule();
  const re = new RegExp(GAP + "[\\s" + GAP + "]*(\\p{Lu}\\p{Ll}*(?:['’]\\p{Ll}+)?)(?![\\p{L}\\p{N}_])", 'gu');
  const s = text.replace(re, (match, word, offset, whole) => {
    const before = whole.slice(0, offset).replace(new RegExp('[\\s' + GAP + ']+$', 'u'), '');
    if (!before || /\n[ \t]*$/.test(whole.slice(0, offset)) || endsSentence(before)) return match;
    return isEverydayWord(word) && !MODAL_NAMES.has(word.toLowerCase()) ? ' ' + lowerFirst(word) : match;
  });
  return s.replace(new RegExp(GAP, 'g'), ' ');
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

// Filler removal does not depend on tone. "Um" is not a word the speaker
// chose, and a casual message is a short message, not a less tidy one.
// Verbatim mode is the switch for keeping every filler.
function stripFillers(text) {
  let s = String(text || '');
  if (!s) return '';
  s = removeFillers(s);
  return tidyAfterFillerRemoval(s);
}

// Small words the engine capitalises mid-sentence as if one had started there:
// "also Let's update", "you Don't update", "I think Like this". Only with a
// lower-case word on both sides -- a capital beside it makes it part of a
// title or a name: "turn on Do Not Disturb", "watching The Office".
const FUNCTION_WORDS = new Set(('a an the and or but so if then because as of to in on at by for from '
  + 'with into about like let is are was were be been being do does did have has had can could would '
  + 'should shall might must not it its this that these those there here you your we our they their he '
  + 'his she her him them us me my what which who where when why how also just now well yeah yes okay '
  + 'ok no please maybe actually even still too very really').split(' '));

function lowerStrayCapitals(text) {
  return text.replace(/(?<=\p{Ll}[,;:]?[ \t]+)\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?(?=[ \t]+\p{Ll})/gu,
    word => (FUNCTION_WORDS.has(contractionBase(word)) ? lowerFirst(word) : word));
}

// The pronoun, on its own or in I'm/I'll -- never the i of "i.e.".
function capitalizePronoun(text) {
  return text.replace(/(?<![\p{L}\p{N}_.'\u2019-])i(?![\p{L}\p{N}_-]|\.\p{L})/gu, 'I');
}

// Very casual writes every sentence in lower case, except where the first
// word is a name: only an everyday word loses its capital, so Alex, NASA,
// iPhone and a dictionary spelling keep theirs.
function lowerSentenceStart(word, after) {
  if (!isEverydayWord(word)) return word;
  if (MODAL_NAMES.has(word.toLowerCase()) && !AFTER_MODAL.test(after)) return word;
  return lowerFirst(word);
}

// Capitals at every sentence start, the closing full stop added.
function applyFormal(text) {
  let s = applyCasual(text);
  if (s && /[\p{L}\p{N}\uE001]$/u.test(s)) s += '.';
  return s;
}

// Capitals at every sentence start; the punctuation as the engine wrote it.
function applyCasual(text) {
  const s = capitalizePronoun(collapseSpaces(text));
  return s ? cleanupModule().mapSentenceStarts(s, cleanupModule().capitalizeWord, { lineStarts: true }) : '';
}

// No capital at a sentence start, and no closing full stop on a line. "?",
// "!", an ellipsis and an abbreviation's own stop stay.
function applyVeryCasual(text) {
  const { mapSentenceStarts, endsSentence } = cleanupModule();
  const s = capitalizePronoun(collapseSpaces(text));
  if (!s) return '';
  return mapSentenceStarts(s, lowerSentenceStart, { lineStarts: true })
    .replace(/(\S+)\.(?=[ \t]*(?:\n|$))/g, (match, word) => (endsSentence(word + '.') ? word : match));
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

// Apply the tone's capitals and punctuation after filler removal and optional
// proofreading.
function finalizeStyle(text, tone) {
  const safeTone = STYLES.includes(tone) ? tone : 'casual';
  const raw = lowerStrayCapitals(tidyAfterFillerRemoval(String(text || '').trim()));
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
