'use strict';

// Feedback and bug reports. What the app sends to the account service, and
// the GitHub issue it can open instead when that service cannot be reached.
// Pure, so the main process, the server tests and the unit tests share it.

const KINDS = Object.freeze(['bug', 'idea', 'other']);
const MAX_MESSAGE = 4000;
const ISSUES_URL = 'https://github.com/sounak1125/voxden/issues/new';
const TITLES = Object.freeze({ bug: '[Bug]', idea: '[Idea]', other: '[Feedback]' });

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return KINDS.includes(kind) ? kind : '';
}

function cleanMessage(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

// What the app knows about itself that helps reproduce a report. Nothing here
// identifies the user beyond their plan.
function diagnosticsText(d) {
  const info = d || {};
  const lines = [];
  if (info.version) lines.push('Voxden ' + info.version);
  if (info.os) lines.push(info.os);
  if (info.cloud) lines.push('Recognizer: Voxden Cloud');
  else if (info.engine) lines.push('Recognizer: ' + info.engine + (info.device ? ' on ' + info.device : ''));
  if (info.language) lines.push('Dictation language: ' + info.language);
  if (info.plan) lines.push('Plan: ' + info.plan);
  return lines.join('\n');
}

// Checks a report from the renderer and shapes it for the wire. `diagnostics`
// is attached only when the user left "include app details" on.
function prepare(input, diagnostics) {
  const body = input && typeof input === 'object' ? input : {};
  const kind = normalizeKind(body.kind);
  if (!kind) return { ok: false, error: 'Say whether this is a bug, an idea, or something else.' };
  const message = cleanMessage(body.message);
  if (!message) return { ok: false, error: 'Write a few words first.' };
  if (message.length > MAX_MESSAGE) return { ok: false, error: 'Keep it under ' + MAX_MESSAGE.toLocaleString() + ' characters.' };
  const email = cleanEmail(body.email);
  if (email === null) return { ok: false, error: 'Enter a valid email address, or leave it empty.' };
  const report = { kind, message };
  if (email) report.email = email;
  if (body.includeDetails !== false && diagnostics && typeof diagnostics === 'object') {
    report.diagnostics = Object.assign({}, diagnostics);
  }
  return { ok: true, body: report };
}

// A prefilled new-issue page for when the service is down. The message goes
// in the body; the details, when included, follow a rule.
function issueUrl(report) {
  const r = report || {};
  const kind = normalizeKind(r.kind) || 'other';
  const message = cleanMessage(r.message);
  const firstLine = message.split('\n')[0].slice(0, 70);
  const title = TITLES[kind] + ' ' + (firstLine || 'Feedback from the app');
  const details = r.diagnostics ? diagnosticsText(r.diagnostics) : '';
  const body = message + (details ? '\n\n---\n' + details : '');
  const params = new URLSearchParams({ title, body });
  return ISSUES_URL + '?' + params.toString();
}

module.exports = { KINDS, MAX_MESSAGE, ISSUES_URL, normalizeKind, cleanMessage, cleanEmail, diagnosticsText, prepare, issueUrl };
