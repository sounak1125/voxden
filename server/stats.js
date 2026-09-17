'use strict';

// The numbers behind the service, and the words they are read in.
//
// Two jobs, both pure enough to test without a network: `snapshot` asks the
// store what is true right now, and `format` turns that into the lines the
// Discord bot posts. Nothing here reaches Discord, and nothing here holds an
// email address -- a channel is a third party, and aggregate counts are all
// it ever needs to see.
//
// Money is deliberately absent. Razorpay already reports revenue, refunds and
// failed charges, and it is the truth; `subscriptions` here is only the mirror
// the app reads a plan from. What this counts is how
// many live subscriptions exist, not what they are worth.

const { periodOf } = require('./app');

const DAY_MS = 86400e3;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isoDay(ms) {
  return iso(ms).slice(0, 10);
}

// The Monday of the week `ms` falls in, as YYYY-MM-DD. Used as the key for
// "has the weekly digest for this week been posted", so a service restarted
// on Wednesday does not post a second one.
function mondayOf(ms) {
  const d = new Date(Number(ms) || 0);
  const day = (d.getUTCDay() + 6) % 7;
  return isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS);
}

function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function count(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
}

// What is true as of `now`. Every figure is a count; none of it identifies
// anybody.
function snapshot(store, now) {
  const t = Number(now) || Date.now();
  const cloud = store.cloudForPeriod(periodOf(t));
  // Only periods that are still running: a free week lasts seven days, so a
  // report older than that describes a week that has already turned over.
  const words = store.wordsSince(iso(t - 7 * DAY_MS));
  const users = store.countUsers();
  const paid = store.countPaid(iso(t));
  return {
    day: isoDay(t),
    at: iso(t),
    users,
    newToday: store.countUsersSince(iso(t - DAY_MS)),
    newThisWeek: store.countUsersSince(iso(t - 7 * DAY_MS)),
    paid,
    conversion: percent(paid, users),
    activeThisWeek: store.countActiveSince(iso(t - 7 * DAY_MS)),
    cloudMinutes: Math.round(cloud.seconds / 60),
    cloudAccounts: cloud.users,
    // Free accounts whose app has reported a running week. Not the same as
    // every free account: one that is offline, or has not dictated since the
    // build that reports, is not in here.
    freeReporting: words.accounts,
    freeWords: words.words,
    freeAtCap: words.atCap,
    capHitRate: percent(words.atCap, words.accounts),
    subscriptions: store.liveSubscriptions(),
    openTickets: store.openFeedbackCount(),
  };
}

// The lines the bot posts. `before` is the snapshot from the previous day,
// when there is one, and only decorates the figures it can compare.
function format(now, before) {
  const move = (key) => {
    if (!before || typeof before[key] !== 'number') return '';
    const change = Math.round(Number(now[key]) - Number(before[key]));
    if (!change) return '';
    return ' ' + (change > 0 ? '+' : '−') + count(Math.abs(change));
  };

  const lines = [];
  lines.push('**Voxden — ' + now.day + '**');
  lines.push('Accounts **' + count(now.users) + '**' + move('users')
    + ' · ' + count(now.newToday) + ' today, ' + count(now.newThisWeek) + ' this week');
  lines.push('Pro **' + count(now.paid) + '**' + move('paid')
    + ' · ' + now.conversion + '% of accounts');
  lines.push('Used the app this week **' + count(now.activeThisWeek) + '**' + move('activeThisWeek'));
  lines.push('Cloud **' + count(now.cloudMinutes) + ' min** this month across '
    + count(now.cloudAccounts) + (now.cloudAccounts === 1 ? ' account' : ' accounts'));

  if (now.freeReporting > 0) {
    const average = Math.round(now.freeWords / now.freeReporting);
    lines.push('Free week **' + count(now.freeAtCap) + ' of ' + count(now.freeReporting)
      + '** hit the cap (' + now.capHitRate + '%) · ' + count(average) + ' words each on average');
  } else {
    lines.push('Free week — no app has reported a running week yet');
  }

  const live = (now.subscriptions || []).reduce((n, row) => n + row.count, 0);
  const detail = (now.subscriptions || []).map((row) => row.provider + ' ' + (row.plan || '?') + ' ' + row.count).join(', ');
  lines.push('Subscriptions **' + count(live) + ' live**' + (detail ? ' · ' + detail : ''));
  lines.push('Open tickets **' + count(now.openTickets) + '**');
  // Said every time on purpose: a count of subscriptions is not revenue, and
  // the providers are the only place that knows what was actually charged.
  lines.push('_Revenue, refunds and failed charges live in the provider dashboards._');
  return lines.join('\n');
}

module.exports = { snapshot, format, mondayOf, isoDay, percent, DAY_MS };
