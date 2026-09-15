/* Voxden motion: a living voice contour, scroll entrances, and tactile light.
   No audio permission, libraries, timers in hidden tabs, or hidden-content gate. */
(function () {
  'use strict';
  var doc = document;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var desktop = window.matchMedia('(min-width: 769px)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var waves = [];
  var frame = 0;
  var lastFrame = 0;
  var motionTime = 0;
  var running = false;
  // The hero ribbon breathes with the demo: fuller while it records, calm at rest.
  var waveEnergy = 0;
  var clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };

  /* Each strand shares the same traveling wave. Varying phase and thickness
     across the band makes it fold as a surface, instead of wobbling as an image. */
  function contour(x, strand, width, height, time, closing) {
    // Small screens see a crop of the same broad form, rather than a squeezed wave.
    var span = Math.max(width, 1000);
    var u = (x + (span - width) / 2) / span;
    var size = Math.min(height, closing ? 440 : 670);
    var amplitude = size * (closing ? .16 : .215) * (1 + waveEnergy * .55);
    var phase = u * 8.8 - time * (.67 + waveEnergy * .45);
    var envelope = .66 + .34 * Math.sin(u * Math.PI);
    var primary = Math.sin(phase + strand * .58);
    var harmonic = Math.sin(u * 15.6 - time * 1.02 + strand * .35) * .22;
    var fold = strand * size * (.108 + .052 * Math.cos(u * 6.4 + time * .29));
    return height * (closing ? .52 : .5) + (primary + harmonic) * amplitude * envelope + fold;
  }

  function drawWave(wave, time) {
    if (!wave.width || !wave.height) return;
    var ctx = wave.ctx;
    var width = wave.width;
    var height = wave.height;
    ctx.clearRect(0, 0, width, height);
    var strands = 34;
    var steps = Math.ceil(width / 10);
    var surface = ctx.createLinearGradient(0, 0, width, height);
    surface.addColorStop(0, 'rgba(37, 70, 53, 0)');
    surface.addColorStop(.23, 'rgba(65, 112, 82, .15)');
    surface.addColorStop(.48, 'rgba(15, 33, 24, .08)');
    surface.addColorStop(.76, 'rgba(76, 120, 94, .15)');
    surface.addColorStop(1, 'rgba(28, 58, 42, 0)');
    ctx.beginPath();
    for (var p = 0; p <= steps; p++) {
      var x = p / steps * width;
      var y = contour(x, -1, width, height, time, wave.closing);
      if (!p) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (var q = steps; q >= 0; q--) {
      var reverseX = q / steps * width;
      ctx.lineTo(reverseX, contour(reverseX, 1, width, height, time, wave.closing));
    }
    ctx.closePath(); ctx.fillStyle = surface; ctx.fill();

    // A soft catchlight moves through the strands with the traveling signal.
    var light = .5 + .34 * Math.sin(time * .24 - 1);
    for (var line = 0; line < strands; line++) {
      var s = line / (strands - 1) * 2 - 1;
      var isEdge = line === 0 || line === strands - 1;
      var alpha = (isEdge ? .64 : .19 + .17 * Math.pow(Math.abs(s), 1.4)) * (1 + waveEnergy * .45);
      var stroke = ctx.createLinearGradient(0, 0, width, 0);
      stroke.addColorStop(0, 'rgba(113, 189, 148, 0)');
      stroke.addColorStop(.09, 'rgba(113, 189, 148, ' + alpha * .42 + ')');
      stroke.addColorStop(Math.max(.1, light - .2), 'rgba(119, 194, 153, ' + alpha * .7 + ')');
      stroke.addColorStop(light, 'rgba(183, 241, 207, ' + alpha + ')');
      stroke.addColorStop(Math.min(.9, light + .2), 'rgba(120, 198, 154, ' + alpha * .65 + ')');
      stroke.addColorStop(.91, 'rgba(113, 189, 148, ' + alpha * .4 + ')');
      stroke.addColorStop(1, 'rgba(113, 189, 148, 0)');
      ctx.beginPath();
      for (var point = 0; point <= steps; point++) {
        var px = point / steps * width;
        var py = contour(px, s, width, height, time, wave.closing);
        if (!point) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = isEdge ? 1.2 : .8;
      ctx.stroke();
    }
  }

  function resizeWave(wave) {
    var bounds = wave.host.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    wave.width = Math.round(bounds.width);
    wave.height = Math.round(bounds.height);
    wave.canvas.width = Math.round(wave.width * dpr);
    wave.canvas.height = Math.round(wave.height * dpr);
    wave.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave(wave, motionTime);
  }
  function shouldRun() { return !reduced.matches && desktop.matches && !doc.hidden && waves.some(function (wave) { return wave.visible; }); }
  function animate(now) {
    if (!shouldRun()) { running = false; frame = 0; lastFrame = 0; return; }
    frame = requestAnimationFrame(animate);
    if (lastFrame && now - lastFrame < 1000 / 30) return;
    if (lastFrame) motionTime += Math.min((now - lastFrame) / 1000, .09);
    lastFrame = now;
    var bar = doc.querySelector('.hero .demo-bar');
    var state = bar ? bar.getAttribute('data-state') : 'idle';
    var target = state === 'recording' ? 1 : state === 'thinking' ? .5 : 0;
    waveEnergy += (target - waveEnergy) * (target > waveEnergy ? .06 : .03);
    waves.forEach(function (wave) { if (wave.visible) drawWave(wave, motionTime); });
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

  /* Dither the halo itself, rather than placing grain behind a CSS shadow.
     The flat face covers the center; only this softly fading raster sits
     outside the card. It is painted once per size, with no frame loop. */
  var haloCache = new Map();
  function goldHaloImage(width, height) {
    var key = width + 'x' + height;
    if (haloCache.has(key)) return haloCache.get(key);
    var pad = 96;
    var canvas = doc.createElement('canvas');
    canvas.width = width + pad * 2;
    canvas.height = height + pad * 2;
    var context = canvas.getContext('2d');
    if (!context) return null;
    var pixels = context.createImageData(canvas.width, canvas.height);
    var data = pixels.data;
    var cx = canvas.width / 2;
    var cy = canvas.height / 2;
    var radius = 12;
    var seed = 17093;
    for (var y = 0; y < canvas.height; y++) {
      for (var x = 0; x < canvas.width; x++) {
        var qx = Math.abs(x + .5 - cx) - width / 2 + radius;
        var qy = Math.abs(y + .5 - cy) - height / 2 + radius;
        var distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
        if (distance < 0) continue;
        var alpha = .145 * Math.exp(-distance * distance / 800) + .06 * Math.exp(-distance * distance / 5000);
        var edgeFade = clamp((pad - distance) / 32, 0, 1);
        alpha *= edgeFade * edgeFade * (3 - 2 * edgeFade);
        // Noise lives in alpha before the final composite, so even very dark
        // display output does not form concentric bands at 8-bit boundaries.
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        var noise = (seed / 4294967296 - .5) * .032 * Math.sqrt(alpha / .205);
        var i = (y * canvas.width + x) * 4;
        data[i] = 238; data[i + 1] = 191; data[i + 2] = 86;
        data[i + 3] = Math.round(clamp(alpha + noise, 0, 1) * 255);
      }
    }
    context.putImageData(pixels, 0, 0);
    var image = 'url("' + canvas.toDataURL('image/png') + '")';
    // Small fixed cache avoids retaining a raster for every intermediate resize.
    if (haloCache.size >= 8) haloCache.delete(haloCache.keys().next().value);
    haloCache.set(key, image);
    return image;
  }
  doc.querySelectorAll('.card-gold, .page-pricing .plan').forEach(function (card) {
    var width = 0;
    var height = 0;
    function paintHalo() {
      var nextWidth = Math.round(card.offsetWidth);
      var nextHeight = Math.round(card.offsetHeight);
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return;
      width = nextWidth; height = nextHeight;
      var image = goldHaloImage(width, height);
      if (image) { card.style.setProperty('--gold-halo-image', image); card.classList.add('gold-halo-ready'); }
    }
    paintHalo();
    if ('ResizeObserver' in window) new ResizeObserver(paintHalo).observe(card);
    else window.addEventListener('resize', paintHalo, { passive: true });
  });

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

  /* Buttons catch the pointer light; card illumination always stays constant. */
  doc.querySelectorAll('.btn-primary, .btn-gold').forEach(function (el) {
    var pointerFrame = 0;
    var x = 50;
    var y = 0;
    function paintPointer() {
      pointerFrame = 0;
      el.style.setProperty('--pointer-x', x.toFixed(1) + '%');
      el.style.setProperty('--pointer-y', y.toFixed(1) + '%');
    }
    el.addEventListener('pointermove', function (event) {
      if (!finePointer.matches || reduced.matches) return;
      var rect = el.getBoundingClientRect();
      x = clamp((event.clientX - rect.left) / rect.width * 100, 0, 100);
      y = clamp((event.clientY - rect.top) / rect.height * 100, 0, 100);
      if (!pointerFrame) pointerFrame = requestAnimationFrame(paintPointer);
    }, { passive: true });
    el.addEventListener('pointerleave', function () {
      cancelAnimationFrame(pointerFrame); pointerFrame = 0;
      el.style.removeProperty('--pointer-x'); el.style.removeProperty('--pointer-y');
    });
  });
})();
