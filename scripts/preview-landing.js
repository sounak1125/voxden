'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4173;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const DEFAULT_SETTINGS = {
  dictateMode: 'toggle',
  shortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  alwaysShowFlowBar: false,
  showInTaskbar: false,
  soundsEnabled: true,
  suggestionsEnabled: true,
  contextAwareness: true,
  asrEngine: 'whisper',
  asrDevice: 'auto',
  dictationLanguage: 'en',
  appLanguage: 'en',
  microphone: 'default',
  displayName: '',
  writingStyles: {
    personal: 'veryCasual',
    work: 'casual',
    email: 'formal',
    other: 'casual',
  },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function countWords(entries) {
  let n = 0;
  for (const e of entries || []) {
    const t = String((e && e.text) || '').trim();
    if (t) n += t.split(/\s+/).length;
  }
  return n;
}

function formatShortcutLabel(accel) {
  return String(accel || 'CommandOrControl+Shift+Space')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .split('+')
    .join('+');
}

function snapshot() {
  const history = readJson(path.join(ROOT, 'data', 'history.json'), { entries: [] });
  const dictionary = readJson(path.join(ROOT, 'data', 'dictionary.json'), { phrases: [] });
  const stored = readJson(path.join(ROOT, 'data', 'settings.json'), {});
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const wordCount = countWords(entries);
  const dictLib = require('../src/dictionary');
  const metrics = require('../src/metrics');
  const understanding = dictLib.understandingState(wordCount);
  const dictationMetrics = metrics.computeMetrics(entries);
  return {
    entries,
    phrases: Array.isArray(dictionary.phrases) ? dictionary.phrases : [],
    dictateMode: settings.dictateMode === 'ptt' ? 'ptt' : 'toggle',
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    pasteLastShortcut: settings.pasteLastShortcut || 'CommandOrControl+Alt+V',
    pasteLastShortcutLabel: formatShortcutLabel(settings.pasteLastShortcut || 'CommandOrControl+Alt+V'),
    launchAtLogin: !!settings.launchAtLogin,
    alwaysShowFlowBar: !!settings.alwaysShowFlowBar,
    showInTaskbar: !!settings.showInTaskbar,
    soundsEnabled: settings.soundsEnabled !== false,
    suggestionsEnabled: settings.suggestionsEnabled !== false,
    contextAwareness: settings.contextAwareness !== false,
    asrEngine: settings.asrEngine || 'whisper',
    asrDevice: settings.asrDevice || 'auto',
    asrEngineActive: 'faster-whisper',
    asrEngineWarning: '',
    asrEngineProgress: null,
    fastEngine: '',
    fastModel: '',
    fastDevice: '',
    dictationLanguage: 'en',
    appLanguage: 'en',
    microphone: settings.microphone || 'default',
    displayName: settings.displayName || '',
    writingStyles: settings.writingStyles || DEFAULT_SETTINGS.writingStyles,
    engine: 'whisper',
    engineStatus: 'ready',
    model: 'large-v3',
    device: 'cuda',
    wordCount,
    ...dictationMetrics,
    ...understanding,
  };
}

