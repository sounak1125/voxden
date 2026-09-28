/*
 * Voxden: the signing goal. A live bar toward the code-signing certificate,
 * on /download and /support.
 *
 *   <div class="sg" data-voxden-support
 *        data-api="https://account.voxden.app/v1"
 *        data-milestones='[{"at":8500,"label":"Card reader"}, ...]'>
 *     <div class="sg-head"> … <div class="sg-clock" data-sg-clock hidden></div></div>
 *     <div data-sg-body></div>
 *   </div>
 *
 * The page writes the heading; this file draws the rest into [data-sg-body]:
 * the raised total, a bar drawn as a voice waveform that fills toward the
 * goal, a small flow-bar character riding its leading edge, the milestones,
 * the latest contributions, and the amount picker that opens Razorpay's own
 * checkout. The countdown goes into [data-sg-clock].
 *
 * Numbers come from the account service: pushed over GET /v1/support/stream
 * the moment a payment is recorded, and read from GET /v1/support on load,
 * every 15 s when the stream is down (every 60 s while it is up), and every
 * 2 s for a minute after the visitor pays. A hidden tab does neither. Only
 * Razorpay's signed webhook moves the total, so the bar shows money that has
 * arrived, never money that was promised.
 *
 * Amounts in the goal are rupees. A visitor paying in dollars sees the goal
 * in dollars too, at the service's rate. Milestones are rupees.
 *
 * Motion: the waveform and the character run only while the bar is on
 * screen and the tab is visible; under reduced motion the bar is still, the
 * numbers change without rolling, and nothing bursts.
 */
