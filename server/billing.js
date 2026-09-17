'use strict';

// Payments, behind one interface: create a hosted checkout for a user, verify
// a webhook, and turn a provider's event into the one fact the account
// service cares about -- this user is paid up until this date, or not.
//
// One provider, Razorpay, with an offer for each price region:
//
//   in       India. ₹349 a month by UPI, cards or net banking.
//   global   Everywhere else Pro is sold. $8 a month by international card.
//
// Razorpay is a payment gateway, not a merchant of record: tax on these sales
// is Voxden's to account for, which is why some countries are not sold to yet
// (DEFAULT_CLOSED_COUNTRIES in app.js).
//
// Checkout is hosted: the app opens a URL in the browser and never sees a
// card. Razorpay confirms by webhook, signed with a shared secret over the raw
// body. Nothing in the desktop app can flip a plan; only a verified webhook
// can, and only through this file.
//
// The request and event shapes below follow Razorpay's public docs and are
// exercised by scripts/test-billing.js against fixtures built to those docs.
// The India offer has taken real payments; the global offer's first real
// checkout is the test of it.

const crypto = require('crypto');

const PLAN_IDS = Object.freeze(['monthly', 'annual']);
// Annual remains readable for existing subscriptions, but is not for sale.
const PURCHASE_PLAN_IDS = Object.freeze(['monthly']);
// Renewals land a little after the period ends; three days keeps a paying
// user from seeing Free while the provider retries a card.
const RENEWAL_GRACE_MS = 3 * 24 * 3600e3;

// What each region pays, in the currency's smallest unit, and the words the
// app shows for it. A Razorpay plan cannot be edited, so checkout refuses a
// plan that disagrees with these rather than charge something the app did not
// advertise. India comes first: apps from before the global offer went through
// Razorpay take the first Razorpay group as India's.
const OFFERS = Object.freeze({
  in: Object.freeze({ label: 'India', amount: 34900, currency: 'INR', labels: Object.freeze({ monthly: '₹349 / month' }) }),
  global: Object.freeze({ label: 'Everywhere else', amount: 800, currency: 'USD', labels: Object.freeze({ monthly: '$8 / month' }) }),
});
const REGIONS = Object.freeze(Object.keys(OFFERS));

