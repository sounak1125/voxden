'use strict';

const { withStructuredTokens } = require('./cleanup');

// An optional English proofreader, deliberately limited to common mistakes.
// No model, network, paraphrasing, or guessed sentence boundaries. Tone is
// applied afterwards so Very casual keeps its lowercase/no-final-period style.
const AGREEMENT = {
  i: { is: 'am', are: 'am', has: 'have', does: 'do', "doesn't": "don't", "hasn't": "haven't" },
  you: { is: 'are', was: 'were', has: 'have', does: 'do', "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't" },
  we: { is: 'are', was: 'were', has: 'have', does: 'do', "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't" },
  they: { is: 'are', was: 'were', has: 'have', does: 'do', "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't" },
};
const SINGULAR = { are: 'is', have: 'has', do: 'does', "aren't": "isn't", "haven't": "hasn't", "don't": "doesn't" };
for (const subject of ['he', 'she', 'it']) AGREEMENT[subject] = SINGULAR;

const BASE_VERBS = {
  went: 'go', goes: 'go', came: 'come', comes: 'come', did: 'do', does: 'do',
  had: 'have', has: 'have', sees: 'see', knew: 'know', knows: 'know',
  wanted: 'want', wants: 'want', needed: 'need', needs: 'need', said: 'say', says: 'say',
  made: 'make', makes: 'make', took: 'take', takes: 'take', sent: 'send', sends: 'send',
  got: 'get', gets: 'get', liked: 'like', likes: 'like', worked: 'work', works: 'work',
};
// "Saw", "spoke" and "broke" can introduce valid noun phrases ("have saw
// blades", "have broke friends"), so they need a parser and stay untouched.
const PARTICIPLES = { went: 'gone', wrote: 'written', took: 'taken', ate: 'eaten', chose: 'chosen' };

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCase(value, replacement) {
  if (value === value.toUpperCase()) return replacement.toUpperCase();
  return /^[A-Z]/.test(value) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function agreement(subject, verb) {
  const key = verb.toLowerCase().replace(/’/g, "'").replace(/^(dont|doesnt|isnt|arent|wasnt|werent|hasnt|havent)$/, v => v.slice(0, -1) + "'t");
  const replacement = AGREEMENT[subject.toLowerCase()]?.[key] || key;
  return matchCase(verb, verb.includes('’') ? replacement.replace(/'/g, '’') : replacement);
}

function correctGrammar(text) {
  let s = text.replace(/\b(i|you|we|they|he|she|it)([ \t]+)(is|are|was|has|have|does|do|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|hasn['’]?t|haven['’]?t|doesn['’]?t|don['’]?t)\b/gi,
    (whole, subject, gap, verb, offset) => {
      const prefix = text.slice(0, offset).split(/[.!?;\n]/).pop();
      // Avoid coordinated subjects and subjunctives such as "I insist he have"
      // or "if I were". Local substitutions cannot parse their full context.
      if (/\b(?:and|or|nor)[ \t]+$/i.test(prefix)) return whole;
      if (/\b(?:if|that|wish\w*|insist\w*|suggest\w*|recommend\w*|demand\w*|essential|important|request\w*|require\w*|prefer\w*|ask\w*|rather)\b/i.test(prefix)) return whole;
      if (/\b(?:do|does|did|can|could|will|would|should|must|may|might|let|see|saw|hear|heard|watch|watched|make|made)(?:n['’]t)?[ \t]+$/i.test(prefix)) return whole;
      return subject + gap + agreement(subject, verb);
    });
  // Inverted questions, only at an existing sentence/line boundary.
  s = s.replace(/(^|[.!?]\s+|\n)(is|are|was|has|have|does|do)([ \t]+)(i|you|we|they|he|she|it)\b/gi,
    (_, boundary, verb, gap, subject) => boundary + agreement(subject, verb) + gap + subject);
  s = s.replace(/\b(did|didn['’]?t|does|doesn['’]?t|don['’]?t|can|could|should|would|must|might)([ \t]+)([a-z]+)\b/g,
    (whole, auxiliary, gap, verb, offset) => {
      // "What he did went unnoticed" and "Everything she does makes sense"
      // contain two clauses. The second verb already agrees with its subject.
      const prefix = s.slice(0, offset).split(/[.!?;\n]/).pop();
      if (/^(?:did|does)$/.test(auxiliary) && !/(?:^|[,][ \t]*|\b(?:and|but|because)[ \t]+)(?:i|you|we|they|he|she|it)[ \t]+$/i.test(prefix)) return whole;
      return BASE_VERBS[verb] ? auxiliary.replace(/nt$/, "n't") + gap + BASE_VERBS[verb] : whole;
    });
  s = s.replace(/\b(did|does|can|could|should|would|must|might)([ \t]+(?:i|you|we|they|he|she|it)[ \t]+)([a-z]+)\b/gi,
    (whole, auxiliary, subject, verb) => BASE_VERBS[verb] ? auxiliary + subject + BASE_VERBS[verb] : whole);
  s = s.replace(/\b(could|should|would|might|must)([ \t]+)of(?=[ \t]+(?:been|done|gone|seen|known|had|sent|said|made|taken|written|left|come|got)\b)/gi, '$1$2have');
  s = s.replace(/\b(have|has|had|[a-z]+['’]ve)([ \t]+(?:(?:already|just|never|not|recently)[ \t]+)?)(went|wrote|took|ate|chose)\b/g,
    (_, auxiliary, gap, verb) => auxiliary + gap + PARTICIPLES[verb]);
  return s;
}

function isDirectQuestion(text) {
  // "What I need is ..." is a statement. Require auxiliary inversion rather
  // than treating every wh-word as a question. Keep existing punctuation.
  return /^(?:(?:what|where|when|why|how)(?:[ \t]+(?:much|many|long|often))?[ \t]+)?(?:am|is|are|was|were|do|does|did|can|could|will|would|should|have|has|had|may|might|must)(?:n['’]t)?[ \t]+(?:i|you|we|they|he|she|it|there)\b/i.test(text);
}

function autoCleanup(text, { language = 'en', protectedTerms = [] } = {}) {
  const original = String(text || '');
  if (!original.trim() || !/^en(?:-|$)/i.test(language)) return original;
  return withStructuredTokens(original, value => {
    const tokens = [];
    const exactEnd = new Set();
    const protect = (token, keepEnding = true) => {
      const id = tokens.push(token) - 1;
      if (keepEnding) exactEnd.add(id);
      return '\uE100' + id + '\uE101';
    };
    // Exact quotations, code, paths, handles, shortcuts and abbreviations are
    // data, even if their spelling resembles a grammar mistake.
    let s = value.replace(/```[\s\S]*?```|`[^`\n]+`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]+'(?!\w)|(?:[A-Za-z]:\\|\\\\|\/)[^\s]+|[@#][\w]+|\b(?:Ctrl|Alt|Shift|Win|Cmd)(?:\+[\w]+)+|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.|\b(?:[A-Za-z]\.){2,}/g, token => protect(token));
    const terms = [...new Set(protectedTerms.filter(t => typeof t === 'string' && t.trim()))].sort((a, b) => b.length - a.length);
    for (const term of terms) {
      s = s.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(term) + '(?![\\p{L}\\p{N}_])', 'gu'), token => protect(token, false));
    }
    s = correctGrammar(s);
    s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
    s = s.replace(/ +([,;:.!?])/g, '$1').replace(/([,;:])(?=[A-Za-z])/g, '$1 ');
    s = s.replace(/([.!?])(?=[A-Za-z])/g, '$1 ');
    s = s.replace(/\bi\b/g, 'I');
    s = s.replace(/(^|[.!?][ \t]+|\n)([a-z])/g, (_, boundary, letter) => boundary + letter.toUpperCase());
    // Finish each line; never invent breaks in a long unpunctuated thought.
    s = s.split('\n').map(line => {
      const trimmed = line.trimEnd();
      if (!/[A-Za-z]/.test(trimmed) || /[.!?;:,]$/.test(trimmed)) return line;
      const endingToken = trimmed.match(/\uE100(\d+)\uE101$/);
      if (endingToken && exactEnd.has(Number(endingToken[1]))) return line;
      const lastSentence = trimmed.split(/[.!?][ \t]+/).pop().trim();
      // Avoid adding a period to a closing quote, code delimiter, or emoji.
      if (!/[\p{L}\p{N}\uE001\uE101]$/u.test(trimmed)) return line;
      return trimmed + (isDirectQuestion(lastSentence) ? '?' : '.');
    }).join('\n');
    return s.replace(/\uE100(\d+)\uE101/g, (_, i) => tokens[Number(i)]).trim();
  });
}

module.exports = { autoCleanup };
