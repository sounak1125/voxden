'use strict';

const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allocatePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && address.port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

class LocalRewriteRuntime {
  constructor(options) {
    const opts = options || {};
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.spawn = opts.spawnImpl || spawn;
    this.host = '127.0.0.1';
    this.startTimeoutMs = Number(opts.startTimeoutMs) || 90000;
    this.logPath = opts.logPath || null;
    this.process = null;
    this.packId = null;
    this.endpoint = null;
    this.apiKey = null;
    this.starting = null;
  }

  async healthy(endpoint, apiKey) {
    if (typeof this.fetch !== 'function' || !endpoint) return false;
    try {
      const response = await this.fetch(endpoint.replace(/\/v1\/chat\/completions$/, '/health'), {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : undefined,
        signal: AbortSignal.timeout(1500),
      });
      return !!response && response.ok;
    } catch (_) {
      return false;
    }
  }

  async ensureStarted(installedPack) {
    if (!installedPack || !installedPack.runtimePath || !installedPack.modelPath) {
      throw new Error('Download a language pack first.');
    }
    if (this.process && this.packId === installedPack.packId && await this.healthy(this.endpoint, this.apiKey)) {
      return { endpoint: this.endpoint, model: installedPack.modelAlias || 'voxden-local', apiKey: this.apiKey };
    }
    if (this.starting) return this.starting;
    this.starting = this.start(installedPack).finally(() => { this.starting = null; });
    return this.starting;
  }

  async start(installedPack) {
    await this.stop();
    if (!fs.existsSync(installedPack.runtimePath) || !fs.existsSync(installedPack.modelPath)) {
      throw new Error('The installed language pack is incomplete.');
    }
    const port = await allocatePort(this.host);
    const endpoint = 'http://' + this.host + ':' + port + '/v1/chat/completions';
    const apiKey = crypto.randomBytes(24).toString('hex');
    const cpuCount = Math.max(1, Math.min(12, (os.cpus() || []).length - 1));
    const args = [
      '--model', installedPack.modelPath,
      '--host', this.host,
      '--port', String(port),
      '--ctx-size', '2048',
      '--threads', String(cpuCount),
      '--api-key', apiKey,
    ];
    let logFd = null;
    let stdio = ['ignore', 'ignore', 'ignore'];
    if (this.logPath) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      logFd = fs.openSync(this.logPath, 'a');
      stdio = ['ignore', logFd, logFd];
    }
    let child;
    try {
      child = this.spawn(installedPack.runtimePath, args, {
        cwd: installedPack.runtimeDir || path.dirname(installedPack.runtimePath),
        windowsHide: true,
        stdio,
        env: Object.assign({}, process.env, { LLAMA_ARG_HOST: this.host }),
      });
    } finally {
      if (logFd !== null) fs.closeSync(logFd);
    }
    this.process = child;
    this.packId = installedPack.packId;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    let exited = false;
    child.once('exit', () => {
      exited = true;
      if (this.process === child) {
        this.process = null;
        this.endpoint = null;
        this.apiKey = null;
        this.packId = null;
      }
    });
    child.once('error', () => { exited = true; });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) break;
      if (await this.healthy(endpoint, apiKey)) {
        return { endpoint, model: installedPack.modelAlias || 'voxden-local', apiKey };
      }
      await delay(350);
    }
    await this.stop();
    throw new Error(exited
      ? 'The local correction runtime could not start.'
      : 'The local correction model took too long to load.');
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.endpoint = null;
    this.apiKey = null;
    this.packId = null;
    if (!child) return;
    try { child.kill(); } catch (_) {}
  }
}

module.exports = { LocalRewriteRuntime, allocatePort };
