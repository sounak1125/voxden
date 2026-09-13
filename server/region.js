'use strict';

// Set which prices an account sees, by hand, when its first sign-in placed it
// in the wrong region (a VPN, a trip abroad).
//
//   node server/region.js someone@example.com in
//   node server/region.js someone@example.com global
//   node server/region.js someone@example.com show
//
// Uses VOXDEN_DB like the service. The user must have signed in at least once.

const path = require('path');
const { createStore } = require('./store');
const { normalizeEmail } = require('./app');

function main(argv) {
  const email = normalizeEmail(argv[0]);
  const region = String(argv[1] || '').trim().toLowerCase();
  if (!email || !['in', 'global', 'show'].includes(region)) {
    process.stderr.write('usage: node server/region.js <email> <in|global|show>\n');
    return 2;
  }
  const store = createStore(process.env.VOXDEN_DB || path.join(__dirname, 'data', 'voxden.sqlite'));
  try {
    const user = store.userByEmail(email);
    if (!user) {
      process.stderr.write(email + ' has never signed in; no region to set.\n');
      return 1;
    }
    if (region === 'show') {
      process.stdout.write(email + ' is ' + (user.region ? 'in region ' + user.region : 'not placed in a region yet')
        + (user.country ? ', first seen from ' + user.country : '') + '\n');
      return 0;
    }
    // Set by hand, the region no longer comes from a country.
    store.setRegion(email, region, '');
    process.stdout.write(email + ' now sees ' + (region === 'in' ? 'India' : 'global') + ' prices\n');
    return 0;
  } finally {
    store.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