function mockScript() {
  const data = JSON.stringify(snapshot());
  return `'use strict';
(function mockMediaDevices() {
  if (!navigator.mediaDevices) return;
  var mockDevices = [
    { deviceId: 'preview-mic-default', kind: 'audioinput', label: 'Microphone Array (Realtek Audio)', groupId: 'g1' },
    { deviceId: 'preview-mic-headset', kind: 'audioinput', label: 'USB Headset Microphone', groupId: 'g2' },
  ];
  navigator.mediaDevices.enumerateDevices = function () {
    return Promise.resolve(mockDevices);
  };
  navigator.mediaDevices.getUserMedia = function () {
    var track = {
      getSettings: function () { return { deviceId: 'preview-mic-default' }; },
      stop: function () {},
    };
    return Promise.resolve({
      getAudioTracks: function () { return [track]; },
      getTracks: function () { return [track]; },
    });
  };
})();
window.voxden = (function () {
  let payload = ${data};
  const historyCbs = [];
  function clone() { return JSON.parse(JSON.stringify(payload)); }
  function refreshMetrics() {
    if (window.voxdenMetrics) {
      Object.assign(payload, window.voxdenMetrics.computeMetrics(payload.entries || []));
    }
  }
  function emit() { refreshMetrics(); const next = clone(); historyCbs.forEach((cb) => cb(next)); }
  return {
    appReady: function () {},
    loadApp: function () { return Promise.resolve(clone()); },
    onHistory: function (cb) { historyCbs.push(cb); },
    setSettings: function (patch) {
      if (!patch || typeof patch !== 'object') return Promise.resolve(clone());
      if (patch.dictateMode === 'ptt' || patch.dictateMode === 'toggle') payload.dictateMode = patch.dictateMode;
      if (typeof patch.shortcut === 'string') {
        payload.shortcut = patch.shortcut;
        payload.shortcutLabel = patch.shortcut.replace(/CommandOrControl/g, 'Ctrl').replace(/Command/g, 'Cmd');
      }
      if (typeof patch.pasteLastShortcut === 'string') {
        payload.pasteLastShortcut = patch.pasteLastShortcut;
        payload.pasteLastShortcutLabel = patch.pasteLastShortcut.replace(/CommandOrControl/g, 'Ctrl').replace(/Command/g, 'Cmd');
      }
      var bools = ['launchAtLogin','alwaysShowFlowBar','showInTaskbar','soundsEnabled','suggestionsEnabled','contextAwareness'];
      for (var i = 0; i < bools.length; i++) {
        var k = bools[i];
        if (typeof patch[k] === 'boolean') payload[k] = patch[k];
      }
      if (patch.dictationLanguage === 'en') payload.dictationLanguage = 'en';
      if (['whisper','qwen3-asr','parakeet'].indexOf(patch.asrEngine) >= 0) {
        payload.asrEngine = patch.asrEngine;
        payload.asrEngineActive = patch.asrEngine === 'whisper' ? 'faster-whisper' : patch.asrEngine;
        payload.model = patch.asrEngine === 'qwen3-asr'
          ? 'Qwen/Qwen3-ASR-1.7B'
          : (patch.asrEngine === 'parakeet' ? 'nemo-parakeet-tdt-0.6b-v2' : 'large-v3');
        payload.engineStatus = patch.asrEngine === 'whisper' ? 'ready' : 'loading';
        payload.asrEngineProgress = patch.asrEngine === 'whisper'
          ? null
          : { phase: 'downloading', percent: 47 };
        payload.fastEngine = patch.asrEngine === 'parakeet' ? 'parakeet' : (payload.fastEngine || '');
      }
      if (['auto','cuda','cpu'].indexOf(patch.asrDevice) >= 0) {
        payload.asrDevice = patch.asrDevice;
        payload.device = patch.asrDevice === 'cpu' ? 'cpu' : 'cuda';
      }
      if (typeof patch.displayName === 'string') payload.displayName = patch.displayName.trim().slice(0, 40);
      if (typeof patch.microphone === 'string' && patch.microphone) payload.microphone = patch.microphone;
      if (patch.writingStyles && typeof patch.writingStyles === 'object') {
        payload.writingStyles = Object.assign({}, payload.writingStyles || DEFAULT_SETTINGS.writingStyles, patch.writingStyles);
      }
      return Promise.resolve(clone());
    },
    copyEntry: function () { return Promise.resolve(true); },
    deleteEntry: function (id) {
      payload.entries = payload.entries.filter(function (e) { return e.id !== id; });
      emit();
      return Promise.resolve(true);
    },
    editEntry: function (id, text) {
      var e = payload.entries.find(function (x) { return x.id === id; });
      if (!e) return Promise.resolve({ ok: false, learned: [] });
      e.text = text;
      emit();
      return Promise.resolve({ ok: true, learned: [] });
    },
    deletePhrase: function (from) {
      payload.phrases = payload.phrases.filter(function (p) { return p.from !== from; });
      emit();
      return Promise.resolve(clone());
    },
    upsertPhrase: function (from, to, meta) {
      var kind = (meta && meta.kind) || (from === to ? 'word' : 'mapping');
      var source = (meta && meta.source) || 'manual';
      payload.phrases = (payload.phrases || []).filter(function (p) {
        return String(p.from).toLowerCase() !== String(from).toLowerCase();
      });
      payload.phrases.unshift({ from: from, to: to, kind: kind, source: source });
      emit();
      return Promise.resolve({ ok: true });
    },
    overlayHold: function () {},
    overlayRelease: function () {},
    markData: function () { return Promise.resolve(null); },
  };
})();
`;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(reqPath, res) {
  const rel = decodeURIComponent(reqPath.split('?')[0]).replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, 'Not found');
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/' || url.startsWith('/?')) {
    res.writeHead(302, { Location: '/src/app.html' });
    res.end();
    return;
  }
  if (url.split('?')[0] === '/__preview-mock.js') {
    send(res, 200, mockScript(), 'application/javascript; charset=utf-8');
    return;
  }
  if (url.split('?')[0] === '/src/app.html') {
    let html = fs.readFileSync(path.join(ROOT, 'src', 'app.html'), 'utf8');
    html = html.replace(
      '<script src="app.js"></script>',
      '<script src="/__preview-mock.js"></script>\n  <script src="app.js"></script>'
    );
    send(res, 200, html, 'text/html; charset=utf-8');
    return;
  }
  serveFile(url, res);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('Voxden landing preview: http://127.0.0.1:' + PORT + '/src/app.html\n');
});
