/* The hero card's two loops: the app marks rising through their own clipped
   zone, and the headline typing its ending. Both run only while the card is on
   screen in a visible window, and neither runs under reduced motion. */
(() => {
  'use strict';
  const stage = document.getElementById('voice-stage');
  const field = stage?.querySelector('.hero-app-field');
  if (!field) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // The flow bar's own motion preference: "reduced" there stills this too.
  const preference = window.VoxdenFlowMotion || null;
  const still = () => reduced.matches || !!(preference && preference.preference === 'reduced');
  const events = new AbortController();
  const random = (min, max) => min + Math.random() * (max - min);
  const states = [...field.querySelectorAll('.hero-app-slot')].map(slot => ({ slot, parked: false }));
  const MAX_LANES = 4;
  let lanes = [], open = 0, width = 0, height = 0, size = 64, requestedSize = 0, clearance = 0;
  let visible = false, suspended = false, frame = 0, previous = 0, time = 0;

  function giveDrift(state) {
    state.phase = random(0, Math.PI * 2);
    state.secondPhase = random(0, Math.PI * 2);
    state.frequency = random(.22, .39);
    state.secondFrequency = random(.43, .68);
    state.sway = random(.55, 1);
    state.tilt = random(4, 8);
    state.restAngle = random(-3, 3);
  }

  function park(state, parked) {
    if (state.parked === parked) return;
    state.parked = parked;
    state.slot.classList.toggle('is-parked', parked);
  }

  function paint(state) {
    const lane = lanes[state.lane];
    const drift = lane.sway * state.sway * (.65 * Math.sin(time * state.frequency + state.phase)
      + .35 * Math.sin(time * state.secondFrequency + state.secondPhase));
    const angle = state.restAngle + state.tilt * Math.sin(time * state.frequency + state.secondPhase);
    state.slot.style.transform = `translate3d(${(lane.x + drift - size / 2).toFixed(2)}px, ${(state.y - size / 2).toFixed(2)}px, 0) rotate(${angle.toFixed(2)}deg)`;
  }

  function recycle(state) {
    // Reserve launch space offscreen. Equal rise rates within each lane keep
    // that clearance intact, while each icon has its own sway and rotation.
    // Only open lanes take a returning mark; with none open it waits unseen.
    const choices = lanes.slice(0, Math.max(1, open)).map((lane, index) => {
      const lowest = states.reduce((y, other) => other !== state && other.lane === index ? Math.max(y, other.y) : y, -Infinity);
      const y = Math.max(height + size / 2 + 12, lowest + clearance + random(4, 28));
      return { index, y, wait: (y - height) / lane.speed + random(0, 1.8) };
    });
    choices.sort((a, b) => a.wait - b.wait);
    state.lane = choices[0].index;
    state.y = choices[0].y;
    giveDrift(state);
    park(state, state.lane >= open);
  }

  function layout() {
    const nextWidth = field.clientWidth, nextHeight = field.clientHeight;
    if (!nextWidth || !nextHeight) { width = 0; return; }
    const nextSize = parseFloat(getComputedStyle(field).getPropertyValue('--app-size')) || 64;
    if (width === nextWidth && height === nextHeight && requestedSize === nextSize) return;
    width = nextWidth; height = nextHeight; requestedSize = nextSize;
    const initialized = lanes.length > 0;
    size = nextSize;
    field.style.setProperty('--app-render-size', size + 'px');
    // Lanes keep one pitch and are anchored to the zone's left edge: a wide
    // zone spreads four across itself; a narrower one keeps the pitch and
    // closes lanes from the right, so a resize never slides a mark sideways
    // or changes its height, speed or drift phase.
    const minPitch = nextSize * 1.12 + 18;
    const pitch = Math.max(minPitch, width / MAX_LANES);
    open = Math.min(MAX_LANES, Math.floor((width + .5) / pitch));
    if (!initialized) lanes = Array.from({ length: MAX_LANES }, () => ({ speed: random(9.5, 14) }));
    clearance = Math.max(64, nextSize) * 1.12 + 18;
    lanes.forEach((lane, i) => {
      lane.x = pitch * (i + .5);
      lane.sway = Math.max(0, (pitch - size * 1.12 - 12) / 2);
    });
    if (initialized) {
      states.forEach(state => { park(state, state.lane >= open); paint(state); });
      return;
    }
    // Shuffle the marks and stagger their starting heights without a shared loop.
    const shuffled = [...states];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const count = Math.max(1, open);
    const spacing = Math.max(clearance + 22, (height + size * 2) / Math.ceil(states.length / count));
    const offsets = lanes.map(() => random(0, spacing));
    shuffled.forEach((state, index) => {
      state.lane = index % count;
      state.y = height + size / 2 - offsets[state.lane] - Math.floor(index / count) * spacing - random(0, 16);
      giveDrift(state);
      park(state, state.lane >= open);
      paint(state);
    });
    field.classList.add('is-ready');
  }

  function tick(timestamp) {
    frame = 0;
    const dt = previous ? Math.min((timestamp - previous) / 1000, .05) : 0;
    previous = timestamp;
    time += dt;
    for (const state of states) {
      state.y -= lanes[state.lane].speed * dt;
      // Include the hover scale and tilt so the reset is always fully clipped.
      if (state.y < -size * .8 - 12) recycle(state);
      paint(state);
    }
    frame = requestAnimationFrame(tick);
  }

  // --- The headline types its ending ---------------------------------------
  // Typed a letter at a time, held about two seconds, erased three letters at
  // a time, then the next one. Stopped, it rests on the first ending in full.
  const typedEl = document.getElementById('hero-typed');
  const ENDINGS = ['in writing.', 'in an email.', 'in a Slack reply.', 'in your notes.', 'in the doc, done.'];
  const TICK_MS = 55, HOLD_TICKS = 36, ERASE_STEP = 3;
  const typing = { index: 0, length: ENDINGS[0].length, hold: 0, erasing: false, timer: 0 };

  function paintTyped() {
    if (typedEl) typedEl.textContent = ENDINGS[typing.index].slice(0, typing.length);
  }

  function typeTick() {
    const full = ENDINGS[typing.index];
    if (!typing.erasing) {
      if (typing.length < full.length) typing.length++;
      else if (typing.hold < HOLD_TICKS) { typing.hold++; return; }
      else { typing.hold = 0; typing.erasing = true; return; }
    } else if (typing.length > 0) {
      typing.length = Math.max(0, typing.length - ERASE_STEP);
    } else {
      typing.index = (typing.index + 1) % ENDINGS.length;
      typing.erasing = false;
    }
    paintTyped();
  }

  function syncTyping(running) {
    if (!typedEl) return;
    stage.classList.toggle('is-typing', running);
    if (running && !typing.timer) typing.timer = setInterval(typeTick, TICK_MS);
    if (!running && typing.timer) { clearInterval(typing.timer); typing.timer = 0; }
    // Reduced motion shows the settled headline rather than a half-typed word.
    if (!running && still()) {
      Object.assign(typing, { index: 0, length: ENDINGS[0].length, hold: 0, erasing: false });
      paintTyped();
    }
  }

  function sync() {
    const awake = visible && !document.hidden && !suspended && !still();
    const floating = awake && lanes.length > 0 && width > 0 && open > 0;
    stage.classList.toggle('is-floating', !!floating);
    if (floating && !frame) { previous = 0; frame = requestAnimationFrame(tick); }
    if (!floating && frame) { cancelAnimationFrame(frame); frame = 0; previous = 0; }
    syncTyping(awake);
  }
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
  const resize = new ResizeObserver(() => { layout(); sync(); });
  layout();
  observer.observe(stage);
  resize.observe(field);
  document.addEventListener('visibilitychange', sync, { signal: events.signal });
  reduced.addEventListener('change', sync, { signal: events.signal });
  if (preference) preference.addEventListener('change', sync);
  window.addEventListener('pagehide', event => {
    suspended = true; sync();
    if (!event.persisted) { observer.disconnect(); resize.disconnect(); events.abort(); }
  }, { signal: events.signal });
  window.addEventListener('pageshow', () => { suspended = false; sync(); }, { signal: events.signal });
})();
