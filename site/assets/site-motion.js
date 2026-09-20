/* Voxden motion: a living voice contour, scroll entrances, and tactile light.
   No audio permission, libraries, timers in hidden tabs, or hidden-content gate. */
(function () {
  'use strict';
  var doc = document;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var desktop = window.matchMedia('(min-width: 769px)');
  var waves = [];
  var frame = 0;
  var lastFrame = 0;
  // How far the signal has travelled across the band, in spans. Integrated per
  // frame so a change of speed never moves the wave: only its rate of drift.
  var waveTravel = 0;
  var running = false;
  // The hero ribbon breathes with the demo: fuller while it records, calm at rest.
  var waveEnergy = 0;
  // Spans per second. Energy adds drift, it does not multiply elapsed time.
  var DRIFT_IDLE = .046;
  var DRIFT_ENERGY = .03;
  // The catchlight rests mid-band, so the strand gradient is constant and cacheable.
  // The catchlight sits left of centre, so the hero wings glow beside the demo.
  var LIGHT = .24;
  var clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };

  /* Each strand shares the same traveling wave. Varying phase and thickness
     across the band makes it fold as a surface, instead of wobbling as an image.
     Every travelling term reads the same shifted coordinate, so the whole signal
     moves as one body from left to right: nothing counter-moves, nothing beats
     against anything else, and no term multiplies an accumulated clock. */
  function contour(x, strand, width, height, travel, closing) {
    // Small screens see a crop of the same broad form, rather than a squeezed wave.
    var span = Math.max(width, 1000);
    var u = (x + (span - width) / 2) / span;
    var size = Math.min(height, closing ? 440 : 670);
    var amplitude = size * (closing ? .16 : .215) * (1 + waveEnergy * .55);
    // Subtracting travel carries every crest toward +x as travel grows.
    var t = u - travel;
    var envelope = .66 + .34 * Math.sin(u * Math.PI);
    var primary = Math.sin(t * 8.8 + strand * .58);
    var harmonic = Math.sin(t * 15.6 + strand * .35) * .22;
    var fold = strand * size * (.108 + .052 * Math.cos(t * 6.4));
    return height * (closing ? .52 : .5) + (primary + harmonic) * amplitude * envelope + fold;
  }

  /* Both gradients depend only on the canvas size, so they are built once per
     size instead of once per strand per frame; per-strand brightness rides on
     globalAlpha, which multiplies the stops exactly as baking it in did. */
  function waveGradients(wave) {
    if (wave.gradientKey === wave.width + 'x' + wave.height) return;
    var ctx = wave.ctx;
    var surface = ctx.createLinearGradient(0, 0, wave.width, wave.height);
    surface.addColorStop(0, 'rgba(37, 70, 53, 0)');
    surface.addColorStop(.22, 'rgba(65, 112, 82, .13)');
    surface.addColorStop(.5, 'rgba(15, 33, 24, .06)');
    surface.addColorStop(.78, 'rgba(65, 112, 82, .13)');
    surface.addColorStop(1, 'rgba(37, 70, 53, 0)');
    var stroke = ctx.createLinearGradient(0, 0, wave.width, 0);
    // Two matching catchlights, one on each wing, dim in the middle where
    // the demo sits and fading to nothing at both edges: the ribbon reads
    // the same on the left as on the right.
    stroke.addColorStop(0, 'rgba(113, 189, 148, 0)');
    stroke.addColorStop(.07, 'rgba(113, 189, 148, .3)');
    stroke.addColorStop(LIGHT, 'rgba(183, 241, 207, .8)');
    stroke.addColorStop(.5, 'rgba(119, 194, 153, .42)');
    stroke.addColorStop(1 - LIGHT, 'rgba(183, 241, 207, .8)');
    stroke.addColorStop(.93, 'rgba(113, 189, 148, .3)');
    stroke.addColorStop(1, 'rgba(113, 189, 148, 0)');
    wave.surface = surface;
    wave.stroke = stroke;
    wave.gradientKey = wave.width + 'x' + wave.height;
  }

  function drawWave(wave, travel) {
    if (!wave.width || !wave.height) return;
    var ctx = wave.ctx;
    var width = wave.width;
    var height = wave.height;
    waveGradients(wave);
    ctx.clearRect(0, 0, width, height);
    var strands = 34;
    var steps = Math.ceil(width / 10);
    ctx.beginPath();
    for (var p = 0; p <= steps; p++) {
      var x = p / steps * width;
      var y = contour(x, -1, width, height, travel, wave.closing);
      if (!p) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (var q = steps; q >= 0; q--) {
      var reverseX = q / steps * width;
      ctx.lineTo(reverseX, contour(reverseX, 1, width, height, travel, wave.closing));
    }
    ctx.closePath(); ctx.fillStyle = wave.surface; ctx.fill();

    ctx.strokeStyle = wave.stroke;
    for (var line = 0; line < strands; line++) {
      var s = line / (strands - 1) * 2 - 1;
      var isEdge = line === 0 || line === strands - 1;
      var alpha = (isEdge ? .46 : .11 + .12 * Math.pow(Math.abs(s), 1.6)) * (1 + waveEnergy * .45);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.beginPath();
      for (var point = 0; point <= steps; point++) {
        var px = point / steps * width;
        var py = contour(px, s, width, height, travel, wave.closing);
        if (!point) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.lineWidth = isEdge ? 1.2 : .8;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function resizeWave(wave) {
    var bounds = wave.host.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    wave.width = Math.round(bounds.width);
    wave.height = Math.round(bounds.height);
    wave.canvas.width = Math.round(wave.width * dpr);
    wave.canvas.height = Math.round(wave.height * dpr);
    wave.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave(wave, waveTravel);
  }
  function shouldRun() { return !reduced.matches && desktop.matches && !doc.hidden && waves.some(function (wave) { return wave.visible; }); }
  var demoBar = null;
  function heroState() {
    if (!demoBar || !demoBar.isConnected) demoBar = doc.querySelector('.hero .demo-bar');
    return demoBar ? demoBar.getAttribute('data-state') : 'idle';
  }
  function animate(now) {
    if (!shouldRun()) { running = false; frame = 0; lastFrame = 0; return; }
    frame = requestAnimationFrame(animate);
    if (lastFrame && now - lastFrame < 1000 / 30) return;
    var elapsed = lastFrame ? Math.min((now - lastFrame) / 1000, .09) : 0;
    lastFrame = now;
    var state = heroState();
    var target = state === 'recording' ? 1 : state === 'thinking' ? .5 : 0;
    waveEnergy += (target - waveEnergy) * (target > waveEnergy ? .06 : .03);
    // Speed is integrated, so energy alters the drift rate and never the position.
    waveTravel += elapsed * (DRIFT_IDLE + waveEnergy * DRIFT_ENERGY);
    waves.forEach(function (wave) { if (wave.visible) drawWave(wave, waveTravel); });
  }
  function syncWaveMotion() {
    if (shouldRun()) {
      if (!running) { running = true; lastFrame = 0; frame = requestAnimationFrame(animate); }
    } else {
      cancelAnimationFrame(frame); frame = 0; lastFrame = 0; running = false;
      // Keep the last beautiful frame when motion is paused.
    }
  }
  doc.querySelectorAll('.hero > .soundwave, .closing-section > .soundwave').forEach(function (host) {
    var canvas = doc.createElement('canvas');
    var ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    canvas.className = 'soundwave-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    var wave = { host: host, canvas: canvas, ctx: ctx, width: 0, height: 0, visible: false, closing: host.parentElement.classList.contains('closing-section') };
    waves.push(wave);
    resizeWave(wave);
    host.classList.add('has-live-wave');
    if ('ResizeObserver' in window) new ResizeObserver(function () { resizeWave(wave); }).observe(host);
    else window.addEventListener('resize', function () { resizeWave(wave); }, { passive: true });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { wave.visible = entries[0].isIntersecting; syncWaveMotion(); }).observe(host);
    } else { wave.visible = true; }
  });
  doc.addEventListener('visibilitychange', syncWaveMotion);
  reduced.addEventListener('change', syncWaveMotion);
  desktop.addEventListener('change', syncWaveMotion);
  syncWaveMotion();

  /* Bounded depth behind the hero follows scroll without changing content. */
  var heroWave = doc.querySelector('.hero > .soundwave');
  var scrollFrame = 0;
  function updateScroll() {
    scrollFrame = 0;
    if (heroWave) heroWave.style.setProperty('--wave-scroll-y', (reduced.matches || !desktop.matches ? 0 : clamp(window.scrollY * .065, 0, 42)).toFixed(1) + 'px');
  }
  function scheduleScroll() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); }
  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', scheduleScroll, { passive: true });
  reduced.addEventListener('change', scheduleScroll);
  updateScroll();

})();
