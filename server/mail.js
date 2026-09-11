'use strict';

// Sends the sign-in code. Resend when a key is configured, otherwise the code
// goes to stdout, which is what local development and the tests want.

const fs = require('fs');

function createMailer(opts) {
  const o = opts || {};
  const apiKey = o.resendApiKey || '';
  const from = o.from || 'Voxden <sign-in@voxden.app>';
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const log = o.log || ((line) => process.stdout.write(line + '\n'));
  // Where unsent codes are appended as well, when there is no provider.
  const codesFile = o.codesFile || '';

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
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('mail provider returned ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
    }
    return { delivered: true, logged: false };
  }

  return { sendCode, configured: !!apiKey };
}

module.exports = { createMailer };
