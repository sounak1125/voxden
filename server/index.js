'use strict';

// Entry point. `node server/index.js` with:
//
//   PORT                 listen port (default 8787)
//   VOXDEN_DB            SQLite file (default ./server/data/voxden.sqlite)
//   RESEND_API_KEY       when set, codes are emailed through Resend;
//                        when unset, codes are printed to stdout
//   MAIL_FROM            sender address for Resend
//   CLOUD_HOURS_CAP      Pro cloud hours per month (default 10)
//   OPENROUTER_API_KEY   key for the speech model; unset disables /v1/transcribe
//   CLOUD_MODEL          OpenRouter model slug (default microsoft/mai-transcribe-2)
//   CLOUD_UPSTREAM_URL   transcription endpoint override, for tests
//   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
//   RAZORPAY_PLAN_MONTHLY / RAZORPAY_PLAN_ANNUAL     India checkout (all five, or none)
//   LEMONSQUEEZY_API_KEY / LEMONSQUEEZY_STORE_ID / LEMONSQUEEZY_WEBHOOK_SECRET
//   LEMONSQUEEZY_VARIANT_MONTHLY / LEMONSQUEEZY_VARIANT_ANNUAL   global checkout
//   PRICE_IN_MONTHLY / PRICE_IN_ANNUAL / PRICE_GLOBAL_MONTHLY / PRICE_GLOBAL_ANNUAL
//                        price labels shown in the app (defaults in billing.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { createMailer } = require('./mail');
const { createApp } = require('./app');
const { createCloudTranscriber } = require('./cloud');
const { createBilling } = require('./billing');

function main() {
  const dbFile = process.env.VOXDEN_DB || path.join(__dirname, 'data', 'voxden.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const store = createStore(dbFile);
  const mailer = createMailer({ resendApiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
  const log = (line) => process.stdout.write(new Date().toISOString() + ' ' + line + '\n');
  const cloud = createCloudTranscriber({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.CLOUD_MODEL,
    upstreamUrl: process.env.CLOUD_UPSTREAM_URL,
  });
  const env = process.env;
  const billing = createBilling({
    razorpay: env.RAZORPAY_KEY_ID ? {
      keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      planMonthly: env.RAZORPAY_PLAN_MONTHLY, planAnnual: env.RAZORPAY_PLAN_ANNUAL,
      labels: { monthly: env.PRICE_IN_MONTHLY, annual: env.PRICE_IN_ANNUAL },
    } : null,
    lemonsqueezy: env.LEMONSQUEEZY_API_KEY ? {
      apiKey: env.LEMONSQUEEZY_API_KEY, storeId: env.LEMONSQUEEZY_STORE_ID, webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET,
      variantMonthly: env.LEMONSQUEEZY_VARIANT_MONTHLY, variantAnnual: env.LEMONSQUEEZY_VARIANT_ANNUAL,
      labels: { monthly: env.PRICE_GLOBAL_MONTHLY, annual: env.PRICE_GLOBAL_ANNUAL },
    } : null,
  });
  const app = createApp({
    store, mailer, log, cloud, billing,
    cloudHoursCap: process.env.CLOUD_HOURS_CAP ? Number(process.env.CLOUD_HOURS_CAP) : undefined,
  });
  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer(app.handle);
  server.listen(port, () => {
    log('account service listening on :' + port + ' (' + (mailer.configured ? 'Resend' : 'codes to stdout')
      + ', cloud ' + (cloud.configured ? cloud.model : 'off') + ')');
  });
  // Codes are useless after ten minutes; keep the table from growing forever.
  const prune = setInterval(() => {
    try { store.pruneLoginCodes(new Date(Date.now() - 24 * 3600e3).toISOString()); } catch (_) {}
  }, 3600e3);
  prune.unref();
  const stop = () => { server.close(); clearInterval(prune); store.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();
