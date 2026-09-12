'use strict';
// Google sign-in on the desktop side: PKCE, the consent URL, the loopback
// listener, and the ways a sign-in can end.
const assert = require('assert');
const crypto = require('crypto');
const googleAuth = require('../src/google-auth');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

async function main() {
  const { codeVerifier, codeChallenge } = googleAuth.pkce();
  eq('the verifier is URL-safe and long enough', /^[A-Za-z0-9_-]{43}$/.test(codeVerifier), true);
  eq('the challenge is the S256 of the verifier', codeChallenge,
    crypto.createHash('sha256').update(codeVerifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

  const url = new URL(googleAuth.authUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:4567/', state: 'st', codeChallenge: 'ch', loginHint: 'me@example.com' }));
  eq('the consent page is Google\'s', url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  eq('it asks for a code with PKCE and the identity scopes', [url.searchParams.get('response_type'), url.searchParams.get('code_challenge_method'), url.searchParams.get('scope'), url.searchParams.get('client_id'), url.searchParams.get('redirect_uri'), url.searchParams.get('login_hint')],
    ['code', 'S256', 'openid email profile', 'cid.apps.googleusercontent.com', 'http://127.0.0.1:4567/', 'me@example.com']);

  eq('a callback with the right state yields the code', googleAuth.parseCallback('/?state=abc&code=4%2Fxyz', 'abc'), { code: '4/xyz' });
  eq('the wrong state is refused', googleAuth.parseCallback('/?state=nope&code=x', 'abc').error.startsWith('That sign-in link is not the one'), true);
  eq('a denied consent says so', googleAuth.parseCallback('/?state=abc&error=access_denied', 'abc'), { error: 'Google sign-in was cancelled.' });
  eq('the callback page says what to do next', googleAuth.callbackPage(true, '').includes('close this tab'), true);

  // A whole sign-in against the real loopback listener, with the browser
  // stood in for by a function that visits the redirect itself.
  let opened = '';
  const attempt = googleAuth.signIn({ clientId: 'cid', timeoutMs: 5000, openExternal: async (u) => { opened = u; } });
  await new Promise((r) => setTimeout(r, 50));
  const consent = new URL(opened);
  const redirect = consent.searchParams.get('redirect_uri');
  eq('the redirect is a loopback address on a fresh port', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(redirect), true);
  const stray = await fetch(redirect + '?state=wrong&code=x');
  eq('a stray visit with the wrong state gets an error page and does not end the wait', [stray.status, (await stray.text()).includes('not the one Voxden started')], [400, true]);
  const back = await fetch(redirect + '?state=' + consent.searchParams.get('state') + '&code=4%2Fthe-code');
  eq('the real callback gets the signed-in page', [back.status, (await back.text()).includes('signed in to Voxden')], [200, true]);
  const grant = await attempt.promise;
  eq('the grant carries the code, the verifier and the redirect', [grant.code, grant.redirectUri, /^[A-Za-z0-9_-]{43}$/.test(grant.codeVerifier)], ['4/the-code', redirect, true]);
  const closed = await fetch(redirect).then(() => 'still listening', () => 'closed');
  eq('the listener closes once the code is in', closed, 'closed');

  const cancelled = googleAuth.signIn({ clientId: 'cid', timeoutMs: 5000, openExternal: async () => {} });
  await new Promise((r) => setTimeout(r, 30));
  cancelled.cancel();
  eq('cancelling rejects with a plain reason', await cancelled.promise.then(() => 'resolved', (e) => e.message), 'Google sign-in was cancelled.');

  const denied = googleAuth.signIn({ clientId: 'cid', timeoutMs: 5000, openExternal: async (u) => { opened = u; } });
  await new Promise((r) => setTimeout(r, 30));
  const deniedUrl = new URL(opened);
  await fetch(deniedUrl.searchParams.get('redirect_uri') + '?state=' + deniedUrl.searchParams.get('state') + '&error=access_denied');
  eq('a denied consent ends the wait with the reason', await denied.promise.then(() => 'resolved', (e) => e.message), 'Google sign-in was cancelled.');

  const slow = googleAuth.signIn({ clientId: 'cid', timeoutMs: 60, openExternal: async () => {} });
  eq('nobody coming back times out', await slow.promise.then(() => 'resolved', (e) => e.message), 'Google sign-in timed out. Try again.');

  const noBrowser = googleAuth.signIn({ clientId: 'cid', timeoutMs: 5000, openExternal: async () => { throw new Error('no browser'); } });
  eq('a browser that will not open is reported', await noBrowser.promise.then(() => 'resolved', (e) => e.message), 'Could not open your browser: no browser');

  eq('no client id means no attempt', (() => { try { googleAuth.signIn({ openExternal: () => {} }); return 'started'; } catch (e) { return e.message; } })(),
    'Google sign-in is not set up on this service yet. Use your email instead.');

  process.stdout.write('all ' + checks + ' google auth checks passed\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
