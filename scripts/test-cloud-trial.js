'use strict';

// The free Voxden Cloud trial: a free account may use a one-time allowance of
// cloud minutes (cloudTrialCredits, 60 by default) on /v1/transcribe,
// /v1/transcribe/warm and /v1/polish, metered over its whole life through the
// same reservations as Pro. Real HTTP against an in-memory database, with a
// stand-in speech model and polisher that the test can hold mid-call. No
// network, no sleeps standing in for a provider.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const credits = require('../src/credits');
const { createStore } = require('../server/store');
const { createApp, dayOf } = require('../server/app');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks++;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

const iso = (ms) => new Date(ms).toISOString();
const USED_UP = 'Your free Voxden Cloud minutes are used up.';
const NEEDS_PRO = 'Cloud transcription needs a Pro plan.';
const POLISH_IS_PRO = 'Polish is part of Voxden Pro.';

// A canonical 16 kHz mono 16-bit WAV of the given length, silence.
function wav(seconds) {
  const rate = 16000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function until(predicate, what) {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for ' + what);
}

async function main() {
  let clock = Date.parse('2026-10-04T10:00:00Z');
  const store = createStore(':memory:');
  const logs = [];
  const sent = [];
  const mailer = { configured: true, sendCode: async (message) => { sent.push(message); return { delivered: true }; } };

  // Provider stand-ins. A request whose terms include "hold" waits until the
  // test finishes it, and ignores cancellation, as a provider that answers
  // after the app has left would.
  const pending = [];
  const calls = { speech: 0, polish: 0, warm: 0, corrections: 0 };
  const speech = {
    configured: true,
    transcribe(args) {
      calls.speech++;
      if (args.terms.includes('hold')) return new Promise((resolve, reject) => { pending.push({ args, resolve, reject }); });
      return Promise.resolve({ text: 'hello', billedSeconds: args.seconds, cost: 0 });
    },
    async warmUp() { calls.warm++; return true; },
  };
  const polisher = {
    configured: true,
    polish(args) {
      calls.polish++;
      if (args.terms.includes('hold')) return new Promise((resolve, reject) => { pending.push({ args, resolve, reject }); });
      return Promise.resolve({ text: 'Polished.', model: 'test/model', cost: 0 });
    },
  };

  const corrector = {
    configured: true,
    async takeBack() { calls.corrections++; return { remove: [], model: 'test/model' }; },
  };

  const servers = [];
  const serve = async (options) => {
    const app = createApp(Object.assign({ store, mailer, now: () => clock, log: (line) => logs.push(String(line)), cloud: speech, polisher, corrector }, options));
    const server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  };

  const member = (email) => {
    const user = store.findOrCreateUser(email, iso(clock));
    const token = 'tok_' + crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: iso(clock) });
    return { email, user, token };
  };
  const call = async (base, who, method, route, body, signal) => {
    const res = await fetch(base + route, {
      method,
      signal,
      headers: Object.assign({ 'Content-Type': 'application/json' }, who ? { Authorization: 'Bearer ' + who.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const me = async (base, who) => (await call(base, who, 'GET', '/me')).body.account;
  const clip = (seconds, hold) => ({ audio: wav(seconds).toString('base64'), format: 'wav', ...(hold ? { terms: ['hold'] } : {}) });
  const transcribe = (base, who, seconds, hold) => call(base, who, 'POST', '/transcribe', clip(seconds, hold));
  const polish = (base, who, hold) => call(base, who, 'POST', '/polish', { text: 'hello world', ...(hold ? { terms: ['hold'] } : {}) });
  const warm = (base, who) => call(base, who, 'POST', '/transcribe/warm');
  const corrections = (base, who) => call(base, who, 'POST', '/corrections', { text: 'meet at three, no, four' });
  // Starts a held call and returns once the provider has it.
  const begin = async (start) => {
    const index = pending.length;
    const response = start();
    await until(() => pending.length > index, 'the provider to take the call');
    return { response, call: pending[index] };
  };
  const spend = (who, seconds, day) => store.addUsageSeconds(who.user.id, day || dayOf(clock), seconds);
  const used = (who) => store.usageSecondsTotal(who.user.id);
  const trialLog = (email, pattern) => logs.filter((line) => line.includes(' for ' + email) && pattern.test(line));

  try {
    const base = await serve({});

    // --- a free account, before and after ---------------------------------------
    const ann = member('ann@example.com');
    let account = await me(base, ann);
    eq('a new free account is offered the whole trial',
      account.trial, { credits: 60, used: 0, left: 60, available: true });
    eq('and is still on the free plan with no cloud allowance of its own',
      [account.plan, account.cloud.creditsCap, account.cloud.creditsUsed], ['free', 0, 0]);
    eq('POST /v1/me carries the same trial', (await call(base, ann, 'POST', '/me', {})).body.account.trial, account.trial);
    eq('so does the profile answer',
      (await call(base, ann, 'PUT', '/me/profile', { firstName: 'Ann', lastName: 'Lee' })).body.account.trial, account.trial);
    eq('and the billing answer', (await call(base, ann, 'GET', '/billing')).body.account.trial, account.trial);

    const first = await transcribe(base, ann, 90);
    eq('a free account transcribes inside its trial', [first.status, first.body.text, first.body.seconds], [200, 'hello', 90]);
    eq('the answer carries the updated trial',
      first.body.trial, { credits: 60, used: 1.5, left: 58.5, available: true });
    eq('and the cloud meter beside it is the free plan\'s empty one',
      [first.body.cloud.creditsCap, first.body.cloud.creditsUsed, first.body.cloud.creditsRemaining], [0, 0, 0]);
    eq('with the relay timing as ever', Object.keys(first.body).sort(), ['cloud', 'seconds', 'text', 'timing', 'trial']);
    eq('the seconds are metered on the account', used(ann), 90);
    eq('/v1/me agrees with the answer', (await me(base, ann)).trial, first.body.trial);
    ok('the service log says it was a trial', trialLog(ann.email, /cloud transcribed 90\.0s .*\(90s metered, trial\)/).length === 1);

    const polished = await polish(base, ann);
    eq('Polish runs on the trial too, a quarter credit for a short text',
      [polished.status, polished.body.text, polished.body.mode, polished.body.credits], [200, 'Polished.', 'polish', 0.25]);
    eq('and its answer carries the updated trial',
      polished.body.trial, { credits: 60, used: 1.75, left: 58.25, available: true });
    eq('Polish answers with the same keys as ever, and the trial', Object.keys(polished.body).sort(), ['cloud', 'credits', 'mode', 'text', 'trial']);
    eq('the polish is metered as fifteen seconds', used(ann), 105);
    ok('and its log line says trial', trialLog(ann.email, /polished 2 words .*\(0\.25 credits, trial\)/).length === 1);

    const tiny1 = await transcribe(base, ann, 1);
    eq('used and left are rounded the way the cloud meter rounds them',
      [tiny1.body.trial.used, tiny1.body.trial.left], [1.77, 58.23]);
    const meter = credits.meterFromSeconds(106, { creditsCap: 60, reset: 'never' });
    eq('which is its own arithmetic', [tiny1.body.trial.used, tiny1.body.trial.left], [meter.creditsUsed, meter.creditsRemaining]);

    // --- signing in -------------------------------------------------------------
    eq('a code is sent', (await call(base, null, 'POST', '/auth/code', { email: 'new@example.com' })).status, 204);
    const verified = await call(base, null, 'POST', '/auth/verify', { email: 'new@example.com', code: sent[sent.length - 1].code, device: 'Pixel' });
    eq('a brand new sign-in already shows the whole trial',
      [verified.status, verified.body.account.plan, verified.body.account.trial], [200, 'free', { credits: 60, used: 0, left: 60, available: true }]);

    // --- the boundary -----------------------------------------------------------
    // The trial is 3,600 seconds. Usage from an earlier month counts: it is the
    // account's whole life.
    const ben = member('ben@example.com');
    spend(ben, 3540, '2026-08-20');
    eq('minutes used in an earlier month still count',
      (await me(base, ben)).trial, { credits: 60, used: 59, left: 1, available: true });
    const speechBefore = calls.speech;
    eq('thirty seconds fit', (await transcribe(base, ben, 30)).status, 200);
    const exact = await transcribe(base, ben, 30);
    eq('and the next thirty end exactly on the boundary', [exact.status, exact.body.trial], [200, { credits: 60, used: 60, left: 0, available: true }]);
    eq('the trial is whole', used(ben), 3600);
    const over = await transcribe(base, ben, 1);
    eq('one second more is refused as used up', [over.status, over.body], [402, { error: USED_UP, code: 'trial_used' }]);
    eq('with the speech model never asked', calls.speech, speechBefore + 2);
    eq('and nothing charged', used(ben), 3600);
    const overPolish = await polish(base, ben);
    eq('Polish is refused the same way', [overPolish.status, overPolish.body], [402, { error: USED_UP, code: 'trial_used' }]);
    eq('with the polisher never asked', calls.polish, 1);
    eq('and /v1/me still offers the trial, spent', (await me(base, ben)).trial, { credits: 60, used: 60, left: 0, available: true });

    const cleo = member('cleo@example.com');
    spend(cleo, 3599);
    const lastSecond = await transcribe(base, cleo, 1);
    eq('the last second is allowed', [lastSecond.status, lastSecond.body.trial.left], [200, 0]);
    const dan = member('dan@example.com');
    spend(dan, 3599);
    const tooLong = await transcribe(base, dan, 2);
    eq('two seconds with one left are not', [tooLong.status, tooLong.body.code], [402, 'trial_used']);
    eq('a one second clip still is', (await transcribe(base, dan, 1)).status, 200);

    // --- reservations -----------------------------------------------------------
    // A trial of one credit: sixty seconds, small enough to fill with clips.
    const tinyBase = await serve({ cloudTrialCredits: 1 });
    eq('the size is the option', (await me(tinyBase, member('size@example.com'))).trial, { credits: 1, used: 0, left: 1, available: true });
    const eve = member('eve@example.com');
    const a = await begin(() => transcribe(tinyBase, eve, 40, true));
    const b = await begin(() => transcribe(tinyBase, eve, 20, true));
    eq('two clips that add up to the trial are both admitted', pending.length, 2);
    const providerCalls = calls.speech + calls.polish;
    const refusedC = await transcribe(tinyBase, eve, 1);
    eq('a third second is refused while the first two are only in flight', [refusedC.status, refusedC.body.code], [402, 'trial_used']);
    const refusedPolish = await polish(tinyBase, eve);
    eq('and so is Polish: speech and Polish share the reservations', [refusedPolish.status, refusedPolish.body.code], [402, 'trial_used']);
    const refusedWarm = await warm(tinyBase, eve);
    eq('and a warm-up, with nothing left to warm for', [refusedWarm.status, refusedWarm.body.code], [402, 'trial_used']);
    eq('none of them reached a provider', calls.speech + calls.polish, providerCalls);
    eq('in-flight clips are reservations, not usage', [used(eve), (await me(tinyBase, eve)).trial.used], [0, 0]);

    b.call.reject(Object.assign(new Error('provider timed out'), { code: 'timeout' }));
    const failed = await b.response;
    eq('a failed clip is a 502 that costs nothing', [failed.status, failed.body.code, used(eve)], [502, 'timeout', 0]);
    const d = await begin(() => transcribe(tinyBase, eve, 20, true));
    eq('and gives its seconds back to the trial', pending.length, 3);
    a.call.resolve({ text: 'first', billedSeconds: 40 });
    d.call.resolve({ text: 'again', billedSeconds: 20 });
    const [doneA, doneD] = await Promise.all([a.response, d.response]);
    eq('both finish', [doneA.status, doneD.status], [200, 200]);
    eq('and between them spend the trial exactly', [used(eve), (await me(tinyBase, eve)).trial], [60, { credits: 1, used: 1, left: 0, available: true }]);
    const last = await transcribe(tinyBase, eve, 1);
    eq('after which it is used up', [last.status, last.body.code], [402, 'trial_used']);

    // A transcription in flight and a Polish are one budget.
    const fay = member('fay@example.com');
    const big = await begin(() => transcribe(tinyBase, fay, 50, true));
    const blocked = await polish(tinyBase, fay);
    eq('a clip in flight leaves too little for a Polish', [blocked.status, blocked.body.code], [402, 'trial_used']);
    big.call.resolve({ text: 'big', billedSeconds: 50 });
    eq('the clip finishes', (await big.response).status, 200);
    const stillBlocked = await polish(tinyBase, fay);
    eq('a Polish that needs more than what is left is refused as used up', [stillBlocked.status, stillBlocked.body.code], [402, 'trial_used']);
    const small = await transcribe(tinyBase, fay, 10);
    eq('while a clip that fits is not', [small.status, small.body.trial], [200, { credits: 1, used: 1, left: 0, available: true }]);

    // A clip the app stopped waiting for is not charged, trial or not.
    const tia = member('tia@example.com');
    const controller = new AbortController();
    const index = pending.length;
    const gone = call(tinyBase, tia, 'POST', '/transcribe', clip(40, true), controller.signal);
    await until(() => pending.length > index, 'the clip to reach the provider');
    controller.abort();
    await assert.rejects(gone, (err) => err.name === 'AbortError');
    await until(() => pending[index].args.signal.aborted, 'the service to notice the app had left');
    pending[index].resolve({ text: 'too late', billedSeconds: 40 });
    await until(() => trialLog(tia.email, /NOT CHARGED/).length === 1, 'the service to log the abandoned clip');
    ok('the abandoned clip is logged as a trial and not charged',
      /\(0s metered, trial, NOT CHARGED: the app had stopped waiting\)/.test(trialLog(tia.email, /NOT CHARGED/)[0]));
    eq('it costs the trial nothing', used(tia), 0);
    const whole = await transcribe(tinyBase, tia, 60);
    eq('and its reservation is back, so the whole sixty seconds still fit',
      [whole.status, whole.body.trial], [200, { credits: 1, used: 1, left: 0, available: true }]);

    // --- the trial is used up ---------------------------------------------------
    const ivy = member('ivy@example.com');
    spend(ivy, 3600);
    const speechAtStart = calls.speech;
    const spent = await transcribe(base, ivy, 5);
    eq('a spent trial answers 402 with the code and the message', [spent.status, spent.body], [402, { error: USED_UP, code: 'trial_used' }]);
    eq('whatever the route: Polish', (await polish(base, ivy)).body, { error: USED_UP, code: 'trial_used' });
    eq('and warm-up', (await warm(base, ivy)).body, { error: USED_UP, code: 'trial_used' });
    // Spoken corrections are not charged, but stop with the trial: a trial that
    // exists is not a trial with minutes left.
    const correctionsAtStart = calls.corrections;
    eq('and spoken corrections', (await corrections(base, ivy)).body, { error: USED_UP, code: 'trial_used' });
    eq('which never reach the model', calls.corrections, correctionsAtStart);
    eq('while a trial with minutes left still has them', (await corrections(base, member('jo@example.com'))).status, 200);
    eq('and no provider was asked', calls.speech, speechAtStart);
    eq('/v1/me says spent, not missing', (await me(base, ivy)).trial, { credits: 60, used: 60, left: 0, available: true });

    // --- warm-up ------------------------------------------------------------------
    const hal = member('hal@example.com');
    const warmBefore = calls.warm;
    const warmed = await warm(base, hal);
    eq('a warm-up is accepted while minutes are left', [warmed.status, warmed.body, calls.warm], [204, null, warmBefore + 1]);
    eq('and meters nothing', used(hal), 0);
    spend(hal, 3599);
    eq('with one second left it still is', (await warm(base, hal)).status, 204);
    spend(hal, 1);
    const coldWarm = await warm(base, hal);
    eq('once the minutes are gone it is refused, and the model is left alone',
      [coldWarm.status, coldWarm.body.code, calls.warm], [402, 'trial_used', warmBefore + 2]);
    eq('a signed-out warm-up is still refused', (await warm(base, null)).status, 401);
    // Signed out, a clip is refused before its body is read, so nobody can
    // make the service hold megabytes without a session.
    const anonymous = await call(base, null, 'POST', '/transcribe', { audio: 'A'.repeat(2e6), format: 'wav' }).catch((err) => ({ status: 'closed: ' + err.message }));
    eq('a signed-out clip is refused as signed out', anonymous.status, 401);

    // --- the trial switched off -----------------------------------------------------
    const offBase = await serve({ cloudTrialCredits: 0 });
    const gus = member('gus@example.com');
    eq('with no trial, /v1/me offers none', (await me(offBase, gus)).trial, { credits: 0, used: 0, left: 0, available: false });
    const speechOff = calls.speech, polishOff = calls.polish, warmOff = calls.warm;
    eq('transcribe is refused as it always was', (await transcribe(offBase, gus, 5)).body, { error: NEEDS_PRO, code: 'plan' });
    eq('so is Polish', (await polish(offBase, gus)).body, { error: POLISH_IS_PRO, code: 'plan' });
    eq('and the warm-up', (await warm(offBase, gus)).body, { error: NEEDS_PRO, code: 'plan' });
    eq('all three with status 402', [(await transcribe(offBase, gus, 5)).status, (await polish(offBase, gus)).status, (await warm(offBase, gus)).status], [402, 402, 402]);
    eq('and no provider asked', [calls.speech, calls.polish, calls.warm], [speechOff, polishOff, warmOff]);
    eq('an unusable option falls back to the default of sixty minutes',
      [(await me(await serve({ cloudTrialCredits: -5 }), gus)).trial.credits, (await me(await serve({ cloudTrialCredits: NaN }), gus)).trial.credits,
        (await me(await serve({ cloudTrialCredits: 'lots' }), gus)).trial.credits], [60, 60, 60]);
    eq('and any other size is taken as given', (await me(await serve({ cloudTrialCredits: 5 }), gus)).trial, { credits: 5, used: 0, left: 5, available: true });

    // --- Pro is untouched ---------------------------------------------------------
    // A subscriber in the welcome month: 1,200 credits to the first renewal.
    const pam = member('pam@example.com');
    store.setPlan(pam.email, 'pro', '2027-01-01T00:00:00.000Z');
    store.upsertSubscription({ userId: pam.user.id, provider: 'razorpay', providerId: 'sub_pam', plan: 'monthly', status: 'active',
      periodEnd: '2026-11-04T10:00:00.000Z', manageUrl: '', updatedAt: iso(clock) });
    store.startWelcome(pam.user.id, '2026-11-04T10:00:00.000Z');
    spend(pam, 5000, '2026-08-10');
    account = await me(base, pam);
    eq('a Pro account reads the trial as not for it', account.trial, { credits: 60, used: 0, left: 0, available: false });
    eq('and keeps its own meter, welcome month and all',
      [account.plan, account.cloud.welcome, account.cloud.creditsCap, account.cloud.creditsUsed, account.cloud.monthlyCredits, account.welcomeOffer],
      ['pro', true, 1200, 0, 900, { credits: 1200, monthlyCredits: 900, eligible: false }]);
    const proClip = await transcribe(base, pam, 10);
    eq('a Pro answer is what it was: no trial in it', Object.keys(proClip.body).sort(), ['cloud', 'seconds', 'text', 'timing']);
    eq('with the credit month\'s meter, not the lifetime one',
      [proClip.status, proClip.body.cloud.creditsUsed, proClip.body.cloud.creditsCap, proClip.body.cloud.welcome], [200, 0.17, 1200, true]);
    ok('and its log line does not say trial', trialLog(pam.email, /cloud transcribed 10\.0s/).every((line) => !/trial/.test(line)));
    const proPolish = await polish(base, pam);
    eq('Pro Polish too', [proPolish.status, Object.keys(proPolish.body).sort(), proPolish.body.cloud.creditsUsed],
      [200, ['cloud', 'credits', 'mode', 'text'], 0.42]);
    ok('with no trial in its log line', trialLog(pam.email, /polished 2 words/).every((line) => !/trial/.test(line)));
    eq('Pro warm-up is accepted', (await warm(base, pam)).status, 204);
    spend(pam, 900 * 60 + 30 - 25);
    eq('past 900 credits the welcome month goes on, as before', (await transcribe(base, pam, 5)).status, 200);
    spend(pam, 300 * 60 - 40);
    const proCap = await transcribe(base, pam, 30);
    eq('and stops at 1,200 with the old code and message',
      [proCap.status, proCap.body.code, /Your cloud credits are used up for this month\. They refresh on 2026-11-04\./.test(proCap.body.error)], [402, 'cap', true]);
    eq('lifetime usage far over the trial never mattered to it', used(pam) > 3600, true);
    spend(pam, 3600);
    eq('a Pro month that is used up refuses a warm-up too', [(await warm(base, pam)).status, (await warm(base, pam)).body.code], [402, 'cap']);
    eq('and spoken corrections', (await corrections(base, pam)).body.code, 'cap');

    // --- a lapsed Pro is a free account with its past counted ----------------------
    const quinn = member('quinn@example.com');
    store.setPlan(quinn.email, 'pro', '2026-09-01T00:00:00.000Z');
    spend(quinn, 20 * 60, '2026-08-15');
    account = await me(base, quinn);
    eq('an expired Pro reads as free', [account.plan, account.planExpiresAt], ['free', null]);
    eq('with its lifetime use already counted against the trial', account.trial, { credits: 60, used: 20, left: 40, available: true });
    const lapsed = await transcribe(base, quinn, 30);
    eq('and what is left is usable', [lapsed.status, lapsed.body.trial], [200, { credits: 60, used: 20.5, left: 39.5, available: true }]);
    eq('as a trial: no cloud allowance of its own', [lapsed.body.cloud.creditsCap, Object.keys(lapsed.body).includes('trial')], [0, true]);

    const rex = member('rex@example.com');
    store.setPlan(rex.email, 'pro', '2026-09-01T00:00:00.000Z');
    spend(rex, 3590, '2026-07-01');
    eq('ten seconds left for a lapsed account', (await me(base, rex)).trial, { credits: 60, used: 59.83, left: 0.17, available: true });
    const rexLong = await transcribe(base, rex, 20);
    eq('a clip past them is used up', [rexLong.status, rexLong.body.code], [402, 'trial_used']);
    eq('one inside them is not', (await transcribe(base, rex, 10)).status, 200);

    const sue = member('sue@example.com');
    store.setPlan(sue.email, 'pro', '2026-09-01T00:00:00.000Z');
    spend(sue, 4000, '2026-07-01');
    account = await me(base, sue);
    eq('a lapsed account that used more than the trial ever allowed has none left',
      account.trial, { credits: 60, used: 66.67, left: 0, available: true });
    eq('and is refused', (await transcribe(base, sue, 1)).body, { error: USED_UP, code: 'trial_used' });
    store.setPlan(sue.email, 'pro', '2027-06-01T00:00:00.000Z');
    eq('renewing makes it Pro again, and the trial is not for it', (await me(base, sue)).trial, { credits: 60, used: 0, left: 0, available: false });

    // --- no monthly reset ---------------------------------------------------------
    const sam = member('sam@example.com');
    spend(sam, 30 * 60, '2026-09-10');
    eq('last month\'s minutes are counted', (await me(base, sam)).trial, { credits: 60, used: 30, left: 30, available: true });
    clock = Date.parse('2026-11-15T09:00:00Z');
    eq('and next month brings none back', (await me(base, sam)).trial, { credits: 60, used: 30, left: 30, available: true });
    clock = Date.parse('2027-03-01T09:00:00Z');
    const later = await transcribe(base, sam, 60);
    eq('not even in March', [later.status, later.body.trial], [200, { credits: 60, used: 31, left: 29, available: true }]);
    clock = Date.parse('2026-10-04T10:00:00Z');
  } finally {
    for (const held of pending) held.reject(new Error('test complete'));
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    store.close();
  }
  process.stdout.write('all ' + checks + ' cloud trial checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