function hmacHex(secret, raw) {
  return crypto.createHmac('sha256', String(secret)).update(raw).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function normalizePlan(value) {
  const id = String(value || '').trim().toLowerCase();
  return PLAN_IDS.includes(id) ? id : '';
}

// --- Razorpay ---------------------------------------------------------------

function razorpayProvider(config, fetchImpl, now) {
  const c = config || {};
  const apiUrl = String(c.apiUrl || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
  // The plans each region checks out with. India may also name a legacy
  // annual plan, only so its old subscriptions are still recognised.
  const plans = {
    in: { monthly: c.planMonthly || '', annual: c.planAnnual || '' },
    global: { monthly: c.planMonthlyGlobal || '' },
  };
  const keys = !!(c.keyId && c.keySecret && c.webhookSecret);
  // A region is on sale once its monthly plan is set; the global plan can
  // arrive after India's without touching it.
  const offers = keys
    ? REGIONS.filter((region) => plans[region].monthly).map((region) => ({ region, label: OFFERS[region].label, labels: OFFERS[region].labels }))
    : [];
  const configured = offers.length > 0;
  const authorization = () => 'Basic ' + Buffer.from(c.keyId + ':' + c.keySecret).toString('base64');

  async function createCheckout({ plan, user, region }) {
    const offer = OFFERS[region];
    const planId = offer && plans[region][plan];
    if (!planId) throw Object.assign(new Error('That payment option is not available.'), { code: 'provider' });
    // A label change cannot change a Razorpay plan. Refuse a stale plan ID
    // rather than charging an amount different from the advertised price.
    const check = await fetchImpl(apiUrl + '/plans/' + encodeURIComponent(planId), {
      headers: { Authorization: authorization() },
    });
    const details = await check.json().catch(() => null);
    if (!check.ok || !details || details.period !== 'monthly' || details.interval !== 1
        || !details.item || details.item.amount !== offer.amount || details.item.currency !== offer.currency) {
      const price = offer.labels.monthly.replace(/\s*\/\s*month$/, '');
      throw new Error('The ' + price + ' monthly plan is not ready for checkout. Please try again later.');
    }
    const res = await fetchImpl(apiUrl + '/subscriptions', {
      method: 'POST',
      headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: planId,
        // How many billing cycles before the subscription completes on its
        // own. Ten years either way; cancellation is the normal ending.
        total_count: plan === 'annual' ? 10 : 120,
        customer_notify: 1,
        notes: { voxden_user: String(user.id), voxden_email: user.email, voxden_plan: plan, voxden_region: region },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.short_url) {
      throw new Error('Razorpay could not start a checkout' + (body && body.error && body.error.description ? ': ' + body.error.description : '.'));
    }
    return { url: body.short_url, providerId: body.id };
  }

  // Stop renewal but keep the paid cycle: Razorpay's cancel-at-cycle-end.
  // The entity that comes back still says active; current_end is the day
  // access stops.
  async function cancel({ providerId }) {
    const res = await fetchImpl(apiUrl + '/subscriptions/' + encodeURIComponent(providerId) + '/cancel', {
      method: 'POST',
      headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      throw new Error('Razorpay could not cancel the subscription' + (body && body.error && body.error.description ? ': ' + body.error.description : '.'));
    }
    const periodEnd = Number(body.current_end) > 0 ? Number(body.current_end) * 1000 : 0;
    return { periodEnd, providerStatus: String(body.status || '') };
  }

  function verify(headers, raw) {
    return safeEqualHex(headers['x-razorpay-signature'], hmacHex(c.webhookSecret, raw));
  }

  function parse(headers, body) {
    const event = String((body && body.event) || '');
    const entity = body && body.payload && body.payload.subscription && body.payload.subscription.entity;
    if (!event.startsWith('subscription.') || !entity) return null;
    const notes = entity.notes || {};
    const periodEnd = Number(entity.current_end) > 0 ? Number(entity.current_end) * 1000 : 0;
    const active = ['subscription.activated', 'subscription.charged', 'subscription.authenticated', 'subscription.resumed'].includes(event);
    const ended = ['subscription.cancelled', 'subscription.completed', 'subscription.expired', 'subscription.halted', 'subscription.paused'].includes(event);
    if (!active && !ended) return null;
    const planByEntity = REGIONS.map((region) => Object.keys(plans[region]).find((id) => plans[region][id] && plans[region][id] === entity.plan_id))
      .find(Boolean) || '';
    return {
      eventKey: String(headers['x-razorpay-event-id'] || '') || ('sha256:' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')),
      type: active ? 'active' : 'ended',
      providerId: String(entity.id || ''),
      userId: notes.voxden_user ? Number(notes.voxden_user) : 0,
      email: String(notes.voxden_email || ''),
      plan: normalizePlan(notes.voxden_plan) || planByEntity,
      status: String(entity.status || ''),
      // Access runs to the end of the paid period whichever way the event
      // goes; an ending with no period end is an ending now.
      periodEnd: periodEnd || (ended ? now() : 0),
      manageUrl: '',
    };
  }

  return { id: 'razorpay', configured, offers, createCheckout, cancel, verify, parse };
}

// --- the billing front door -------------------------------------------------

function createBilling(config) {
  // Not `options`: the function of that name below hoists over a parameter.
  const opts = config || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const providers = {};
  if (opts.razorpay) providers.razorpay = razorpayProvider(opts.razorpay, fetchImpl, now);
  if (opts.providers) Object.assign(providers, opts.providers);

  function provider(id) {
    const p = providers[String(id || '').trim().toLowerCase()];
    return p && p.configured ? p : null;
  }

  // The offer a provider has for a region, or null when that region has
  // nothing on sale through it.
  function offerFor(providerId, region) {
    const p = provider(providerId);
    return (p && (p.offers || []).find((offer) => offer.region === region)) || null;
  }

  // What the app can offer: one group for each region a configured provider
  // sells in, India first.
  function options() {
    const groups = [];
    for (const p of Object.values(providers)) {
      if (!p.configured) continue;
      for (const offer of p.offers || []) {
        groups.push({
          provider: p.id,
          region: offer.region,
          label: offer.label,
          plans: PURCHASE_PLAN_IDS.map((id) => ({ id, label: offer.labels[id] })),
        });
      }
    }
    return groups.sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
  }

  async function createCheckout(request) {
    const req = request || {};
    const p = provider(req.provider);
    const plan = normalizePlan(req.plan);
    if (!p || !offerFor(p.id, req.region)) throw Object.assign(new Error('That payment option is not available.'), { code: 'provider' });
    if (!PURCHASE_PLAN_IDS.includes(plan)) throw Object.assign(new Error('Only monthly subscriptions are available.'), { code: 'plan' });
    if (!req.user || !req.user.id) throw Object.assign(new Error('Sign in first.'), { code: 'auth' });
    const result = await p.createCheckout({ plan, user: req.user, region: req.region });
    return { url: result.url, provider: p.id, plan, region: req.region, providerId: result.providerId || '' };
  }

  // Stop a subscription renewing. Access runs to the end of what was paid
  // for; the provider's own webhook later reports the actual ending.
  async function cancel(providerId, subscriptionId) {
    const p = provider(providerId);
    if (!p) throw Object.assign(new Error('That payment option is not available.'), { code: 'provider' });
    if (!subscriptionId) throw Object.assign(new Error('There is no subscription to cancel.'), { code: 'subscription' });
    const result = await p.cancel({ providerId: String(subscriptionId) });
    return { provider: p.id, periodEnd: result.periodEnd || 0, providerStatus: result.providerStatus || '' };
  }

  // The price the app should show for a subscription it already has: the
  // account's region's, or the provider's first region when it has none.
  function labelFor(providerId, plan, region) {
    const p = providers[String(providerId || '').trim().toLowerCase()];
    const offers = (p && p.offers) || [];
    const offer = offers.find((o) => o.region === region) || offers[0];
    return offer && offer.labels ? String(offer.labels[normalizePlan(plan)] || '') : '';
  }

  // A webhook, verified and normalised, or null when it is not one we act on.
  // Throws on a bad signature so the route can answer 400 and the provider
  // can retry with the right secret once someone fixes the config.
  function webhook(providerId, headers, rawBody) {
    const p = provider(providerId);
    if (!p) throw Object.assign(new Error('Unknown payment provider.'), { code: 'provider' });
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
    const lower = {};
    for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
    if (!p.verify(lower, raw)) throw Object.assign(new Error('Bad webhook signature.'), { code: 'signature' });
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) { throw Object.assign(new Error('Webhook body is not JSON.'), { code: 'body' }); }
    return p.parse(lower, body);
  }

  // What a normalised event means for the account: the date the plan should
  // run to. An active period gets renewal grace; an ended one runs out
  // exactly when it says.
  function planExpiryFor(event) {
    if (!event || !event.periodEnd) return 0;
    return event.type === 'active' ? event.periodEnd + RENEWAL_GRACE_MS : event.periodEnd;
  }

  return { options, offerFor, createCheckout, cancel, labelFor, webhook, planExpiryFor, provider, PLAN_IDS, RENEWAL_GRACE_MS };
}

module.exports = { createBilling, normalizePlan, hmacHex, PLAN_IDS, RENEWAL_GRACE_MS, OFFERS, REGIONS };
