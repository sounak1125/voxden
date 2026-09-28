/*
 * Voxden: the signing goal's card, on /download and /support. The live
 * numbers, payments and the character come from goal.js (window.VoxdenGoal),
 * which must load first.
 *
 *   <div class="sg" data-voxden-support [data-sg-optional]
 *        data-goal-label="Certificate"
 *        data-milestones='[{"at":8500,"label":"Card reader"}, ...]'>
 *     <div class="sg-head"> … <div class="sg-clock" data-sg-clock hidden></div></div>
 *     <div data-sg-body></div>
 *   </div>
 *
 * The page writes the heading; this file draws the rest into [data-sg-body]:
 * the raised total, a bar drawn as a voice waveform that fills toward a seal,
 * the character walking along its leading edge, the milestones, the latest
 * contributions, and the amount picker that opens Razorpay's own checkout.
 * The countdown goes into [data-sg-clock]. data-sg-optional hides the whole
 * section while the service cannot be reached.
 *
 * Motion: the waveform runs only while the bar is on screen and the tab is
 * visible; under reduced motion the bar is still, the numbers change without
 * rolling, and nothing bursts.
 */
(function () {
  'use strict';

  const G = window.VoxdenGoal;
  const mount = document.querySelector('[data-voxden-support]');
  if (!G || !mount || mount.dataset.sgReady) return;
  mount.dataset.sgReady = '1';

  const doc = document;
  let milestones = [];
  try { milestones = JSON.parse(mount.dataset.milestones || '[]'); } catch (_) { milestones = []; }

  const state = {
    goal: null,
    amount: G.limits().pick,
    ghost: 0,          // the fraction of the goal the chosen amount adds
    hoverGhost: null,  // the same while a pointer hovers the empty bar
    busy: false,
    reached: false,
    lastPaid: '',
  };
  const shown = { frac: 0 };  // what the bar draws, easing toward the real fraction
  let energy = 1;             // how loudly the waveform speaks; events raise it
  let loadedOnce = false;

  const el = (tag, cls, html) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const reduce = () => G.reduce();
  const money = (v, c) => G.money(v, c);
  const pct = G.pct;
  const toDisplay = (inr) => G.toDisplay(inr);
  const goalInr = () => (state.goal ? state.goal.goalInr : 25000);
  const raisedFrac = () => (state.goal ? state.goal.raisedInr / state.goal.goalInr : 0);

  // ---- markup --------------------------------------------------------------------

  const body = mount.querySelector('[data-sg-body]');
  const clock = mount.querySelector('[data-sg-clock]');
  if (!body) return;
  const section = mount.hasAttribute('data-sg-optional') ? mount.closest('section') : null;

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
    + '  <button class="sg-mascot" type="button" aria-label="Talk to the bar"></button>'
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
  const buddy = new G.Buddy(ui.mascot);
  const raisedRoller = new G.Roller(ui.raised);

  // ---- the countdown -----------------------------------------------------------------

  const clockUnits = [];
  if (clock) {
    clock.innerHTML = '<div class="sg-units">' + ['days', 'hrs', 'min', 'sec'].map((label) => '<div class="sg-unit">'
      + '<span class="sg-cell" aria-hidden="true"></span><span class="sg-unit-label">' + label + '</span></div>').join('')
      + '</div><p class="sg-clock-note"></p><p class="sr-only" data-sg-clock-text></p>';
    clock.querySelectorAll('.sg-cell').forEach((cell) => clockUnits.push(new G.Roller(cell)));
  }
  const clockNote = clock && clock.querySelector('.sg-clock-note');
  const clockText = clock && clock.querySelector('[data-sg-clock-text]');

  function tickClock() {
    if (!clock) return;
    const g = state.goal;
    const end = g && g.deadline ? Date.parse(g.deadline) : NaN;
    const now = G.now();
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
    intro: ['Psst. Windows thinks I’m a stranger.', 'Hi. I’m trying to get signed.', 'Every bit walks me to the right.'],
    poke: [
      'A certificate puts Sounak’s name on me.',
      'No more “Unknown publisher”. That’s the dream.',
      'Drag along the bar to see where your bit gets me.',
      'See my tummy? It fills up as the bar does.',
      'The seal at the end is the signature.',
      'Every number here is real money that arrived.',
    ],
    behind: ['That part’s already paid for. Look further right!', 'Been there. Thanks to everyone who got me here.'],
    wake: ['Oh! I’m up.', 'Hm? Was I dreaming about certificates?'],
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  let lineIndex = 0;
  let stopTyping = () => {};
  let hideTimer = 0;

  function say(text, holdMs) {
    stopTyping();
    clearTimeout(hideTimer);
    wake(true);
    ui.bubble.classList.add('is-on');
    placeBubble();
    energy = Math.max(energy, 1.35);
    stopTyping = G.typeInto(ui.bubbleText, text, buddy, () => {
      hideTimer = setTimeout(() => ui.bubble.classList.remove('is-on'), holdMs || 3600);
    });
  }

  let idleTimer = 0;
  function wake(quiet) {
    clearTimeout(idleTimer);
    if (buddy.has('sleep')) {
      buddy.set('sleep', false);
      if (!quiet) say(pick(LINES.wake), 2400);
    }
    idleTimer = setTimeout(() => {
      if (!buddy.has('talk') && !state.busy) buddy.set('sleep', true);
    }, 30000);
  }

  function hop() {
    buddy.hop();
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
  const HALF = 28; // half the character's width

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
    moveMascot();
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
    const x = clamp(xOf(shown.frac), HALF, trackW - HALF);
    const w = ui.bubble.offsetWidth;
    const right = x + HALF + 6 + w <= trackW || x < trackW / 2;
    const left = right ? x + HALF + 6 : x - HALF - 6 - w;
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
    const t = reduce() ? 1.2 : now / 1000;
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
    const pulse = reduce() ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3.4);
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
    // The character walks while the fill is still catching up.
    buddy.walk(Math.abs(target - shown.frac) > 0.002, target < shown.frac);
    shown.frac += (target - shown.frac) * (1 - Math.exp(-dt * 2.6));
    if (Math.abs(target - shown.frac) < 0.0005) shown.frac = target;
    energy += (1 - energy) * (1 - Math.exp(-dt * 1.4));
    draw(now);
    moveMascot();
    if (onScreen && !doc.hidden && !reduce()) raf = requestAnimationFrame(frame);
    else buddy.walk(false);
  }
  function start() {
    if (reduce()) {
      shown.frac = raisedFrac();
      draw(performance.now());
      moveMascot();
      return;
    }
    if (!raf && onScreen && !doc.hidden) { last = 0; raf = requestAnimationFrame(frame); }
  }

  function moveMascot() {
    const x = clamp(xOf(shown.frac), HALF, trackW - HALF);
    ui.mascot.style.transform = 'translate3d(' + (x - HALF).toFixed(1) + 'px, 0, 0)';
    if (ui.bubble.classList.contains('is-on')) placeBubble();
    // Eyes: at the pointer when there is one, else at the chosen amount's
    // end, else ahead along the bar.
    if (pointer) buddy.lookAt(pointer.x, pointer.y);
    else buddy.lookDir(state.ghost > 0 ? 2.2 : 1.2, 0.4);
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
    buddy.fill(frac).set('live', true);
    if (state.reached && !was && loadedOnce) {
      ui.seal.classList.add('is-stamp');
      G.burst(ui.seal, 64);
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
      item.appendChild(el('span', '', G.ago(r.at)));
      ui.feed.appendChild(item);
    });
    feedKeys = keys;
  }

  // ---- amounts ---------------------------------------------------------------------------------

  function buildAmounts() {
    const c = G.limits();
    ui.amounts.querySelectorAll('.sg-chip, .sg-other').forEach((n) => n.remove());
    c.chips.forEach((v) => {
      const chip = el('label', 'sg-chip');
      chip.innerHTML = '<input type="radio" name="sg-amount" value="' + v + '"><span>' + money(v) + '</span>';
      ui.amounts.appendChild(chip);
    });
    const other = el('label', 'sg-other');
    other.innerHTML = '<span class="sg-cur" aria-hidden="true">' + c.symbol + '</span>'
      + '<input type="text" inputmode="numeric" autocomplete="off" placeholder="Other" aria-label="Another amount, in ' + c.word + '">';
    ui.amounts.appendChild(other);
    ui.switcher.textContent = G.currency() === 'INR' ? 'Pay in dollars instead' : 'Pay in rupees instead';
    setAmount(c.pick, 'chip');
  }

  function otherInput() { return ui.amounts.querySelector('.sg-other input'); }

  // `from` is where the amount came from: a chip, the Other field, or the bar.
  function setAmount(value, from) {
    const c = G.limits();
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
    const c = G.limits();
    return Number.isFinite(value) && value >= c.min && value <= c.max;
  }

  // A message that outranks the amount's effect for a while: an error, or
  // news about this visitor's own payment. Updates arrive every few seconds
  // and must not wipe it.
  let note = null;
  function hold(text, ms, error) {
    note = { text, error: !!error, until: Date.now() + (ms || 8000) };
    updateEffect();
  }

  function updateEffect() {
    const c = G.limits();
    const value = state.amount;
    const ok = valid(value);
    state.ghost = ok ? G.toInr(value) / goalInr() : 0;
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
    G.setCurrency(G.currency() === 'INR' ? 'USD' : 'INR');
  });

  // ---- the bar itself: hover to preview, press or drag to choose -------------------------------

  function amountAt(clientX) {
    const rect = ui.wave.getBoundingClientRect();
    const f = clamp((clientX - rect.left) / rect.width, 0, 1);
    const add = f - raisedFrac();
    if (add <= 0) return null;
    const c = G.limits();
    const raw = toDisplay(add * goalInr());
    const step = G.currency() === 'INR' ? (raw < 2000 ? 50 : 100) : 1;
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
      state.hoverGhost = value != null ? G.toInr(value) / goalInr() : null;
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
  ui.mascot.addEventListener('pointerenter', () => { if (!buddy.has('talk')) buddy.wave(); });

  // ---- paying ---------------------------------------------------------------------------------------

  // Fetch Razorpay's script as soon as someone looks like paying.
  ui.submit.addEventListener('pointerenter', G.preload, { once: true });
  ui.submit.addEventListener('focus', G.preload, { once: true });

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

  ui.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy || !state.goal || !state.goal.open) return;
    const value = state.amount;
    if (!valid(value)) { updateEffect(); return; }
    const label = money(value);
    setBusy(true);
    try {
      const result = await G.pay(value, {
        onOpen: () => setBusy(true, 'Waiting for Razorpay…'),
        onFailed: (message) => { note = { text: message, error: true, until: Date.now() + 12000 }; },
      });
      if (result === 'paid') {
        state.lastPaid = label;
        state.busy = false;
        mount.classList.remove('is-busy');
        hold('Paid. Counting it…', 60000);
        say('Counting it… one second.', 2400);
        energy = 2;
      } else {
        setBusy(false);
      }
    } catch (err) {
      state.busy = false;
      mount.classList.remove('is-busy');
      hold((err && err.message) || 'The payment could not be started.', 12000, true);
    }
  });

  // ---- live updates ----------------------------------------------------------------------------------

  G.subscribe((event) => {
    if (event.type === 'goal') {
      const prev = state.goal;
      state.goal = event.goal;
      if (section) section.hidden = false;
      mount.classList.remove('is-offline');
      mount.classList.add('is-live');
      // Someone paid since the last look: this visitor, or anybody else.
      if (prev && event.goal.contributions > prev.contributions) {
        const newest = event.goal.recent && event.goal.recent[0];
        hop();
        buddy.play('ping', 900);
        if (event.mine) {
          G.burst(ui.mascot, 48);
          say('That’s you on the bar. Thank you!', 5200);
          mount.classList.add('is-thanked');
          hold('Thank you. Your ' + (state.lastPaid || 'bit') + ' is on the bar.', 12000);
          setTimeout(() => mount.classList.remove('is-thanked'), 8000);
        } else if (newest) {
          say('Someone just chipped in ' + money(newest.amount, newest.currency) + '!', 3200);
        }
      }
      render();
      if (!loadedOnce) {
        loadedOnce = true;
        setTimeout(() => { if (onScreen && !state.reached) say(pick(LINES.intro), 3000); }, 1300);
      }
    } else if (event.type === 'offline') {
      mount.classList.add('is-offline');
      buddy.set('live', false);
      if (event.first) {
        // A page where the goal is a side note leaves it out until the
        // service answers; the support page says what is wrong.
        if (section) section.hidden = true;
        hold('The live total is out of reach right now. Trying again…', 60000, true);
      }
    } else if (event.type === 'currency') {
      buildAmounts();
      render();
    } else if (event.type === 'pending-lapsed') {
      hold('Paid. It lands on the bar as soon as Razorpay confirms it.', 20000);
    }
  });

  // ---- start -----------------------------------------------------------------------------------------

  buildAmounts();
  raisedRoller.set(money(0));
  measure();
  new ResizeObserver(() => measure()).observe(ui.track);
  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    if (onScreen) start();
  }, { rootMargin: '80px' }).observe(ui.track);
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) start(); });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', start);
  setInterval(() => { if (!doc.hidden) tickClock(); }, 1000);
  setInterval(() => { if (!doc.hidden && state.goal) renderFeed(); }, 30000);
  wake(true);
})();
