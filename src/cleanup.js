'use strict';

function applyVoiceCommands(text) {
  let s = text;
  s = s.replace(/\bnew paragraph\b/gi, '\n\n');
  s = s.replace(/\bnew line\b/gi, '\n');
  s = s.replace(/\bnewline\b/gi, '\n');
  s = s.replace(/\bquestion mark\b/gi, '?');
  s = s.replace(/\bexclamation mark\b/gi, '!');
  s = s.replace(/\bfull stop\b/gi, '.');
  s = s.replace(/\bperiod\b/gi, '.');
  s = s.replace(/\bcomma\b/gi, ',');
  return s;
}

function applyScratchThat(text) {
  const parts = text.split(/\bscratch that\b/gi);
  if (parts.length === 1) return text;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      out = parts[i];
      continue;
    }
    out = out.replace(/[\s]*[^.?!\n]*$/, '');
    out += parts[i];
  }
  return out;
}

function capitalizeSentences(text) {
  const chars = text.split('');
  let cap = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) continue;
    if (cap && /[a-z]/.test(ch)) {
      chars[i] = ch.toUpperCase();
      cap = false;
    } else {
      cap = false;
    }
    if (/[.!?]/.test(ch)) cap = true;
    if (ch === '\n') cap = true;
  }
  return chars.join('');
}

function tidyPunct(text) {
  let s = text.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/ +([.,!?])/g, '$1');
  s = s.replace(/([.!?])([A-Za-z])/g, '$1 $2');
  s = s.replace(/,([^\s])/g, ', $1');
  s = s.replace(/\s+([.!?])/g, '$1');
  return s;
}

function stripHallucinations(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  const whole = s.replace(/[.!?]+$/g, '').trim().toLowerCase();
  if (
    whole === 'thanks for watching' ||
    whole === 'thank you for watching' ||
    whole === 'please subscribe' ||
    whole === 'subscribe' ||
    whole === 'the end' ||
    whole === 'you' ||
    /^subtitles by\b/.test(whole)
  ) {
    return '';
  }
  s = s.replace(
    /\s+(thanks for watching|thank you for watching|please subscribe)\.?\s*$/i,
    ''
  );
  return s.trim();
}

function wordKey(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '');
}

function phraseKey(words) {
  return words.map(wordKey).filter(Boolean).join(' ');
}

function collapseAdjacentWords(words) {
  const out = [];
  for (const word of words) {
    const key = wordKey(word);
    const prev = out[out.length - 1];
    if (key && prev && wordKey(prev) === key) {
      const prevCore = prev.replace(/[^a-z0-9']/gi, '');
      const nextCore = word.replace(/[^a-z0-9']/gi, '');
      if (nextCore && nextCore.length === word.length && prevCore.length !== prev.length) {
        out[out.length - 1] = word;
      }
      continue;
    }
    out.push(word);
  }
  return out;
}

function collapseAdjacentPhrases(words) {
  let next = words.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const maxLen = Math.min(8, Math.floor(next.length / 2));
    for (let len = maxLen; len >= 2; len--) {
      let i = 0;
      while (i + len * 2 <= next.length) {
        const a = phraseKey(next.slice(i, i + len));
        const b = phraseKey(next.slice(i + len, i + len * 2));
        if (a && a === b) {
          next.splice(i + len, len);
          changed = true;
          continue;
        }
        i += 1;
      }
    }
  }
  return next;
}

function dedupeRepeats(text) {
  const lines = String(text || '').split('\n');
  const outLines = [];
  for (const line of lines) {
    let words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      outLines.push('');
      continue;
    }
    words = collapseAdjacentWords(words);
    words = collapseAdjacentPhrases(words);
    outLines.push(words.join(' '));
  }
  return outLines.join('\n').trim();
}

function cleanup(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  s = stripHallucinations(s);
  if (!s) return '';
  s = applyVoiceCommands(s);
  s = applyScratchThat(s);
  s = tidyPunct(s);
  s = capitalizeSentences(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return s;
}

module.exports = {
  cleanup,
  dedupeRepeats,
  applyVoiceCommands,
  applyScratchThat,
  capitalizeSentences,
  stripHallucinations,
};
