'use strict';

// The approved Soft Glass previews, synthesized locally once per context.
// Fixed 48 kHz PCM reproduces the previews without file loading or decoding
// on the recording path. Levels are +3 dB RMS over the original cues.
(function (root) {
  const RATE = 48000;
  const DURATIONS = { opening: .25, start: .08, success: .12, error: .16 };
  const LEVELS = { opening: .019308395411144607, start: .019364558282996283,
    success: .019308395411144607, error: .027316689172752314 };

  function samples(kind) {
    if (!Object.prototype.hasOwnProperty.call(DURATIONS, kind)) return null;
    const data = new Float64Array(Math.round(DURATIONS[kind] * RATE));
    function tone(offset, duration, frequency, strength = 1, endFrequency = frequency) {
      const start = Math.round(offset * RATE), count = Math.round(duration * RATE);
      let phase = 0;
      for (let i = 0; i < count && start + i < data.length; i++) {
        const t = i / RATE, progress = t / duration;
        const attack = Math.min(1, t / .004), tail = Math.min(1, (duration - t) / .009);
        const env = Math.sin(attack * Math.PI / 2) ** 2 * Math.exp(-4.8 * progress) * tail * tail;
        phase += 2 * Math.PI * (frequency + (endFrequency - frequency) * progress) / RATE;
        const wave = Math.sin(phase) + .18 * Math.sin(phase * 2.01) * Math.exp(-7 * progress);
        data[start + i] += wave * env * strength;
      }
    }
    if (kind === 'opening') {
      tone(0, .105, 660, .8); tone(.065, .11, 825, .85); tone(.13, .12, 990);
    } else if (kind === 'start') tone(0, .08, 660, 1, 660 * 1.08);
    else if (kind === 'success') { tone(0, .07, 825, .75); tone(.045, .075, 990); }
    else { tone(0, .075, 660 * .72, 1, 660 * .66); tone(.075, .085, 660 * .54, .8); }
    let sum = 0, peak = 0;
    for (const value of data) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
    const scale = Math.min(LEVELS[kind] / Math.sqrt(sum / data.length), .16 / peak);
    return Float32Array.from(data, value => Math.round(value * scale * 32767) / 32768);
  }

  function createPlayer(ctx) {
    const buffers = new Map();
    for (const kind of Object.keys(DURATIONS)) {
      const pcm = samples(kind);
      const buffer = ctx.createBuffer(1, pcm.length, RATE);
      buffer.copyToChannel(pcm, 0);
      buffers.set(kind, buffer);
    }
    let active = null;
    let generation = 0;
    function stop() {
      generation++;
      if (!active) return;
      try { active.stop(); } catch (_) {}
      active.disconnect();
      active = null;
    }
    function play(kind, lead = 0) {
      const buffer = buffers.get(kind);
      if (!buffer || ctx.state === 'closed') return 0;
      stop(); // Opening and success must never bleed into a new recording.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const now = ctx.currentTime + lead;
      active = source;
      source.onended = () => { source.disconnect(); if (active === source) active = null; };
      source.start(now);
      return now + buffer.duration;
    }
    async function playOpening() {
      stop();
      const requested = generation;
      try {
        // A fresh output may still be opening. Only the launch chime waits;
        // a dictation cue keeps its original immediate, 80 ms schedule.
        if (ctx.state !== 'running') await ctx.resume();
        if (requested !== generation || ctx.state !== 'running') return 0;
        const latency = Math.max(0, Number(ctx.baseLatency) || 0)
          + Math.max(0, Number(ctx.outputLatency) || 0);
        return play('opening', Math.min(.3, Math.max(.12, latency + .02)));
      } catch (_) { return 0; }
    }
    return { stop, play, playOpening };
  }
  const api = { samples, createPlayer, RATE, DURATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voxdenSounds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
