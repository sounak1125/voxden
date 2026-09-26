/*
 * Voxden home page: what Voxden does (#features).
 *
 * The markup carries everything a visitor needs without this file: the four
 * features' headlines and lines in reading order, each over its lead window
 * in a still frame. This file turns that stack into the arc:
 * - The page scroll carries the windows across, right to left going down,
 *   one step of the track per window, and holds each window in front for a
 *   stretch of the scroll. A drag or swipe on the stage, the arrow keys
 *   (while it has focus) and the two buttons move the arc by scrolling the
 *   page, so the scroll position is the one thing the arc follows.
 * - The arc follows it through a critically damped spring, so it glides
 *   without overshooting, and only transforms and opacities change.
 * - Once the arc rests on a window, that window plays its vignette, with the
 *   shared flow bar under it and a caption of what is being said.
 * - The stylesheet floats the windows while the stage is on screen; this
 *   file only says when it is.
 * - The apps band drifts; the stylesheet rests it on hover, focus and off
 *   screen.
 * Under reduced motion the arc steps from window to window without gliding,
 * nothing floats or plays, and the flow bar shows the window's last line.
 *
 * Vanilla ES2019, one IIFE, no globals.
 */
(function () {
  'use strict';

  const root = document.querySelector('.fx');
  if (!root || root.fxReady) return;
  root.fxReady = true;

  const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(reducedQuery && reducedQuery.matches);
  const onChange = (query, fn) => {
    if (!query) return;
    if (query.addEventListener) query.addEventListener('change', fn);
    else if (query.addListener) query.addListener(fn);
  };
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // --- The vignettes -----------------------------------------------------------
  // Each step: [step, at ms, flow bar state, flow bar line, gold button held].
  // A step names which parts of the window are on (their data-show lists it).
  // `said` is the caption while the bar records; `still` is what the bar
  // shows under a window that is in front but not playing.
  const LINE = 'The build is green, so we can ship the beta on Thursday.';
  const RAMBLE = 'So I was just wondering if maybe we could push the call to three instead of two';
  const POLISHED = 'Could we push the call from two to three? Priya and I are stuck in another meeting that won’t end on time.';
  const HINGLISH = 'Kal ki client meeting 3 baje shift kar do, main thoda late hoon';
  const MISHEARD = 'The vox den beta ships on Friday';
  const LEARNED = 'The Voxden update is live for everyone';
  const SCRIPTS = {
    anywhere: {
      loop: 7600, said: LINE, still: ['done', LINE],
      steps: [['e', 0, 'rest'], ['e', 450, 'rec'], ['e', 2650, 'busy'], ['l', 3250, 'done', LINE]],
    },
    polish: {
      loop: 8400, said: '', still: ['done', POLISHED],
      steps: [['p0', 0, 'gold', RAMBLE], ['p1', 1700, 'gold', null, true], ['p2', 2100, 'busyline', 'Polishing…'], ['p3', 3100, 'done', POLISHED]],
    },
    lang: {
      loop: 8800, said: HINGLISH, still: ['done', HINGLISH],
      steps: [['h0', 0, 'rest'], ['h1', 450, 'rec'], ['h2', 2850, 'busy'], ['h3', 3450, 'done', HINGLISH], ['h4', 5900, 'rest']],
    },
    dict: {
      loop: 12200, said: LEARNED, still: ['done', LEARNED],
      steps: [
        ['d0', 0, 'done', MISHEARD], ['d1', 1400, 'rest'], ['d2', 2200, 'rest'],
        ['d3', 3000, 'note', 'Added “Voxden” to dictionary'],
        ['d4', 5600, 'rest'], ['d5', 6300, 'rec'], ['d6', 8300, 'busy'], ['d7', 8900, 'done', LEARNED],
      ],
    },
  };

  // --- The flow bar --------------------------------------------------------------
  // One bar for the whole stage, with every part the scripts need in the real
  // bar's order (src/overlay.html) and the real glyphs; the stylesheet shows
  // the parts each state has. Its width follows the words in it, so each new
  // line is measured (in the bar's em, so it scales with the stage).
  const svg = (vb, body) => '<svg viewBox="' + vb + '" aria-hidden="true" focusable="false">' + body + '</svg>';
  const PARTS = [
    ['fx-isl-btn fx-isl-x', svg('0 0 16 16', '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')],
    ['fx-isl-wave', '<i></i>'.repeat(13)],
    ['fx-isl-btn fx-isl-stop', svg('0 0 16 16', '<rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/>')],
    ['fx-isl-spin', '<i></i>'.repeat(8)],
    ['fx-isl-mark', svg('0 0 16 16', '<path d="M3.2 8.4l3.2 3.2 6.4-6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>')],
    ['fx-isl-label', ''],
    ['fx-isl-undo', 'Undo'],
    ['fx-isl-btn fx-isl-gold', svg('0 0 16 16', '<path d="M6.6 1.6c.5 2.8 1.4 3.7 4.2 4.2-2.8.5-3.7 1.4-4.2 4.2-.5-2.8-1.4-3.7-4.2-4.2 2.8-.5 3.7-1.4 4.2-4.2Z" fill="currentColor"/><path d="M12.2 9.3c.26 1.3.66 1.7 1.96 1.96-1.3.26-1.7.66-1.96 1.96-.26-1.3-.66-1.7-1.96-1.96 1.3-.26 1.7-.66 1.96-1.96Z" fill="currentColor"/>')],
  ];
  const MAX_LINE_EM = 14;
  let ctx = null;
  function lineEm(bar, label, text) {
    try {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d');
      const cs = window.getComputedStyle(label);
      ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      const px = ctx.measureText(text).width + 2;
      const em = parseFloat(window.getComputedStyle(bar).fontSize) || 14;
      return Math.min(MAX_LINE_EM, px / em);
    } catch (_) {
      return MAX_LINE_EM;
    }
  }
  function Island(el) {
    this.el = el;
    el.textContent = '';
    for (const part of PARTS) {
      const span = document.createElement('span');
      span.className = part[0];
      span.innerHTML = part[1];
      el.appendChild(span);
    }
    this.label = el.querySelector('.fx-isl-label');
    this.gold = el.querySelector('.fx-isl-gold');
    this.bar = el.getAttribute('data-bar') || 'rest';
    this.line = '';
  }
  Island.prototype.set = function (bar, line, held) {
    if (line != null && line !== this.line) {
      this.line = line;
      this.label.textContent = line;
      this.el.style.setProperty('--fx-lw', lineEm(this.el, this.label, line).toFixed(2) + 'em');
    }
    if (bar !== this.bar) {
      this.bar = bar;
      this.el.setAttribute('data-bar', bar);
    }
    this.gold.classList.toggle('is-pressed', !!held);
  };

  // --- One window's vignette ----------------------------------------------------
  function Scene(card) {
    this.card = card;
    this.script = SCRIPTS[card.getAttribute('data-feat')] || null;
    this.poster = card.getAttribute('data-step');
    this.parts = Array.prototype.map.call(card.querySelectorAll('[data-show]'), (node) => ({
      node,
      steps: node.getAttribute('data-show').split(/\s+/),
    }));
    this.timers = [];
    this.playing = false;
  }
  Scene.prototype.show = function (step) {
    this.card.setAttribute('data-step', step);
    for (const part of this.parts) part.node.classList.toggle('is-on', part.steps.indexOf(step) !== -1);
  };
  Scene.prototype.play = function (onStep) {
    this.stop();
    if (!this.script) return;
    this.playing = true;
    this.card.classList.add('is-playing');
    const run = () => {
      this.timers = [];
      for (const s of this.script.steps) {
        const go = () => {
          this.show(s[0]);
          onStep(this, s);
        };
        if (s[1] === 0) go();
        else this.timers.push(window.setTimeout(go, s[1]));
      }
      this.timers.push(window.setTimeout(run, this.script.loop));
    };
    run();
  };
  // Stops the vignette and puts the window back in its still frame.
  Scene.prototype.stop = function () {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    if (!this.playing) return;
    this.playing = false;
    this.card.classList.remove('is-playing');
    this.show(this.poster);
  };

  // --- The arc ---------------------------------------------------------------------
  const arc = root.querySelector('[data-fx-arc]');
  const stage = arc && arc.querySelector('[data-fx-stage]');
  const cards = stage ? Array.prototype.slice.call(stage.querySelectorAll('.fx-card')) : [];
  const indexOf = (name) => cards.findIndex((c) => c.getAttribute('data-win') === name);
  // The arc starts with the mail window in front and ends on the dictionary.
  const P0 = indexOf('mail');
  const P1 = indexOf('dict');
  if (stage && P0 >= 0 && P1 > P0 && 'IntersectionObserver' in window && window.requestAnimationFrame) arcify();

  function arcify() {
    const N = cards.length;
    const STEPS = P1 - P0;
    const feats = Array.prototype.slice.call(stage.querySelectorAll('.fx-feat'));
    const barEl = stage.querySelector('.fx-isl');
    const cap = stage.querySelector('.fx-cap');
    const capText = cap && cap.querySelector('.fx-cap-text');
    const prevBtn = stage.querySelector('[data-fx-go="-1"]');
    const nextBtn = stage.querySelector('[data-fx-go="1"]');
    if (!barEl || !capText) return;
    const island = new Island(barEl);
    const scenes = cards.map((c) => new Scene(c));
    const veils = cards.map((c) => {
      const veil = document.createElement('i');
      veil.className = 'fx-veil';
      (c.querySelector('.fx-w') || c).appendChild(veil);
      return veil;
    });
    const was = cards.map(() => ({ off: null, far: null, z: null, o: null, veil: null }));
    const mod = (i) => ((i % N) + N) % N;

    arc.classList.add('is-arc');
    stage.tabIndex = 0;
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-label', 'Features');
    stage.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');

    // --- Geometry. The window's width follows the stage: a share of its width,
    // and never so big that the headline, the windows, the flow bar and the
    // caption stop fitting its height. The group is centred in the stage.
    let W = 540;
    let sh = 1;
    let stickTop = 0;
    let range = 1;
    let pitch = 400;
    let lift1 = 0.19;
    let lift2 = 0.035;
    function measure() {
      const cs = window.getComputedStyle(stage);
      const sw = stage.clientWidth;
      const phone = sw < 640;
      sh = stage.clientHeight || 1;
      stickTop = parseFloat(cs.top) || 0;
      range = Math.max(1, arc.offsetHeight - sh);
      const ratio = (parseFloat(cs.getPropertyValue('--fx-hem')) || 28.75) / (parseFloat(cs.getPropertyValue('--fx-wem')) || 46);
      let head = 0;
      for (const f of feats) head = Math.max(head, f.offsetHeight);
      // How far the side windows rise over the one in front, in window widths.
      const lift = phone ? 0.07 : 0.15;
      const edge = phone ? 16 : 20;
      const gapHead = phone ? 18 : 24;
      const gapBar = phone ? 10 : 12;
      const gapCap = 8;
      const capLines = phone ? 2 : 1;
      const nav = phone ? 60 : 0;
      const barFont = (w) => clamp(w / 40, 11, 14);
      const capFont = (w) => clamp(w / 40, 12, 14);
      const below = (w) => gapBar + barFont(w) * 2.3 + gapCap + capFont(w) * (1.4 * capLines + 0.95) + 2 + nav;
      let w = Math.min(phone ? sw * 0.88 : sw * 0.42, 620);
      for (let i = 0; i < 2; i++) w = Math.min(w, (sh - 2 * edge - head - gapHead - below(w)) / (lift + ratio));
      W = Math.max(180, Math.floor(w));
      const content = head + gapHead + W * (lift + ratio) + below(W);
      const top = Math.max(edge, Math.round((sh - content) / 2));
      const winTop = top + head + gapHead + W * lift;
      const bary = winTop + W * ratio + gapBar;
      lift1 = phone ? 0.08 : 0.19;
      lift2 = phone ? 0.014 : 0.035;
      pitch = W * (phone ? 0.7 : 0.77);
      const set = (k, v) => stage.style.setProperty(k, v);
      set('--fx-W', W + 'px');
      set('--fx-cy', (winTop + (W * ratio) / 2).toFixed(1) + 'px');
      set('--fx-headb', (sh - top - head).toFixed(1) + 'px');
      set('--fx-bary', bary.toFixed(1) + 'px');
      const capy = bary + barFont(W) * 2.3 + gapCap;
      set('--fx-capy', capy.toFixed(1) + 'px');
      // On a phone the buttons sit under the caption, with the group.
      set('--fx-navy', (capy + capFont(W) * (1.4 * capLines + 0.95) + 2 + 16).toFixed(1) + 'px');
      set('--fx-islf', barFont(W).toFixed(2) + 'px');
      set('--fx-capf', capFont(W).toFixed(2) + 'px');
    }

    // --- The track. The scroll's place on the track is u, 0 to STEPS. Around
    // each whole u the arc holds its window in front (HOLD of a step on either
    // side) and between holds it moves on a smoothstep.
    const HOLD = 0.3;
    const eased = (u) => {
      const k = Math.floor(u);
      const x = clamp((u - k - HOLD) / (1 - 2 * HOLD), 0, 1);
      return k + x * x * (3 - 2 * x);
    };
    // The place on the track that puts the arc at pos (the middle of a hold
    // for a whole window).
    const uFor = (pos) => {
      const q = clamp(pos - P0, 0, STEPS);
      const k = Math.floor(q);
      const s = q - k;
      if (s < 1e-4) return k;
      if (s > 1 - 1e-4) return k + 1;
      const x = 0.5 - Math.sin(Math.asin(1 - 2 * s) / 3);
      return k + HOLD + x * (1 - 2 * HOLD);
    };
    const trackU = () => clamp((stickTop - arc.getBoundingClientRect().top) / range, 0, 1) * STEPS;
    const aim = () => P0 + (reduced() ? Math.round(trackU()) : eased(trackU()));
    function scrollToU(u, smooth) {
      const y = Math.round(window.scrollY + arc.getBoundingClientRect().top - stickTop + (u / STEPS) * range);
      if (smooth) {
        try {
          window.scrollTo({ top: y, behavior: 'smooth' });
          return;
        } catch (_) { /* no smooth scrolling here: jump instead */ }
      }
      // The page scrolls smoothly by default; a drag has to move it at once.
      const html = document.documentElement;
      const before = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      window.scrollTo(0, y);
      html.style.scrollBehavior = before;
    }

    // --- Laying out the arc for a position p (a window's index, fractional
    // between windows). A window d places from the front sits out to the side
    // on a curve, set back, turned away, a little higher and tilted, dimmer
    // the further out it is, softly focused past the side slots, and gone
    // beyond FADE places.
    const FADE = 2.8;
    function lay(p) {
      for (let i = 0; i < N; i++) {
        let d = i - p;
        d -= N * Math.round(d / N);
        const a = Math.abs(d);
        const s = d < 0 ? -1 : 1;
        const card = cards[i];
        const w = was[i];
        const off = a >= FADE;
        if (off !== w.off) {
          w.off = off;
          card.classList.toggle('is-off', off);
        }
        if (off) continue;
        const x = s * W * (0.97 * a - 0.08 * a * a);
        const y = -W * (lift1 * a - lift2 * a * a);
        const z = -W * (0.13 * a + 0.09 * a * a);
        const ry = s * 52 * (1 - Math.exp(-0.86 * a));
        const rz = s * Math.min(a, 2);
        card.style.transform = 'translate3d(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px, ' + z.toFixed(2) + 'px) rotateY(' + ry.toFixed(3) + 'deg) rotateZ(' + rz.toFixed(3) + 'deg)';
        const o = a <= 2 ? 1 : Math.round(((FADE - a) / (FADE - 2)) * 1000) / 1000;
        if (o !== w.o) {
          w.o = o;
          card.style.opacity = o === 1 ? '' : String(o);
        }
        const zi = 1000 - Math.round(a * 200);
        if (zi !== w.z) {
          w.z = zi;
          card.style.zIndex = String(zi);
        }
        const veil = Math.round(Math.min(0.7, 0.2 * a) * 1000) / 1000;
        if (veil !== w.veil) {
          w.veil = veil;
          veils[i].style.opacity = String(veil);
        }
        const far = a > 1.5;
        if (far !== w.far) {
          w.far = far;
          card.classList.toggle('is-far', far);
        }
      }
    }

    // --- Motion: a critically damped spring from p to the target.
    const OMEGA = 2 * Math.PI * 1.1;
    let p = P0;
    let v = 0;
    let target = P0;
    let raf = 0;
    let last = 0;
    let drag = null;
    let goal = null;
    let goalAt = 0;
    let onScreen = false;
    let inFull = false;
    function frame(now) {
      raf = 0;
      // Real time since the last frame (half a second at most), in small
      // steps, so the glide takes as long on a slow screen as on a fast one.
      let dt = last ? Math.min((now - last) / 1000, 0.5) : 1 / 60;
      last = now;
      if (!drag) target = aim();
      if (reduced()) {
        p = target;
        v = 0;
      } else {
        const w = drag ? OMEGA * 1.8 : OMEGA;
        while (dt > 0) {
          const h = Math.min(dt, 1 / 120);
          v += (w * w * (target - p) - 2 * w * v) * h;
          p += v * h;
          dt -= h;
        }
        if (Math.abs(target - p) < 5e-4 && Math.abs(v) < 5e-3) {
          p = target;
          v = 0;
        }
      }
      lay(p);
      settle();
      if (p !== target || drag) raf = window.requestAnimationFrame(frame);
      else last = 0;
    }
    const kick = () => {
      if (!raf) raf = window.requestAnimationFrame(frame);
    };
    // Straight to where the scroll says, with no glide (on load, on resize,
    // and when the stage comes back on screen).
    function snap() {
      target = aim();
      p = target;
      v = 0;
    }

    // --- What the window in front means: the headline, the buttons, the
    // vignette. A vignette starts once the arc has rested on its window for a
    // moment, and stops (back to its still frame) as soon as the arc moves.
    let centre = -1;
    let feat = null;
    let sceneKey = '';
    let playing = null;
    let startTimer = 0;
    const setDisabled = (btn, off) => {
      if (btn && (btn.getAttribute('aria-disabled') === 'true') !== off) btn.setAttribute('aria-disabled', off ? 'true' : 'false');
    };
    const canPlay = () => !reduced() && !document.hidden && inFull;
    function settle() {
      const k = Math.round(p);
      const i = mod(k);
      if (i !== centre) {
        if (centre >= 0) cards[centre].classList.remove('is-centre');
        centre = i;
        cards[i].classList.add('is-centre');
        const f = cards[i].getAttribute('data-feat');
        if (f !== feat) {
          feat = f;
          for (const el of feats) el.classList.toggle('is-active', el.getAttribute('data-feat') === f);
        }
      }
      const at = goal != null && performance.now() - goalAt < 900 ? goal : Math.round(target);
      setDisabled(prevBtn, at <= P0);
      setDisabled(nextBtn, at >= P1);
      syncScene();
    }
    function syncScene() {
      const k = Math.round(p);
      const resting = !drag && p === target && p === k;
      const play = resting && canPlay();
      const key = (resting ? String(mod(k)) : 'moving') + (play ? ':play' : ':still');
      if (key === sceneKey) return;
      sceneKey = key;
      window.clearTimeout(startTimer);
      if (playing) {
        playing.stop();
        playing = null;
      }
      barEl.classList.remove('is-playing');
      cap.classList.remove('is-on');
      const script = resting ? scenes[mod(k)].script : null;
      if (script && reduced()) island.set(script.still[0], script.still[1]);
      else island.set('rest');
      if (!play) return;
      const scene = scenes[mod(k)];
      startTimer = window.setTimeout(() => {
        playing = scene;
        barEl.classList.add('is-playing');
        scene.play(onStep);
      }, 520);
    }
    function onStep(scene, s) {
      if (scene !== playing) return;
      island.set(s[2], s[3], s[4]);
      const said = s[2] === 'rec' ? scene.script.said : '';
      if (said) capText.textContent = said;
      cap.classList.toggle('is-on', !!said);
    }

    // --- Moving it: buttons, keys, drags. Each one scrolls the page.
    function go(dir) {
      const from = goal != null && performance.now() - goalAt < 900 ? goal : Math.round(target);
      const to = clamp(from + dir, P0, P1);
      goal = to;
      goalAt = performance.now();
      scrollToU(to - P0, !reduced());
      kick();
    }
    [prevBtn, nextBtn].forEach((btn) => {
      if (btn) btn.addEventListener('click', () => go(Number(btn.getAttribute('data-fx-go')) || 0));
    });
    stage.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    });

    // A sideways drag (a swipe on a touch screen; vertical ones stay the
    // page's) moves the arc under the pointer while the stage is pinned; on
    // release it settles on the nearest window, or the next one for a flick.
    const stuck = () => {
      const r = arc.getBoundingClientRect();
      return r.top <= stickTop + 1 && r.bottom >= stickTop + sh - 1;
    };
    const rubber = (over) => 0.35 * (1 - Math.exp(-over / 0.35));
    stage.addEventListener('pointerdown', (e) => {
      if (drag || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, from: p, lx: e.clientX, lt: e.timeStamp, vx: 0 };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.on) {
        const dx = e.clientX - drag.x0;
        const dy = e.clientY - drag.y0;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dy) >= Math.abs(dx) || !stuck()) {
          drag = null;
          return;
        }
        // Measured from where the pointer went down, so a slow device that
        // hands over one late, long move still moves the arc all the way.
        drag.on = true;
        drag.from = p;
        goal = null;
        try { stage.setPointerCapture(e.pointerId); } catch (_) { /* the drag works without capture */ }
        stage.classList.add('is-dragging');
      }
      const dt = Math.max(1, e.timeStamp - drag.lt);
      drag.vx = 0.7 * ((e.clientX - drag.lx) / dt) + 0.3 * drag.vx;
      drag.lx = e.clientX;
      drag.lt = e.timeStamp;
      let pos = drag.from - (e.clientX - drag.x0) / pitch;
      if (pos < P0) pos = P0 - rubber(P0 - pos);
      if (pos > P1) pos = P1 + rubber(pos - P1);
      target = pos;
      scrollToU(uFor(pos), false);
      kick();
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      stage.classList.remove('is-dragging');
      // A flick (still moving at release) finishes the move it started; a
      // slow release settles on the nearest window.
      const vx = e.timeStamp - d.lt > 90 ? 0 : d.vx;
      let to = Math.round(target);
      if (vx < -0.35) to = Math.ceil(target - 0.15);
      else if (vx > 0.35) to = Math.floor(target + 0.15);
      to = clamp(to, P0, P1);
      goal = to;
      goalAt = performance.now();
      scrollToU(to - P0, !reduced());
      kick();
    }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', endDrag);

    // --- Watching: the scroll only matters while the track is on screen; the
    // windows float while it is; a vignette plays only while most of the
    // stage is in view and the tab is visible.
    window.addEventListener('scroll', () => {
      if (onScreen) kick();
    }, { passive: true });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === arc) {
          const back = e.isIntersecting && !onScreen;
          onScreen = e.isIntersecting;
          arc.classList.toggle('is-inview', onScreen);
          if (back) {
            snap();
            lay(p);
            settle();
          }
        } else {
          inFull = e.isIntersecting && e.intersectionRatio >= 0.6;
        }
      }
      syncScene();
    }, { threshold: [0, 0.6, 1] });
    io.observe(arc);
    io.observe(stage);
    document.addEventListener('visibilitychange', syncScene);
    onChange(reducedQuery, () => {
      snap();
      lay(p);
      settle();
    });
    let resizeFrame = 0;
    const relayout = () => {
      resizeFrame = 0;
      measure();
      snap();
      lay(p);
      settle();
    };
    window.addEventListener('resize', () => {
      if (!resizeFrame) resizeFrame = window.requestAnimationFrame(relayout);
    });
    // Fonts can change the headlines' height after load; the layout follows.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout, () => {});

    measure();
    snap();
    lay(p);
    settle();
  }

  // --- The apps band -------------------------------------------------------------
  // The page carries the list once. For the loop the track gets a copy that
  // assistive tech and the keyboard skip, and the drift takes as long as the
  // list is wide, at a calm 32 px a second. It rests off screen; hover and
  // focus rest it in the stylesheet. Under reduced motion the list stays
  // still and wraps, and no copy is made.
  const marquee = root.querySelector('[data-fx-marquee]');
  const track = marquee && marquee.querySelector('.fx-marquee-track');
  const list = track && track.querySelector('.fx-marquee-list');
  const MARQUEE_PX_PER_S = 32;
  function syncMarquee() {
    if (!list || reduced()) return;
    if (!marquee.classList.contains('is-ready')) {
      const copy = list.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      track.appendChild(copy);
      marquee.classList.add('is-ready');
    }
    const width = list.getBoundingClientRect().width;
    if (width > 0) marquee.style.setProperty('--fx-mq-dur', (width / MARQUEE_PX_PER_S).toFixed(1) + 's');
  }
  if (list) {
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const e of entries) marquee.classList.toggle('is-offscreen', !e.isIntersecting);
      }).observe(marquee);
    }
    onChange(reducedQuery, syncMarquee);
    // Fonts can change the list's width after load; the loop follows.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncMarquee, () => {});
    syncMarquee();
  }
})();
