'use strict';

// Google Play Billing, the Android app's payment. Play's policy requires a
// subscription sold inside an app on Play to go through Play Billing, so the
// Android Play build does not use the Razorpay page billing.js opens.
//
// The flow is the reverse of a hosted checkout. The app buys through Google's
// own sheet and is handed a purchase token; it posts the token to the account
// service, which asks Google's Play Developer API what that token is worth,
// acknowledges the purchase (Google refunds one that is not acknowledged in
// three days) and switches Pro on. Renewals, cancellations, holds and refunds
// arrive as real-time developer notifications on a Pub/Sub push endpoint, and
// a notification is only ever a hint: the service names the token back to
// Google and believes the answer, never the message.
//
// Play is the merchant of record for these sales, so the country closures
// that follow Razorpay's tax position (DEFAULT_CLOSED_COUNTRIES in app.js) do
// not apply to them. Prices are Play Console's, not billing.js's OFFERS.
//
// The request and response shapes follow the public docs for
// purchases.subscriptionsv2 and the real-time notification reference, and are
// exercised by scripts/test-google-play.js against fixtures built to those
// docs. Nothing here has talked to the real Play Developer API yet; the first
// license-tester purchase on the internal test track is the test of it.

const crypto = require('crypto');

const API_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function stateName(sub) {
  return String((sub && sub.subscriptionState) || '').replace(/^SUBSCRIPTION_STATE_/, '');
}

