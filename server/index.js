'use strict';

// Entry point. `node server/index.js` with:
//
//   PORT                 listen port (default 8787)
//   VOXDEN_DB            SQLite file (default ./server/data/voxden.sqlite)
//   RESEND_API_KEY       when set, codes are emailed through Resend;
//                        when unset, codes are printed to stdout
//   MAIL_FROM            sender address for Resend
//   CLOUD_HOURS_CAP      Pro cloud hours per month (default 10)
//   CLOUD_CREDITS_CAP    Pro credits; 1 credit = 1 minute (default hours × 60)
//   CLOUD_CREDITS_RESET  month (default) or never, for a fixed API spend cap
//   OPENROUTER_API_KEY   key for the speech model; unset disables /v1/transcribe
//   CLOUD_MODEL          OpenRouter model slug (default in cloud.js)
//   CLOUD_UPSTREAM_URL   transcription endpoint override, for tests
//   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
//   RAZORPAY_PLAN_MONTHLY   India: ₹349 INR, monthly interval 1 (required with keys)
//   RAZORPAY_PLAN_ANNUAL    optional, for recognizing legacy subscriptions only
//   LEMONSQUEEZY_API_KEY / LEMONSQUEEZY_STORE_ID / LEMONSQUEEZY_WEBHOOK_SECRET
//   LEMONSQUEEZY_VARIANT_MONTHLY   global checkout (annual is legacy-only)
//   PRICE_GLOBAL_MONTHLY  global price label (India is fixed at ₹349/month)

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
  // Logging must never stall the service. A Windows console pauses any
  // program that writes to it while text is selected, and a synchronous
  // stdout write on the event loop would freeze every request until someone
  // presses a key. fs.write goes through the thread pool instead, so a paused
  // console delays log lines, not sign-ins.
  const serviceLog = path.join(path.dirname(dbFile), 'service.log');
  const log = (line) => {
    const stamped = new Date().toISOString() + ' ' + line + '\n';
    // A closed or odd stdout is not a reason to stop serving, and a hidden
    // or paused console is not a reason to lose the line: it goes to the
    // file as well.
    try { fs.write(1, stamped, () => {}); } catch (_) {}
    try { fs.appendFileSync(serviceLog, stamped); } catch (_) {}
  };
  const mailer = createMailer({
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.MAIL_FROM,
    log,
    // With no mail provider, codes also land in a file next to the database,
    // so reading one never means touching the console at all.
    codesFile: path.join(path.dirname(dbFile), 'sign-in-codes.log'),
  });
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
    cloudCreditsCap: process.env.CLOUD_CREDITS_CAP ? Number(process.env.CLOUD_CREDITS_CAP) : undefined,
    cloudCreditsReset: process.env.CLOUD_CREDITS_RESET || undefined,
  });
  // Why the process stopped, in the same file. A console can be closed,
  // paused or scrolled away; this cannot.
  const note = (line) => {
    try { fs.appendFileSync(serviceLog, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {}
  };
  note('start pid=' + process.pid + ' node=' + process.version + ' port=' + (Number(process.env.PORT) || 8787)
    + ' cloud=' + (cloud.configured ? cloud.model : 'off') + ' mail=' + (mailer.configured ? 'resend' : 'stdout'));
  process.on('uncaughtException', (err) => { note('uncaughtException ' + ((err && err.stack) || err)); log('fatal: ' + ((err && err.stack) || err)); process.exit(1); });
  process.on('unhandledRejection', (err) => { note('unhandledRejection ' + ((err && err.stack) || err)); });
  process.on('exit', (code) => note('exit code=' + code));

  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer(app.handle);
  server.on('error', (err) => { note('server error ' + ((err && err.stack) || err)); log('cannot listen: ' + ((err && err.message) || err)); });
  server.listen(port, () => {
    log('account service listening on :' + port + ' (' + (mailer.configured ? 'Resend' : 'codes to stdout')
      + ', cloud ' + (cloud.configured ? cloud.model : 'off') + ')');
  });
  // Open the connection to the speech model before anyone needs it, and keep
  // it from going cold between dictations.
  if (cloud.configured) {
    const warm = () => cloud.warmUp().then((ok) => { if (!ok) log('speech model warm-up did not get a response'); });
    warm();
    const warmTimer = setInterval(warm, 10 * 60e3);
    warmTimer.unref();
  }
  // Codes are useless after ten minutes; keep the table from growing forever.
  const prune = setInterval(() => {
    try { store.pruneLoginCodes(new Date(Date.now() - 24 * 3600e3).toISOString()); } catch (_) {}
  }, 3600e3);
  prune.unref();
  const stop = (signal) => {
    note('stopping on ' + signal);
    server.close();
    clearInterval(prune);
    store.close();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) main();
