/* The settings card uses the same material as the floating Orb. Its clock only
   runs while the sphere is visible and the card is being hovered or focused. */
(function initEnergyOrbPreview() {
  'use strict';

  const canvas = document.getElementById('flow-preview-energy-orb');
  const card = canvas && canvas.closest('.flow-style-card');
  if (!canvas || !card || !window.VoxdenEnergyOrb) return;

  const renderer = window.VoxdenEnergyOrb.create(canvas);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let visible = false;
  let hovered = false;
  let focused = false;
  let frame = 0;
  let lastTime = 0;
  let time = 2.1;
  let disposed = false;

  function canPaint() {
    return !disposed && visible && document.visibilityState !== 'hidden';
  }

  function paint(active) {
    renderer.draw({
      time,
      energy: active ? .24 + .13 * (.5 + .5 * Math.sin(time * 2.1)) : .22,
      hover: active ? 1 : 0,
      processing: false,
      reducedMotion: reduced.matches,
    });
  }

  function tick(stamp) {
    frame = 0;
    if (!canPaint() || reduced.matches || !(hovered || focused)) return;
    if (lastTime) time += Math.min(.05, Math.max(0, (stamp - lastTime) / 1000));
    lastTime = stamp;
    paint(true);
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    if (!canPaint()) return;
    const active = hovered || focused;
    paint(active && !reduced.matches);
    if (active && !reduced.matches) frame = requestAnimationFrame(tick);
  }

  card.addEventListener('pointerenter', () => { hovered = true; sync(); }, { signal: events.signal });
  card.addEventListener('pointerleave', () => { hovered = false; sync(); }, { signal: events.signal });
  card.addEventListener('focusin', () => { focused = true; sync(); }, { signal: events.signal });
  card.addEventListener('focusout', event => {
    if (event.relatedTarget && card.contains(event.relatedTarget)) return;
    focused = false;
    sync();
  }, { signal: events.signal });
  document.addEventListener('visibilitychange', sync, { signal: events.signal });
  reduced.addEventListener('change', sync);

  const visibility = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.target === canvas && entry.isIntersecting);
    sync();
  });
  visibility.observe(canvas);
  const size = new ResizeObserver(() => { if (canPaint() && !frame) paint(false); });
  size.observe(canvas);

  window.addEventListener('pagehide', () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    events.abort();
    visibility.disconnect();
    size.disconnect();
    reduced.removeEventListener('change', sync);
    renderer.dispose();
  }, { once: true });
})();
