/*
 * Voxden: the signing goal's corner capsule, on / and /download. Needs
 * goal.js (window.VoxdenGoal) first.
 *
 * A glass tube in the bottom-left corner shows the live total and fills with
 * ink as the goal fills: violet-black liquid with a sloshing mint edge, a
 * back wave, faint light webs and rising bubbles, drawn by a small WebGL
 * shader. It fills slowly when it arrives, sloshes forward when anyone pays,
 * and falls back to a plain gradient without WebGL.
 *
 * Pressing it grows a card upward around it: the latest contribution, three
 * amounts and Custom, and Chip in, which opens Razorpay's checkout. The ×
 * (and Hide in the card) puts it away until the next visit; a new tab or a
 * later visit shows it again.
 *
 * Desktop shows "Help sign Voxden  ₹50 / ₹25,000"; phones show a smaller
 * tube without the goal figure. It appears once the service has answered,
 * steps aside while the download page's own goal card is on screen, and on
 * phones waits until the hero has scrolled out of view and slides away
 * while the page scrolls. It
 * draws about 30 frames a second only while it is on screen in a visible
 * tab; under reduced motion it draws a still frame.
 */
(function () {
  'use strict';

  const G = window.VoxdenGoal;
  if (!G || document.querySelector('.vcap')) return;

  const doc = document;
  const HIDE_KEY = 'voxden-capsule-hidden';
  let hidden = false;
  try { hidden = sessionStorage.getItem(HIDE_KEY) === '1'; } catch (_) {}
  if (hidden) return;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const phoneMQ = window.matchMedia('(max-width: 639px)');

  // ---- markup --------------------------------------------------------------------

  const X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const wrap = doc.createElement('div');
  wrap.className = 'vcap is-waiting';
  wrap.innerHTML = ''
    + '<div class="vcap-card" id="vcap-card" role="dialog" aria-labelledby="vcap-title" tabindex="-1" hidden><div class="vcap-in"><div class="vcap-body">'
    + '  <div class="vcap-head"><h2 class="vcap-title" id="vcap-title">Help put a name on the installer.</h2>'
    + '    <button class="vcap-fold" type="button" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button></div>'
    + '  <p class="vcap-meta"></p>'
    + '  <div class="vcap-chips" role="group" aria-label="How much"></div>'
    + '  <label class="vcap-custom" hidden><span class="vcap-sym" aria-hidden="true"></span><input type="text" inputmode="numeric" autocomplete="off" placeholder="Any amount"><span class="vcap-hint"></span></label>'
    + '  <button class="btn btn-primary vcap-go" type="button"><span class="vcap-go-text">Chip in</span><span aria-hidden="true">→</span></button>'
    + '  <p class="vcap-note" aria-live="polite"></p>'
    + '  <div class="vcap-foot"><a class="vcap-more" href="/support">Where it goes <span aria-hidden="true">→</span></a>'
    + '    <button class="vcap-hide" type="button">Hide</button></div>'
    + '</div></div></div>'
    + '<div class="vcap-tube">'
    + '  <canvas class="vcap-ink" aria-hidden="true"></canvas><span class="vcap-fb" aria-hidden="true"></span>'
    + '  <button class="vcap-open" type="button" aria-expanded="false" aria-controls="vcap-card">'
    + '    <span class="vcap-label" aria-hidden="true">Help sign Voxden</span>'
    + '    <span class="vcap-num" aria-hidden="true"><span class="vcap-raised"></span><i class="vcap-goal"></i></span>'
    + '    <span class="sr-only vcap-sr"></span></button>'
    + '  <button class="vcap-x" type="button" aria-label="Hide until your next visit">' + X + '</button>'
    + '</div>';

  const $ = (sel) => wrap.querySelector(sel);
  const ui = {
    card: $('.vcap-card'), fold: $('.vcap-fold'), meta: $('.vcap-meta'), chips: $('.vcap-chips'),
    custom: $('.vcap-custom'), sym: $('.vcap-sym'), input: $('.vcap-custom input'), hint: $('.vcap-hint'),
    go: $('.vcap-go'), goText: $('.vcap-go-text'), note: $('.vcap-note'), more: $('.vcap-more'), hide: $('.vcap-hide'),
    tube: $('.vcap-tube'), canvas: $('.vcap-ink'), fb: $('.vcap-fb'), open: $('.vcap-open'),
    label: $('.vcap-label'), raised: $('.vcap-raised'), goal: $('.vcap-goal'), sr: $('.vcap-sr'), x: $('.vcap-x'),
  };
  // On the download page the full goal is further down the same page.
  const card = doc.getElementById('sign');
  if (card) ui.more.setAttribute('href', '#sign');

  const S = { goal: null, open: false, away: false, amount: 0, custom: false, busy: false, lastPaid: '' };
  let shown = false;

  // ---- the ink ---------------------------------------------------------------------

  const FS = `
precision highp float;
uniform vec2 R;
uniform float T, F, DPR, P, PX, V;

float h21(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1., 0.)), u.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) { v += a * vn(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1; a *= .5; }
  return v;
}
float caustic(vec2 p){
  vec2 q = p; float c = 0.;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    q += vec2(sin(q.y * 1.3 + T * .7 + fi), cos(q.x * 1.1 - T * .6 - fi)) * .55;
    c += 1. / (1. + 14. * abs(sin(q.x) * sin(q.y)));
  }
  return pow(c / 3., 2.2);
}
float bubbles(vec2 css){
  vec2 g = vec2(css.x / 8., (css.y - T * 8.) / 8.);
  vec2 id = floor(g); vec2 f = fract(g) - .5;
  float h = h21(id);
  if (h < .82) return 0.;
  vec2 off = vec2(h21(id + 2.1), h21(id + 5.3)) - .5;
  off.x += sin(T * 2. + h * 20.) * .15;
  float r = .08 + .1 * h21(id + 9.);
  float d = length(f - off * .5);
  return smoothstep(r, r - .05, d) * (.45 + .55 * smoothstep(r - .1, r - .03, d));
}

const vec3 MINT = vec3(.612, .953, .769);
const vec3 VIOLET = vec3(.655, .545, .980);

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / R;
  float len = R.x / DPR, hgt = R.y / DPR;
  float x = frag.x / DPR;
  float yc = uv.y * 2. - 1.;

  // Curved glass bunches the ink toward the top and bottom.
  vec2 lc = vec2(x, (sign(yc) * pow(abs(yc), 1.55) * .5 + .5) * hgt);

  // A front wave and a back wave a little ahead of it; both slosh more
  // while the level is moving.
  float amp = .9 + min(V * 900., 5.);
  float wf = sin(lc.y * .36 + T * 3.1) * amp * .6 + sin(lc.y * .85 - T * 4.2) * amp * .4;
  float wb = sin(lc.y * .30 - T * 2.6 + 1.9) * amp * .7 + sin(lc.y * .7 + T * 3.7) * amp * .3;
  float men = (1. - yc * yc) * 2.2 - 1.;
  float front = F * len + wf + men;
  float back = F * len + wb + men + 2.6;
  float on = step(.0001, F);
  float inside = on * (1. - smoothstep(front - 1., front + .4, x));
  float inBack = on * (1. - smoothstep(back - 1., back + .4, x)) * (1. - inside);
  float behind = max(front - x, 0.);
  float foam = on * exp(-abs(x - front));

  vec3 c = mix(vec3(.025, .05, .10), vec3(.10, .08, .22), uv.y);
  c += vec3(.10, .08, .24) * smoothstep(.45, .8, fbm(lc / 14. + vec2(-T * .25, T * .1)));
  c += mix(VIOLET, MINT, uv.y) * caustic(lc / 11.) * .7;
  c += MINT * bubbles(lc) * .5;
  c += MINT * foam * 1.25 + MINT * exp(-behind / 5.) * .2;
  float l = dot(c, vec3(.3, .55, .15));
  c /= 1. + max(l - .4, 0.) * 1.6;
  c += vec3(.8, 1., .9) * pow(abs(yc), 6.) * .1;
  c += vec3(.75, 1., .88) * P * exp(-abs(x - PX * len) / 10.) * inside;

  vec3 col = mix(vec3(.05, .07, .15) + MINT * .08, c, inside);
  float a = clamp(inside * .95 + inBack * .8, 0., 1.);
  col += (h21(frag + fract(T) * 91.) - .5) / 255.;
  gl_FragColor = vec4(col * a, a);
}`;

  const ink = {
    gl: null, U: {}, fill: 0, from: 0, to: 0, t0: 0, dur: 0, last: 0, vel: 0, surgeAt: -1e9,
    raf: 0, drawnAt: 0, t: 0,
  };

  function initGl() {
    let gl = null;
    try { gl = ui.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (_) {}
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }');
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['R', 'T', 'F', 'DPR', 'P', 'PX', 'V'].forEach((k) => { ink.U[k] = gl.getUniformLocation(prog, k); });
    gl.clearColor(0, 0, 0, 0);
    ink.gl = gl;
    return true;
  }
  function noGl() {
    ink.gl = null;
    ui.tube.classList.add('no-gl');
    ui.fb.style.transform = 'scaleX(' + shownFill().toFixed(4) + ')';
  }
  ui.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(ink.raf); ink.raf = 0; noGl(); });

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // Even ₹50 of ₹25,000 shows as a little ink at the start of the tube.
  function shownFill() {
    const minPx = phoneMQ.matches ? 8 : 12;
    return ink.fill > 0 ? Math.max(ink.fill, minPx / Math.max(1, ui.tube.offsetWidth)) : 0;
  }
  function fillTo(frac, ms) {
    ink.from = ink.fill;
    ink.to = clamp(frac, 0, 1);
    ink.t0 = performance.now();
    ink.dur = reduceMQ.matches ? 0 : ms;
    if (!ink.dur) ink.fill = ink.to;
    if (!ink.gl) ui.fb.style.transform = 'scaleX(' + (ink.to > 0 ? Math.max(ink.to, 0.04) : 0).toFixed(4) + ')';
    wakeInk();
  }

  function draw(now) {
    const gl = ink.gl;
    if (!gl) return;
    if (ink.dur) {
      const k = Math.min(1, (now - ink.t0) / ink.dur);
      ink.fill = ink.from + (ink.to - ink.from) * ease(k);
      if (k >= 1) ink.dur = 0;
    }
    ink.vel = ink.vel * 0.9 + Math.abs(ink.fill - ink.last) * 0.1;
    ink.last = ink.fill;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(ui.tube.offsetWidth * dpr));
    const h = Math.max(1, Math.round(ui.tube.offsetHeight * dpr));
    if (ui.canvas.width !== w || ui.canvas.height !== h) { ui.canvas.width = w; ui.canvas.height = h; }
    const age = (now - ink.surgeAt) / 1000;
    const shown = shownFill();
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(ink.U.R, w, h);
    gl.uniform1f(ink.U.T, reduceMQ.matches ? 12 : now / 1000);
    gl.uniform1f(ink.U.F, shown);
    gl.uniform1f(ink.U.DPR, dpr);
    gl.uniform1f(ink.U.P, age < 1.6 ? Math.sin((age / 1.6) * Math.PI) : 0);
    gl.uniform1f(ink.U.PX, Math.min(1, age / 1.3) * shown);
    gl.uniform1f(ink.U.V, ink.vel);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // About 30 frames a second while it can be seen; one still frame under
  // reduced motion; nothing in a hidden tab or while it is put away.
  const live = () => !!ink.gl && shown && !doc.hidden && !S.away;
  function loop(now) {
    ink.raf = 0;
    if (!live()) return;
    if (now - ink.drawnAt >= 32) { ink.drawnAt = now; draw(now); }
    if (!reduceMQ.matches || ink.dur) ink.raf = requestAnimationFrame(loop);
  }
  function wakeInk() { if (!ink.raf && live()) ink.raf = requestAnimationFrame(loop); }
  doc.addEventListener('visibilitychange', wakeInk);
  if (window.ResizeObserver) new ResizeObserver(() => { if (ink.gl && shown) draw(performance.now()); }).observe(ui.tube);

  // ---- the card ----------------------------------------------------------------------

  function openCard() {
    if (S.open) return;
    S.open = true;
    ui.card.hidden = false;
    // Let the collapsed card paint, then grow it.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (S.open) wrap.classList.add('is-open'); }));
    ui.open.setAttribute('aria-expanded', 'true');
    ui.label.textContent = 'Raised';
    renderCard();
    G.preload();
    setTimeout(() => { if (S.open) ui.card.focus({ preventScroll: true }); }, 60);
  }
  function closeCard(returnFocus) {
    if (!S.open) return;
    S.open = false;
    wrap.classList.remove('is-open');
    ui.open.setAttribute('aria-expanded', 'false');
    ui.label.textContent = 'Help sign Voxden';
    setTimeout(() => { if (!S.open) ui.card.hidden = true; }, 340);
    if (returnFocus) ui.open.focus({ preventScroll: true });
  }
  ui.open.addEventListener('click', () => { if (S.open) closeCard(true); else openCard(); });
  ui.fold.addEventListener('click', () => closeCard(true));
  ui.more.addEventListener('click', () => closeCard(false));
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closeCard(true); });
  doc.addEventListener('pointerdown', (e) => {
    if (S.open && !wrap.contains(e.target) && !doc.querySelector('.razorpay-container, .razorpay-checkout-frame')) closeCard(false);
  });

  // Put away until the next visit: this tab keeps it hidden across pages,
  // a new tab or a later visit shows it again.
  function putAway() {
    try { sessionStorage.setItem(HIDE_KEY, '1'); } catch (_) {}
    closeCard(false);
    wrap.classList.add('is-gone');
    cancelAnimationFrame(ink.raf);
    setTimeout(() => wrap.remove(), 500);
  }
  ui.x.addEventListener('click', putAway);
  ui.hide.addEventListener('click', putAway);

  // ---- amounts -----------------------------------------------------------------------

  function buildChips() {
    const c = G.limits();
    ui.chips.innerHTML = c.chips.slice(0, 3).map((v) => '<button type="button" class="vcap-chip" data-v="' + v + '" aria-pressed="false">' + G.money(v) + '</button>').join('')
      + '<button type="button" class="vcap-chip" data-v="custom" aria-pressed="false">Custom</button>';
    ui.sym.textContent = c.symbol;
    ui.input.setAttribute('aria-label', 'Amount in ' + c.word);
    ui.hint.textContent = G.money(c.min) + ' – ' + G.money(c.max);
    S.amount = c.pick;
    S.custom = false;
    ui.input.value = '';
    renderAmount();
  }
  function renderAmount() {
    const c = G.limits();
    ui.chips.querySelectorAll('.vcap-chip').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === 'custom' ? S.custom : !S.custom && Number(b.dataset.v) === S.amount));
    });
    ui.custom.hidden = !S.custom;
    const v = S.amount;
    const ok = Number.isFinite(v) && v >= c.min && v <= c.max;
    const typed = S.custom && ui.input.value !== '';
    ui.custom.classList.toggle('is-bad', typed && !ok);
    ui.hint.textContent = !typed || ok ? G.money(c.min) + ' – ' + G.money(c.max) : v < c.min ? 'At least ' + G.money(c.min) : 'Up to ' + G.money(c.max);
    if (!S.busy) {
      ui.goText.textContent = S.goal && !S.goal.open ? 'Payments open soon' : ok ? 'Chip in ' + G.money(v) : 'Chip in';
      ui.go.disabled = !ok || !(S.goal && S.goal.open);
    }
  }
  ui.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.vcap-chip');
    if (!b) return;
    if (b.dataset.v === 'custom') {
      S.custom = true;
      S.amount = Number(ui.input.value) || NaN;
      renderAmount();
      ui.input.focus();
    } else {
      S.custom = false;
      S.amount = Number(b.dataset.v);
      renderAmount();
    }
  });
  ui.input.addEventListener('input', () => {
    const digits = ui.input.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== ui.input.value) ui.input.value = digits;
    S.amount = digits ? Number(digits) : NaN;
    renderAmount();
  });
  ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ui.go.disabled) ui.go.click(); });

  let noteTimer = 0;
  function note(text, error, ms) {
    clearTimeout(noteTimer);
    ui.note.textContent = text;
    ui.note.classList.toggle('is-error', !!error);
    noteTimer = setTimeout(() => { ui.note.textContent = ''; }, ms || 10000);
  }

  ui.go.addEventListener('pointerenter', G.preload, { once: true });
  ui.go.addEventListener('click', async () => {
    if (S.busy || ui.go.disabled) return;
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
      }
    } catch (err) {
      note((err && err.message) || 'The payment could not be started.', true, 12000);
    } finally {
      S.busy = false;
      renderAmount();
    }
  });

  // ---- numbers -----------------------------------------------------------------------

  function renderTube() {
    const g = S.goal;
    if (!g) return;
    const raised = G.money(G.toDisplay(g.raisedInr));
    const goal = G.money(G.toDisplay(g.goalInr));
    ui.raised.textContent = raised;
    ui.goal.textContent = ' / ' + goal;
    ui.sr.textContent = raised + ' raised of ' + goal + ' to sign Voxden. Open the signing goal.';
  }
  function renderCard() {
    const g = S.goal;
    if (!g) return;
    const newest = g.recent && g.recent[0];
    const count = g.contributions.toLocaleString('en-IN') + (g.contributions === 1 ? ' contribution' : ' contributions');
    ui.meta.textContent = newest
      ? count + ' · latest ' + G.money(newest.amount, newest.currency) + ', ' + G.ago(newest.at)
      : 'Nobody yet. Be the first.';
    renderAmount();
  }

  // ---- stepping aside ------------------------------------------------------------------
  //
  // It steps aside while the download page's own goal card is on screen and,
  // on phones, until the page's first block (the hero, or the download
  // page's header) has scrolled out of view, so the first screen is clear,
  // and while the page is scrolling, so it never sits over what is passing
  // under it. It comes back once scrolling has stopped for a moment.

  const hero = doc.querySelector('main .hero, main .page-head');
  let overCard = false;
  let scrolling = false;
  let inHero = !!hero && phoneMQ.matches;
  function applyAway() {
    const away = overCard || (phoneMQ.matches && (inHero || scrolling));
    if (S.away === away) return;
    S.away = away;
    wrap.classList.toggle('is-away', away);
    if (away) closeCard(false);
    else { pour(); wakeInk(); }
  }
  if (card) {
    new IntersectionObserver((entries) => {
      overCard = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.15);
      applyAway();
    }, { threshold: [0, 0.15, 0.4] }).observe(card);
  }
  if (hero) {
    new IntersectionObserver((entries) => {
      inHero = entries.some((entry) => entry.isIntersecting);
      applyAway();
    }).observe(hero);
  }
  phoneMQ.addEventListener('change', applyAway);

  // Scrolling on a phone: away after 12 px of movement, back 650 ms after the
  // last scroll. An open card stays put, so a nudge or the keyboard for a
  // custom amount cannot close it.
  let scrollFrom = null;
  let settleTimer = 0;
  window.addEventListener('scroll', () => {
    if (!phoneMQ.matches || S.open) return;
    const y = window.scrollY;
    if (scrollFrom === null) scrollFrom = y;
    if (!scrolling && Math.abs(y - scrollFrom) > 12) { scrolling = true; applyAway(); }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      scrollFrom = null;
      if (scrolling) { scrolling = false; applyAway(); }
    }, 650);
  }, { passive: true });

  // ---- arriving and live updates -------------------------------------------------------

  // The ink pours in slowly the first time the tube is on screen.
  let poured = false;
  function pour() {
    if (poured || !shown || S.away) return;
    poured = true;
    setTimeout(() => fillTo(S.goal.raisedInr / S.goal.goalInr, 2800), reduceMQ.matches ? 0 : 450);
  }

  function arrive() {
    if (shown) return;
    shown = true;
    S.away = null;
    doc.body.appendChild(wrap);
    if (!initGl()) noGl();
    requestAnimationFrame(() => wrap.classList.remove('is-waiting'));
    applyAway();
    pour();
    wakeInk();
  }

  G.subscribe((event) => {
    if (event.type === 'goal') {
      const prev = S.goal;
      S.goal = event.goal;
      if (!prev) buildChips();
      renderTube();
      if (S.open) renderCard();
      if (!shown) { setTimeout(arrive, 600); return; }
      if (!poured) return;
      const frac = event.goal.raisedInr / event.goal.goalInr;
      if (prev && event.goal.contributions > prev.contributions) {
        ink.surgeAt = performance.now();
        fillTo(frac, 1800);
        if (event.mine) {
          note('Thank you. Your ' + (S.lastPaid || 'bit') + ' is in the tube.', false, 12000);
          if (!S.open) {
            ui.label.textContent = 'Thank you!';
            setTimeout(() => { if (!S.open) ui.label.textContent = 'Help sign Voxden'; }, 4000);
          }
        }
      } else if (Math.abs(frac - ink.to) > 1e-6) {
        fillTo(frac, 1200);
      }
    } else if (event.type === 'currency') {
      buildChips();
      renderTube();
      if (S.open) renderCard();
    } else if (event.type === 'pending-lapsed') {
      note('Paid. It lands in the tube as soon as Razorpay confirms it.', false, 20000);
    }
  });

  setInterval(() => { if (S.open && !doc.hidden) renderCard(); }, 30000);
})();
