'use strict';

const assert = require('assert');
const credits = require('../src/credits');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

eq('a minute is one credit', credits.creditsFromSeconds(60), 1);
eq('ten hours is 600 credits', credits.creditsFromHours(10), 600);
eq('$5 at $0.10/hour is 3000 credits', credits.creditsFromHours(5 / 0.10), 3000);

const used = credits.meterFromSeconds(947, { creditsCap: 3000, reset: 'never' });
eq('developer usage is minutes', used.creditsUsed, 15.78);
eq('developer remaining', used.creditsRemaining, 2984.22);
eq('no monthly reset', used.reset, 'never');
eq('no period end', used.periodEnd, null);

eq('free cap stays zero', credits.meterFromSeconds(0, { creditsCap: 0 }).creditsCap, 0);

const fromHours = credits.normalizeCloud({ hoursUsed: 1.25, hoursCap: 10, periodEnd: '2026-10-01T00:00:00.000Z' });
eq('legacy hours become credits', [fromHours.creditsUsed, fromHours.creditsCap], [75, 600]);

eq('quiet bar', credits.toneForPercent(credits.percentUsed({ creditsUsed: 16, creditsCap: 3000 })), 'ok');
eq('warn at 75', credits.toneForPercent(75), 'warn');
eq('high at 90', credits.toneForPercent(90), 'high');
eq('soft critical at 95', credits.toneForPercent(95), 'critical');

eq('no warnings on a fresh key', credits.pendingWarnings({ creditsUsed: 16, creditsCap: 3000, reset: 'never' }), []);
eq('three warnings fire once each past 90%', credits.pendingWarnings({
  creditsUsed: 2700, creditsCap: 3000, reset: 'never',
}).map((row) => row.id), [
  'cloud-credits:lifetime:75',
  'cloud-credits:lifetime:80',
  'cloud-credits:lifetime:90',
]);

process.stdout.write('all ' + checks + ' credit checks passed\n');
