/* A continuous stream: only bubbles entirely outside the card are recycled. */
(() => {
  'use strict';
  const stage = document.getElementById('voice-stage');
  const field = stage?.querySelector('.hero-app-field');
  if (!field) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  const random = (min, max) => min + Math.random() * (max - min);
  const states = [...field.querySelectorAll('.hero-app-slot')].map(slot => ({ slot }));
  let lanes = [], width = 0, height = 0, size = 64, requestedSize = 0, clearance = 0;
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
    const choices = lanes.map((lane, index) => {
      const lowest = states.reduce((y, other) => other !== state && other.lane === index ? Math.max(y, other.y) : y, -Infinity);
      const y = Math.max(height + size / 2 + 12, lowest + clearance + random(4, 28));
      return { index, y, wait: (y - height) / lane.speed + random(0, 1.8) };
    });
    choices.sort((a, b) => a.wait - b.wait);
    state.lane = choices[0].index;
    state.y = choices[0].y;
    giveDrift(state);
  }

  function layout() {
    const nextWidth = field.clientWidth, nextHeight = field.clientHeight;
    if (!nextWidth || !nextHeight) return;
    const nextSize = parseFloat(getComputedStyle(field).getPropertyValue('--app-size')) || 64;
    if (width === nextWidth && height === nextHeight && requestedSize === nextSize) return;
    width = nextWidth; height = nextHeight; requestedSize = nextSize;
    const initialized = lanes.length > 0;
    // A sidebar transition delivers many resizes. Keep the same lanes, speeds,
    // heights and drift phases throughout; only their horizontal space changes.
    const count = lanes.length || Math.max(1, Math.min(4, Math.floor(width / (nextSize * 1.12 + 18))));
    const laneWidth = width / count;
    if (!initialized) lanes = Array.from({ length: count }, () => ({ speed: random(9.5, 14) }));
    // Retain separation even at narrow breakpoints, including the hover scale.
    size = Math.min(nextSize, laneWidth / 1.12);
    field.style.setProperty('--app-render-size', size + 'px');
    clearance = Math.max(64, nextSize) * 1.12 + 18;
    lanes.forEach((lane, i) => {
      lane.x = laneWidth * (i + .5);
      lane.sway = Math.max(0, (laneWidth - size * 1.12 - 12) / 2);
    });
    if (initialized) {
      states.forEach(paint);
      return;
    }
    // Shuffle the marks and stagger their starting heights without a shared loop.
    const shuffled = [...states];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const spacing = Math.max(clearance + 22, (height + size * 2) / Math.ceil(states.length / count));
    const offsets = lanes.map(() => random(0, spacing));
    shuffled.forEach((state, index) => {
      state.lane = index % count;
      state.y = height + size / 2 - offsets[state.lane] - Math.floor(index / count) * spacing - random(0, 16);
      giveDrift(state);
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

  function sync() {
    const running = visible && !document.hidden && !suspended && !reduced.matches && lanes.length > 0;
    stage.classList.toggle('is-floating', !!running);
    if (running && !frame) { previous = 0; frame = requestAnimationFrame(tick); }
    if (!running && frame) { cancelAnimationFrame(frame); frame = 0; previous = 0; }
  }
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
  const resize = new ResizeObserver(() => { layout(); sync(); });
  layout();
  observer.observe(stage);
  resize.observe(field);
  document.addEventListener('visibilitychange', sync, { signal: events.signal });
  reduced.addEventListener('change', sync, { signal: events.signal });
  window.addEventListener('pagehide', event => {
    suspended = true; sync();
    if (!event.persisted) { observer.disconnect(); resize.disconnect(); events.abort(); }
  }, { signal: events.signal });
  window.addEventListener('pageshow', () => { suspended = false; sync(); }, { signal: events.signal });
})();
