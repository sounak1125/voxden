'use strict';

// Payments, behind one interface: create a hosted checkout for a user, verify
// a webhook, and turn a provider's event into the one fact the account
// service cares about -- this user is paid up until this date, or not.
//
// Two providers, chosen by the user by region:
//
//   razorpay      India. UPI, cards, net banking, in rupees.
//   lemonsqueezy  Everywhere else. Merchant of record, so VAT and invoices
//                 are theirs.
//
// Both are hosted checkouts: the app opens a URL in the browser and never
// sees a card. Both confirm by webhook, signed with a shared secret over the
// raw body. Nothing in the desktop app can flip a plan; only a verified
// webhook can, and only through this file.
//
// The request and event shapes below follow each provider's public docs as
// of writing and are exercised by scripts/test-billing.js against fixtures
// built to those docs. They have not yet been run against a live account;
// the first real checkout is the test of that.

const crypto = require('crypto');

const PLAN_IDS = Object.freeze(['monthly', 'annual']);
// Annual remains readable for existing subscriptions, but is not for sale.
const PURCHASE_PLAN_IDS = Object.freeze(['monthly']);
const INDIA_MONTHLY_AMOUNT = 34900;
// Renewals land a little after the period ends; three days keeps a paying
// user from seeing Free while the provider retries a card.
const RENEWAL_GRACE_MS = 3 * 24 * 3600e3;

const DEFAULT_LABELS = Object.freeze({
  razorpay: Object.freeze({ monthly: '₹349 / month' }),
  lemonsqueezy: Object.freeze({ monthly: '$8 / month', annual: '$72 / year ($6 / month)' }),
});

function hmacHex(secret, raw) {
  return crypto.createHmac('sha256', String(secret)).update(raw).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Env-sourced labels arrive as undefined when unset; those must not shadow
// the defaults the way Object.assign would let them.
function definedLabels(labels) {
  const out = {};
  for (const [k, v] of Object.entries(labels || {})) if (v) out[k] = String(v);
  return out;
}

function normalizePlan(value) {
  const id = String(value || '').trim().toLowerCase();
  return PLAN_IDS.includes(id) ? id : '';
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// --- Razorpay ---------------------------------------------------------------

function razorpayProvider(config, fetchImpl, now) {
  const c = config || {};
  const apiUrl = String(c.apiUrl || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
  const plans = { monthly: c.planMonthly || '', annual: c.planAnnual || '' };
  const labels = DEFAULT_LABELS.razorpay;
  const configured = !!(c.keyId && c.keySecret && c.webhookSecret && plans.monthly);

  async function createCheckout({ plan, user }) {
    const auth = Buffer.from(c.keyId + ':' + c.keySecret).toString('base64');
    // A label change cannot change a Razorpay plan. Refuse a stale plan ID
    // rather than charging an amount different from the advertised ₹349.
    const check = await fetchImpl(apiUrl + '/plans/' + encodeURIComponent(plans[plan]), {
      headers: { Authorization: 'Basic ' + auth },
    });
    const details = await check.json().catch(() => null);
    if (!check.ok || !details || details.period !== 'monthly' || details.interval !== 1
        || !details.item || details.item.amount !== INDIA_MONTHLY_AMOUNT || details.item.currency !== 'INR') {
      throw new Error('The ₹349 monthly plan is not ready for checkout. Please try again later.');
    }
    const res = await fetchImpl(apiUrl + '/subscriptions', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: plans[plan],
        // How many billing cycles before the subscription completes on its
        // own. Ten years either way; cancellation is the normal ending.
        total_count: plan === 'annual' ? 10 : 120,
        customer_notify: 1,
        notes: { voxden_user: String(user.id), voxden_email: user.email, voxden_plan: plan },
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
    const auth = Buffer.from(c.keyId + ':' + c.keySecret).toString('base64');
    const res = await fetchImpl(apiUrl + '/subscriptions/' + encodeURIComponent(providerId) + '/cancel', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
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
    const planByEntity = Object.keys(plans).find((id) => plans[id] && plans[id] === entity.plan_id) || '';
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

  return { id: 'razorpay', region: 'in', label: 'India', configured, labels, createCheckout, cancel, verify, parse };
}

// --- Lemon Squeezy ----------------------------------------------------------

function lemonSqueezyProvider(config, fetchImpl, now) {
  const c = config || {};
  const apiUrl = String(c.apiUrl || 'https://api.lemonsqueezy.com/v1').replace(/\/+$/, '');
  const variants = { monthly: c.variantMonthly || '', annual: c.variantAnnual || '' };
  const labels = Object.assign({}, DEFAULT_LABELS.lemonsqueezy, definedLabels(c.labels));
  const configured = !!(c.apiKey && c.storeId && c.webhookSecret && variants.monthly);

  async function createCheckout({ plan, user }) {
    const res = await fetchImpl(apiUrl + '/checkouts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.apiKey,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user.email,
              custom: { voxden_user: String(user.id), voxden_plan: plan },
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(c.storeId) } },
            variant: { data: { type: 'variants', id: String(variants[plan]) } },
          },
        },
      }),
    });
    const body = await res.json().catch(() => null);
    const url = body && body.data && body.data.attributes && body.data.attributes.url;
    if (!res.ok || !url) {
      const detail = body && Array.isArray(body.errors) && body.errors[0] ? (body.errors[0].detail || body.errors[0].title) : '';
      throw new Error('Lemon Squeezy could not start a checkout' + (detail ? ': ' + detail : '.'));
    }
    return { url, providerId: String(body.data.id || '') };
  }

  // Lemon Squeezy cancels at the end of the paid period on DELETE; ends_at
  // in the reply is when access stops.
  async function cancel({ providerId }) {
    const res = await fetchImpl(apiUrl + '/subscriptions/' + encodeURIComponent(providerId), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + c.apiKey, Accept: 'application/vnd.api+json' },
    });
    const body = await res.json().catch(() => null);
    const attrs = body && body.data && body.data.attributes;
    if (!res.ok || !attrs) {
      const detail = body && Array.isArray(body.errors) && body.errors[0] ? (body.errors[0].detail || body.errors[0].title) : '';
      throw new Error('Lemon Squeezy could not cancel the subscription' + (detail ? ': ' + detail : '.'));
    }
    const ends = Date.parse(attrs.ends_at || '');
    const renews = Date.parse(attrs.renews_at || '');
    return { periodEnd: Number.isFinite(ends) ? ends : (Number.isFinite(renews) ? renews : 0), providerStatus: String(attrs.status || '') };
  }

  function verify(headers, raw) {
    return safeEqualHex(headers['x-signature'], hmacHex(c.webhookSecret, raw));
  }

  function parse(headers, body) {
    const meta = (body && body.meta) || {};
    const event = String(meta.event_name || '');
    const data = (body && body.data) || {};
    const attrs = data.attributes || {};
    if (!event.startsWith('subscription_')) return null;
    const custom = meta.custom_data || {};
    const status = String(attrs.status || '');
    const liveStatus = ['active', 'on_trial', 'past_due'].includes(status);
    let type = null;
    if (event === 'subscription_expired' || status === 'expired' || status === 'unpaid') type = 'ended';
    else if (event === 'subscription_cancelled' || status === 'cancelled' || status === 'paused') type = 'ended';
    else if (liveStatus && ['subscription_created', 'subscription_updated', 'subscription_resumed', 'subscription_payment_success', 'subscription_plan_changed', 'subscription_unpaused'].includes(event)) type = 'active';
    if (!type) return null;
    const renews = Date.parse(attrs.renews_at || '');
    const ends = Date.parse(attrs.ends_at || '');
    const periodEnd = type === 'active'
      ? (Number.isFinite(renews) ? renews : 0)
      : (Number.isFinite(ends) ? ends : (Number.isFinite(renews) ? renews : now()));
    const planByVariant = Object.keys(variants).find((id) => variants[id] && String(variants[id]) === String(attrs.variant_id)) || '';
    const urls = attrs.urls || {};
    return {
      eventKey: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      type,
      providerId: String(data.id || ''),
      userId: custom.voxden_user ? Number(custom.voxden_user) : 0,
      email: String(attrs.user_email || ''),
      plan: normalizePlan(custom.voxden_plan) || planByVariant,
      status,
      periodEnd,
      manageUrl: String(urls.customer_portal || urls.update_payment_method || ''),
    };
  }

  return { id: 'lemonsqueezy', region: 'global', label: 'Everywhere else', configured, labels, createCheckout, cancel, verify, parse };
}

