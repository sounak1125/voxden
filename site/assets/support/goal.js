/*
 * Voxden: the signing goal's shared parts. One live connection per page,
 * whatever shows the goal: the card (support.js, on /download and /support)
 * and the corner capsule (capsule.js, on / and /download).
 *
 *   window.VoxdenGoal
 *     subscribe(fn)       starts the connection on first use; fn(event) for
 *                           { type: 'goal', goal, prev, mine }   new totals; `mine` when
 *                                                               this visitor's payment landed
 *                           { type: 'offline', failures, first } the service did not answer
 *                           { type: 'currency', currency }       the visitor's currency changed
 *                           { type: 'pending-lapsed' }           paid, but no webhook within a minute
 *     goal(), now()       the last totals; this PC's clock set to the service's
 *     currency(), setCurrency(c), limits(c)
 *     pay(amount, hooks)  an order, then Razorpay's checkout, in the current currency.
 *                         Resolves 'paid' or 'dismissed'; rejects with a message to show.
 *                         hooks.onOpen() once the checkout is on screen, hooks.onFailed(msg)
 *                         when Razorpay refuses an attempt and the visitor may try again.
 *     preload()           fetch Razorpay's script ahead of a click
 *     money, pct, ago, toDisplay, toInr, reduce()
 *     Roller              rolling digits
 *     Buddy               the character: a small flow bar with a face, arms and legs
 *     typeInto(el, text, buddy)   a speech bubble typed out like a dictation arriving
 *     burst(el, count)    confetti of little waveform bars from an element
 *
 * Totals come from the account service: pushed over GET /v1/support/stream
 * the moment a payment is recorded, and read from GET /v1/support on start,
 * every 15 s while the stream is down (60 s while it is up) and every 2 s for
 * a minute after this visitor pays. A hidden tab does neither. Only
 * Razorpay's signed webhook moves the total, so the goal shows money that has
 * arrived, never money that was promised. Amounts are rupees; a visitor
 * paying in dollars sees them in dollars at the service's rate.
 */
