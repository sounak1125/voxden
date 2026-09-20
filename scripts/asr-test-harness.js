'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { createRequire } = require('module');
const { EventEmitter } = require('events');

module.exports = function harness({ dialog, shell, clipboard, createWriteStream = fs.createWriteStream } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-lifecycle-'));
  const main = path.join(__dirname, '../src/main.js');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const ipcEvents = new Map();
  const shortcuts = new Map();
  const launches = [];
  const timers = new Map();
  const logStreams = new Set();
  const fixtureFs = Object.create(fs);
  fixtureFs.createWriteStream = (...args) => {
    const stream = createWriteStream(...args);
    logStreams.add(stream);
    stream.once('close', () => logStreams.delete(stream));
    return stream;
  };
  let closing;
  let nextTimer = 0;
  class Process extends EventEmitter {
    constructor() {
      super(); this.exitCode = null; this.signalCode = null; this.killed = false;
      this.stdout = new EventEmitter(); this.stdout.setEncoding = () => {};
      this.stderr = new EventEmitter(); this.stdin = new EventEmitter();
      // What main wrote to the process, so a test can answer a long-lived
      // helper's requests in the order they were made.
      this.stdin.written = [];
      this.stdin.write = (s) => { this.stdin.written.push(String(s)); return true; };
    }
    kill() {
      if (this.killed) return false;
      this.killed = true;
      queueMicrotask(() => { this.exitCode = 0; this.emit('exit', 0); });
      return true;
    }
  }
  const electron = {
    dialog,
    shell,
    // A no-op unless a test wants to read what was copied: handlers that write
    // to the clipboard are otherwise untestable here.
    clipboard: clipboard || { writeText() {}, readText: () => '' },
    app: { isPackaged: true, setName() {}, setAppUserModelId() {},
      commandLine: { appendSwitch() {} }, getPath: () => root, getVersion: () => 'test',
      requestSingleInstanceLock: () => false, quit() {}, on() {} },
    ipcMain: { handle: (id, fn) => handlers.set(id, fn), on: (id, fn) => ipcEvents.set(id, fn) },
    globalShortcut: {
      register: (accel, fn) => { shortcuts.set(accel, fn); return true; },
      unregister: accel => shortcuts.delete(accel),
      unregisterAll: () => shortcuts.clear(),
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };
  const childProcess = {
    spawn: (...args) => { const proc = new Process(); launches.push({ args, proc }); return proc; },
    execFile: (...args) => { const proc = new Process(); launches.push({ args, proc, callback: args.at(-1) }); return proc; },
    execFileSync: () => '',
  };
  const context = vm.createContext({ console, Buffer, AbortController, URL,
    __dirname: path.dirname(main), module: { exports: {} },
    process: { env: {}, platform: 'win32', resourcesPath: path.join(__dirname, '..'), argv: [], hrtime: process.hrtime },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
    require: name => name === 'fs' ? fixtureFs : name === 'electron' ? electron : name === 'child_process' ? childProcess
      : name === './updater' ? { getUpdateStatus: () => ({}) } : realRequire(name),
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(main, 'utf8'));
  run('initPaths(); loadStores();');
  return { root, handlers, ipcEvents, shortcuts, launches, timers, context, Process, run,
    close: () => closing || (closing = (async () => {
      run("isQuitting = true; closeSidecarLog(); sidecarQueue.rejectAll(new Error('Test finished'))");
      for (const { proc } of launches) proc.kill();
      timers.clear();
      // end() does not wait for an asynchronously opened file to close. Keep
      // every stream, including logs from previous sidecars, until 'close'.
      await Promise.all([...logStreams].map(stream => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Test log did not close within 5 seconds')), 5000);
        stream.once('close', () => { clearTimeout(timeout); resolve(); });
        if (!stream.writableEnded && !stream.destroyed) stream.end();
      })));
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('voxden-lifecycle-')) throw new Error('Unsafe test cleanup path');
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })()) };
};