(function () {
  'use strict';

  const mount = document.querySelector('[data-voxden-support]');
  if (!mount || mount.dataset.sgReady) return;
  mount.dataset.sgReady = '1';

  const doc = document;
  const root = doc.documentElement;
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = reduceMQ.matches;

  // ---- configuration -----------------------------------------------------------

  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = (() => {
    // A local preview may point at a local service: ?api=http://127.0.0.1:8787/v1
    const asked = LOCAL ? new URLSearchParams(location.search).get('api') : '';
    return String(asked || mount.dataset.api || 'https://account.voxden.app/v1').replace(/\/+$/, '');
  })();
  const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';
  const POLL_MS = 15000;
  const STREAM_POLL_MS = 60000;
  const FAST_POLL_MS = 2000;
  const FAST_POLL_FOR_MS = 60000;
  const CURRENCIES = {
    INR: { symbol: '₹', chips: [100, 250, 500, 1000], pick: 250, min: 50, max: 50000, locale: 'en-IN' },
    USD: { symbol: '$', chips: [2, 5, 10, 25], pick: 5, min: 1, max: 500, locale: 'en-US' },
  };
  const CURRENCY_KEY = 'voxden-support-currency';
  let milestones = [];
  try { milestones = JSON.parse(mount.dataset.milestones || '[]'); } catch (_) { milestones = []; }

  // ---- state ---------------------------------------------------------------------

  const state = {
    goal: null,            // the last answer from /v1/support
    clockOffset: 0,        // server time minus this PC's
    currency: 'INR',
    currencyChosen: false, // the visitor picked one; the region no longer decides
    amount: CURRENCIES.INR.pick,
    ghost: 0,              // the fraction of the goal the chosen amount adds
    hoverGhost: null,      // the same while a pointer hovers the empty bar
    pending: null,         // { before, amount, currency, until } after this visitor paid
    busy: false,
    reached: false,
    failures: 0,
  };
  const shown = { frac: 0 };  // what the bar draws, easing toward the real fraction
  let energy = 1;             // how loudly the waveform speaks; events raise it

  // ---- small helpers ---------------------------------------------------------------

  const el = (tag, cls, html) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const cur = () => CURRENCIES[state.currency];
  const rate = () => (state.goal && state.goal.usdInr) || 88;
  const toDisplay = (inr) => (state.currency === 'USD' ? inr / rate() : inr);
  const toInr = (amount, currency) => (currency === 'USD' ? amount * rate() : amount);
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
    const s = Math.max(0, (Date.now() + state.clockOffset - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  const goalInr = () => (state.goal ? state.goal.goalInr : 25000);
  const raisedFrac = () => (state.goal ? state.goal.raisedInr / state.goal.goalInr : 0);

  // ---- markup --------------------------------------------------------------------

  const body = mount.querySelector('[data-sg-body]');
  const clock = mount.querySelector('[data-sg-clock]');
  if (!body) return;
  // data-sg-optional: hide the whole section while the service cannot be
  // reached, rather than show a broken card.
  const section = mount.hasAttribute('data-sg-optional') ? mount.closest('section') : null;

  const MASCOT = '<svg viewBox="0 0 60 44" aria-hidden="true" focusable="false">'
    + '<defs>'
    + '<linearGradient id="sg-m-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a30"/><stop offset="1" stop-color="#141417"/></linearGradient>'
    + '<linearGradient id="sg-m-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#9cf3c4" stop-opacity=".28"/></linearGradient>'
    + '</defs>'
    + '<g class="sg-m-body">'
    + '<rect x="4.5" y="6.5" width="51" height="31" rx="15.5" fill="url(#sg-m-fill)" stroke="url(#sg-m-rim)"/>'
    + '<path d="M16 9.5h28" stroke="#fff" stroke-opacity=".16" stroke-linecap="round"/>'
    + '<g class="sg-m-look">'
    + ['22', '38'].map((x) => '<g transform="translate(' + x + ' 17.5)">'
      + '<rect class="sg-m-open" x="-2.6" y="-4" width="5.2" height="8" rx="2.6" fill="#fff"/>'
      + '<path class="sg-m-happy" d="M-3.2 1.6Q0-3.2 3.2 1.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>'
      + '<path class="sg-m-shut" d="M-3 .5h6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'
      + '</g>').join('')
    + '</g>'
    + '<g transform="translate(30 29)">'
    + [-8, -4, 0, 4, 8].map((x) => '<rect class="sg-m-bar" x="' + (x - 1) + '" y="-3.5" width="2" height="7" rx="1" fill="#9cf3c4"/>').join('')
    + '</g>'
    + '</g>'
    + '</svg>'
    + '<span class="sg-m-z" aria-hidden="true">z</span>';

  // A rosette with twelve scallops and a tick: the signature at the end.
  const SEAL = (() => {
    let d = '';
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2 - Math.PI / 2;
      const r = 19 + Math.cos(a * 12) * 1.8;
      d += (i ? 'L' : 'M') + (22 + Math.cos(a) * r).toFixed(2) + ' ' + (22 + Math.sin(a) * r).toFixed(2);
    }
    return '<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false">'
      + '<path class="sg-seal-edge" d="' + d + 'Z"/>'
      + '<circle class="sg-seal-ring" cx="22" cy="22" r="13.5"/>'
      + '<path class="sg-seal-tick" d="M16.5 22.4l3.7 3.6 7.4-7.6"/>'
      + '</svg>';
  })();

  body.innerHTML = ''
    + '<div class="sg-figures">'
    + '  <p class="sg-raised"><span class="sg-num" data-sg-raised aria-hidden="true"></span><span class="sr-only" data-sg-raised-text></span>'
    + '    <span class="sg-of">raised of <b data-sg-goal></b></span></p>'
    + '  <ul class="sg-stats">'
    + '    <li><b data-sg-pct>0%</b><span>of the goal</span></li>'
    + '    <li><b data-sg-count>0</b><span data-sg-count-label>contributions</span></li>'
    + '    <li><b data-sg-left></b><span data-sg-left-label>to go</span></li>'
    + '  </ul>'
    + '</div>'
    + '<div class="sg-track" data-sg-track role="progressbar" aria-label="Raised toward the signing goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">'
    + '  <div class="sg-well"><canvas class="sg-wave" aria-hidden="true"></canvas><div class="sg-ticks" aria-hidden="true"></div>'
    + '    <div class="sg-seal" title="Signed">' + SEAL + '</div></div>'
    + '  <button class="sg-mascot" type="button" aria-label="Talk to the bar">' + MASCOT + '</button>'
    + '  <div class="sg-bubble" aria-live="polite"><span class="sg-bubble-text"></span></div>'
    + '</div>'
    + '<div class="sg-marks" aria-hidden="true"></div>'
    + '<div class="sg-feed"><span class="sg-feed-label"><span class="sg-live" aria-hidden="true"></span>Latest</span>'
    + '  <ol class="sg-feed-list" aria-label="Latest contributions"></ol></div>'
    + '<form class="sg-pay" novalidate>'
    + '  <fieldset class="sg-amounts"><legend class="sr-only">How much</legend></fieldset>'
    + '  <div class="sg-go">'
    + '    <button class="btn btn-primary btn-lg sg-submit" type="submit"><span class="sg-submit-text">Chip in</span><span class="sg-submit-arrow" aria-hidden="true">→</span></button>'
    + '    <p class="sg-effect" aria-live="polite"></p>'
    + '  </div>'
    + '</form>'
    + '<p class="fine sg-fine">Razorpay takes the payment: UPI, cards and net banking in India, cards everywhere else. '
    + 'It is a gift toward the certificate, the card reader and their yearly renewal: voluntary, not refundable, and it buys nothing. '
    + 'Anything past the goal goes to next year’s renewal. <button type="button" class="sg-switch"></button></p>';

  const $ = (sel) => mount.querySelector(sel);
  const ui = {
    raised: $('[data-sg-raised]'), raisedText: $('[data-sg-raised-text]'), goal: $('[data-sg-goal]'),
    pct: $('[data-sg-pct]'), count: $('[data-sg-count]'), countLabel: $('[data-sg-count-label]'),
    left: $('[data-sg-left]'), leftLabel: $('[data-sg-left-label]'),
    track: $('[data-sg-track]'), well: $('.sg-well'), wave: $('.sg-wave'), ticks: $('.sg-ticks'), seal: $('.sg-seal'),
    mascot: $('.sg-mascot'), bubble: $('.sg-bubble'), bubbleText: $('.sg-bubble-text'),
    marks: $('.sg-marks'), feed: $('.sg-feed-list'),
    form: $('.sg-pay'), amounts: $('.sg-amounts'), submit: $('.sg-submit'), submitText: $('.sg-submit-text'),
    effect: $('.sg-effect'), switcher: $('.sg-switch'),
  };
  const mouth = Array.from(mount.querySelectorAll('.sg-m-bar'));
  const look = mount.querySelector('.sg-m-look');

  // ---- rolling numbers ---------------------------------------------------------------

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
    if (!same || reduce) {
      node.textContent = '';
      for (const ch of text) {
        if (/\d/.test(ch)) {
          const col = el('span', 'sg-d');
          const strip = el('span', 'sg-strip', '0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9');
          col.appendChild(strip);
          node.appendChild(col);
        } else {
          node.appendChild(el('span', 'sg-c', ch === ' ' ? '&nbsp;' : ch.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
        }
      }
      if (reduce) return this.apply(text, 0);
      // Let the zeroes paint, then roll.
      requestAnimationFrame(() => requestAnimationFrame(() => this.apply(text, 1)));
      return;
    }
    this.apply(text, 1);
  };
  Roller.prototype.apply = function (text, animate) {
    const cols = this.node.children;
    let digit = 0;
    const digits = text.replace(/\D/g, '').length;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!/\d/.test(ch)) continue;
      const strip = cols[i] && cols[i].firstChild;
      if (!strip) continue;
      strip.style.transitionDelay = animate ? ((digits - digit) * 45) + 'ms' : '0ms';
      strip.style.transform = 'translateY(' + (-Number(ch) * 10) + '%)';
      digit++;
    }
  };

  const raisedRoller = new Roller(ui.raised);

  // ---- the countdown -----------------------------------------------------------------

  const clockUnits = [];
  if (clock) {
    clock.innerHTML = '<div class="sg-units">' + ['days', 'hrs', 'min', 'sec'].map((label) => '<div class="sg-unit">'
      + '<span class="sg-cell" aria-hidden="true"></span><span class="sg-unit-label">' + label + '</span></div>').join('')
      + '</div><p class="sg-clock-note"></p><p class="sr-only" data-sg-clock-text></p>';
    clock.querySelectorAll('.sg-cell').forEach((cell) => clockUnits.push(new Roller(cell)));
  }
  const clockNote = clock && clock.querySelector('.sg-clock-note');
  const clockText = clock && clock.querySelector('[data-sg-clock-text]');

  function tickClock() {
    if (!clock) return;
    const g = state.goal;
    const end = g && g.deadline ? Date.parse(g.deadline) : NaN;
    const now = Date.now() + state.clockOffset;
    if (!g || !Number.isFinite(end) || state.reached || end <= now) {
      clock.hidden = !(g && state.reached);
      if (g && state.reached) {
        clock.classList.add('is-done');
        if (clockNote) clockNote.textContent = 'Goal reached. Thank you.';
      }
      return;
    }
    clock.hidden = false;
    clock.classList.remove('is-done');
    let s = Math.floor((end - now) / 1000);
    const days = Math.floor(s / 86400); s -= days * 86400;
    const hrs = Math.floor(s / 3600); s -= hrs * 3600;
    const min = Math.floor(s / 60); s -= min * 60;
    [days, hrs, min, s].forEach((v, i) => clockUnits[i].set(String(v).padStart(2, '0')));
    if (clockNote) {
      clockNote.textContent = 'to reach it by ' + new Date(end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
    }
    if (clockText && (s % 30 === 0 || !clockText.textContent)) clockText.textContent = days + ' days and ' + hrs + ' hours left';
  }

  // ---- the character ---------------------------------------------------------------------

  const LINES = {
    intro: ['Psst. Windows thinks I’m a stranger.', 'Hi. I’m trying to get signed.', 'Every bit moves me to the right.'],
    poke: [
      'A certificate puts Sounak’s name on me.',
      'No more “Unknown publisher”. That’s the dream.',
      'Drag along the bar to see where your bit gets me.',
      'I’m made of sound waves. Mind the edges.',
      'The seal at the end is the signature.',
      'Every number here is real money that arrived.',
    ],
    behind: ['That part’s already paid for. Look further right!', 'Been there. Thanks to everyone who got me here.'],
    wake: ['Oh! I’m up.', 'Hm? Was I dreaming about certificates?'],
  };
  let lineIndex = 0;
  let talkTimer = 0;
  let hideTimer = 0;
  let talking = false;

  function say(text, hold) {
    clearTimeout(talkTimer);
    clearTimeout(hideTimer);
    wake(true);
    const box = ui.bubble;
    box.classList.add('is-on');
    placeBubble();
    if (reduce) {
      ui.bubbleText.textContent = text;
      talking = false;
      hideTimer = setTimeout(() => box.classList.remove('is-on'), hold || 4200);
      return;
    }
    // Typed out like a dictation arriving.
    let i = 0;
    talking = true;
    energy = Math.max(energy, 1.35);
    const step = () => {
      i = Math.min(text.length, i + (text[i] === ' ' ? 2 : 1));
      ui.bubbleText.textContent = text.slice(0, i);
      if (i < text.length) {
        talkTimer = setTimeout(step, 26);
      } else {
        talking = false;
        hideTimer = setTimeout(() => box.classList.remove('is-on'), hold || 3600);
      }
    };
    step();
  }
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  let blinkTimer = 0;
  function blinkLater() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (!ui.mascot.classList.contains('is-sleep')) {
        ui.mascot.classList.add('is-blink');
        setTimeout(() => ui.mascot.classList.remove('is-blink'), 140);
      }
      blinkLater();
    }, 2400 + Math.random() * 3800);
  }

  let idleTimer = 0;
  function wake(quiet) {
    clearTimeout(idleTimer);
    if (ui.mascot.classList.contains('is-sleep')) {
      ui.mascot.classList.remove('is-sleep');
      if (!quiet) say(pick(LINES.wake), 2400);
    }
    idleTimer = setTimeout(() => {
      if (!talking && !state.busy) ui.mascot.classList.add('is-sleep');
    }, 30000);
  }

  function happy(ms) {
    ui.mascot.classList.add('is-happy');
    setTimeout(() => ui.mascot.classList.remove('is-happy'), ms || 1800);
  }

  function hop() {
    if (reduce) return happy(1600);
    ui.mascot.classList.remove('is-hop');
    void ui.mascot.offsetWidth;
    ui.mascot.classList.add('is-hop');
    happy(1600);
    energy = 2.2;
  }

  // Where the pointer is, for the eyes. Null when it is off the card.
  let pointer = null;
  mount.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; wake(); }, { passive: true });
  mount.addEventListener('pointerleave', () => { pointer = null; state.hoverGhost = null; });

  // ---- layout ------------------------------------------------------------------------------

  let waveW = 0;
  let waveH = 0;
  let trackW = 0;
  const ctx = ui.wave.getContext('2d');

  function measure() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    waveW = ui.wave.clientWidth;
    waveH = ui.wave.clientHeight;
    trackW = ui.track.clientWidth;
    ui.wave.width = Math.round(waveW * dpr);
    ui.wave.height = Math.round(waveH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    placeMarks();
    draw(performance.now());
    moveMascot(performance.now());
  }

  // The x of a fraction of the goal, in the track's own pixels.
  function xOf(frac) {
    return ui.wave.offsetLeft + ui.well.offsetLeft + clamp(frac, 0, 1) * waveW;
  }

  function placeMarks() {
    ui.ticks.textContent = '';
    ui.marks.textContent = '';
    const goal = goalInr();
    const raised = state.goal ? state.goal.raisedInr : 0;
    for (const m of milestones) {
      const f = m.at / goal;
      if (!(f > 0 && f < 1)) continue;
      const done = raised >= m.at;
      const tick = el('span', 'sg-tick' + (done ? ' is-done' : ''));
      tick.style.left = (ui.wave.offsetLeft + f * waveW) + 'px';
      ui.ticks.appendChild(tick);
      const mark = el('span', 'sg-mark' + (done ? ' is-done' : '') + (f > 0.72 ? ' is-end' : ''),
        '<b>' + (done ? '✓ ' : '') + m.label + '</b><span>' + money(toDisplay(m.at)) + '</span>');
      mark.style.left = xOf(f) + 'px';
      ui.marks.appendChild(mark);
    }
    const end = el('span', 'sg-mark is-end is-goal' + (state.reached ? ' is-done' : ''),
      '<b>' + (state.reached ? '✓ ' : '') + (mount.dataset.goalLabel || 'Signed') + '</b><span>' + money(toDisplay(goal)) + '</span>');
    end.style.left = (ui.well.offsetLeft + ui.well.offsetWidth) + 'px';
    ui.marks.appendChild(end);
    // On a narrow bar, labels that would touch lose their amount, then
    // their words; the tick stays.
    const marks = Array.from(ui.marks.children);
    for (let i = marks.length - 2; i >= 0; i--) {
      const next = marks[i + 1].getBoundingClientRect();
      if (marks[i].getBoundingClientRect().right > next.left - 10) marks[i].classList.add('is-tight');
      if (marks[i].getBoundingClientRect().right > next.left - 10) marks[i].classList.add('is-hidden');
    }
  }

  // Beside the character, on whichever side has room, and never past the
  // track's edges: on a phone it may tuck over the character instead.
  function placeBubble() {
    const x = clamp(xOf(shown.frac), 30, trackW - 30);
    const w = ui.bubble.offsetWidth;
    const right = x + 34 + w <= trackW || x < trackW / 2;
    const left = right ? x + 34 : x - 34 - w;
    ui.bubble.style.left = clamp(left, 0, Math.max(0, trackW - w)) + 'px';
  }

  // ---- the waveform -------------------------------------------------------------------------

  // Three slow sines per bar: organic enough to read as a voice, cheap
  // enough to run every frame for a few hundred bars.
  function level(i, t) {
    return 0.5 + 0.5 * (0.5 * Math.sin(i * 0.37 + t * 1.6) + 0.3 * Math.sin(i * 0.11 - t * 0.9 + 1.3) + 0.2 * Math.sin(i * 0.83 + t * 2.7 + 0.4));
  }

  function bar(x, y, w, h) {
    const r = Math.min(w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }

  function draw(now) {
    if (!waveW) return;
    const t = reduce ? 1.2 : now / 1000;
    ctx.clearRect(0, 0, waveW, waveH);
    const pitch = waveW < 520 ? 5 : 6;
    const bw = pitch === 5 ? 2.5 : 3;
    const n = Math.floor(waveW / pitch);
    const lead = (waveW - n * pitch) / 2;
    const edge = clamp(shown.frac, 0, 1) * waveW;
    const ghost = state.hoverGhost != null ? state.hoverGhost : state.ghost;
    const ghostEdge = ghost > 0 ? clamp(shown.frac + ghost, 0, 1) * waveW : -1;
    const mid = waveH / 2;
    const maxH = waveH - 14;
    const fill = ctx.createLinearGradient(0, 0, Math.max(edge, 2), 0);
    fill.addColorStop(0, 'rgba(156, 243, 196, .42)');
    fill.addColorStop(0.72, 'rgba(156, 243, 196, .92)');
    fill.addColorStop(1, '#ffffff');
    const pulse = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3.4);
    for (let i = 0; i < n; i++) {
      const x = lead + i * pitch + (pitch - bw) / 2;
      const cx = x + bw / 2;
      let h;
      if (cx <= edge) {
        // Loudest near the leading edge, where the voice is.
        const near = Math.max(0, 1 - (edge - cx) / (pitch * 10));
        h = maxH * clamp((0.22 + 0.62 * level(i, t)) * (0.86 + 0.14 * energy) + near * 0.22 * energy, 0.1, 1);
        ctx.fillStyle = fill;
      } else if (cx <= ghostEdge) {
        h = maxH * (0.16 + 0.42 * level(i, t * 1.3));
        ctx.fillStyle = 'rgba(156, 243, 196, ' + (0.26 + 0.14 * pulse).toFixed(3) + ')';
      } else {
        h = 4;
        ctx.fillStyle = 'rgba(255, 255, 255, .11)';
      }
      bar(x, mid - Math.max(4, h) / 2, bw, Math.max(4, h));
    }
    // The ghost's far end: a thin line where the chosen amount would reach.
    if (ghostEdge > edge + 2) {
      ctx.fillStyle = 'rgba(156, 243, 196, ' + (0.45 + 0.35 * pulse).toFixed(3) + ')';
      ctx.fillRect(Math.round(ghostEdge) - 0.5, 6, 1, waveH - 12);
    }
  }

  // ---- the frame loop --------------------------------------------------------------------------

  let raf = 0;
  let last = 0;
  let onScreen = false;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    const target = raisedFrac();
    shown.frac += (target - shown.frac) * (1 - Math.exp(-dt * 2.6));
    if (Math.abs(target - shown.frac) < 0.0005) shown.frac = target;
    energy += (1 - energy) * (1 - Math.exp(-dt * 1.4));
    draw(now);
    moveMascot(now);
    if (onScreen && !doc.hidden && !reduce) raf = requestAnimationFrame(frame);
  }
  function start() {
    if (reduce) {
      shown.frac = raisedFrac();
      draw(performance.now());
      moveMascot(performance.now());
      return;
    }
    if (!raf && onScreen && !doc.hidden) { last = 0; raf = requestAnimationFrame(frame); }
  }

  function moveMascot(now) {
    const x = clamp(xOf(shown.frac), 30, trackW - 30);
    ui.mascot.style.transform = 'translate3d(' + (x - 30).toFixed(1) + 'px, 0, 0)';
    if (ui.bubble.classList.contains('is-on')) placeBubble();
    // Eyes: at the pointer when there is one, else at the chosen amount's
    // end, else ahead along the bar.
    let dx = 1.4;
    let dy = 0.2;
    const box = ui.mascot.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height * 0.4;
    if (pointer) {
      const vx = pointer.x - cx;
      const vy = pointer.y - cy;
      const len = Math.hypot(vx, vy) || 1;
      dx = (vx / len) * Math.min(2.4, len / 40);
      dy = (vy / len) * Math.min(1.8, len / 60);
    } else if (state.ghost > 0) {
      dx = 2.2;
    }
    look.setAttribute('transform', 'translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) + ')');
    // The mouth: loud while talking, a murmur otherwise.
    const t = reduce ? 0 : now / 1000;
    mouth.forEach((node, i) => {
      const v = talking
        ? 0.35 + 0.65 * Math.abs(Math.sin(t * 17 + i * 1.9) * Math.sin(t * 7.3 + i))
        : ui.mascot.classList.contains('is-sleep') ? 0.2 : 0.3 + 0.22 * level(i * 3, t * 1.3) * energy;
      node.style.transform = 'scaleY(' + clamp(v, 0.15, 1.25).toFixed(3) + ')';
    });
  }

  // ---- numbers on the page --------------------------------------------------------------------

  function render() {
    const g = state.goal;
    if (!g) return;
    const frac = g.raisedInr / g.goalInr;
    const was = state.reached;
    state.reached = frac >= 1;
    raisedRoller.set(money(toDisplay(g.raisedInr)));
    ui.raisedText.textContent = money(toDisplay(g.raisedInr)) + ' raised of ' + money(toDisplay(g.goalInr));
    ui.goal.textContent = money(toDisplay(g.goalInr));
    ui.pct.textContent = pct(frac);
    ui.count.textContent = g.contributions.toLocaleString('en-IN');
    ui.countLabel.textContent = g.contributions === 1 ? 'contribution' : 'contributions';
    const left = Math.max(0, g.goalInr - g.raisedInr);
    ui.left.textContent = money(toDisplay(state.reached ? g.raisedInr - g.goalInr : left));
    ui.leftLabel.textContent = state.reached ? 'toward renewal' : 'to go';
    ui.track.setAttribute('aria-valuenow', String(Math.min(100, Math.round(frac * 100))));
    ui.track.setAttribute('aria-valuetext', money(toDisplay(g.raisedInr)) + ' of ' + money(toDisplay(g.goalInr)));
    mount.classList.toggle('is-reached', state.reached);
    ui.seal.classList.toggle('is-signed', state.reached);
    if (state.reached && !was && loadedOnce) {
      ui.seal.classList.add('is-stamp');
      burst(ui.seal, 64);
      setTimeout(() => say('Signed, sealed. Thank you, all of you.', 6000), 700);
    }
    renderFeed();
    placeMarks();
    updateEffect();
    tickClock();
    start();
  }

  let feedKeys = [];
  function renderFeed() {
    const recent = (state.goal && state.goal.recent) || [];
    if (!recent.length) {
      ui.feed.innerHTML = '<li class="sg-feed-empty">Nobody yet. Be the first on the bar.</li>';
      feedKeys = [];
      return;
    }
    const keys = recent.map((r) => r.at + '|' + r.amount + r.currency);
    const fresh = new Set(loadedOnce ? keys.filter((k) => !feedKeys.includes(k)) : []);
    ui.feed.textContent = '';
    recent.forEach((r, i) => {
      const item = el('li', 'sg-feed-item' + (fresh.has(keys[i]) ? ' is-new' : ''));
      item.appendChild(el('b', '', money(r.amount, r.currency)));
      item.appendChild(el('span', '', ago(r.at)));
      ui.feed.appendChild(item);
    });
    feedKeys = keys;
  }

  // ---- amounts ---------------------------------------------------------------------------------

  function buildAmounts() {
    const c = cur();
    ui.amounts.querySelectorAll('.sg-chip, .sg-other').forEach((n) => n.remove());
    c.chips.forEach((v) => {
      const chip = el('label', 'sg-chip');
      chip.innerHTML = '<input type="radio" name="sg-amount" value="' + v + '"><span>' + money(v) + '</span>';
      ui.amounts.appendChild(chip);
    });
    const other = el('label', 'sg-other');
    other.innerHTML = '<span class="sg-cur" aria-hidden="true">' + c.symbol + '</span>'
      + '<input type="text" inputmode="numeric" autocomplete="off" placeholder="Other" aria-label="Another amount, in ' + (state.currency === 'INR' ? 'rupees' : 'dollars') + '">';
    ui.amounts.appendChild(other);
    ui.switcher.textContent = state.currency === 'INR' ? 'Pay in dollars instead' : 'Pay in rupees instead';
    setAmount(c.pick, 'chip');
  }

  function otherInput() { return ui.amounts.querySelector('.sg-other input'); }

  // `from` is where the amount came from: a chip, the Other field, or the bar.
  function setAmount(value, from) {
    const c = cur();
    state.amount = value;
    ui.amounts.querySelectorAll('.sg-chip input').forEach((input) => {
      input.checked = from !== 'other' && from !== 'bar' ? Number(input.value) === value : false;
    });
    const input = otherInput();
    if (from === 'bar' || (from === 'chip' && !c.chips.includes(value))) {
      input.value = value ? String(value) : '';
    } else if (from === 'chip') {
      input.value = '';
    }
    ui.amounts.querySelector('.sg-other').classList.toggle('is-on', from === 'other' || from === 'bar');
    updateEffect();
  }

  function valid(value) {
    const c = cur();
    return Number.isFinite(value) && value >= c.min && value <= c.max;
  }

  // A message that outranks the amount's effect for a while: an error, or
  // news about this visitor's own payment. Polls re-render every few
  // seconds and must not wipe it.
  let note = null;
  function hold(text, ms, error) {
    note = { text, error: !!error, until: Date.now() + (ms || 8000) };
    updateEffect();
  }

  function updateEffect() {
    const c = cur();
    const value = state.amount;
    const ok = valid(value);
    state.ghost = ok ? toInr(value, state.currency) / goalInr() : 0;
    const g = state.goal;
    if (state.busy) return;
    let text = '';
    if (!g) {
      ui.submit.disabled = true;
      ui.submitText.textContent = 'Chip in';
    } else if (!g.open) {
      ui.submit.disabled = true;
      ui.submitText.textContent = 'Payments open soon';
      text = 'The bar is live; the button isn’t switched on yet.';
    } else {
      ui.submit.disabled = !ok;
      ui.submitText.textContent = ok ? 'Chip in ' + money(value) : 'Chip in';
      const after = raisedFrac() + state.ghost;
      if (!ok) text = value || (otherInput() && otherInput().value) ? 'Any amount from ' + money(c.min) + ' to ' + money(c.max) + '.' : 'Pick an amount, or drag along the bar.';
      else if (raisedFrac() >= 1) text = 'The goal is met. This goes to next year’s renewal.';
      else text = 'Moves the bar ' + pct(state.ghost) + (after >= 1 ? ' and finishes it.' : ', to ' + pct(after) + '.');
    }
    const held = note && Date.now() < note.until;
    ui.effect.textContent = held ? note.text : text;
    ui.effect.classList.toggle('is-error', !!(held && note.error));
    if (!held) note = null;
  }

  ui.amounts.addEventListener('change', (e) => {
    if (e.target.name === 'sg-amount') {
      setAmount(Number(e.target.value), 'chip');
      reactToAmount();
    }
  });
  ui.amounts.addEventListener('input', (e) => {
    if (e.target.closest('.sg-other')) {
      // Whole units only. Everything after a decimal point goes, so 4.50 is
      // 4 and never 450; grouping commas (1,000) are simply dropped.
      const digits = e.target.value.split('.')[0].replace(/[^\d]/g, '').slice(0, 6);
      if (digits !== e.target.value) e.target.value = digits;
      setAmount(digits ? Number(digits) : 0, 'other');
    }
  });
  ui.amounts.addEventListener('focusin', (e) => {
    if (e.target.closest('.sg-other') && e.target.value) setAmount(Number(e.target.value), 'other');
  });

  let reactTimer = 0;
  function reactToAmount() {
    clearTimeout(reactTimer);
    reactTimer = setTimeout(() => {
      if (!valid(state.amount) || raisedFrac() >= 1) return;
      const after = raisedFrac() + state.ghost;
      if (after >= 1) say(money(state.amount) + '? That finishes it. Wow.', 3200);
      else if (state.ghost >= 0.08) say(money(state.amount) + '? That’s ' + pct(state.ghost) + ' in one go!', 3000);
      else say(money(state.amount) + ' gets me to ' + pct(after) + '.', 2600);
      energy = Math.max(energy, 1.5);
    }, 380);
  }

  ui.switcher.addEventListener('click', () => {
    state.currency = state.currency === 'INR' ? 'USD' : 'INR';
    state.currencyChosen = true;
    try { localStorage.setItem(CURRENCY_KEY, state.currency); } catch (_) {}
    buildAmounts();
    render();
  });

  // ---- the bar itself: hover to preview, press or drag to choose -------------------------------

  function amountAt(clientX) {
    const rect = ui.wave.getBoundingClientRect();
    const f = clamp((clientX - rect.left) / rect.width, 0, 1);
    const add = f - raisedFrac();
    if (add <= 0) return null;
    const c = cur();
    const raw = toDisplay(add * goalInr());
    const step = state.currency === 'INR' ? (raw < 2000 ? 50 : 100) : 1;
    return clamp(Math.max(c.min, Math.round(raw / step) * step), c.min, c.max);
  }

  let drag = null;
  ui.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.goal) return;
    drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, onMascot: !!e.target.closest('.sg-mascot') };
  });
  ui.track.addEventListener('pointermove', (e) => {
    if (!state.goal) return;
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && Math.abs(e.clientX - drag.x) > 5 && Math.abs(e.clientX - drag.x) > Math.abs(e.clientY - drag.y)) {
        drag.moved = true;
        try { ui.track.setPointerCapture(e.pointerId); } catch (_) {}
        ui.track.classList.add('is-dragging');
      }
      if (drag.moved) {
        const value = amountAt(e.clientX);
        if (value != null) setAmount(value, 'bar');
        e.preventDefault();
      }
      return;
    }
    if (e.pointerType === 'mouse' && !e.target.closest('.sg-mascot')) {
      const value = amountAt(e.clientX);
      state.hoverGhost = value != null ? toInr(value, state.currency) / goalInr() : null;
      ui.track.classList.toggle('is-ahead', value != null);
    }
  });
  const endDrag = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    ui.track.classList.remove('is-dragging');
    if (d.moved) { state.hoverGhost = null; reactToAmount(); return; }
    if (d.onMascot) return; // the click handler talks
    const value = amountAt(e.clientX);
    if (value == null) { say(pick(LINES.behind), 2800); return; }
    setAmount(value, 'bar');
    state.hoverGhost = null;
    reactToAmount();
  };
  ui.track.addEventListener('pointerup', endDrag);
  ui.track.addEventListener('pointercancel', (e) => { if (drag && drag.id === e.pointerId) { drag = null; ui.track.classList.remove('is-dragging'); } });
  ui.track.addEventListener('pointerleave', () => { state.hoverGhost = null; ui.track.classList.remove('is-ahead'); });

  ui.mascot.addEventListener('click', () => {
    if (drag && drag.moved) return;
    hop();
    say(LINES.poke[lineIndex++ % LINES.poke.length], 3400);
  });

  // ---- confetti: little waveform bars, a short burst -----------------------------------------------

  function burst(from, count) {
    if (reduce) return;
    const box = mount.getBoundingClientRect();
    const src = from.getBoundingClientRect();
    const canvas = el('canvas', 'sg-burst');
    canvas.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    mount.appendChild(canvas);
    const c2 = canvas.getContext('2d');
    c2.scale(dpr, dpr);
    const ox = src.left - box.left + src.width / 2;
    const oy = src.top - box.top + src.height / 2;
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
      c2.clearRect(0, 0, box.width, box.height);
      for (const p of parts) {
        p.vy += 900 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.vr * dt;
        c2.save();
        c2.globalAlpha = clamp(1.6 - age, 0, 1);
        c2.translate(p.x, p.y);
        c2.rotate(p.r);
        c2.fillStyle = p.c;
        c2.beginPath();
        if (c2.roundRect) c2.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, p.w / 2); else c2.rect(-p.w / 2, -p.h / 2, p.w, p.h);
        c2.fill();
        c2.restore();
      }
      if (age < 1.6) requestAnimationFrame(run); else canvas.remove();
    };
    requestAnimationFrame(run);
  }

  // ---- talking to the service ---------------------------------------------------------------------

  let loadedOnce = false;
  let pollTimer = 0;
  let inFlight = false;

  // New totals, from a poll or the live stream. Either may bring what the
  // other already did; only a rise in the count means somebody paid.
  function apply(next) {
    if (!next || typeof next.raisedInr !== 'number') return;
    const prev = state.goal;
    if (prev && next.contributions < prev.contributions) return; // an older answer arriving late
    if (next.serverTime) state.clockOffset = Date.parse(next.serverTime) - Date.now();
    state.goal = next;
    state.failures = 0;
    if (section) section.hidden = false;
    mount.classList.remove('is-offline');
    mount.classList.add('is-live');
    // Someone paid since the last look: this visitor, or anybody else.
    if (prev && next.contributions > prev.contributions) {
      const newest = next.recent && next.recent[0];
      if (state.pending && next.contributions > state.pending.before) {
        state.pending = null;
        hop();
        burst(ui.mascot, 48);
        say('That’s you on the bar. Thank you!', 5200);
        thanks();
      } else {
        hop();
        if (newest) say('Someone just chipped in ' + money(newest.amount, newest.currency) + '!', 3200);
      }
    }
    render();
    if (!loadedOnce) {
      loadedOnce = true;
      setTimeout(() => { if (onScreen && !state.reached) say(pick(LINES.intro), 3000); }, 1300);
    }
  }

  // The live stream: the service pushes new totals the moment a payment is
  // recorded. Polling carries on underneath, slower while the stream is up,
  // so a proxy that holds the stream back only costs a few seconds.
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

  async function load() {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(API + '/support', { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      apply(await res.json());
    } catch (err) {
      state.failures++;
      mount.classList.add('is-offline');
      if (!state.goal) {
        // A page where the goal is a side note leaves it out until the
        // service answers; the support page says what is wrong.
        if (section) section.hidden = true;
        hold('The live total is out of reach right now. Trying again…', POLL_MS * 4, true);
      }
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
      hold('Paid. It lands on the bar as soon as Razorpay confirms it.', 20000);
    }
    const wait = fast ? FAST_POLL_MS
      : streamLive ? STREAM_POLL_MS
        : Math.min(60000, POLL_MS * Math.pow(2, Math.min(2, state.failures)));
    pollTimer = setTimeout(load, wait);
  }

  // A hidden tab lets go of the stream and stops polling; coming back
  // catches up at once.
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) { clearTimeout(pollTimer); closeStream(); return; }
    load();
    openStream();
    start();
  });

  // ---- paying ---------------------------------------------------------------------------------------

  let checkoutLoading = null;
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = CHECKOUT_JS;
      s.async = true;
      const timer = setTimeout(() => reject(new Error('Razorpay did not load. Check your connection and try again.')), 15000);
      s.onload = () => { clearTimeout(timer); window.Razorpay ? resolve() : reject(new Error('Razorpay did not load.')); };
      s.onerror = () => { clearTimeout(timer); checkoutLoading = null; reject(new Error('Razorpay did not load. A blocker may be stopping it.')); };
      doc.head.appendChild(s);
    });
    return checkoutLoading;
  }
  // Fetch Razorpay's script as soon as someone looks like paying.
  ui.submit.addEventListener('pointerenter', () => { loadCheckout().catch(() => {}); }, { once: true });
  ui.submit.addEventListener('focus', () => { loadCheckout().catch(() => {}); }, { once: true });

  function setBusy(busy, label) {
    state.busy = busy;
    ui.submit.disabled = busy;
    mount.classList.toggle('is-busy', busy);
    if (busy) {
      ui.submitText.textContent = label || 'Opening Razorpay…';
      ui.effect.classList.remove('is-error');
    } else {
      updateEffect();
    }
  }

  function fail(message) {
    state.busy = false;
    mount.classList.remove('is-busy');
    hold(message, 12000, true);
  }

  function thanks() {
    mount.classList.add('is-thanked');
    hold('Thank you. Your ' + (state.lastPaid || 'bit') + ' is on the bar.', 12000);
    setTimeout(() => mount.classList.remove('is-thanked'), 8000);
  }

  ui.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy || !state.goal || !state.goal.open) return;
    const value = state.amount;
    if (!valid(value)) { updateEffect(); return; }
    const currency = state.currency;
    const label = money(value);
    setBusy(true);
    let order;
    try {
      const [res] = await Promise.all([
        fetch(API + '/support/order', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(value * 100), currency }),
        }),
        loadCheckout(),
      ]);
      order = await res.json().catch(() => null);
      if (!res.ok || !order || !order.orderId) throw new Error((order && order.error) || 'The payment could not be started. Try again in a minute.');
    } catch (err) {
      fail((err && err.message) || 'The payment could not be started.');
      return;
    }
    const before = state.goal.contributions;
    let settled = false;
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
        settled = true;
        state.lastPaid = label;
        state.pending = { before, until: Date.now() + FAST_POLL_FOR_MS };
        state.busy = false;
        mount.classList.remove('is-busy');
        hold('Paid. Counting it…', FAST_POLL_FOR_MS);
        say('Counting it… one second.', 2400);
        energy = 2;
        load();
      },
      modal: {
        ondismiss: () => { if (!settled) setBusy(false); },
      },
    });
    rzp.on('payment.failed', (resp) => {
      const why = resp && resp.error && resp.error.description;
      settled = true;
      fail((why ? why + ' ' : '') + 'Nothing was charged. Try again, or another way to pay.');
    });
    setBusy(true, 'Waiting for Razorpay…');
    rzp.open();
  });

  // ---- start -----------------------------------------------------------------------------------------

  function initialCurrency() {
    let saved = '';
    try { saved = localStorage.getItem(CURRENCY_KEY) || ''; } catch (_) {}
    if (saved === 'INR' || saved === 'USD') { state.currencyChosen = true; return saved; }
    const region = root.getAttribute('data-region');
    if (region === 'world') return 'USD';
    if (region === 'in') return 'INR';
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    return /^Asia\/(Kolkata|Calcutta)$/.test(tz) ? 'INR' : 'USD';
  }
  state.currency = initialCurrency();
  buildAmounts();
  // site.js settles the region a moment after load; follow it until the
  // visitor picks a currency themselves.
  new MutationObserver(() => {
    if (state.currencyChosen) return;
    const region = root.getAttribute('data-region');
    const next = region === 'world' ? 'USD' : region === 'in' ? 'INR' : state.currency;
    if (next !== state.currency) { state.currency = next; buildAmounts(); render(); }
  }).observe(root, { attributes: true, attributeFilter: ['data-region'] });

  raisedRoller.set(money(0));
  measure();
  new ResizeObserver(() => measure()).observe(ui.track);
  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    if (onScreen) start();
  }, { rootMargin: '80px' }).observe(ui.track);
  reduceMQ.addEventListener('change', (m) => { reduce = m.matches; start(); });
  setInterval(() => { if (!doc.hidden) tickClock(); }, 1000);
  setInterval(() => { if (!doc.hidden && state.goal) renderFeed(); }, 30000);
  blinkLater();
  wake(true);
  load();
  openStream();
})();