(function () {
  'use strict';

  if (window.VoxdenGoal) return;

  const doc = document;
  const root = doc.documentElement;
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  // A local preview may point at a local service: ?api=http://127.0.0.1:8787/v1
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = String((LOCAL && new URLSearchParams(location.search).get('api')) || 'https://account.voxden.app/v1').replace(/\/+$/, '');
  const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';
  const POLL_MS = 15000;
  const STREAM_POLL_MS = 60000;
  const FAST_POLL_MS = 2000;
  const FAST_POLL_FOR_MS = 60000;
  const CURRENCIES = {
    INR: { symbol: '₹', chips: [100, 250, 500, 1000], pick: 250, min: 50, max: 50000, locale: 'en-IN', word: 'rupees' },
    USD: { symbol: '$', chips: [2, 5, 10, 25], pick: 5, min: 1, max: 500, locale: 'en-US', word: 'dollars' },
  };
  const CURRENCY_KEY = 'voxden-support-currency';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const listeners = new Set();
  const state = {
    goal: null,
    offset: 0,          // service time minus this PC's
    failures: 0,
    pending: null,      // { before, until } after this visitor paid
    paying: false,
    currency: 'INR',
    chosen: false,      // the visitor picked a currency; the region no longer decides
    started: false,
  };

  function emit(event) {
    listeners.forEach((fn) => {
      // One broken listener must not starve the others; its error still
      // reaches the console.
      try { fn(event); } catch (err) { setTimeout(() => { throw err; }); }
    });
  }

  // ---- formatting --------------------------------------------------------------------

  const rate = () => (state.goal && state.goal.usdInr) || 88;
  function money(value, currency) {
    const c = CURRENCIES[currency || state.currency];
    return c.symbol + Math.round(value).toLocaleString(c.locale);
  }
  function pct(frac) {
    const p = frac * 100;
    if (p > 0 && p < 1) return '<1%';
    return (p < 10 && p % 1 ? p.toFixed(1).replace(/\.0$/, '') : Math.floor(p)) + '%';
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() + state.offset - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  const toDisplay = (inr, currency) => ((currency || state.currency) === 'USD' ? inr / rate() : inr);
  const toInr = (amount, currency) => ((currency || state.currency) === 'USD' ? amount * rate() : amount);

  // ---- the live connection ------------------------------------------------------------

  function apply(next) {
    if (!next || typeof next.raisedInr !== 'number') return;
    const prev = state.goal;
    if (prev && next.contributions < prev.contributions) return; // an older answer arriving late
    if (next.serverTime) state.offset = Date.parse(next.serverTime) - Date.now();
    state.goal = next;
    state.failures = 0;
    let mine = false;
    if (prev && next.contributions > prev.contributions && state.pending && next.contributions > state.pending.before) {
      mine = true;
      state.pending = null;
    }
    emit({ type: 'goal', goal: next, prev, mine });
  }

  let stream = null;
  let streamLive = false;
  function openStream() {
    if (stream || typeof window.EventSource !== 'function' || doc.hidden) return;
    stream = new EventSource(API + '/support/stream');
    stream.onopen = () => { streamLive = true; };
    stream.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch (_) {} };
    stream.onerror = () => {
      streamLive = false;
      // EventSource retries by itself; a refusal (the service at its cap)
      // closes it for good, and polling alone carries on.
      if (stream && stream.readyState === 2) stream = null;
    };
  }
  function closeStream() {
    if (stream) stream.close();
    stream = null;
    streamLive = false;
  }

  let pollTimer = 0;
  let inFlight = false;
  async function load() {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(API + '/support', { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      apply(await res.json());
    } catch (_) {
      state.failures++;
      emit({ type: 'offline', failures: state.failures, first: !state.goal });
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (doc.hidden) return;
    const fast = state.pending && Date.now() < state.pending.until;
    if (state.pending && !fast) {
      state.pending = null;
      emit({ type: 'pending-lapsed' });
    }
    const wait = fast ? FAST_POLL_MS
      : streamLive ? STREAM_POLL_MS
        : Math.min(60000, POLL_MS * Math.pow(2, Math.min(2, state.failures)));
    pollTimer = setTimeout(load, wait);
  }

  // A hidden tab lets go of the stream and stops polling; coming back
  // catches up at once.
  doc.addEventListener('visibilitychange', () => {
    if (!state.started) return;
    if (doc.hidden) { clearTimeout(pollTimer); closeStream(); return; }
    load();
    openStream();
  });

  function start() {
    if (state.started) return;
    state.started = true;
    load();
    openStream();
  }

  // ---- currency -----------------------------------------------------------------------

  function initialCurrency() {
    let saved = '';
    try { saved = localStorage.getItem(CURRENCY_KEY) || ''; } catch (_) {}
    if (saved === 'INR' || saved === 'USD') { state.chosen = true; return saved; }
    const region = root.getAttribute('data-region');
    if (region === 'world') return 'USD';
    if (region === 'in') return 'INR';
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    return /^Asia\/(Kolkata|Calcutta)$/.test(tz) ? 'INR' : 'USD';
  }
  state.currency = initialCurrency();
  // site.js settles the region a moment after load; follow it until the
  // visitor picks a currency themselves.
  new MutationObserver(() => {
    if (state.chosen) return;
    const region = root.getAttribute('data-region');
    const next = region === 'world' ? 'USD' : region === 'in' ? 'INR' : state.currency;
    if (next !== state.currency) { state.currency = next; emit({ type: 'currency', currency: next }); }
  }).observe(root, { attributes: true, attributeFilter: ['data-region'] });

  function setCurrency(currency) {
    if (!CURRENCIES[currency]) return;
    state.chosen = true;
    try { localStorage.setItem(CURRENCY_KEY, currency); } catch (_) {}
    if (currency === state.currency) return;
    state.currency = currency;
    emit({ type: 'currency', currency });
  }

  // ---- paying -------------------------------------------------------------------------

  let checkoutLoading = null;
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = CHECKOUT_JS;
      s.async = true;
      const timer = setTimeout(() => { checkoutLoading = null; reject(new Error('Razorpay did not load. Check your connection and try again.')); }, 15000);
      s.onload = () => { clearTimeout(timer); window.Razorpay ? resolve() : reject(new Error('Razorpay did not load.')); };
      s.onerror = () => { clearTimeout(timer); checkoutLoading = null; reject(new Error('Razorpay did not load. A blocker may be stopping it.')); };
      doc.head.appendChild(s);
    });
    return checkoutLoading;
  }

  async function pay(amount, hooks) {
    const h = hooks || {};
    const currency = state.currency;
    const c = CURRENCIES[currency];
    if (state.paying) throw new Error('A payment is already open.');
    if (!state.goal || !state.goal.open) throw new Error('Payments are not open yet.');
    if (!(Number.isFinite(amount) && amount >= c.min && amount <= c.max)) {
      throw new Error('Any amount from ' + money(c.min, currency) + ' to ' + money(c.max, currency) + '.');
    }
    state.paying = true;
    let order;
    try {
      const [res] = await Promise.all([
        fetch(API + '/support/order', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(amount * 100), currency }),
        }),
        loadCheckout(),
      ]);
      order = await res.json().catch(() => null);
      if (!res.ok || !order || !order.orderId) throw new Error((order && order.error) || 'The payment could not be started. Try again in a minute.');
    } catch (err) {
      state.paying = false;
      throw new Error((err && err.message) || 'The payment could not be started.');
    }
    const before = state.goal.contributions;
    return new Promise((resolve) => {
      let paid = false;
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'Voxden',
        description: 'Help sign Voxden',
        image: location.origin + '/assets/img/icon.png',
        notes: { voxden_kind: 'support' },
        theme: { color: '#0b0b0c' },
        handler: () => {
          paid = true;
          state.paying = false;
          state.pending = { before, until: Date.now() + FAST_POLL_FOR_MS };
          load();
          resolve('paid');
        },
        modal: {
          ondismiss: () => {
            if (paid) return;
            state.paying = false;
            resolve('dismissed');
          },
        },
      });
      // A refused attempt leaves Razorpay's window open for another try, so
      // it only reports; closing the window is what settles it.
      rzp.on('payment.failed', (resp) => {
        const why = resp && resp.error && resp.error.description;
        if (h.onFailed) h.onFailed((why ? why + ' ' : '') + 'Nothing was charged. Try again, or another way to pay.');
      });
      rzp.open();
      if (h.onOpen) h.onOpen();
    });
  }

  // ---- rolling digits -----------------------------------------------------------------

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // Each digit is a column of 0-9 that slides to its value. A change in the
  // number of characters rebuilds the columns and rolls them up from zero.
  function Roller(node) {
    this.node = node;
    this.text = '';
  }
  Roller.prototype.set = function (text) {
    if (text === this.text) return;
    const node = this.node;
    const same = text.length === this.text.length;
    this.text = text;
    if (!same || reduceMQ.matches) {
      node.textContent = '';
      for (const ch of text) {
        if (/\d/.test(ch)) {
          const col = doc.createElement('span');
          col.className = 'vg-d';
          col.innerHTML = '<span class="vg-strip">0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9</span>';
          node.appendChild(col);
        } else {
          const c = doc.createElement('span');
          c.className = 'vg-c';
          c.innerHTML = ch === ' ' ? '&nbsp;' : esc(ch);
          node.appendChild(c);
        }
      }
      if (reduceMQ.matches) return this.apply(text, 0);
      // Let the zeroes paint, then roll.
      requestAnimationFrame(() => requestAnimationFrame(() => this.apply(text, 1)));
      return;
    }
    this.apply(text, 1);
  };
  Roller.prototype.apply = function (text, animate) {
    const cols = this.node.children;
    const digits = text.replace(/\D/g, '').length;
    let digit = 0;
    for (let i = 0; i < text.length; i++) {
      if (!/\d/.test(text[i])) continue;
      const strip = cols[i] && cols[i].firstChild;
      if (!strip) continue;
      strip.style.transitionDelay = animate ? ((digits - digit) * 45) + 'ms' : '0ms';
      strip.style.transform = 'translateY(' + (-Number(text[i]) * 10) + '%)';
      digit++;
    }
  };

  // ---- the character ------------------------------------------------------------------

  // A small flow bar with a face: the capsule body fills with mint as the
  // goal fills, the mouth is a waveform, an antenna lights while the goal is
  // live, and it has arms and legs to walk, sit, wave and kick with. One SVG,
  // 64 × 66 user units; every pose and motion is a class on the host
  // (goal.css), so JS only switches states and points the eyes.
  let buddies = 0;
  function Buddy(host) {
    const id = 'vb' + (++buddies);
    this.host = host;
    host.classList.add('vb');
    const eye = (x) => '<g transform="translate(' + x + ' 27.5)">'
      + '<rect class="vb-eye-open" x="-2.6" y="-4" width="5.2" height="8" rx="2.6"/>'
      + '<circle class="vb-eye-whoa" r="3.3"/>'
      + '<path class="vb-eye-happy" d="M-3.2 1.6Q0-3.2 3.2 1.6"/>'
      + '<path class="vb-eye-shut" d="M-3 .5h6"/>'
      + '</g>';
    host.insertAdjacentHTML('beforeend', '<svg class="vb-svg" viewBox="0 0 64 66" aria-hidden="true" focusable="false">'
      + '<defs>'
      + '<linearGradient id="' + id + 'f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d2d33"/><stop offset="1" stop-color="#141417"/></linearGradient>'
      + '<linearGradient id="' + id + 'r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#9cf3c4" stop-opacity=".35"/></linearGradient>'
      + '<clipPath id="' + id + 'c"><rect x="8.5" y="14.5" width="47" height="31" rx="15.5"/></clipPath>'
      + '</defs>'
      + '<g class="vb-leg vb-leg-l"><path d="M25 43.5 23.6 57.6"/><ellipse cx="21.6" cy="59.4" rx="4.3" ry="2.3"/></g>'
      + '<g class="vb-leg vb-leg-r"><path d="M39 43.5 40.4 57.6"/><ellipse cx="42.4" cy="59.4" rx="4.3" ry="2.3"/></g>'
      + '<g class="vb-torso">'
      + '<path class="vb-stalk" d="M32 14.5V8"/><circle class="vb-bulb" cx="32" cy="5.8" r="2.7"/>'
      + '<rect x="8.5" y="14.5" width="47" height="31" rx="15.5" fill="url(#' + id + 'f)"/>'
      + '<g clip-path="url(#' + id + 'c)"><g class="vb-level"><path class="vb-liquid" d="M-32 0q8-2.4 16 0t16 0 16 0 16 0 16 0 16 0 16 0 16 0v40h-128z"/></g></g>'
      + '<rect x="8.5" y="14.5" width="47" height="31" rx="15.5" fill="none" stroke="url(#' + id + 'r)"/>'
      + '<path class="vb-shine" d="M18 18.2h28"/>'
      // Arms after the body, so a wave or arms-up shows in full.
      + '<path class="vb-arm vb-arm-l" d="M10.5 30.5Q5.5 34.5 6 40.5"/>'
      + '<path class="vb-arm vb-arm-r" d="M53.5 30.5Q58.5 34.5 58 40.5"/>'
      + '<g class="vb-look">' + eye(24) + eye(40) + '</g>'
      + '<g transform="translate(32 38)">' + [-8, -4, 0, 4, 8].map((x) => '<rect class="vb-bar" x="' + (x - 1) + '" y="-3" width="2" height="6" rx="1"/>').join('') + '</g>'
      + '</g>'
      + '</svg><span class="vb-z" aria-hidden="true">z</span>');
    this.look = host.querySelector('.vb-look');
    this.level = host.querySelector('.vb-level');
    this.timers = {};
    this.fill(0);
    this._blink();
  }
  Buddy.prototype.set = function (name, on) {
    this.host.classList.toggle('is-' + name, !!on);
    return this;
  };
  Buddy.prototype.has = function (name) {
    return this.host.classList.contains('is-' + name);
  };
  // A state for a while, then off again.
  Buddy.prototype.flash = function (name, ms) {
    clearTimeout(this.timers[name]);
    this.set(name, true);
    this.timers[name] = setTimeout(() => this.set(name, false), ms || 1600);
    return this;
  };
  // A one-shot animation, restarted even if it is already running.
  Buddy.prototype.play = function (name, ms) {
    this.set(name, false);
    void this.host.offsetWidth;
    return this.flash(name, ms || 800);
  };
  Buddy.prototype.hop = function () {
    this.flash('happy', 1600);
    if (!reduceMQ.matches) this.play('hop', 760);
    return this;
  };
  Buddy.prototype.wave = function () {
    this.flash('happy', 1400);
    return this.play('wave', 1900);
  };
  Buddy.prototype.walk = function (on, left) {
    this.set('walk', on && !reduceMQ.matches);
    if (on) this.set('left', !!left);
    return this;
  };
  Buddy.prototype.fill = function (frac) {
    // Empty sits the liquid just under the body; full, just over its top.
    this.level.style.transform = 'translate(0px, ' + (46.5 - clamp(frac, 0, 1) * 33).toFixed(2) + 'px)';
    return this;
  };
  // Eyes toward a point on the screen; null looks ahead.
  Buddy.prototype.lookAt = function (x, y) {
    let dx = 1;
    let dy = 0.4;
    if (x != null) {
      const r = this.host.getBoundingClientRect();
      const vx = x - (r.left + r.width / 2);
      const vy = y - (r.top + r.height * 0.42);
      const len = Math.hypot(vx, vy) || 1;
      dx = (vx / len) * Math.min(2.4, len / 40);
      dy = (vy / len) * Math.min(1.8, len / 60);
    }
    return this.lookDir(dx, dy);
  };
  Buddy.prototype.lookDir = function (dx, dy) {
    this.look.setAttribute('transform', 'translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) + ')');
    return this;
  };
  Buddy.prototype._blink = function () {
    clearTimeout(this.timers.blinkLoop);
    this.timers.blinkLoop = setTimeout(() => {
      if (!this.has('sleep')) this.flash('blink', 150);
      this._blink();
    }, 2200 + Math.random() * 3800);
  };

  // ---- a speech bubble, typed out -----------------------------------------------------

  // Types `text` into `node` a few letters at a time with the character's
  // mouth moving, and returns a function that stops it. Under reduced motion
  // the words appear at once.
  function typeInto(node, text, buddy, done) {
    let timer = 0;
    let i = 0;
    const finish = () => {
      if (buddy) buddy.set('talk', false);
      if (done) done();
    };
    if (reduceMQ.matches) {
      node.textContent = text;
      finish();
      return () => {};
    }
    if (buddy) buddy.set('talk', true);
    const step = () => {
      i = Math.min(text.length, i + (text[i] === ' ' ? 2 : 1));
      node.textContent = text.slice(0, i);
      if (i < text.length) timer = setTimeout(step, 26); else finish();
    };
    step();
    return () => { clearTimeout(timer); if (buddy) buddy.set('talk', false); };
  }

  // ---- confetti -----------------------------------------------------------------------

  // Little waveform bars bursting from an element, on a canvas laid over the
  // window for a second and a half.
  function burst(from, count) {
    if (reduceMQ.matches || !from) return;
    const src = from.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const canvas = doc.createElement('canvas');
    canvas.className = 'vg-burst';
    canvas.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    doc.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const ox = src.left + src.width / 2;
    const oy = src.top + src.height / 2;
    const colors = ['#9cf3c4', '#ffffff', '#a78bfa', '#e8c15c', '#9cf3c4'];
    const parts = Array.from({ length: count || 40 }, () => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const v = 240 + Math.random() * 360;
      return {
        x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        w: 2.5 + Math.random() * 1.5, h: 7 + Math.random() * 12,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        c: colors[Math.floor(Math.random() * colors.length)],
      };
    });
    let prev = performance.now();
    const began = prev;
    const run = (now) => {
      const dt = Math.min(0.04, (now - prev) / 1000);
      prev = now;
      const age = (now - began) / 1000;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.vy += 900 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.vr * dt;
        ctx.save();
        ctx.globalAlpha = clamp(1.6 - age, 0, 1);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, p.w / 2); else ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fill();
        ctx.restore();
      }
      if (age < 1.6) requestAnimationFrame(run); else canvas.remove();
    };
    requestAnimationFrame(run);
  }

  window.VoxdenGoal = {
    subscribe(fn) {
      listeners.add(fn);
      start();
      if (state.goal) fn({ type: 'goal', goal: state.goal, prev: null, mine: false });
      return () => listeners.delete(fn);
    },
    goal: () => state.goal,
    now: () => Date.now() + state.offset,
    currency: () => state.currency,
    setCurrency,
    limits: (currency) => CURRENCIES[currency || state.currency],
    pay,
    paying: () => state.paying,
    preload: () => loadCheckout().catch(() => {}),
    money, pct, ago, toDisplay, toInr,
    reduce: () => reduceMQ.matches,
    Roller, Buddy, typeInto, burst,
  };
})();
