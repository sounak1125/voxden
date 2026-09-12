'use strict';

// Google sign-in for a desktop app. The consent page opens in the system
// browser (Google refuses embedded windows), Google sends the user back to a
// one-shot listener on 127.0.0.1, and the code that arrives goes to the
// account service, which holds the client secret and swaps it for the
// identity. Nothing here ever sees a Google token.

const crypto = require('crypto');
const http = require('http');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = 'openid email profile';
const DEFAULT_TIMEOUT_MS = 5 * 60e3;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Proof Key for Code Exchange: the browser carries the challenge, the code
// exchange carries the verifier, so a code stolen from the redirect is useless.
function pkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function authUrl(o) {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: o.codeChallenge,
    code_challenge_method: 'S256',
    state: o.state,
    access_type: 'online',
    prompt: 'select_account',
  });
  if (o.loginHint) params.set('login_hint', o.loginHint);
  return AUTH_URL + '?' + params.toString();
}

// What the browser shows after Google sends the user back.
function callbackPage(ok, message) {
  const title = ok ? 'You are signed in to Voxden' : 'Sign-in did not finish';
  const body = ok ? 'You can close this tab and go back to Voxden.' : message;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101113;color:#eef1ef;font:15px/1.6 "Segoe UI",system-ui,sans-serif}'
    + '.card{max-width:420px;padding:36px 40px;border:1px solid #303631;border-radius:20px;background:#191b1e;box-shadow:0 24px 80px #0008;text-align:center}'
    + '.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:16px;display:grid;place-items:center;background:rgba(156,243,196,.12);color:#9cf3c4;font-size:26px}'
    + 'h1{font-size:20px;font-weight:600;letter-spacing:-.3px;margin:0 0 8px}p{margin:0;color:#a3ada6}</style></head>'
    + '<body><div class="card"><div class="mark">' + (ok ? '&#10003;' : '&#33;') + '</div><h1>' + title + '</h1><p>' + body + '</p></div></body></html>';
}

// The redirect Google made. Only a matching state is a real answer.
function parseCallback(requestUrl, expectedState) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const state = url.searchParams.get('state') || '';
  if (!state || state !== expectedState) return { error: 'That sign-in link is not the one Voxden started. Try again from the app.' };
  const denied = url.searchParams.get('error');
  if (denied) return { error: denied === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google reported ' + denied + '.' };
  const code = url.searchParams.get('code') || '';
  if (!code) return { error: 'Google sent no sign-in code.' };
  return { code };
}

// Runs one sign-in. Resolves with what the account service needs to finish
// it: the code, the PKCE verifier and the exact redirect address. `cancel()`
// ends it early, which is what the app's Cancel button does.
function signIn(options) {
  const o = options || {};
  if (!o.clientId) throw new Error('Google sign-in is not set up on this service yet. Use your email instead.');
  if (typeof o.openExternal !== 'function') throw new Error('No browser is available to open Google in.');
  const { codeVerifier, codeChallenge } = pkce();
  const state = base64url(crypto.randomBytes(16));
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  let settle = null;
  let server = null;
  let timer = null;

  function finish(err, result) {
    if (!settle) return;
    const done = settle;
    settle = null;
    if (timer) clearTimeout(timer);
    if (server) { try { server.close(); } catch (_) {} }
    if (err) done.reject(err); else done.resolve(result);
  }

  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
    server = http.createServer((req, res) => {
      const parsed = parseCallback(req.url || '/', state);
      res.writeHead(parsed.error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(callbackPage(!parsed.error, parsed.error || ''));
      if (parsed.error) {
        // A stray hit on the port is not the user giving up; only a real
        // answer from Google (denied, or no code) ends the wait.
        if (/cancelled|reported|no sign-in code/.test(parsed.error)) finish(new Error(parsed.error));
        return;
      }
      finish(null, { code: parsed.code, codeVerifier, redirectUri: server.redirectUri });
    });
    server.on('error', (err) => finish(new Error('Could not listen for Google on this PC: ' + ((err && err.message) || err))));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.redirectUri = 'http://127.0.0.1:' + port + '/';
      timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), timeoutMs);
      Promise.resolve()
        .then(() => o.openExternal(authUrl({ clientId: o.clientId, redirectUri: server.redirectUri, state, codeChallenge, loginHint: o.loginHint })))
        .catch((err) => finish(new Error('Could not open your browser: ' + ((err && err.message) || err))));
    });
  });

  // A rejection nobody is awaiting yet (the browser answered before the
  // caller attached its handler) must not take the process down.
  promise.catch(() => {});

  return {
    promise,
    cancel() { finish(new Error('Google sign-in was cancelled.')); },
  };
}

module.exports = { pkce, authUrl, parseCallback, callbackPage, signIn, AUTH_URL, SCOPES };
