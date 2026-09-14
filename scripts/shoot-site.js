'use strict';

// Full-resolution captures of the local site preview, for design review.
// Windows clamps a BrowserWindow to the screen and the DevTools full-page
// capture crashes the offscreen renderer, so the page is captured as a
// column of viewport tiles instead, scrolling between them so the reveal
// animations fire the way they do for a reader.
//
//   SHOT_OUT=<outDir> SHOT_URL=<url> [SHOT_W=1440] [SHOT_H=900] node node_modules/electron/cli.js scripts/shoot-site.js
//
// Parameters travel in the environment: Electron on Windows refuses to
// start when a URL is passed on its command line.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const outDir = process.env.SHOT_OUT || path.join(__dirname, '..', 'temp', 'site-shots');
const url = process.env.SHOT_URL || 'http://127.0.0.1:4174/';
const width = Number(process.env.SHOT_W) || 1440;
const height = Number(process.env.SHOT_H) || 900;
const logFile = path.join(outDir, 'shoot-site.log');
const log = (line) => { try { fs.mkdirSync(outDir, { recursive: true }); fs.appendFileSync(logFile, line + '\n'); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('uncaughtException', (err) => { log('uncaught: ' + (err && err.stack || err)); app.exit(1); });

app.setPath('userData', path.join(app.getPath('temp'), 'voxden-site-shots'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width, height, show: false, frame: false, useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(30);
    await win.loadURL(url);
    await sleep(2500);
    const docHeight = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
    const name = url.replace(/^https?:\/\/[^/]+\/?/, '').replace(/[^a-z0-9]+/gi, '-') || 'home';
    fs.mkdirSync(outDir, { recursive: true });
    const tiles = Math.min(12, Math.ceil(docHeight / height));
    for (let i = 0; i < tiles; i++) {
      const y = Math.min(i * height, Math.max(0, docHeight - height));
      await win.webContents.executeJavaScript('window.scrollTo({top:' + y + ',behavior:"instant"})');
      await sleep(i === 0 ? 2500 : 1400);
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, name + '-' + width + '-' + String(i + 1).padStart(2, '0') + '.png');
      fs.writeFileSync(file, image.toPNG());
      const size = image.getSize();
      log(file + ' ' + size.width + 'x' + size.height + ' at y=' + y + ' of ' + docHeight);
    }
    process.stdout.write(tiles + ' tiles of ' + name + ' (' + docHeight + 'px)\n');
  } catch (err) {
    log('failed: ' + (err && err.stack || err));
  }
  app.exit(0);
});