function googlePlayProvider(config, fetchImpl, now) {
  const c = config || {};
  const apiUrl = String(c.apiUrl || API_URL).replace(/\/+$/, '');
  const packageName = String(c.packageName || '').trim();
  const productId = String(c.productId || '').trim();
  const pushKey = String(c.pushKey || '');
  let account = c.serviceAccount || null;
  if (typeof account === 'string') {
    try { account = JSON.parse(account); } catch (_) { account = null; }
  }
  const credentialsOk = !!(account && account.client_email && account.private_key);
  const configured = !!(credentialsOk && packageName && productId && pushKey);
  const tokenUrl = String((account && account.token_uri) || c.tokenUrl || TOKEN_URL);
  // The value the app hands Google as the buyer's obfuscated account id. It
  // carries the account id so a notification for a purchase this service has
  // not seen yet can still be tied to its owner, and a tag only this service
  // can make so one account cannot claim another's purchase by naming it.
  const accountSecret = String(c.accountSecret || (account && account.private_key) || '');

  let cached = { token: '', until: 0 };

  async function accessToken() {
    if (cached.token && cached.until > now() + 60e3) return cached.token;
    const issued = Math.floor(now() / 1000);
    const unsigned = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.'
      + base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUrl, iat: issued, exp: issued + 3600 }));
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + signature,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) {
      throw Object.assign(new Error('Google did not give the service access to Play.'), { code: 'provider' });
    }
    cached = { token: String(body.access_token), until: now() + (Number(body.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  // One call to the Play Developer API. A refused token is fetched again once;
  // a purchase Google does not know, or no longer keeps, is a `purchase` error
  // the route can tell the buyer about, anything else a `provider` one.
  async function call(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(apiUrl + path, {
        method,
        headers: { Authorization: 'Bearer ' + await accessToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 401 && attempt === 0) { cached = { token: '', until: 0 }; continue; }
      const parsed = await res.json().catch(() => null);
      if (res.ok) return parsed || {};
      const reason = parsed && parsed.error && parsed.error.message ? ': ' + parsed.error.message : '';
      if (res.status === 400 || res.status === 404 || res.status === 410) {
        throw Object.assign(new Error('Google Play does not know that purchase' + reason), { code: 'purchase', status: res.status });
      }
      throw Object.assign(new Error('Google Play did not answer' + reason), { code: 'provider', status: res.status });
    }
    throw Object.assign(new Error('Google Play did not accept the service\'s access.'), { code: 'provider' });
  }

  const enc = encodeURIComponent;
  const pkg = '/applications/' + enc(packageName);

  const getSubscription = (token) => call('GET', pkg + '/purchases/subscriptionsv2/tokens/' + enc(token));

  const acknowledge = (id, token) => call('POST', pkg + '/purchases/subscriptions/' + enc(id) + '/tokens/' + enc(token) + ':acknowledge', {});

  // Stops the next renewal and leaves the paid period; the user can undo it in
  // Play. Google answers with nothing, so the period end is read afterwards.
  async function cancel({ providerId }) {
    await call('POST', pkg + '/purchases/subscriptionsv2/tokens/' + enc(providerId) + ':cancel',
      { cancellationContext: { cancellationType: 'USER_REQUESTED_STOP_RENEWALS' } });
    const sub = await getSubscription(providerId);
    const event = describe(sub);
    return { periodEnd: event.periodEnd || 0, providerStatus: stateName(sub) };
  }

  // The tag covers the email as well as the id: a deleted account's id is
  // handed to the next person who signs up, and a purchase made for the old
  // one must not match them.
  function accountIdFor(user) {
    const id = String(Math.floor(Number(user.id)));
    return id + '.' + crypto.createHmac('sha256', accountSecret).update('googleplay:' + id + ':' + String(user.email || '')).digest('hex').slice(0, 24);
  }

  const accountIdMatches = (user, value) => safeEqual(value, accountIdFor(user));

  // The account id a notification's obfuscated id claims, or 0 when it is
  // not one this service could have made. A claim only: check it with
  // accountIdMatches against that account.
  function accountIdUser(value) {
    const dot = String(value || '').indexOf('.');
    const id = dot > 0 ? Number(String(value).slice(0, dot)) : 0;
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  // What a Play subscription means for the account, as one fact in the shape
  // the webhook path already understands:
  //   active   Pro, and renewing (Play handles retries; a grace period counts)
  //   ended    no more renewals; access runs to periodEnd, which may be past
  //   pending  paid for by a slow method and not settled; nothing to grant yet
  //   ignored  not a purchase that was ever paid for, or not this product
  function describe(sub) {
    const items = Array.isArray(sub && sub.lineItems) ? sub.lineItems : [];
    const item = items.find((i) => i && i.productId === productId) || null;
    const name = stateName(sub);
    const base = {
      providerId: '', plan: 'monthly', productId: item ? String(item.productId) : '', periodEnd: 0, status: name.toLowerCase(),
      manageUrl: 'https://play.google.com/store/account/subscriptions?sku=' + enc(productId) + '&package=' + enc(packageName),
      accountId: String(sub && sub.externalAccountIdentifiers && sub.externalAccountIdentifiers.obfuscatedExternalAccountId || ''),
      testPurchase: !!(sub && sub.testPurchase),
      acknowledged: /ACKNOWLEDGED$/.test(String((sub && sub.acknowledgementState) || '')) && !/PENDING$/.test(String(sub.acknowledgementState)),
      needsAcknowledge: false,
    };
    if (!item) return { ...base, type: 'ignored' };
    const expiry = Date.parse(item.expiryTime) || 0;
    const t = now();
    let event;
    if (name === 'ACTIVE') event = { type: 'active', status: 'active', periodEnd: expiry };
    // Google keeps trying the card for a while after the period ends; the
    // service's own renewal grace bounds how long that is trusted between
    // notifications, and the end of the grace period arrives as one.
    else if (name === 'IN_GRACE_PERIOD') event = { type: 'active', status: 'active', periodEnd: Math.max(expiry, t) };
    else if (name === 'CANCELED') event = { type: 'ended', status: 'cancelling', periodEnd: expiry };
    else if (name === 'ON_HOLD') event = { type: 'ended', status: 'halted', periodEnd: expiry };
    else if (name === 'PAUSED') event = { type: 'ended', status: 'paused', periodEnd: expiry };
    else if (name === 'EXPIRED') event = { type: 'ended', status: 'expired', periodEnd: expiry };
    else if (name === 'PENDING') event = { type: 'pending', status: 'pending', periodEnd: 0 };
    else event = { type: 'ignored', status: name.toLowerCase(), periodEnd: 0 };
    if ((event.type === 'active' || (event.status === 'cancelling' && expiry > t)) && !base.acknowledged) event.needsAcknowledge = true;
    // An active or cancelled subscription with no period end cannot be trusted
    // to grant anything.
    if ((event.type === 'active' || event.status === 'cancelling') && !event.periodEnd) event = { ...event, type: 'ignored' };
    return { ...base, ...event };
  }

  // The thing Pub/Sub POSTs to the push endpoint: the notification inside it,
  // or null when the body is not one. The token is all a notification is used
  // for. `test` marks the notification Play Console sends to try the wire.
  function parsePush(body) {
    const data = body && body.message && body.message.data;
    if (typeof data !== 'string') return null;
    let note;
    try { note = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch (_) { return null; }
    if (!note || typeof note !== 'object') return null;
    if (String(note.packageName || '') !== packageName) return null;
    if (note.testNotification) return { test: true };
    const sub = note.subscriptionNotification;
    const voided = note.voidedPurchaseNotification;
    const token = String((sub && sub.purchaseToken) || (voided && Number(voided.productType) === 1 && voided.purchaseToken) || '');
    return token ? { token } : { ignored: true };
  }

  return {
    id: 'googleplay', configured, offers: [], packageName, productId,
    accountIdFor, accountIdMatches, accountIdUser, getSubscription, acknowledge, cancel, describe, parsePush,
    pushKeyOk: (given) => !!pushKey && safeEqual(given, pushKey),
  };
}

module.exports = { googlePlayProvider };
