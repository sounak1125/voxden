'use strict';

// Entry point. `node server/index.js` with:
//
//   PORT                 listen port (default 8787)
//   VOXDEN_DB            SQLite file (default ./server/data/voxden.sqlite)
//   RESEND_API_KEY       when set, codes are emailed through Resend;
//                        when unset, codes are printed to stdout
//   MAIL_FROM            sender address for Resend
//   CLOUD_HOURS_CAP      Pro cloud hours per month (default 10)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { createMailer } = require('./mail');
const { createApp } = require('./app');

function main() {
  const dbFile = process.env.VOXDEN_DB || path.join(__dirname, 'data', 'voxden.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const store = createStore(dbFile);
  const mailer = createMailer({ resendApiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
  const log = (line) => process.stdout.write(new Date().toISOString() + ' ' + line + '\n');
  const app = createApp({
    store, mailer, log,
    cloudHoursCap: process.env.CLOUD_HOURS_CAP ? Number(process.env.CLOUD_HOURS_CAP) : undefined,
  });
  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer(app.handle);
  server.listen(port, () => {
    log('account service listening on :' + port + ' (' + (mailer.configured ? 'Resend' : 'codes to stdout') + ')');
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
