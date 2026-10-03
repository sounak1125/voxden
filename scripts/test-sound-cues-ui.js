'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-sounds-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const deadline = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true,
    preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true } });
  win.webContents.setAudioMuted(true);
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    soundsEnabled = false;
    const output = [];
    for (const kind of ['opening', 'start', 'success', 'error']) {
      sfxCtx = new OfflineAudioContext(1, 24000, 48000);
      sfxPlayer = voxdenSounds.createPlayer(sfxCtx);
      soundsEnabled = true;
      // Offline contexts cannot resume before rendering. Exercise the same
      // scheduled buffer with launch lead-in, then verify the full waveform.
      const lead = kind === 'opening' ? .12 : 0;
      const end = kind === 'opening' ? sfxPlayer.play(kind, lead) : playCue(kind);
      const rendered = (await sfxCtx.startRendering()).getChannelData(0);
      const expected = voxdenSounds.samples(kind);
      const offset = Math.round(lead * 48000);
      output.push({ kind, end, exact: expected.every((sample, i) => sample === rendered[offset + i]),
        silentLead: rendered.slice(0, offset).every(sample => sample === 0),
        silentTail: rendered.slice(offset + expected.length).every(sample => sample === 0) });
    }
    const resampled = [];
    for (const kind of ['opening', 'start', 'success', 'error']) {
      const ctx = new OfflineAudioContext(1, 22050, 44100);
      voxdenSounds.createPlayer(ctx).play(kind);
      const data = (await ctx.startRendering()).getChannelData(0);
      const duration = voxdenSounds.DURATIONS[kind];
      resampled.push({ kind, finite: data.every(Number.isFinite),
        audible: data.slice(0, Math.floor(duration * 44100)).some(value => Math.abs(value) > .01),
        tail: data.slice(Math.ceil((duration + .01) * 44100)).every(value => value === 0) });
    }
    soundsEnabled = false;
    const muted = playCue('start');
    sfxCtx = new AudioContext();
    sfxPlayer = voxdenSounds.createPlayer(sfxCtx);
    const launchEnd = await sfxPlayer.playOpening();
    const liveOpening = sfxCtx.state === 'running' && launchEnd > sfxCtx.currentTime + .25;
    sfxPlayer.stop();
    await sfxCtx.close();
    sfxCtx = null; sfxPlayer = null;
    return { output, resampled, muted, liveOpening };
  })()`);
  assert.strictEqual(result.muted, 0);
  assert.strictEqual(result.liveOpening, true, 'real output resumes before the launch chime is scheduled');
  for (const row of result.resampled) assert(row.finite && row.audible && row.tail,
    row.kind + ' plays and ends correctly on a 44.1 kHz output');
  for (const row of result.output) {
    assert(row.exact && row.silentLead && row.silentTail, row.kind + ' renders exactly and ends on time');
    assert.strictEqual(row.end, { opening: .37, start: .08, success: .12, error: .16 }[row.kind]);
  }
  console.log('Real overlay: all four approved cues render exactly, end on time, and respect Sound off');
  clearTimeout(deadline); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
