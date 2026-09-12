'use strict';

// Cloud dictation credits. One credit is one minute of billed audio.
// Paying India Pro is 600 credits (10 hours) per month. A developer OpenRouter
// key limited to $5 at MAI's $0.10/hour launch price is 3,000 credits, with
// no monthly reset unless the key itself is topped up.

const SECONDS_PER_CREDIT = 60;
const DEFAULT_HOURS_CAP = 10;
const WARN_AT = Object.freeze([75, 80, 90]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function creditsFromSeconds(seconds) {
  return Math.round((Math.max(0, num(seconds)) / SECONDS_PER_CREDIT) * 100) / 100;
}

function secondsFromCredits(credits) {
  return Math.max(0, num(credits)) * SECONDS_PER_CREDIT;
}

function creditsFromHours(hours) {
  return Math.round(Math.max(0, num(hours)) * 60);
}

function hoursFromCredits(credits) {
  return Math.round((Math.max(0, num(credits)) / 60) * 100) / 100;
}

function normalizeReset(value) {
  return String(value || '').trim().toLowerCase() === 'never' ? 'never' : 'month';
}

function meterFromSeconds(seconds, options) {
  const opts = options || {};
  const reset = normalizeReset(opts.reset);
  let creditsCap;
  if (opts.creditsCap !== undefined && opts.creditsCap !== null && Number.isFinite(Number(opts.creditsCap))) {
    creditsCap = Math.max(0, Math.round(Number(opts.creditsCap)));
  } else if (opts.hoursCap !== undefined && opts.hoursCap !== null && Number.isFinite(Number(opts.hoursCap))) {
    creditsCap = creditsFromHours(opts.hoursCap);
  } else {
    creditsCap = creditsFromHours(DEFAULT_HOURS_CAP);
  }
  const creditsUsed = creditsFromSeconds(seconds);
  const creditsRemaining = Math.max(0, Math.round((creditsCap - creditsUsed) * 100) / 100);
  return {
    hoursUsed: Math.round((Math.max(0, num(seconds)) / 3600) * 100) / 100,
    hoursCap: hoursFromCredits(creditsCap),
    creditsUsed,
    creditsCap,
    creditsRemaining,
    reset,
    periodEnd: reset === 'never' ? null : (opts.periodEnd || null),
  };
}

function normalizeCloud(cloud) {
  const raw = cloud && typeof cloud === 'object' ? cloud : {};
  if (num(raw.creditsCap) > 0) {
    const creditsUsed = Math.max(0, num(raw.creditsUsed));
    const creditsCap = Math.round(num(raw.creditsCap));
    return {
      hoursUsed: num(raw.hoursUsed),
      hoursCap: num(raw.hoursCap) > 0 ? num(raw.hoursCap) : hoursFromCredits(creditsCap),
      creditsUsed,
      creditsCap,
      creditsRemaining: Math.max(0, Math.round((creditsCap - creditsUsed) * 100) / 100),
      reset: normalizeReset(raw.reset || (raw.periodEnd ? 'month' : 'never')),
      periodEnd: raw.periodEnd || null,
    };
  }
  if (num(raw.hoursCap) > 0) {
    return meterFromSeconds(num(raw.hoursUsed) * 3600, {
      hoursCap: raw.hoursCap,
      reset: raw.periodEnd ? 'month' : 'never',
      periodEnd: raw.periodEnd,
    });
  }
  return null;
}

function percentUsed(cloud) {
  const meter = normalizeCloud(cloud);
  if (!meter || !(meter.creditsCap > 0)) return 0;
  return Math.min(100, Math.max(0, (meter.creditsUsed / meter.creditsCap) * 100));
}

function toneForPercent(percent) {
  const pct = num(percent);
  if (pct >= 95) return 'critical';
  if (pct >= 90) return 'high';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function displayCredits(value) {
  return Math.max(0, Math.round(num(value))).toLocaleString();
}

function usageLabel(cloud) {
  const meter = normalizeCloud(cloud);
  if (!meter) return '';
  const used = displayCredits(meter.creditsUsed);
  const cap = displayCredits(meter.creditsCap);
  return meter.reset === 'never'
    ? used + ' of ' + cap + ' cloud credits used.'
    : used + ' of ' + cap + ' cloud credits used this month.';
}

function remainingLabel(cloud) {
  const meter = normalizeCloud(cloud);
  if (!meter) return '';
  const left = displayCredits(meter.creditsRemaining);
  return left + (left === '1' ? ' credit left' : ' credits left');
}

function warningCopy(threshold) {
  if (threshold >= 90) {
    return {
      title: 'Cloud credits almost gone',
      body: '90% of your cloud credits are used. Dictation will keep working on this PC when they run out.',
    };
  }
  if (threshold >= 80) {
    return {
      title: '80% of cloud credits used',
      body: 'Four fifths of this cloud allowance is gone. The remaining credits keep Voxden Cloud running until they run out.',
    };
  }
  return {
    title: 'Three quarters of cloud credits used',
    body: '75% of your cloud credits are used. The bar in the sidebar shows what is left.',
  };
}

function warningPeriodKey(cloud) {
  const meter = normalizeCloud(cloud);
  if (!meter) return '';
  if (meter.reset === 'never') return 'lifetime';
  const end = String(meter.periodEnd || '').slice(0, 7);
  return end || 'month';
}

function pendingWarnings(cloud) {
  const meter = normalizeCloud(cloud);
  if (!meter || !(meter.creditsCap > 0)) return [];
  const pct = percentUsed(meter);
  const period = warningPeriodKey(meter);
  const out = [];
  for (const threshold of WARN_AT) {
    if (pct < threshold) continue;
    const copy = warningCopy(threshold);
    out.push({
      id: 'cloud-credits:' + period + ':' + threshold,
      kind: 'feature',
      title: copy.title,
      body: copy.body,
      action: { settings: 'billing' },
    });
  }
  return out;
}

function capMessage(cloud) {
  const meter = normalizeCloud(cloud);
  if (meter && meter.reset === 'never') {
    return 'Your cloud credits are used up. Dictation continues on your PC.';
  }
  const until = meter && meter.periodEnd ? String(meter.periodEnd).slice(0, 10) : '';
  return 'Your cloud credits are used up for this month.'
    + (until ? ' They refresh on ' + until + '.' : '')
    + ' Dictation continues on your PC.';
}

module.exports = {
  SECONDS_PER_CREDIT,
  DEFAULT_HOURS_CAP,
  WARN_AT,
  creditsFromSeconds,
  secondsFromCredits,
  creditsFromHours,
  hoursFromCredits,
  meterFromSeconds,
  normalizeCloud,
  percentUsed,
  toneForPercent,
  displayCredits,
  usageLabel,
  remainingLabel,
  pendingWarnings,
  capMessage,
};
