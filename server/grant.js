'use strict';

// Set a user's plan by hand until payments exist.
//
//   node server/grant.js someone@example.com pro 2027-01-01
//   node server/grant.js someone@example.com free
//
// Uses VOXDEN_DB like the service. The user must have signed in at least once.

const path = require('path');
const { createStore } = require('./store');
const { normalizeEmail } = require('./app');

function main(argv) {
  const email = normalizeEmail(argv[0]);
  const plan = String(argv[1] || '').trim().toLowerCase();
  const until = argv[2] ? new Date(argv[2]) : null;
  if (!email || !['free', 'pro'].includes(plan) || (until && Number.isNaN(until.getTime()))) {
    process.stderr.write('usage: node server/grant.js <email> <free|pro> [YYYY-MM-DD]\n');
    return 2;
  }
  const store = createStore(process.env.VOXDEN_DB || path.join(__dirname, 'data', 'voxden.sqlite'));
  try {
    const changed = store.setPlan(email, plan, until ? until.toISOString() : null);
    if (!changed) {
      process.stderr.write(email + ' has never signed in; nothing to grant.\n');
      return 1;
    }
    process.stdout.write(email + ' is now ' + plan + (until ? ' until ' + until.toISOString() : '') + '\n');
    return 0;
  } finally {
    store.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
