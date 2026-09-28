/*
 * Voxden: the signing goal's corner window, on / and /download. Needs
 * goal.js (window.VoxdenGoal) first.
 *
 * A small glass window in the bottom-left corner shows the live total, and
 * the character lives beside it: it stands next to the window, wanders a few
 * steps and back, climbs up to sit on top with its legs dangling, dozes when
 * nobody moves, follows the pointer with its eyes, waves when hovered, and
 * can be picked up and dropped (it falls, lands on the window or the ground,
 * and shakes it off). When anyone pays, it hops and says so; when this
 * visitor pays, it celebrates.
 *
 * Pressing the window or the character opens a panel with the live bar, the
 * countdown, the latest contribution and a quick "Chip in" that opens
 * Razorpay's checkout. "Hide for now" puts it away for three days.
 *
 * It shows only once the service has answered, steps aside while the
 * download page's own goal card is on screen, and stays out of the way of
 * the phone menu. Under reduced motion it does not wander, and moves between
 * places without walking or falling.
 */
(function () {
  'use strict';

  const G = window.VoxdenGoal;
  if (!G || document.querySelector('.vbf')) return;

  const doc = document;
  const root = doc.documentElement;
  const HIDE_KEY = 'voxden-buddy-hidden-until';
  const SPOT_KEY = 'voxden-buddy-spot';
  const MET_KEY = 'voxden-buddy-met';
  const HIDE_DAYS = 3;

  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch (_) { return null; } },
    set(area, key, value) { try { window[area].setItem(key, value); } catch (_) {} },
  };
  if (Number(store.get('localStorage', HIDE_KEY)) > Date.now()) return;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const reduce = () => G.reduce();
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- markup --------------------------------------------------------------------

  const wrap = doc.createElement('div');
  wrap.className = 'vbf is-waiting';
  wrap.innerHTML = ''
    + '<div class="vbf-panel" id="vbf-panel" role="dialog" aria-labelledby="vbf-title" tabindex="-1" hidden>'
    + '  <div class="vbf-p-head"><p class="vbf-p-eyebrow"><span class="vbf-dot" aria-hidden="true"></span>Live goal</p>'
    + '    <button class="vbf-close" type="button" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>'
    + '  <h2 class="vbf-p-title" id="vbf-title">Help put a name on the installer.</h2>'
    + '  <p class="vbf-p-raised"><span class="vbf-p-num" aria-hidden="true"></span><span class="vbf-p-of">raised of <b class="vbf-p-goal"></b></span><span class="sr-only vbf-p-sr"></span></p>'
    + '  <div class="vbf-p-bar" aria-hidden="true"></div>'
    + '  <p class="vbf-p-meta"></p>'
    + '  <p class="vbf-p-latest"></p>'
    + '  <div class="vbf-p-chips" role="group" aria-label="How much"></div>'
    + '  <button class="btn btn-primary vbf-p-go" type="button"><span class="vbf-p-go-text">Chip in</span><span aria-hidden="true">→</span></button>'
    + '  <p class="vbf-p-note" aria-live="polite"></p>'
    + '  <div class="vbf-p-foot"><a class="vbf-p-more" href="/support">Where it goes <span aria-hidden="true">→</span></a>'
    + '    <button class="vbf-p-hide" type="button">Hide for now</button></div>'
    + '</div>'
    + '<button class="vbf-win" type="button" aria-expanded="false" aria-controls="vbf-panel">'
    + '  <span class="vbf-top"><span class="vbf-dot" aria-hidden="true"></span>Help sign Voxden</span>'
    + '  <span class="vbf-sum"><span class="vbf-num" aria-hidden="true"></span><span class="vbf-of"></span><span class="vbf-pct"></span></span>'
    + '  <span class="vbf-line" aria-hidden="true"><i></i></span>'
    + '  <span class="sr-only vbf-sr"></span>'
    + '</button>'
    + '<button class="vbf-buddy" type="button" aria-label="Voxden’s little helper. Opens the signing goal." aria-controls="vbf-panel" aria-expanded="false"></button>'
    + '<div class="vbf-say" aria-live="polite"><span></span></div>';

  const $ = (sel) => wrap.querySelector(sel);
  const ui = {
    win: $('.vbf-win'), num: $('.vbf-num'), of: $('.vbf-of'), pct: $('.vbf-pct'), line: $('.vbf-line i'), sr: $('.vbf-sr'),
    host: $('.vbf-buddy'), say: $('.vbf-say'), sayText: $('.vbf-say span'),
    panel: $('.vbf-panel'), close: $('.vbf-close'), pNum: $('.vbf-p-num'), pGoal: $('.vbf-p-goal'), pSr: $('.vbf-p-sr'),
    pBar: $('.vbf-p-bar'), pMeta: $('.vbf-p-meta'), pLatest: $('.vbf-p-latest'), chips: $('.vbf-p-chips'),
    go: $('.vbf-p-go'), goText: $('.vbf-p-go-text'), note: $('.vbf-p-note'), more: $('.vbf-p-more'), hide: $('.vbf-p-hide'),
  };
  const buddy = new G.Buddy(ui.host);
  const winRoller = new G.Roller(ui.num);
  const panelRoller = new G.Roller(ui.pNum);
  // On the download page the full goal is further down the same page.
  const card = doc.getElementById('sign');
  if (card) ui.more.setAttribute('href', '#sign');

  const MINI_BARS = 40;
  ui.pBar.innerHTML = Array.from({ length: MINI_BARS }, (_, i) =>
    '<i style="--h:' + (0.34 + 0.62 * Math.abs(Math.sin(i * 0.61) * Math.cos(i * 0.23))).toFixed(2) + ';--d:' + (-(i % 9) * 0.13).toFixed(2) + 's"></i>').join('');
  const miniBars = Array.from(ui.pBar.children);

  // ---- where things are ----------------------------------------------------------------
  //
  // The character is placed from the corner the window sits in: x to the
  // right of the window's left edge, y up from the ground (the window's
  // bottom edge). The window's top is a seat.

  const S = {
    x: 0, y: 0,
    surface: 'ground',     // 'ground' | 'seat'
    mode: 'idle',          // 'idle' | 'walk' | 'hop' | 'held' | 'fall'
    open: false,
    away: false,
    goal: null,
    amount: G.limits().pick,
    busy: false,
    lastPaid: '',
    reachedSaid: false,
  };
  let W = { win: 0, winH: 0, bw: 64, bh: 66, left: 20, bottom: 20 };

  function measure() {
    const r = wrap.getBoundingClientRect();
    W = {
      win: ui.win.offsetWidth,
      winH: ui.win.offsetHeight,
      bw: ui.host.offsetWidth,
      bh: ui.host.offsetHeight,
      left: r.left,
      bottom: window.innerHeight - r.bottom,
    };
  }
  const homeX = () => W.win + 6;
  const seatY = () => W.winH - W.bh * 0.31;
  const seatX = () => W.win - W.bw - 4;
  const maxX = () => Math.max(homeX(), window.innerWidth - W.left - W.bw - 10);
  const maxY = () => Math.max(0, window.innerHeight - W.bottom - W.bh - 8);

  function place() {
    ui.host.style.transform = 'translate3d(' + S.x.toFixed(1) + 'px, ' + (-S.y).toFixed(1) + 'px, 0)';
    if (ui.say.classList.contains('is-on')) placeSay();
  }

  function remember() {
    store.set('sessionStorage', SPOT_KEY, JSON.stringify({ surface: S.surface, x: S.x / Math.max(1, window.innerWidth) }));
  }

  // ---- motion: walking, hopping, falling ------------------------------------------------

  let raf = 0;
  let tween = null;   // (dt) => true while still moving
  function run(fn) {
    tween = fn;
    if (!raf) {
      let last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (tween && !tween(dt)) tween = null;
        place();
        raf = tween ? requestAnimationFrame(loop) : 0;
      };
      raf = requestAnimationFrame(loop);
    }
  }
  function stop() {
    tween = null;
    buddy.walk(false);
    if (S.mode === 'walk' || S.mode === 'hop') S.mode = 'idle';
  }

  function walkTo(x, speed, then) {
    x = clamp(x, -W.bw, maxX());
    if (reduce()) { S.x = x; place(); if (then) then(); return; }
    S.mode = 'walk';
    buddy.set('sit', false).set('sleep', false);
    const left = x < S.x;
    buddy.walk(true, left);
    run((dt) => {
      const step = (speed || 72) * dt;
      if (Math.abs(x - S.x) <= step) {
        S.x = x;
        buddy.walk(false);
        S.mode = 'idle';
        if (then) then();
        return false;
      }
      S.x += left ? -step : step;
      return true;
    });
  }

  // An arc from here to (x, y): up over whichever end is higher, squash on
  // landing.
  function hopTo(x, y, surface, then) {
    buddy.set('sit', false).set('sleep', false);
    if (reduce()) { S.x = x; S.y = y; S.surface = surface; settle(); if (then) then(); return; }
    S.mode = 'hop';
    const x0 = S.x;
    const y0 = S.y;
    const peak = Math.max(y0, y) + 28;
    const T = 0.56;
    let t = 0;
    buddy.flash('happy', 700);
    run((dt) => {
      t = Math.min(T, t + dt);
      const k = t / T;
      S.x = x0 + (x - x0) * k;
      // A parabola through y0, peak and y.
      const a = y0;
      const c = y;
      S.y = (1 - k) * (1 - k) * a + 2 * (1 - k) * k * (2 * peak - (a + c) / 2) + k * k * c;
      if (t >= T) {
        S.x = x; S.y = y; S.surface = surface; S.mode = 'idle';
        buddy.play('land', 420);
        settle();
        if (then) then();
        return false;
      }
      return true;
    });
  }

  // After landing anywhere: sit on the seat; on the ground in front of the
  // window, step out from in front of it.
  function settle() {
    buddy.set('sit', S.surface === 'seat');
    remember();
    if (S.surface === 'ground' && S.x < homeX() - 4) walkTo(homeX(), 90, remember);
  }

  // Dropped: falls under gravity onto the seat, if it is over the window and
  // above it, or else the ground.
  function fall() {
    S.mode = 'fall';
    buddy.set('held', false);
    // What it would land on from here: the seat while it is over the window
    // and still above it, the ground otherwise. Asked every frame, so a
    // window resized mid-fall cannot leave it standing on air.
    const overWin = () => S.x + W.bw / 2 > 4 && S.x + W.bw / 2 < W.win - 4;
    const floorFrom = (y) => (overWin() && y >= seatY() - 2 ? seatY() : 0);
    const from = S.y;
    if (reduce()) { S.y = floorFrom(S.y); S.surface = S.y ? 'seat' : 'ground'; S.mode = 'idle'; buddy.set('whoa', false); place(); settle(); return; }
    let vy = 0;
    if (from - floorFrom(from) > 140) say(pick(['Wheee!', 'Whoa, whoa, whoa!', 'Aaah!']), 1200);
    run((dt) => {
      const floor = floorFrom(S.y);
      vy += 2600 * dt;
      S.y -= vy * dt;
      if (S.y <= floor) {
        S.y = floor;
        S.surface = floor ? 'seat' : 'ground';
        S.mode = 'idle';
        buddy.set('whoa', false).play('land', 420);
        if (from - floor > 140) setTimeout(() => say(pick(['Oof.', 'Stuck the landing.', 'I’m fine. Totally fine.']), 2000), 350);
        settle();
        return false;
      }
      return true;
    });
  }

  // ---- talking -----------------------------------------------------------------------------

  let stopTyping = () => {};
  let sayTimer = 0;
  let sayW = 0; // the whole sentence's width, measured before it is typed
  function say(text, holdMs) {
    stopTyping();
    clearTimeout(sayTimer);
    wake(true);
    ui.say.classList.add('is-on');
    // Placed at the full sentence's width, so the typing grows into room
    // that is already on screen.
    ui.sayText.textContent = text;
    sayW = ui.say.offsetWidth;
    placeSay();
    ui.sayText.textContent = '';
    stopTyping = G.typeInto(ui.sayText, text, buddy, () => {
      sayTimer = setTimeout(() => ui.say.classList.remove('is-on'), holdMs || 3200);
    });
  }
  function placeSay() {
    const w = sayW || ui.say.offsetWidth;
    const x = clamp(S.x + W.bw / 2 - w / 2, 0, Math.max(0, window.innerWidth - W.left - w - 10));
    ui.say.style.transform = 'translate3d(' + x.toFixed(1) + 'px, ' + (-(S.y + W.bh + 6)).toFixed(1) + 'px, 0)';
  }

  // ---- idle life ------------------------------------------------------------------------------

  let idleTimer = 0;
  let sleepTimer = 0;
  function wake(quiet) {
    clearTimeout(sleepTimer);
    if (buddy.has('sleep')) {
      buddy.set('sleep', false);
      if (!quiet) say(pick(['Oh! Hi.', 'Hm? I was resting my eyes.', 'I’m up, I’m up.']), 2200);
    }
    sleepTimer = setTimeout(() => {
      if (S.mode === 'idle' && !S.open && !buddy.has('talk')) buddy.set('sleep', true);
    }, 45000);
  }

  function lookAround() {
    const seq = [[-2.3, 0.2], [2.3, 0.2], [-2, -1.2], [0, 0.4]];
    seq.forEach((d, i) => setTimeout(() => { if (!pointerNear) buddy.lookDir(d[0], d[1]); }, i * 650));
  }

  function idle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!reduce() && !doc.hidden && !S.open && !S.away && S.mode === 'idle' && !buddy.has('sleep') && !buddy.has('talk')) {
        const r = Math.random();
        if (S.surface === 'seat') {
          if (r < 0.4) hopTo(homeX() + rand(0, 40), 0, 'ground');
          else if (r < 0.65) lookAround();
          else if (r < 0.8) buddy.wave();
        } else {
          const far = Math.min(maxX(), homeX() + (window.innerWidth < 640 ? 70 : 190));
          if (r < 0.38) walkTo(rand(homeX(), far), 60, () => setTimeout(() => { if (S.mode === 'idle' && S.surface === 'ground') walkTo(homeX() + rand(0, 24), 60, remember); }, rand(1500, 4000)));
          else if (r < 0.64) walkTo(homeX(), 72, () => hopTo(seatX(), seatY(), 'seat'));
          else if (r < 0.8) lookAround();
          else if (r < 0.9) buddy.wave();
        }
      }
      idle();
    }, rand(7000, 15000));
  }

  // ---- the pointer ------------------------------------------------------------------------------

  // The eyes follow the pointer anywhere on the page, once a frame at most.
  let pointerNear = false;
  let lookAt = null;
  let lookPending = false;
  doc.addEventListener('pointermove', (e) => {
    if (S.mode === 'held' || !shown) return;
    lookAt = { x: e.clientX, y: e.clientY };
    if (!lookPending) {
      lookPending = true;
      requestAnimationFrame(() => {
        lookPending = false;
        const p = lookAt;
        if (!p || buddy.has('sleep') || S.mode === 'held') return;
        const r = ui.host.getBoundingClientRect();
        pointerNear = Math.hypot(p.x - (r.left + r.width / 2), p.y - (r.top + r.height / 2)) < 420;
        buddy.lookAt(p.x, p.y);
      });
    }
    wake(false);
  }, { passive: true });

  ui.host.addEventListener('pointerenter', () => { if (S.mode === 'idle' && !buddy.has('talk')) buddy.wave(); });

  // Pick it up and drop it; a press without a drag opens the panel.
  let grab = null;
  ui.host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    grab = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false };
    try { ui.host.setPointerCapture(e.pointerId); } catch (_) {}
  });
  ui.host.addEventListener('pointermove', (e) => {
    if (!grab || grab.id !== e.pointerId) return;
    if (!grab.moved) {
      if (Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 6) return;
      grab.moved = true;
      stop();
      measure();
      const r = ui.host.getBoundingClientRect();
      grab.dx = grab.x - r.left;
      grab.dy = r.bottom - grab.y;
      S.mode = 'held';
      buddy.set('sit', false).set('sleep', false).set('held', true).set('whoa', true);
      if (S.open) closePanel(false);
      if (Math.random() < 0.5) say(pick(['Hey! Put me down!', 'Whoa, I can see my house!', 'Careful, I’m full of sound waves.']), 1600);
    }
    S.x = clamp(e.clientX - W.left - grab.dx, -8, maxX());
    S.y = clamp(window.innerHeight - W.bottom - e.clientY - grab.dy, 0, maxY());
    place();
    e.preventDefault();
  });
  // A drag ends in a click on the same element; only a plain press opens.
  let dragged = false;
  const release = (e) => {
    if (!grab || grab.id !== e.pointerId) return;
    const g = grab;
    grab = null;
    if (g.moved) {
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      fall();
    }
  };
  ui.host.addEventListener('pointerup', release);
  ui.host.addEventListener('pointercancel', release);
  ui.host.addEventListener('click', (e) => {
    if (dragged || S.mode === 'held' || S.mode === 'fall') { e.preventDefault(); return; }
    togglePanel();
  });
  ui.win.addEventListener('click', () => togglePanel());

  // ---- the panel ----------------------------------------------------------------------------------

  function togglePanel() { if (S.open) closePanel(true); else openPanel(); }

  function openPanel() {
    if (S.open) return;
    S.open = true;
    wake(true);
    ui.panel.hidden = false;
    wrap.classList.add('is-open');
    ui.win.setAttribute('aria-expanded', 'true');
    ui.host.setAttribute('aria-expanded', 'true');
    // Sitting on the window would put it under the panel: hop down first.
    if (S.surface === 'seat' && S.mode === 'idle') hopTo(homeX() + 10, 0, 'ground');
    buddy.flash('happy', 1200);
    renderPanel();
    G.preload();
    requestAnimationFrame(() => ui.panel.focus({ preventScroll: true }));
  }

  function closePanel(returnFocus) {
    if (!S.open) return;
    S.open = false;
    wrap.classList.remove('is-open');
    ui.win.setAttribute('aria-expanded', 'false');
    ui.host.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!S.open) ui.panel.hidden = true; }, 220);
    if (returnFocus) ui.win.focus({ preventScroll: true });
  }

  ui.close.addEventListener('click', () => closePanel(true));
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closePanel(true); });
  doc.addEventListener('pointerdown', (e) => {
    if (S.open && !wrap.contains(e.target) && !doc.querySelector('.razorpay-container, .razorpay-checkout-frame')) closePanel(false);
  });
  ui.more.addEventListener('click', () => closePanel(false));

  ui.hide.addEventListener('click', () => {
    store.set('localStorage', HIDE_KEY, String(Date.now() + HIDE_DAYS * 86400e3));
    closePanel(false);
    say('Okay! See you in a few days.', 1400);
    buddy.wave();
    setTimeout(() => { wrap.classList.add('is-gone'); setTimeout(() => wrap.remove(), 500); }, 1500);
  });

  function buildChips() {
    const c = G.limits();
    ui.chips.innerHTML = c.chips.slice(0, 3).map((v) => '<button type="button" class="vbf-chip" data-v="' + v + '" aria-pressed="false">' + G.money(v) + '</button>').join('');
    S.amount = c.pick;
    renderChips();
  }
  function renderChips() {
    ui.chips.querySelectorAll('.vbf-chip').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === S.amount)));
    if (!S.busy) ui.goText.textContent = 'Chip in ' + G.money(S.amount);
  }
  ui.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.vbf-chip');
    if (!b) return;
    S.amount = Number(b.dataset.v);
    renderChips();
    const frac = S.goal ? G.toInr(S.amount) / S.goal.goalInr : 0;
    say(G.money(S.amount) + '? That’s ' + G.pct(frac) + ' of me!', 2200);
  });

  let noteTimer = 0;
  function note(text, error, ms) {
    clearTimeout(noteTimer);
    ui.note.textContent = text;
    ui.note.classList.toggle('is-error', !!error);
    noteTimer = setTimeout(() => { ui.note.textContent = ''; }, ms || 10000);
  }

  ui.go.addEventListener('pointerenter', G.preload, { once: true });
  ui.go.addEventListener('click', async () => {
    if (S.busy || !S.goal || !S.goal.open) return;
    const label = G.money(S.amount);
    S.busy = true;
    ui.go.disabled = true;
    ui.goText.textContent = 'Opening Razorpay…';
    try {
      const result = await G.pay(S.amount, {
        onOpen: () => { ui.goText.textContent = 'Waiting for Razorpay…'; },
        onFailed: (message) => note(message, true, 14000),
      });
      if (result === 'paid') {
        S.lastPaid = label;
        note('Paid. Counting it…', false, 60000);
        say('Counting it… one second.', 2000);
      }
    } catch (err) {
      note((err && err.message) || 'The payment could not be started.', true, 12000);
    } finally {
      S.busy = false;
      ui.go.disabled = !(S.goal && S.goal.open);
      renderChips();
    }
  });

  // ---- numbers ------------------------------------------------------------------------------------

  function renderWin() {
    const g = S.goal;
    if (!g) return;
    const frac = g.raisedInr / g.goalInr;
    winRoller.set(G.money(G.toDisplay(g.raisedInr)));
    ui.of.textContent = ' of ' + G.money(G.toDisplay(g.goalInr));
    ui.pct.textContent = G.pct(frac);
    ui.line.style.transform = 'scaleX(' + clamp(frac, frac > 0 ? 0.015 : 0, 1).toFixed(4) + ')';
    ui.sr.textContent = G.money(G.toDisplay(g.raisedInr)) + ' raised of ' + G.money(G.toDisplay(g.goalInr)) + '. Open the signing goal.';
    buddy.fill(frac).set('live', true);
    wrap.classList.toggle('is-reached', frac >= 1);
    // The window can change height with its text; keep a seated character on it.
    if (shown && S.surface === 'seat' && S.mode === 'idle') { measure(); S.x = seatX(); S.y = seatY(); place(); }
  }

  function renderPanel() {
    const g = S.goal;
    if (!g) return;
    const frac = g.raisedInr / g.goalInr;
    panelRoller.set(G.money(G.toDisplay(g.raisedInr)));
    ui.pGoal.textContent = G.money(G.toDisplay(g.goalInr));
    ui.pSr.textContent = G.money(G.toDisplay(g.raisedInr)) + ' raised of ' + G.money(G.toDisplay(g.goalInr));
    const lit = frac > 0 ? Math.max(1, Math.round(frac * MINI_BARS)) : 0;
    miniBars.forEach((b, i) => b.classList.toggle('on', i < lit));
    const bits = [g.contributions.toLocaleString('en-IN') + (g.contributions === 1 ? ' contribution' : ' contributions'), G.pct(frac) + ' there'];
    const end = g.deadline ? Date.parse(g.deadline) : NaN;
    if (Number.isFinite(end) && frac < 1) {
      const days = Math.max(0, Math.ceil((end - G.now()) / 86400e3));
      if (days > 0) bits.push(days + (days === 1 ? ' day left' : ' days left'));
    }
    ui.pMeta.textContent = bits.join(' · ');
    const newest = g.recent && g.recent[0];
    ui.pLatest.textContent = newest ? 'Latest: ' + G.money(newest.amount, newest.currency) + ', ' + G.ago(newest.at) : 'Nobody yet. Be the first.';
    ui.go.disabled = !g.open || S.busy;
    if (!g.open && !S.busy) ui.goText.textContent = 'Payments open soon';
  }

  // ---- stepping aside -------------------------------------------------------------------------------

  function setAway(away) {
    if (S.away === away) return;
    S.away = away;
    wrap.classList.toggle('is-away', away);
    if (away) { closePanel(false); stop(); }
  }
  if (card) {
    new IntersectionObserver((entries) => {
      setAway(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.15));
    }, { threshold: [0, 0.15, 0.4] }).observe(card);
  }

  // ---- arriving ---------------------------------------------------------------------------------------

  let shown = false;
  function arrive() {
    if (shown) return;
    shown = true;
    doc.body.appendChild(wrap);
    measure();
    let spot = null;
    try { spot = JSON.parse(store.get('sessionStorage', SPOT_KEY) || 'null'); } catch (_) { spot = null; }
    const met = store.get('sessionStorage', MET_KEY);
    requestAnimationFrame(() => wrap.classList.remove('is-waiting'));
    if (!met) {
      // First visit this session: it drops in from the sky onto its seat.
      store.set('sessionStorage', MET_KEY, '1');
      S.x = seatX();
      S.y = reduce() ? seatY() : maxY();
      S.mode = 'held';
      buddy.set('whoa', true);
      place();
      setTimeout(() => {
        fall();
        setTimeout(() => {
          buddy.wave();
          say(pick(['Hi! I’m trying to get signed.', 'Psst. Windows thinks I’m a stranger.', 'Hello! Help me get a signature?']), 3200);
        }, reduce() ? 200 : 1300);
      }, reduce() ? 0 : 500);
    } else if (spot && spot.surface === 'seat') {
      S.x = seatX(); S.y = seatY(); S.surface = 'seat';
      place(); settle();
    } else {
      S.x = spot ? clamp(spot.x * window.innerWidth, homeX(), maxX()) : homeX();
      S.y = 0; S.surface = 'ground';
      place(); settle();
    }
    idle();
    wake(true);
  }

  // A resize keeps it on the screen. In the air or mid-hop it only stays
  // inside the edges; at rest it keeps to its seat or its stretch of ground.
  window.addEventListener('resize', () => {
    if (!shown) return;
    measure();
    if (S.mode === 'held' || S.mode === 'fall' || S.mode === 'hop') {
      S.x = clamp(S.x, -8, maxX());
      S.y = clamp(S.y, 0, maxY());
    } else if (S.surface === 'seat') {
      S.x = seatX();
      S.y = seatY();
    } else {
      S.x = clamp(S.x, homeX(), maxX());
    }
    place();
  });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop(); });

  // ---- live updates -----------------------------------------------------------------------------------

  G.subscribe((event) => {
    if (event.type === 'goal') {
      const prev = S.goal;
      S.goal = event.goal;
      if (!shown) {
        buildChips();
        setTimeout(arrive, 900);
      }
      renderWin();
      if (S.open) renderPanel();
      if (prev && event.goal.contributions > prev.contributions && shown) {
        const newest = event.goal.recent && event.goal.recent[0];
        if (!S.away) {
          if (S.mode === 'idle') buddy.hop();
          buddy.play('ping', 900);
        }
        if (event.mine) {
          G.burst(ui.host, 44);
          say('That’s you! Thank you!', 4200);
          note('Thank you. Your ' + (S.lastPaid || 'bit') + ' is on the bar.', false, 12000);
        } else if (newest && !S.away) {
          say('Someone just chipped in ' + G.money(newest.amount, newest.currency) + '!', 3200);
        }
      }
      if (event.goal.raisedInr >= event.goal.goalInr && !S.reachedSaid && shown) {
        S.reachedSaid = true;
        setTimeout(() => say('I’m getting signed! Thank you, everyone.', 5000), 900);
      }
    } else if (event.type === 'offline') {
      buddy.set('live', false);
    } else if (event.type === 'currency') {
      buildChips();
      renderWin();
      if (S.open) renderPanel();
    } else if (event.type === 'pending-lapsed') {
      note('Paid. It lands on the bar as soon as Razorpay confirms it.', false, 20000);
    }
  });

  setInterval(() => { if (S.open && !doc.hidden) renderPanel(); }, 30000);
})();
