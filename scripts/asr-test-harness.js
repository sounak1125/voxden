'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { createRequire } = require('module');
const { EventEmitter } = require('events');

module.exports = function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-lifecycle-'));
  const main = path.join(__dirname, '../src/main.js');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const launches = [];
  const timers = new Map();
  let nextTimer = 0;
  class Process extends EventEmitter {
    constructor() {
      super(); this.exitCode = null; this.signalCode = null; this.killed = false;
      this.stdout = new EventEmitter(); this.stdout.setEncoding = () => {};
      this.stderr = new EventEmitter(); this.stdin = new EventEmitter();
      this.stdin.write = () => true;
    }
    kill() {
      this.killed = true;
      queueMicrotask(() => { this.exitCode = 0; this.emit('exit', 0); });
      return true;
    }
  }
  const electron = {
    app: { isPackaged: true, setName() {}, setAppUserModelId() {},
      commandLine: { appendSwitch() {} }, getPath: () => root, getVersion: () => 'test',
      requestSingleInstanceLock: () => false, quit() {}, on() {} },
    ipcMain: { handle: (id, fn) => handlers.set(id, fn), on() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };
  const childProcess = {
    spawn: (...args) => { const proc = new Process(); launches.push({ args, proc }); return proc; },
    execFile: (...args) => { const proc = new Process(); launches.push({ args, proc, callback: args.at(-1) }); return proc; },
    execFileSync: () => '',
  };
  const context = vm.createContext({ console, Buffer, AbortController, URL,
    __dirname: path.dirname(main), module: { exports: {} },
    process: { env: {}, platform: 'win32', resourcesPath: path.join(__dirname, '..'), argv: [] },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
    require: name => name === 'electron' ? electron : name === 'child_process' ? childProcess
      : name === './updater' ? { getUpdateStatus: () => ({}) } : realRequire(name),
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(main, 'utf8'));
  run('initPaths(); loadStores();');
  return { root, handlers, launches, timers, context, Process, run,
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
};
