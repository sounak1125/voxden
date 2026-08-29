'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const fsPromises = fs.promises;
const DEFAULT_REPOSITORY = 'sounak1125/voxden';
const DEFAULT_RELEASE_TAG = 'language-packs-v1';
const MANIFEST_ASSET = 'voxden-language-packs.json';
const RECEIPT_SCHEMA = 1;

const PACK_CATALOG = Object.freeze({
  standard: Object.freeze({
    tier: 'standard',
    name: 'Standard',
    description: 'Faster',
    advertisedBytes: 1.4 * 1000 * 1000 * 1000,
    advertisedSize: '1.4 GB',
  }),
  enhanced: Object.freeze({
    tier: 'enhanced',
    name: 'Enhanced',
    description: 'Better quality',
    advertisedBytes: 2.5 * 1000 * 1000 * 1000,
    advertisedSize: '2.5 GB',
  }),
});

class LanguagePackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LanguagePackError';
    this.code = code || 'LANGUAGE_PACK_ERROR';
  }
}

class DownloadCancelledError extends LanguagePackError {
  constructor() {
    super('Language pack download cancelled. The partial download was kept so it can resume later.', 'CANCELLED');
    this.name = 'DownloadCancelledError';
  }
}

function normalizeTier(value) {
  return value === 'enhanced' ? 'enhanced' : 'standard';
}

function parseDigest(value) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(value || '').trim());
  return match ? match[1].toLowerCase() : null;
}

function normalizeSha256(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

function safeName(value, label) {
  const raw = String(value || '').trim();
  if (!raw || raw !== path.basename(raw) || raw === '.' || raw === '..' || /[\\/]/.test(raw)) {
    throw new LanguagePackError('Invalid ' + label + ' in the language-pack manifest.', 'INVALID_MANIFEST');
  }
  return raw;
}

function safeId(value, label) {
  const raw = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(raw)) {
    throw new LanguagePackError('Invalid ' + label + ' in the language-pack manifest.', 'INVALID_MANIFEST');
  }
  return raw;
}

function isInside(parent, candidate) {
  const root = path.resolve(parent).toLowerCase();
  const target = path.resolve(candidate).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.partial';
  await fsPromises.writeFile(temporary, JSON.stringify(value, null, 2));
  await fsPromises.rm(filePath, { force: true });
  await fsPromises.rename(temporary, filePath);
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function statMatches(filePath, expected) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (Number.isFinite(expected.size) && stat.size !== expected.size) return false;
    if (Number.isFinite(expected.verifiedMtimeMs)
        && Math.abs(stat.mtimeMs - expected.verifiedMtimeMs) > 2) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function friendlyFetchError(err) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError();
  }
  if (err instanceof LanguagePackError) return err;
  return new LanguagePackError(
    'Could not reach the Voxden language-pack release on GitHub. Check the connection and try again.',
    'NETWORK_ERROR'
  );
}

class LanguagePackManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('LanguagePackManager requires a persistent root directory.');
    this.root = path.resolve(opts.root);
    this.repository = String(opts.repository || DEFAULT_REPOSITORY);
    this.releaseTag = String(opts.releaseTag || DEFAULT_RELEASE_TAG);
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.releaseApiUrl = opts.releaseApiUrl
      || 'https://api.github.com/repos/' + this.repository + '/releases/tags/' + encodeURIComponent(this.releaseTag);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.abortController = null;
    this.segmentSize = Number.isFinite(opts.segmentSize)
      ? Math.max(0, Math.floor(opts.segmentSize))
      : 32 * 1024 * 1024;
    this.segmentThreshold = Number.isFinite(opts.segmentThreshold)
      ? Math.max(0, Math.floor(opts.segmentThreshold))
      : 64 * 1024 * 1024;
    this.segmentConcurrency = Number.isFinite(opts.segmentConcurrency)
      ? Math.max(1, Math.floor(opts.segmentConcurrency))
      : 4;
    this.segmentStateQueue = Promise.resolve();
  }

  receiptPath(tier) {
    return path.join(this.root, 'current-' + normalizeTier(tier) + '.json');
  }

  packDir(packId) {
    return path.join(this.root, 'packs', safeId(packId, 'pack id'));
  }

  runtimeDir(runtimeId) {
    return path.join(this.root, 'runtime', safeId(runtimeId, 'runtime id'));
  }

  installed(tier) {
    const selected = normalizeTier(tier);
    const receipt = readJsonSync(this.receiptPath(selected));
    if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA || receipt.tier !== selected) return null;
    if (!receipt.packId || !receipt.model || !receipt.runtime) return null;
    const modelPath = path.resolve(this.root, receipt.model.path || '');
    const runtimePath = path.resolve(this.root, receipt.runtime.executablePath || '');
    if (!isInside(this.root, modelPath) || !isInside(this.root, runtimePath)) return null;
    if (!statMatches(modelPath, receipt.model)) return null;
    if (!statMatches(runtimePath, receipt.runtime.executable)) return null;
    for (const file of receipt.runtime.files || []) {
      const absolute = path.resolve(this.root, file.path || '');
      if (!isInside(this.root, absolute) || !statMatches(absolute, file)) return null;
    }
    return {
      tier: selected,
      packId: receipt.packId,
      packVersion: receipt.packVersion,
      displayName: receipt.displayName || PACK_CATALOG[selected].name,
      modelPath,
      runtimePath,
      runtimeDir: path.dirname(runtimePath),
      modelAlias: receipt.modelAlias || 'voxden-' + selected,
      installedAt: receipt.installedAt,
      receipt,
    };
  }

  snapshot(selectedTier) {
    const selected = normalizeTier(selectedTier);
    const packs = {};
    for (const tier of Object.keys(PACK_CATALOG)) {
      const installed = this.installed(tier);
      packs[tier] = Object.assign({}, PACK_CATALOG[tier], {
        installed: !!installed,
        packId: installed ? installed.packId : null,
        packVersion: installed ? installed.packVersion : null,
        installedAt: installed ? installed.installedAt : null,
      });
    }
    return { selected, root: this.root, packs };
  }

  cancel() {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async fetchRelease(signal) {
    if (typeof this.fetch !== 'function') {
      throw new LanguagePackError('Downloads are unavailable in this build.', 'NO_FETCH');
    }
    const response = await this.fetch(this.releaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Voxden-Language-Packs',
      },
      signal,
    });
    if (response && response.status === 404) {
      throw new LanguagePackError(
        'The Voxden language-pack release has not been published yet.',
        'RELEASE_NOT_FOUND'
      );
    }
    if (!response || !response.ok) {
      throw new LanguagePackError('GitHub could not provide the language-pack release.', 'RELEASE_UNAVAILABLE');
    }
    const release = await response.json();
    if (!release || !Array.isArray(release.assets)) {
      throw new LanguagePackError('GitHub returned an invalid language-pack release.', 'INVALID_RELEASE');
    }
    return release;
  }

  async fetchSmallAsset(asset, signal) {
    const response = await this.fetch(asset.browser_download_url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Voxden-Language-Packs' },
      signal,
    });
    if (!response || !response.ok) {
      throw new LanguagePackError('Could not download the language-pack manifest.', 'MANIFEST_UNAVAILABLE');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1024 * 1024) {
      throw new LanguagePackError('The language-pack manifest is unexpectedly large.', 'INVALID_MANIFEST');
    }
    const expected = parseDigest(asset.digest);
    if (expected && sha256Buffer(buffer) !== expected) {
      throw new LanguagePackError('The language-pack manifest failed verification.', 'CHECKSUM_MISMATCH');
    }
    return buffer;
  }

  validateManifest(raw, release) {
    if (!raw || raw.schemaVersion !== 1 || !raw.runtime || !raw.packs) {
      throw new LanguagePackError('The language-pack manifest format is not supported.', 'INVALID_MANIFEST');
    }
    const releaseAssets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const normalizeFile = (entry, label) => {
      const item = typeof entry === 'string' ? { asset: entry } : Object.assign({}, entry);
      item.asset = safeName(item.asset, label + ' asset');
      item.path = safeName(item.path || item.asset, label + ' destination');
      const releaseAsset = releaseAssets.get(item.asset);
      if (!releaseAsset || !releaseAsset.browser_download_url) {
        throw new LanguagePackError('Release asset “' + item.asset + '” is missing.', 'ASSET_MISSING');
      }
      item.url = releaseAsset.browser_download_url;
      item.size = Number(releaseAsset.size || item.size);
      item.sha256 = parseDigest(releaseAsset.digest) || normalizeSha256(item.sha256);
      if (!Number.isSafeInteger(item.size) || item.size < 1 || !item.sha256) {
        throw new LanguagePackError('Release asset “' + item.asset + '” has no verifiable size or SHA-256 digest.', 'INVALID_ASSET');
      }
      return item;
    };

    const runtime = {
      id: safeId(raw.runtime.id, 'runtime id'),
      executable: safeName(raw.runtime.executable || 'llama-server.exe', 'runtime executable'),
      files: Array.isArray(raw.runtime.files)
        ? raw.runtime.files.map((entry) => normalizeFile(entry, 'runtime'))
        : [],
    };
    if (!runtime.files.some((file) => file.path === runtime.executable)) {
      throw new LanguagePackError('The runtime executable is not present in the manifest.', 'INVALID_MANIFEST');
    }

    const packs = {};
    for (const tier of Object.keys(PACK_CATALOG)) {
      const rawPack = raw.packs[tier];
      if (!rawPack || !Array.isArray(rawPack.parts) || rawPack.parts.length < 1) {
        throw new LanguagePackError('The ' + tier + ' language pack is missing from the manifest.', 'INVALID_MANIFEST');
      }
      packs[tier] = {
        tier,
        id: safeId(rawPack.id, tier + ' pack id'),
        version: Number.isSafeInteger(rawPack.version) ? rawPack.version : 1,
        displayName: String(rawPack.displayName || PACK_CATALOG[tier].name).slice(0, 80),
        modelAlias: safeId(rawPack.modelAlias || 'voxden-' + tier, tier + ' model alias'),
        modelFile: safeName(rawPack.modelFile || ('voxden-' + tier + '.gguf'), tier + ' model file'),
        modelSize: Number(rawPack.modelSize),
        modelSha256: normalizeSha256(rawPack.modelSha256),
        parts: rawPack.parts.map((entry) => normalizeFile(entry, tier + ' model')),
      };
      const combinedSize = packs[tier].parts.reduce((sum, part) => sum + part.size, 0);
      if (!Number.isSafeInteger(packs[tier].modelSize) || packs[tier].modelSize < 1) {
        packs[tier].modelSize = combinedSize;
      }
      if (!packs[tier].modelSha256 && packs[tier].parts.length === 1) {
        packs[tier].modelSha256 = packs[tier].parts[0].sha256;
      }
      if (!packs[tier].modelSha256) {
        throw new LanguagePackError('The assembled ' + tier + ' model has no SHA-256 digest.', 'INVALID_MANIFEST');
      }
    }
    return { runtime, packs };
  }

  async getManifest(signal) {
    const release = await this.fetchRelease(signal);
    const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_ASSET);
    if (!manifestAsset) {
      throw new LanguagePackError('The GitHub release is missing ' + MANIFEST_ASSET + '.', 'MANIFEST_MISSING');
    }
    const bytes = await this.fetchSmallAsset(manifestAsset, signal);
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new LanguagePackError('The language-pack manifest contains invalid JSON.', 'INVALID_MANIFEST');
    }
    return this.validateManifest(raw, release);
  }

  async verifyFile(filePath, expected) {
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (_) {
      return null;
    }
    if (!stat.isFile() || stat.size !== expected.size) return null;
    const digest = await sha256File(filePath);
    if (digest !== expected.sha256) return null;
    return { size: stat.size, sha256: digest, verifiedMtimeMs: stat.mtimeMs };
  }

  // The release CDN gives a single connection roughly a fifth of the bandwidth
  // this link can carry, so large assets are pulled as concurrent byte ranges
  // written straight into their final offsets.
  saveSegmentState(statePath, payload) {
    this.segmentStateQueue = this.segmentStateQueue
      .then(() => fsPromises.writeFile(statePath, JSON.stringify(payload)))
      .catch(() => {});
    return this.segmentStateQueue;
  }

  async loadSegmentState(statePath, asset, count) {
    const saved = await readJson(statePath);
    if (!saved || saved.size !== asset.size || saved.sha256 !== asset.sha256) return new Set();
    if (!Array.isArray(saved.done)) return new Set();
    return new Set(saved.done.filter((index) => Number.isInteger(index) && index >= 0 && index < count));
  }

  async downloadInSegments(asset, destination, partial, opts) {
    const signal = opts.signal;
    const count = Math.ceil(asset.size / this.segmentSize);
    const segments = [];
    for (let index = 0; index < count; index += 1) {
      const start = index * this.segmentSize;
      segments.push({ index, start, end: Math.min(asset.size, start + this.segmentSize) - 1 });
    }

    const statePath = partial + '.segments';
    const done = await this.loadSegmentState(statePath, asset, count);
    let existingBytes = 0;
    try {
      const stat = await fsPromises.stat(partial);
      if (stat.isFile()) existingBytes = stat.size;
    } catch (_) {
      const handle = await fsPromises.open(partial, 'w');
      await handle.close();
    }
    // A partial left by the single-connection downloader holds good bytes from
    // zero up to its length, so keep whichever segments it already covers.
    if (done.size === 0 && existingBytes > 0 && existingBytes < asset.size) {
      for (const segment of segments) {
        if (segment.end < existingBytes) done.add(segment.index);
      }
    }
    await fsPromises.truncate(partial, asset.size);

    let received = 0;
    for (const segment of segments) {
      if (done.has(segment.index)) received += segment.end - segment.start + 1;
    }
    if (opts.onBytes) opts.onBytes(received, asset.size);

    const pending = segments.filter((segment) => !done.has(segment.index));
    let cursor = 0;
    let failure = null;

    const fetchSegment = async (segment) => {
      const response = await this.fetch(asset.url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'Voxden-Language-Packs',
          Range: 'bytes=' + segment.start + '-' + segment.end,
        },
        signal,
      });
      if (signal && signal.aborted) throw new DownloadCancelledError();
      if (!response || !response.body || response.status !== 206) {
        throw new LanguagePackError('The download server ignored a range request.', 'RANGE_UNSUPPORTED');
      }
      const output = fs.createWriteStream(partial, { flags: 'r+', start: segment.start });
      const input = Readable.fromWeb(response.body);
      input.on('data', (chunk) => {
        received += chunk.length;
        if (opts.onBytes) opts.onBytes(Math.min(received, asset.size), asset.size);
      });
      await pipeline(input, output, { signal });
      done.add(segment.index);
      await this.saveSegmentState(statePath, {
        size: asset.size,
        sha256: asset.sha256,
        done: Array.from(done),
      });
    };

    const worker = async () => {
      while (!failure && cursor < pending.length) {
        if (signal && signal.aborted) {
          failure = new DownloadCancelledError();
          break;
        }
        const segment = pending[cursor];
        cursor += 1;
        try {
          await fetchSegment(segment);
        } catch (err) {
          failure = failure || err;
        }
      }
    };

    const lanes = Math.max(1, Math.min(this.segmentConcurrency, pending.length));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    if (failure) throw failure;

    const verified = await this.verifyFile(partial, asset);
    if (!verified) {
      throw new LanguagePackError('“' + asset.asset + '” failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    await fsPromises.rm(statePath, { force: true });
    return verified;
  }

  async downloadAsset(asset, destination, options) {
    const opts = options || {};
    const signal = opts.signal;
    const existing = await this.verifyFile(destination, asset);
    if (existing) {
      if (opts.onBytes) opts.onBytes(asset.size, asset.size);
      return existing;
    }

    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    const partial = destination + '.partial';
    if (this.segmentSize > 0 && this.segmentConcurrency > 1 && asset.size >= this.segmentThreshold) {
      try {
        return await this.downloadInSegments(asset, destination, partial, opts);
      } catch (err) {
        if (err instanceof DownloadCancelledError) throw err;
        if (!(err instanceof LanguagePackError) || err.code !== 'RANGE_UNSUPPORTED') throw err;
        await fsPromises.rm(partial, { force: true });
        await fsPromises.rm(partial + '.segments', { force: true });
      }
    }
    let offset = 0;
    try {
      const stat = await fsPromises.stat(partial);
      if (stat.isFile() && stat.size <= asset.size) offset = stat.size;
    } catch (_) {}
    if (offset === asset.size) {
      const completePartial = await this.verifyFile(partial, asset);
      if (completePartial) {
        await fsPromises.rename(partial, destination);
        if (opts.onBytes) opts.onBytes(asset.size, asset.size);
        return completePartial;
      }
      await fsPromises.truncate(partial, 0);
      offset = 0;
    }
    if (opts.onBytes) opts.onBytes(offset, asset.size);

    const headers = { Accept: 'application/octet-stream', 'User-Agent': 'Voxden-Language-Packs' };
    if (offset > 0) headers.Range = 'bytes=' + offset + '-';
    let response = await this.fetch(asset.url, { headers, signal });
    if (signal && signal.aborted) throw new DownloadCancelledError();
    if (offset > 0 && response && response.status === 416) {
      await fsPromises.truncate(partial, 0);
      offset = 0;
      delete headers.Range;
      response = await this.fetch(asset.url, { headers, signal });
    }
    if (!response || !response.ok || !response.body) {
      throw new LanguagePackError('Could not download “' + asset.asset + '”.', 'DOWNLOAD_FAILED');
    }
    const append = offset > 0 && response.status === 206;
    if (!append) offset = 0;
    const output = fs.createWriteStream(partial, { flags: append ? 'a' : 'w' });
    let received = offset;
    const input = Readable.fromWeb(response.body);
    input.on('data', (chunk) => {
      received += chunk.length;
      if (opts.onBytes) opts.onBytes(received, asset.size);
    });
    try {
      await pipeline(input, output, { signal });
    } catch (err) {
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) throw new DownloadCancelledError();
      throw err;
    }
    const verified = await this.verifyFile(partial, asset);
    if (!verified) {
      throw new LanguagePackError('“' + asset.asset + '” failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    return verified;
  }

  async assembleModel(pack, partFiles, destination, signal) {
    const expected = { size: pack.modelSize, sha256: pack.modelSha256 };
    const alreadyInstalled = await this.verifyFile(destination, expected);
    if (alreadyInstalled) return alreadyInstalled;
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    if (partFiles.length === 1) {
      const verifiedPart = await this.verifyFile(partFiles[0], expected);
      if (!verifiedPart) {
        throw new LanguagePackError('The downloaded language model failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
      }
      await fsPromises.rm(destination, { force: true });
      await fsPromises.rename(partFiles[0], destination);
      return verifiedPart;
    }
    const partial = destination + '.partial';
    await fsPromises.rm(partial, { force: true });
    const output = fs.createWriteStream(partial, { flags: 'w' });
    try {
      for (const filePath of partFiles) {
        if (signal && signal.aborted) throw new DownloadCancelledError();
        await pipeline(fs.createReadStream(filePath), output, { end: false, signal });
      }
      await new Promise((resolve, reject) => {
        output.end(resolve);
        output.once('error', reject);
      });
    } catch (err) {
      output.destroy();
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) throw new DownloadCancelledError();
      throw err;
    }
    const verified = await this.verifyFile(partial, expected);
    if (!verified) {
      throw new LanguagePackError('The assembled language model failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    return verified;
  }

  async install(tier) {
    const selected = normalizeTier(tier);
    if (this.abortController) {
      throw new LanguagePackError('Another language pack is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    try {
      await fsPromises.mkdir(this.root, { recursive: true });
      this.onProgress({ status: 'preparing', tier: selected, progress: 0, message: 'Checking the GitHub release…' });
      const manifest = await this.getManifest(signal);
      const pack = manifest.packs[selected];
      const current = this.installed(selected);
      if (current && current.packId === pack.id && current.receipt.runtime.id === manifest.runtime.id) {
        this.onProgress({ status: 'installed', tier: selected, progress: 100, message: pack.displayName + ' is already installed.' });
        return { installed: current, reused: true };
      }

      const allAssets = manifest.runtime.files.concat(pack.parts);
      const totalBytes = allAssets.reduce((sum, asset) => sum + asset.size, 0);
      let completedBytes = 0;
      const report = (asset, currentBytes) => {
        const downloaded = Math.min(totalBytes, completedBytes + currentBytes);
        const progress = totalBytes > 0 ? Math.floor((downloaded / totalBytes) * 100) : 0;
        this.onProgress({
          status: 'downloading',
          tier: selected,
          progress,
          downloadedBytes: downloaded,
          totalBytes,
          message: 'Downloading ' + pack.displayName + '…',
          asset: asset.asset,
        });
      };

      const runtimeDir = this.runtimeDir(manifest.runtime.id);
      const runtimeRecords = [];
      for (const asset of manifest.runtime.files) {
        const destination = path.join(runtimeDir, asset.path);
        const verified = await this.downloadAsset(asset, destination, {
          signal,
          onBytes: (bytes) => report(asset, bytes),
        });
        completedBytes += asset.size;
        runtimeRecords.push({
          path: path.relative(this.root, destination),
          size: verified.size,
          sha256: verified.sha256,
          verifiedMtimeMs: verified.verifiedMtimeMs,
        });
      }

      const stagingDir = path.join(this.root, 'downloads', pack.id);
      const partFiles = [];
      for (const asset of pack.parts) {
        const destination = path.join(stagingDir, asset.asset);
        await this.downloadAsset(asset, destination, {
          signal,
          onBytes: (bytes) => report(asset, bytes),
        });
        completedBytes += asset.size;
        partFiles.push(destination);
      }

      this.onProgress({ status: 'verifying', tier: selected, progress: 99, message: 'Verifying ' + pack.displayName + '…' });
      const modelPath = path.join(this.packDir(pack.id), pack.modelFile);
      const modelVerified = await this.assembleModel(pack, partFiles, modelPath, signal);
      const runtimeExecutable = path.join(runtimeDir, manifest.runtime.executable);
      const executableRecord = runtimeRecords.find((record) => path.resolve(this.root, record.path) === runtimeExecutable);
      if (!executableRecord) {
        throw new LanguagePackError('The local correction runtime is incomplete.', 'RUNTIME_INCOMPLETE');
      }

      const receipt = {
        schemaVersion: RECEIPT_SCHEMA,
        tier: selected,
        packId: pack.id,
        packVersion: pack.version,
        displayName: pack.displayName,
        modelAlias: pack.modelAlias,
        installedAt: new Date().toISOString(),
        releaseTag: this.releaseTag,
        model: {
          path: path.relative(this.root, modelPath),
          size: modelVerified.size,
          sha256: modelVerified.sha256,
          verifiedMtimeMs: modelVerified.verifiedMtimeMs,
        },
        runtime: {
          id: manifest.runtime.id,
          executablePath: path.relative(this.root, runtimeExecutable),
          executable: executableRecord,
          files: runtimeRecords,
        },
      };
      await writeJsonAtomic(this.receiptPath(selected), receipt);
      await fsPromises.rm(stagingDir, { recursive: true, force: true });
      const installed = this.installed(selected);
      if (!installed) throw new LanguagePackError('The installed language pack could not be opened.', 'INSTALL_FAILED');
      this.onProgress({ status: 'installed', tier: selected, progress: 100, message: pack.displayName + ' is installed and ready.' });
      return { installed, reused: false };
    } catch (err) {
      throw friendlyFetchError(err);
    } finally {
      this.abortController = null;
    }
  }

  async remove(tier) {
    const selected = normalizeTier(tier);
    const receiptPath = this.receiptPath(selected);
    const receipt = await readJson(receiptPath);
    if (!receipt) return false;
    const packPath = this.packDir(receipt.packId);
    const packsRoot = path.join(this.root, 'packs');
    if (!isInside(packsRoot, packPath) || path.resolve(packPath) === path.resolve(packsRoot)) {
      throw new LanguagePackError('Refusing to remove an unsafe model path.', 'UNSAFE_PATH');
    }
    await fsPromises.rm(packPath, { recursive: true, force: true });
    await fsPromises.rm(path.join(this.root, 'downloads', safeId(receipt.packId, 'pack id')), {
      recursive: true,
      force: true,
    });
    await fsPromises.rm(receiptPath, { force: true });
    return true;
  }
}

module.exports = {
  DEFAULT_REPOSITORY,
  DEFAULT_RELEASE_TAG,
  MANIFEST_ASSET,
  PACK_CATALOG,
  LanguagePackError,
  DownloadCancelledError,
  LanguagePackManager,
  normalizeTier,
  normalizeSha256,
  parseDigest,
  sha256File,
};
