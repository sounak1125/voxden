'use strict';

// Sends the sign-in code, and forwards feedback to the people who build
// Voxden. Resend when a key is configured, otherwise everything goes to
// stdout, which is what local development and the tests want.

const fs = require('fs');

function createMailer(opts) {
  const o = opts || {};
  const apiKey = o.resendApiKey || '';
  const from = o.from || 'Voxden <sign-in@voxden.app>';
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const log = o.log || ((line) => process.stdout.write(line + '\n'));
  // Where unsent codes are appended as well, when there is no provider.
  const codesFile = o.codesFile || '';
  // The inbox that receives feedback. Reports are stored either way; this
  // only decides whether they are also mailed.
  const feedbackTo = o.feedbackTo || '';

  async function post(payload) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('mail provider returned ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
    }
  }

  async function sendCode({ to, code, minutes }) {
    const subject = code + ' is your Voxden sign-in code';
    const text = 'Your Voxden sign-in code is ' + code + '. It expires in ' + minutes
      + ' minutes.\n\nIf you did not ask for it, ignore this email; nobody can sign in without the code.';
    if (!apiKey) {
      log('[mail] to=' + to + ' code=' + code);
      if (codesFile) {
        try {
          fs.mkdirSync(require('path').dirname(codesFile), { recursive: true });
          fs.appendFileSync(codesFile, new Date().toISOString() + ' ' + to + ' ' + code + '\n');
        } catch (_) {}
      }
      return { delivered: false, logged: true };
    }
    await post({ from, to: [to], subject, text });
    return { delivered: true, logged: false };
  }

  // A report on its way to the inbox. The sender's address, when they gave
  // one, becomes the reply-to so answering is one click.
  async function sendFeedback({ kind, message, email, diagnostics }) {
    const firstLine = String(message || '').split('\n')[0].slice(0, 70);
    const subject = '[Voxden ' + kind + '] ' + (firstLine || 'feedback');
    const text = String(message || '')
      + '\n\n---\nFrom: ' + (email || 'no address given')
      + (diagnostics ? '\n' + diagnostics : '');
    if (!apiKey || !feedbackTo) {
      log('[feedback] kind=' + kind + ' from=' + (email || '-') + ' ' + JSON.stringify(firstLine));
      return { delivered: false, logged: true };
    }
    const payload = { from, to: [feedbackTo], subject, text };
    if (email) payload.reply_to = email;
    await post(payload);
    return { delivered: true, logged: false };
  }

  return { sendCode, sendFeedback, configured: !!apiKey, feedbackConfigured: !!(apiKey && feedbackTo) };
}

module.exports = { createMailer };
