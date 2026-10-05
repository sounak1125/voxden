'use strict';

// Spoken corrections: which words of a dictation the speaker took back ("on
// the field, no, no, in the park"; "And push to main. No, no, don't push to
// main."). A text model names the pieces to take out, copied from the
// transcript. It never returns the text itself, so it cannot change any other
// word, and an answer of a few words comes back fast. The app takes a piece
// out only after its own check (src/spoken-corrections.js checkModelEdit):
// words taken back, then the cue, then at most a short echo.
//
// Trialled on 2026-10-05 with the owner's real dictations and the ones that
// only sound like corrections (temp/self-correction): GPT-OSS-120B on
// Cerebras was right on 13 of 14 in a median 0.6 s, GPT-4.1 mini on 14 of 14
// in 1.6 s, and the app's check turned down every wrong piece from either.
// So the fast one answers first and the careful one when it fails.
//
// Like Polish, every request goes to zero-data-retention endpoints only.

const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_FALLBACK_MODEL = 'openai/gpt-4.1-mini';
// A dictation is sent only when it has a cue word, and only this much of one.
const MAX_WORDS = 400;
const ATTEMPT_MS = 4000;
const MAX_PIECES = 8;

// Per model: GPT-OSS reasons a little before answering, and Cerebras is what
// makes it fast; another zero-retention host is allowed when Cerebras is down.
const MODEL_REQUEST = {
  'openai/gpt-oss-120b': {
    reasoning: { effort: 'low' },
    provider: { zdr: true, order: ['cerebras'], allow_fallbacks: true },
  },
};

const PROMPT = [
  'You are the correction step of a dictation app. You receive a transcript of something a person said, inside <transcript> tags.',
  '',
  'People sometimes take back what they just said and say it again the way they meant it: "on the field, no, no, in the park"; "And push to main. No, no, don\'t push to main."; "Rahul, sorry, Rohit"; "at 3, wait, 4". For each place where that happens, find the piece to delete: the words they took back, the correction word ("no", "no no", "sorry", "wait", "I mean", "actually"), and any repeat of what they took back ("not in the field"). Deleting it must leave the text reading the way they finally meant it.',
  '',
  'Copy each piece exactly as it appears in the transcript, character for character, including punctuation and filler words. List the pieces in the order they appear. Return an empty list when nothing was taken back.',
  '',
  '"No", "sorry" or "I mean" that answers someone, apologises, disagrees with the listener or explains is not a correction: "No, no, you changed too much, keep it simple." and "Sorry, my bad, it closed." and "I told you not to show the bottom. I mean, see, it is isometric." have nothing to delete.',
  '',
  'Examples:',
  '<transcript>The cat is running on the field. Uh, no, no. in the park.</transcript> -> ["on the field. Uh, no, no."]',
  '<transcript>Yes, let\'s commit. And push to mean. No, no, don\'t push to main. Maybe we can revert it.</transcript> -> ["And push to mean. No, no,"]',
  '<transcript>Okay, so let\'s walk into the field. Uh. No, no, not in the field. Let\'s put it in the water.</transcript> -> ["walk into the field. Uh. No, no, not in the field. Let\'s"]',
  '<transcript>Send it to Rahul, sorry, Rohit by tonight.</transcript> -> ["Rahul, sorry,"]',
  '<transcript>No, no, you made it way too dark. Can we keep the old colours?</transcript> -> []',
  '',
  'Return the pieces in the "remove" field.',
].join('\n');

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'pieces',
    strict: true,
    schema: {
      type: 'object',
      properties: { remove: { type: 'array', items: { type: 'string' } } },
      required: ['remove'],
      additionalProperties: false,
    },
  },
};

const wordCount = (text) => (String(text || '').trim().match(/\S+/g) || []).length;

// The pieces out of a model's answer, or null when there is no answer to use:
// nothing came back, it did not parse, or a piece is not in the transcript.
function piecesFrom(content, text) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.remove) ? parsed.remove : null;
  if (!list || list.length > MAX_PIECES) return null;
  const lower = String(text).toLowerCase();
  const pieces = [];
  for (const item of list) {
    const piece = typeof item === 'string' ? item.trim() : '';
    if (!piece) continue;
    if (!lower.includes(piece.toLowerCase())) return null;
    pieces.push(piece);
  }
  return pieces;
}

function createCorrector(options) {
  const opts = options || {};
  const apiKey = String(opts.apiKey || '');
  const url = String(opts.url || DEFAULT_URL);
  const model = String(opts.model || DEFAULT_MODEL);
  const fallbackModel = opts.fallbackModel === '' ? '' : String(opts.fallbackModel || DEFAULT_FALLBACK_MODEL);
  const attemptMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : ATTEMPT_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  // One model, one answer: { pieces, cost }, or a coded error (timeout,
  // cancelled, upstream, unusable).
  async function attempt(useModel, text, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    const cancel = () => controller.abort();
    if (signal && signal.aborted) cancel();
    else if (signal) signal.addEventListener('abort', cancel, { once: true });
    let res;
    let parsed = null;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://voxden.app',
          'X-Title': 'Voxden',
        },
        body: JSON.stringify(Object.assign({
          model: useModel,
          temperature: 0,
          max_tokens: 1500,
          usage: { include: true },
          provider: { zdr: true },
          response_format: RESPONSE_FORMAT,
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: '<transcript>' + text + '</transcript>' },
          ],
        }, MODEL_REQUEST[useModel] || {})),
        signal: controller.signal,
      });
      try { parsed = await res.json(); } catch (err) {
        if (controller.signal.aborted) throw err;
      }
    } catch (err) {
      if (signal && signal.aborted) throw Object.assign(new Error('Correction cancelled.'), { code: 'cancelled' });
      if (controller.signal.aborted) throw Object.assign(new Error('The correction model timed out.'), { code: 'timeout' });
      throw Object.assign(new Error('The correction model could not be reached.'), { code: 'upstream' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
    }
    if (!res.ok) {
      const message = (parsed && parsed.error && parsed.error.message) || ('status ' + res.status);
      throw Object.assign(new Error('The correction model returned ' + res.status + ': ' + message), { code: 'upstream' });
    }
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const pieces = piecesFrom(choice && choice.message ? choice.message.content : '', text);
    const cost = Number(parsed && parsed.usage && parsed.usage.cost) || 0;
    if (!pieces) throw Object.assign(new Error('The correction model gave no usable answer.'), { code: 'unusable', cost });
    return { pieces, cost };
  }

  // { remove, model, cost, fallback } for a dictation, or a coded error.
  async function takeBack(request) {
    const req = request || {};
    const text = String(req.text || '').trim();
    if (!text) throw Object.assign(new Error('Nothing to check.'), { code: 'empty' });
    if (wordCount(text) > MAX_WORDS) throw Object.assign(new Error('Too long to check.'), { code: 'long' });
    let first;
    try {
      first = await attempt(model, text, req.signal);
      return { remove: first.pieces, model, cost: first.cost, fallback: false };
    } catch (err) {
      if (err.code === 'cancelled' || !fallbackModel || fallbackModel === model) throw err;
      const second = await attempt(fallbackModel, text, req.signal);
      return { remove: second.pieces, model: fallbackModel, cost: (Number(err.cost) || 0) + second.cost, fallback: true };
    }
  }

  return { configured: !!apiKey, model, fallbackModel, takeBack };
}

module.exports = { createCorrector, piecesFrom, PROMPT, MAX_WORDS, DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL };
