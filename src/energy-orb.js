/* A small, procedural volume for the Orb surface. Canvas2D works with Electron's
   software renderer too. The owner supplies time and schedules every draw. */
(function exposeEnergyOrb(root) {
  'use strict';

  const TAU = Math.PI * 2;
  const QUARTER_TURN = Math.PI / 2;
  const STAR_STEPS = 512;
  const starRadius = new Float32Array(STAR_STEPS + 1);
  const starSlope = new Float32Array(STAR_STEPS + 1);
  // One exact AI-star quarter: (0,-1) -> (1,0), with concave cubic controls
  // (.14,-.34) and (.34,-.14). Cache polar samples once; all four sharp tips
  // share this contour, so the silhouette stays balanced while it rotates.
  for (let i = 0; i <= STAR_STEPS; i++) {
    const wantedAngle = i / STAR_STEPS * QUARTER_TURN;
    let low = 0;
    let high = 1;
    for (let step = 0; step < 18; step++) {
      const t = (low + high) / 2;
      const x = .42 * t + .18 * t * t + .4 * t * t * t;
      const y = -1 + 1.98 * t - 1.38 * t * t + .4 * t * t * t;
      if (Math.atan2(x, -y) < wantedAngle) low = t;
      else high = t;
    }
    const t = i === 0 ? 0 : i === STAR_STEPS ? 1 : (low + high) / 2;
    const x = .42 * t + .18 * t * t + .4 * t * t * t;
    const y = -1 + 1.98 * t - 1.38 * t * t + .4 * t * t * t;
    const dx = .42 + .36 * t + 1.2 * t * t;
    const dy = 1.98 - 2.76 * t + 1.2 * t * t;
    const radius = Math.sqrt(x * x + y * y);
    starRadius[i] = radius;
    starSlope[i] = (x * dx + y * dy) * radius / (-y * dx + x * dy);
  }
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  function create(canvas) {
    let context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: true }) : null;
    let pixels = null;
    let geometry = null;
    let shapeGeometry = null;
    let backingWidth = 0;
    let backingHeight = 0;
    let disposed = false;

    function resize() {
      if (!context || disposed) return false;
      const dpr = Math.min(2, Math.max(1, finite(root.devicePixelRatio) || 1));
      const cssWidth = Math.min(128, Math.max(8, canvas.clientWidth || parseFloat(canvas.style && canvas.style.width) || 36));
      const cssHeight = Math.min(128, Math.max(8, canvas.clientHeight || parseFloat(canvas.style && canvas.style.height) || cssWidth));
      const width = Math.round(cssWidth * dpr);
      const height = Math.round(cssHeight * dpr);
      if (width === backingWidth && height === backingHeight) return true;
      backingWidth = canvas.width = width;
      backingHeight = canvas.height = height;
      pixels = context.createImageData(width, height);
      // Seven floats per pixel: longitude, latitude, depth, diffuse light,
      // sphere coverage, outside haze and sub-byte dither. These never change
      // while the canvas keeps its size; no textures or objects grow per frame.
      geometry = new Float32Array(width * height * 7);
      shapeGeometry = new Float32Array(width * height * 2);
      const radius = Math.min(width, height) * .425;
      const edgeWidth = 1 / radius;
      const tiltCos = Math.cos(.28);
      const tiltSin = Math.sin(.28);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 7;
          const nx = (x + .5 - width / 2) / radius;
          const ny = (y + .5 - height / 2) / radius;
          const distance = Math.sqrt(nx * nx + ny * ny);
          const polarAt = (y * width + x) * 2;
          shapeGeometry[polarAt] = distance;
          shapeGeometry[polarAt + 1] = Math.atan2(ny, nx);
          const coverage = clamp((1 - distance) / edgeWidth + .5);
          const z = Math.sqrt(Math.max(0, 1 - Math.min(1, distance * distance)));
          const tx = nx * tiltCos + ny * tiltSin;
          const ty = -nx * tiltSin + ny * tiltCos;
          geometry[at] = Math.atan2(tx, z);
          geometry[at + 1] = Math.asin(Math.max(-1, Math.min(1, -ty)));
          geometry[at + 2] = z;
          geometry[at + 3] = .53 + .47 * Math.max(0, -.36 * nx - .49 * ny + .72 * z);
          geometry[at + 4] = coverage;
          geometry[at + 5] = distance > .98 && distance < 1.17
            ? Math.pow(Math.max(0, 1 - Math.abs(distance - 1) / .17), 2) * (1 - coverage) : 0;
          geometry[at + 6] = (((x * 17 + y * 43 + (x * y) % 13) % 19) / 19 - .5) * .8;
        }
      }
      return true;
    }

    function drawGlassProcessing(mix, phase, energy, hover, pulse) {
      const data = pixels.data;
      const radius = Math.min(backingWidth, backingHeight) * .425;
      const originalHaze = 12 + energy * 12 + hover * 5 + pulse * 14;
      const hazeLevel = originalHaze + (28 + energy * 8 - originalHaze) * mix;
      const lightX = .59 * Math.cos(phase);
      const lightY = .55 * Math.sin(phase);
      const lightZ = .72;
      const lightLength = Math.sqrt(lightX * lightX + lightY * lightY + lightZ * lightZ);
      const breath = .24 + (.5 + .5 * Math.sin(phase * 3)) * .15;
      const pulseLift = Math.min(1, pulse * 3);
      const focalX = .18 + .18 * Math.sin(phase);
      const focalY = -.16 + .2 * Math.cos(phase * 2);
      for (let at = 0, polarAt = 0, pixel = 0; at < geometry.length; at += 7, polarAt += 2, pixel += 4) {
        const distance = shapeGeometry[polarAt];
        const angle = shapeGeometry[polarAt + 1];
        // A circle becomes the pointed four-part contour. It rotates through
        // the same clock as the refractions; no second flat icon is overlaid.
        // Fourfold symmetry closes the phase loop after two quarter turns.
        const quarterAngle = ((angle - phase * .5) % QUARTER_TURN + QUARTER_TURN) % QUARTER_TURN;
        const sample = quarterAngle / QUARTER_TURN * STAR_STEPS;
        const index = Math.min(STAR_STEPS - 1, Math.floor(sample));
        const fraction = sample - index;
        const pointedRadius = starRadius[index] + (starRadius[index + 1] - starRadius[index]) * fraction;
        const pointedSlope = starSlope[index] + (starSlope[index + 1] - starSlope[index]) * fraction;
        const contour = 1 + (pointedRadius - 1) * mix;
        const contourSlope = pointedSlope * mix;
        const coverage = clamp((contour - distance) * radius + .5);
        if (coverage <= 0) {
          const falloff = Math.max(0, 1 - (distance - contour) / .17);
          data[pixel] = Math.round(data[pixel] + (100 - data[pixel]) * mix);
          data[pixel + 1] = Math.round(data[pixel + 1] + (218 - data[pixel + 1]) * mix);
          data[pixel + 2] = Math.round(data[pixel + 2] + (183 - data[pixel + 2]) * mix);
          data[pixel + 3] = Math.round(falloff * falloff * hazeLevel);
          continue;
        }
        const relativeRadius = Math.min(1, distance / contour);
        const depth = Math.sqrt(Math.max(0, 1 - relativeRadius * relativeRadius));
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);
        const radialNormal = relativeRadius / contour;
        const curveNormal = relativeRadius * relativeRadius * contourSlope / (contour * Math.max(.0001, distance));
        // The normal follows the curved contour as well as its domed height.
        // This preserves a convex glass face with highlights around each arm.
        let normalX = radialNormal * cosAngle + curveNormal * sinAngle;
        let normalY = radialNormal * sinAngle - curveNormal * cosAngle;
        const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + depth * depth) || 1;
        normalX /= normalLength;
        normalY /= normalLength;
        const normalZ = depth / normalLength;
        const longitude = Math.atan2(normalX, normalZ);
        const latitude = Math.asin(Math.max(-1, Math.min(1, -normalY)));
        const diffuse = Math.max(0, -.34 * normalX - .5 * normalY + .75 * normalZ);
        const topLight = Math.pow(Math.max(0, -.44 * normalX - .6 * normalY + .66 * normalZ), 22);
        const movingLight = Math.pow(Math.max(0,
          (normalX * lightX + normalY * lightY + normalZ * lightZ) / lightLength), 38);
        const refractedWave = .5 + .5 * Math.cos(longitude * 3
          + Math.sin(latitude * 2 - phase) * .9 + phase);
        const caustic = Math.pow(refractedWave, 4) * depth * depth * breath * (.84 + energy * .45);
        const seam = Math.pow(.5 + .5 * Math.cos(longitude * 5 + latitude * 1.8 - phase), 24)
          * (.16 + depth * .33);
        // Processing uses a restrained pulse envelope. Concentrate that energy
        // into an internal caustic and its existing glints so even a .3 pulse
        // reads at 30px, while the valleys and most of the glass stay dark.
        const flareLatitude = Math.pow(.5 + .5 * Math.sin(latitude * 3 - phase * 2 + .6), 4);
        const flareBand = Math.pow(refractedWave, 8) * depth;
        const focalDistance = (normalX - focalX) * (normalX - focalX) + (normalY - focalY) * (normalY - focalY);
        const focalCaustic = Math.exp(-focalDistance * 18) * Math.pow(depth, .6);
        const pulseFlash = pulseLift * (.8 + energy * .2)
          * (flareBand * (.18 + .82 * flareLatitude) * .58 + focalCaustic * .62 + movingLight * .22 + topLight * .14);
        const fresnel = Math.pow(1 - normalZ, 2.4);
        const dither = geometry[at + 6];
        const red = 9 + diffuse * 14 + caustic * 50 + seam * 42 + topLight * 155 + movingLight * 185 + fresnel * 95 + pulseFlash * 180;
        const green = 27 + diffuse * 30 + caustic * 112 + seam * 125 + topLight * 190 + movingLight * 210 + fresnel * 190 + pulseFlash * 218;
        const blue = 27 + diffuse * 25 + caustic * 97 + seam * 116 + topLight * 195 + movingLight * 220 + fresnel * 164 + pulseFlash * 205;
        data[pixel] = Math.min(255, Math.max(0, Math.round(data[pixel] + (red + dither - data[pixel]) * mix)));
        data[pixel + 1] = Math.min(255, Math.max(0, Math.round(data[pixel + 1] + (green + dither - data[pixel + 1]) * mix)));
        data[pixel + 2] = Math.min(255, Math.max(0, Math.round(data[pixel + 2] + (blue + dither - data[pixel + 2]) * mix)));
        data[pixel + 3] = Math.round(coverage * 255);
      }
    }

    function draw(state) {
      if (!resize()) return;
      const options = state || {};
      const energy = clamp(options.energy);
      const reducedMotion = !!options.reducedMotion;
      const pulse = reducedMotion ? 0 : clamp(options.pulse);
      // The caller supplies the syllable envelope and a continuously integrated
      // clock. Energy bends the material; it never multiplies absolute time.
      const movement = reducedMotion ? 0 : energy;
      const hover = clamp(options.hover);
      const processing = options.processing === true ? 1 : clamp(options.processing);
      // Wrapping a very long session keeps trigonometric inputs well behaved.
      // Integer harmonics close the same loop, so there is no wrap-frame jump.
      const time = reducedMotion ? 2.1 : finite(options.time);
      const phase = ((time * .62) % TAU + TAU) % TAU;
      const strength = .63 + energy * .25 + hover * .07 + processing * .05;
      const warmth = .18 + energy * .17;
      const broadPower = 1.55 - movement * .5 - pulse * .12;
      const crestPower = 8 - movement * 1.8;
      const finePower = 18 - movement * 6;
      const burstLatitude = Math.sin(phase * 2 + .8) * .75;
      const data = pixels.data;
      for (let at = 0, pixel = 0; at < geometry.length; at += 7, pixel += 4) {
        const coverage = geometry[at + 4];
        if (coverage <= 0) {
          const haze = geometry[at + 5];
          data[pixel] = 81;
          data[pixel + 1] = 194;
          data[pixel + 2] = 139;
          data[pixel + 3] = Math.round(haze * (12 + energy * 12 + hover * 5 + pulse * 14));
          continue;
        }
        const longitude = geometry[at];
        const latitude = geometry[at + 1];
        const depth = geometry[at + 2];
        const diffuse = geometry[at + 3];
        // Broad ribbons bend in latitude before wrapping over the limb. The
        // quieter second field adds a folded edge instead of another ring.
        const surfaceRipple = Math.sin(latitude * 5 - longitude * 1.7 + phase * 3) * movement * .18
          + Math.sin(latitude * 8 + longitude * 2 - phase * 4) * pulse * .14;
        const fold = Math.sin(latitude * 2 + phase) * (.7 + movement * .78 + pulse * .32)
          + Math.sin(latitude * 3 - phase * 2) * (.16 + movement * .24)
          + surfaceRipple;
        const ribbonPhase = longitude * 3 + phase * 2 + latitude * .55 + fold;
        const wave = .5 + .5 * Math.cos(ribbonPhase);
        const broad = Math.pow(wave, broadPower);
        const crest = Math.pow(wave, crestPower);
        const fineWave = .5 + .5 * Math.cos(ribbonPhase + .34
          + Math.sin(latitude * 4 - phase) * (.2 + movement * .25) + surfaceRipple * .7);
        const fine = Math.pow(fineWave, finePower);
        const movingLight = .5 + .5 * Math.sin(latitude * 4 + longitude * 1.8 - phase * 3);
        const burstDistance = latitude - burstLatitude;
        // A syllable adds a local pearl flare on the existing ribbon, rather
        // than lifting every pixel into a white disc. Valleys stay dark.
        const burst = pulse * (crest * .75 + fine * .25)
          * (.12 + .88 * Math.exp(-burstDistance * burstDistance * 7)) * (.55 + depth * .45);
        const hot = crest * (.16 + .84 * Math.pow(movingLight, 4)) * (.58 + energy * .24 + processing * .14)
          + burst * .78;
        const volume = .28 + .72 * Math.pow(depth, .45);
        const filament = Math.pow(.5 + .5 * Math.cos(longitude * 8
          + Math.sin(latitude * 3 + phase) * (1.8 + movement * .8) - phase * 2), 28);
        const radiance = (broad * .72 + crest * .22 + fine * .24
          + filament * broad * (.15 + movement * .28 + pulse * .18)) * volume * strength;
        const rim = Math.pow(1 - depth, 3) * (.12 + broad * .15);
        const light = diffuse * (.82 + .18 * depth);
        const dither = geometry[at + 6];
        // Green remains dominant; teal shadows and near-white crests supply
        // spherical depth without washing the entire object into a white dot.
        // Emission belongs to the material rather than the outside light: the
        // bands stay luminous as they turn into shadow, then fade over the limb.
        let red = 5 * light + radiance * 95 + hot * 160 + rim * 70;
        let green = 22 * light + radiance * 215 + hot * 96 + rim * 95;
        let blue = 20 * light + radiance * (174 - warmth * 40) + hot * 140 + rim * 82;
        const pearl = Math.pow(Math.max(0, depth * .85 - longitude * .2 + latitude * .14), 17) * .085;
        red += pearl * 200;
        green += pearl * 160;
        blue += pearl * 180;
        data[pixel] = Math.min(255, Math.max(0, Math.round(red + dither)));
        data[pixel + 1] = Math.min(255, Math.max(0, Math.round(green + dither)));
        data[pixel + 2] = Math.min(255, Math.max(0, Math.round(blue + dither)));
        data[pixel + 3] = Math.round(coverage * 255);
      }
      // Processing has its own glass material and contour. Zero/omitted leaves
      // the approved speech pixels above completely untouched.
      if (processing > 0) drawGlassProcessing(processing, phase, energy, hover, pulse);
      context.putImageData(pixels, 0, 0);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (context) context.clearRect(0, 0, backingWidth, backingHeight);
      pixels = null;
      geometry = null;
      shapeGeometry = null;
      context = null;
    }

    return { draw, dispose };
  }

  root.VoxdenEnergyOrb = Object.freeze({ create });
})(typeof window === 'object' ? window : globalThis);
