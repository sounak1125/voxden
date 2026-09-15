'use strict';

// Sends sign-in codes through Resend. An absent provider is not a delivery.

function createMailer(opts) {
  const o = opts || {};
  const apiKey = String(o.resendApiKey || '').trim();
  const from = o.from || 'Voxden <sign-in@voxden.app>';
  const fetchImpl = o.fetchImpl || globalThis.fetch;

  async function post(payload) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // Provider bodies can contain recipient data; keep diagnostics minimal.
      throw new Error('mail provider returned ' + res.status);
    }
  }

  async function sendCode({ to, code, minutes }) {
    if (!apiKey) throw new Error('Email delivery is not configured.');
    const subject = code + ' is your Voxden sign-in code';
    const text = 'Your Voxden sign-in code is ' + code + '. It expires in ' + minutes
      + ' minutes.\n\nIf you did not ask for it, ignore this email; nobody can sign in without the code.';
    await post({ from, to: [to], subject, text });
    return { delivered: true, logged: false };
  }

  return { sendCode, configured: !!apiKey };
}

module.exports = { createMailer };
