/* The flow bar's orb, on the website. A port of the driver in src/overlay.js:
   the same sphere renderer (energy-orb.js), the same halo, particle and
   processing-echo motion, fed a synthetic syllable envelope instead of the
   microphone. Each .demo-orb-wrap follows the data-state of its .demo-bar:
   idle, recording (voice, particles), thinking (the glass star, echoes). */
(function () {
  'use strict';
  if (!window.VoxdenEnergyOrb) return;
  var wraps = document.querySelectorAll('.demo-orb-wrap');
  if (!wraps.length) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TAU = Math.PI * 2;
  var approach = function (cur, target, tau, dt) { return cur + (target - cur) * (1 - Math.exp(-dt / tau)); };
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var ECHOES = [['a', .18, .4], ['b', .37, .27]];

  function makeOrb(wrap) {
    var canvas = wrap.querySelector('canvas');
    var bar = wrap.closest('.demo-bar');
    var particles = Array.prototype.map.call((bar || wrap).querySelectorAll('.orb-particle'), function (el) {
      return { el: el, age: 0, life: 0, angle: 0, strength: 0, bend: 0, travel: 0, ox: 0, oy: 0, size: 1 };
    });
    return {
      wrap: wrap, bar: bar, renderer: window.VoxdenEnergyOrb.create(canvas),
      particles: particles, credit: 0, serial: 0,
      time: 1.3 + Math.random() * 4, budget: 0,
      active: 0, voice: 0, trail: 0, pulse: 0, target: 0, nextSyllable: 0,
      procMix: 0, procClock: 0, procOrigin: null,
    };
  }
  var orbs = Array.prototype.map.call(wraps, makeOrb);

  function setVar(o, name, value) { o.wrap.style.setProperty(name, value); }

  // Speech, invented: bursts of energy the length of syllables, with gaps
  // between words, so the sphere and the particles react the way they do
  // to a real voice.
  function synthVoice(o, dt) {
    o.nextSyllable -= dt;
    if (o.nextSyllable <= 0) {
      var word = Math.random() < .22;
      o.target = word ? .02 : .45 + Math.random() * .5;
      o.nextSyllable = word ? .18 + Math.random() * .22 : .09 + Math.random() * .14;
    }
    o.voice = approach(o.voice, o.target, o.target > o.voice ? .035 : .085, dt);
    o.trail = approach(o.trail, o.voice, .24, dt);
    var onset = clamp01((o.voice - o.trail) * 3.4);
    o.pulse = approach(o.pulse, onset, onset > o.pulse ? .022 : .13, dt);
  }

  function drawLive(o, dt, state) {
    var recording = state === 'recording';
    o.active = reduced ? 0 : approach(o.active, recording ? 1 : 0, .12, dt);
    if (recording) synthVoice(o, dt); else { o.voice = approach(o.voice, 0, .1, dt); o.pulse = approach(o.pulse, 0, .1, dt); }
    var energy = recording ? o.voice : .04;
    var pulse = recording && !reduced ? o.pulse : 0;
    if (!reduced) o.time += dt * (.7 + energy * 1.65 + pulse * .65);
    var phase = o.time * .62;
    var motion = recording && !reduced ? energy : 0;
    var scale = reduced ? .8 : .8 + o.active * .04 + motion * .06 + pulse * .055;
    setVar(o, '--orb-scale', scale.toFixed(4));
    setVar(o, '--orb-x', (Math.sin(phase * 2) * motion * .55).toFixed(3) + 'px');
    setVar(o, '--orb-y', (Math.sin(phase * 3 + .6) * motion * .55).toFixed(3) + 'px');
    setVar(o, '--orb-halo-opacity', Math.min(1, .18 + energy * .5 + pulse * .38).toFixed(3));
    setVar(o, '--orb-halo-scale', (1 + motion * .12 + pulse * .15).toFixed(4));
    setVar(o, '--orb-halo-x', (Math.sin(phase) * motion * 1.6).toFixed(3) + 'px');
    setVar(o, '--orb-halo-y', (Math.cos(phase * 2) * motion * 1.4).toFixed(3) + 'px');
    setVar(o, '--orb-halo-turn', (reduced ? 0 : Math.sin(phase) * motion * 32).toFixed(3) + 'deg');
    setVar(o, '--orb-echo-a-opacity', '0'); setVar(o, '--orb-echo-b-opacity', '0');
    o.procMix = 0; o.procOrigin = null;
    o.budget += dt;
    if (o.budget < 1 / 30) return;
    o.budget %= 1 / 30;
    o.renderer.draw({ time: o.time, energy: energy, pulse: pulse, hover: 0, reducedMotion: reduced });
  }

  function drawProcessing(o, dt) {
    if (!o.procOrigin) {
      var num = function (name, fb) { var v = parseFloat(o.wrap.style.getPropertyValue(name)); return isFinite(v) ? v : fb; };
      o.procOrigin = { scale: num('--orb-scale', .8), x: num('--orb-x', 0), y: num('--orb-y', 0), halo: num('--orb-halo-opacity', .2),
        haloScale: num('--orb-halo-scale', 1), haloX: num('--orb-halo-x', 0), haloY: num('--orb-halo-y', 0), haloTurn: num('--orb-halo-turn', 0),
        energy: o.voice, pulse: o.pulse };
      o.procClock = 0;
    }
    if (!reduced) { o.time += dt * .9; o.procClock += dt; }
    o.procMix = reduced ? 1 : approach(o.procMix, 1, .14, dt);
    var cycle = (o.procClock / 2.6) % 1;
    var charge = reduced ? .3 : Math.min(1,
      Math.pow((1 + Math.cos((cycle - .18) * TAU)) / 2, 12) + .52 * Math.pow((1 + Math.cos((cycle - .44) * TAU)) / 2, 16));
    var flare = reduced ? 0 : charge * .3;
    var from = o.procOrigin;
    var blend = function (a, b) { return a + (b - a) * o.procMix; };
    setVar(o, '--orb-scale', blend(from.scale, .89 + charge * .016).toFixed(4));
    setVar(o, '--orb-x', blend(from.x, 0).toFixed(3) + 'px');
    setVar(o, '--orb-y', blend(from.y, 0).toFixed(3) + 'px');
    setVar(o, '--orb-halo-opacity', blend(from.halo, .55 + charge * .42).toFixed(3));
    setVar(o, '--orb-halo-scale', blend(from.haloScale, 1 + charge * .17).toFixed(4));
    setVar(o, '--orb-halo-x', blend(from.haloX, 0).toFixed(3) + 'px');
    setVar(o, '--orb-halo-y', blend(from.haloY, 0).toFixed(3) + 'px');
    setVar(o, '--orb-halo-turn', blend(from.haloTurn, 0).toFixed(3) + 'deg');
    setVar(o, '--orb-processing-turn', (o.time * .31 * 180 / Math.PI).toFixed(3) + 'deg');
    ECHOES.forEach(function (e) {
      var progress = Math.min(1, ((cycle - e[1] + 1) % 1) / .6);
      var light = reduced ? 0 : Math.sin(progress * Math.PI) * (1 - progress * .4) * e[2] * o.procMix;
      setVar(o, '--orb-echo-' + e[0] + '-opacity', light.toFixed(3));
      setVar(o, '--orb-echo-' + e[0] + '-scale', (.78 + progress * .92).toFixed(4));
    });
    o.budget += dt;
    if (o.budget < 1 / 30) return;
    o.budget %= 1 / 30;
    o.renderer.draw({ time: o.time, processing: o.procMix, energy: blend(from.energy, .48 + charge * .22),
      pulse: blend(from.pulse, flare), hover: 0, reducedMotion: reduced });
  }

  function resetParticles(o) {
    o.credit = 0;
    o.particles.forEach(function (p) { p.life = 0; p.el.style.opacity = '0'; });
  }

  // Beads leave the sphere's rim while speaking, and a few small ones shed
  // from the glass while processing. Same lifetimes and easing as the app.
  function updateParticles(o, dt, state) {
    var processing = state === 'thinking';
    if ((state !== 'recording' && !processing) || reduced) { if (o.credit || o.particles.some(function (p) { return p.life; })) resetParticles(o); return; }
    var energy = processing ? .38 + .14 * Math.sin(o.procClock * Math.PI / 1.2) : o.voice;
    o.wrap.style.setProperty('--orb-energy', energy.toFixed(2));
    var emitting = processing ? o.procMix > .65 : energy > .055;
    var rate = processing ? 3.2 + energy * 2 : 4 + energy * 10 + o.pulse * 4;
    o.credit = emitting ? Math.min(2, o.credit + dt * rate) : 0;
    if (o.credit >= 1) {
      var p = null;
      for (var i = 0; i < o.particles.length; i++) if (!o.particles[i].life) { p = o.particles[i]; break; }
      if (p) {
        var serial = o.serial++;
        var fraction = (serial * .61803398875 + .17) % 1;
        // The capsule is 46px high with 23px end caps; anchors are percentages
        // of its width so they follow the width morph, as in the app.
        var edge = serial % 4;
        if (processing) {
          p.el.style.left = '28px';
          p.angle = (serial % 2 ? 0 : Math.PI) + (fraction - .5) * .9;
          p.ox = Math.cos(p.angle) * 13; p.oy = Math.sin(p.angle) * 13;
        } else if (edge < 2) {
          var along = .12 + fraction * .76;
          p.el.style.left = 'calc(' + (along * 100).toFixed(2) + '% + ' + (23 * (1 - 2 * along)).toFixed(2) + 'px)';
          p.ox = 0; p.oy = edge === 0 ? -20 : 20;
          p.angle = (edge === 0 ? -Math.PI / 2 : Math.PI / 2) + (fraction - .5) * .45;
        } else {
          p.el.style.left = edge === 2 ? '23px' : 'calc(100% - 23px)';
          p.angle = (edge === 2 ? Math.PI : 0) + (fraction - .5) * 2.1;
          p.ox = Math.cos(p.angle) * 19; p.oy = Math.sin(p.angle) * 19;
        }
        p.age = 0;
        p.life = .85 + fraction * .3;
        p.strength = processing ? .36 + energy * .2 : .28 + energy * .4 + o.pulse * .16;
        p.bend = (fraction - .5) * 3;
        // Short hops: the beads stay close to the capsule they left.
        p.travel = processing ? 9 + fraction * 3 : Math.sin(p.angle) > .3 ? 7 : 9 + fraction * 3;
        p.size = processing ? .66 + fraction * .2 : .86 + fraction * .34;
        o.credit -= 1;
      }
    }
    o.particles.forEach(function (q) {
      if (!q.life) return;
      q.age += dt;
      var progress = Math.min(1, q.age / q.life);
      if (progress >= 1) { q.life = 0; q.el.style.opacity = '0'; return; }
      var travel = q.travel * (1 - Math.pow(1 - progress, 1.5));
      var x = q.ox + Math.cos(q.angle) * travel + Math.sin(progress * Math.PI) * q.bend;
      var y = q.oy + Math.sin(q.angle) * travel;
      var light = Math.sin(Math.PI * progress) * (1 - progress * .3) * q.strength;
      var size = q.size * (1 - progress * .52);
      q.el.style.opacity = light.toFixed(3);
      q.el.style.transform = 'translate(-50%, -50%) translate(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px) scale(' + size.toFixed(3) + ')';
    });
  }

  var last = 0, frame = 0, visible = true;
  function step(o, dt) {
    var state = o.bar ? o.bar.getAttribute('data-state') : 'idle';
    o.wrap.setAttribute('data-orb', state);
    if (state === 'thinking') drawProcessing(o, dt); else drawLive(o, dt, state);
    updateParticles(o, dt, state);
  }
  function tick(now) {
    frame = 0;
    if (!visible || document.hidden) return;
    var dt = last ? Math.max(.001, Math.min(.05, (now - last) / 1000)) : 1 / 60;
    last = now;
    orbs.forEach(function (o) { step(o, dt); });
    frame = requestAnimationFrame(tick);
  }
  function wake() { if (!frame) { last = 0; frame = requestAnimationFrame(tick); } }

  if (reduced) { orbs.forEach(function (o) { step(o, 0); }); return; }
  if ('IntersectionObserver' in window) {
    var onScreen = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target); });
      visible = onScreen.size > 0;
      if (visible) wake(); else orbs.forEach(resetParticles);
    }, { threshold: 0.05 });
    wraps.forEach(function (w) { io.observe(w); });
  } else { wake(); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); else orbs.forEach(resetParticles); });
})();