// --- the billing front door -------------------------------------------------

function createBilling(config) {
  // Not `options`: the function of that name below hoists over a parameter.
  const opts = config || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const providers = {};
  if (opts.razorpay) providers.razorpay = razorpayProvider(opts.razorpay, fetchImpl, now);
  if (opts.lemonsqueezy) providers.lemonsqueezy = lemonSqueezyProvider(opts.lemonsqueezy, fetchImpl, now);
  if (opts.providers) Object.assign(providers, opts.providers);

  function provider(id) {
    const p = providers[String(id || '').trim().toLowerCase()];
    return p && p.configured ? p : null;
  }

  // What the app can offer: only providers with every credential present.
  function options() {
    return Object.values(providers).filter((p) => p.configured).map((p) => ({
      provider: p.id,
      region: p.region,
      label: p.label,
      plans: PURCHASE_PLAN_IDS.map((id) => ({ id, label: p.labels[id] })),
    }));
  }

  async function createCheckout(request) {
    const req = request || {};
    const p = provider(req.provider);
    const plan = normalizePlan(req.plan);
    if (!p) throw Object.assign(new Error('That payment option is not available.'), { code: 'provider' });
    if (!PURCHASE_PLAN_IDS.includes(plan)) throw Object.assign(new Error('Only monthly subscriptions are available.'), { code: 'plan' });
    if (!req.user || !req.user.id) throw Object.assign(new Error('Sign in first.'), { code: 'auth' });
    const result = await p.createCheckout({ plan, user: req.user });
    return { url: result.url, provider: p.id, plan, providerId: result.providerId || '' };
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

  // The price the app should show for a subscription it already has.
  function labelFor(providerId, plan) {
    const p = providers[String(providerId || '').trim().toLowerCase()];
    return p && p.labels ? String(p.labels[normalizePlan(plan)] || '') : '';
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

  return { options, createCheckout, cancel, labelFor, webhook, planExpiryFor, provider, PLAN_IDS, RENEWAL_GRACE_MS };
}

module.exports = { createBilling, normalizePlan, hmacHex, PLAN_IDS, RENEWAL_GRACE_MS, DEFAULT_LABELS };
