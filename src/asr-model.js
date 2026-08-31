'use strict';

// Installs the Whisper weights.
//
// faster-whisper would fetch these from Hugging Face on the first dictation,
// which puts the last and largest step of a new user's first run on a service
// we do not control and cannot verify. Hosting them alongside everything else
// means the whole first run comes from one release, over the same resumable,
// digest-checked transport, and works on a network where Hugging Face does not.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  ReleaseError,
  DownloadCancelledError,
  ReleaseDownloader,
  isInside,
  safeName,
  safeId,
  readJson,
  readJsonSync,
  writeJsonAtomic,
  statMatches,
} = require('./release-download');

const fsPromises = fs.promises;

const DEFAULT_REPOSITORY = 'sounak1125/voxden';
const DEFAULT_RELEASE_TAG = 'asr-model-v1';
const MANIFEST_ASSET = 'voxden-asr-model.json';
const RECEIPT_SCHEMA = 1;

const ADVERTISED = Object.freeze({
  name: 'Whisper large-v3',
  downloadBytes: 3.1 * 1000 * 1000 * 1000,
  downloadSize: '3.1 GB',
});

function friendlyFetchError(err) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError('Speech model');
  }
  if (err instanceof ReleaseError) return err;
  if (err && err.code === 'ENOSPC') return new ReleaseError('There is not enough free disk space for the speech model.', 'DISK_FULL');
  return new ReleaseError(
    'Could not reach the Voxden speech-model release on GitHub. Check the connection and try again.',
    'NETWORK_ERROR'
  );
}

class AsrModelManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('AsrModelManager requires a persistent root directory.');
    this.root = path.resolve(opts.root);
    this.cacheRoot = opts.cacheRoot || null;
    this.repository = String(opts.repository || DEFAULT_REPOSITORY);
    this.releaseTag = String(opts.releaseTag || DEFAULT_RELEASE_TAG);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.abortController = null;
    this.downloader = new ReleaseDownloader({
      repository: this.repository,
      releaseTag: this.releaseTag,
      releaseApiUrl: opts.releaseApiUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: 'Voxden-Asr-Model',
      cancelLabel: 'Speech model',
      segmentSize: opts.segmentSize,
      segmentThreshold: opts.segmentThreshold,
      segmentConcurrency: opts.segmentConcurrency,
    });
  }

  receiptPath() {
    return path.join(this.root, 'current-model.json');
  }

  modelDir(id) {
    return path.join(this.root, safeId(id || 'model', 'model id'));
  }

  /**
   * The installed model directory, or null. This runs on every snapshot, so it
   * stats the files rather than re-hashing three gigabytes.
   */
  installed() {
    const receipt = readJsonSync(this.receiptPath());
    if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA || !receipt.id
      || !Array.isArray(receipt.files) || !receipt.files.length) return null;
    const dir = path.resolve(this.root, receipt.dir || '');
    if (!isInside(this.root, dir) || dir === this.root || !fs.existsSync(dir)) return null;
    for (const file of receipt.files || []) {
      const absolute = path.resolve(this.root, file.path || '');
      if (!isInside(this.root, absolute) || !statMatches(absolute, file)) return null;
    }
    return {
      id: receipt.id,
      path: dir,
      source: receipt.source || '',
      installedAt: receipt.installedAt || '',
      bytes: (receipt.files || []).reduce((sum, f) => sum + (f.size || 0), 0),
    };
  }

  snapshot() {
    const installed = this.installed();
    return Object.assign({}, ADVERTISED, {
      installed: !!installed,
      path: installed ? installed.path : null,
      id: installed ? installed.id : null,
      installedAt: installed ? installed.installedAt : null,
      root: this.root,
    });
  }

  cancel() {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async getManifest(signal) {
    const release = await this.downloader.fetchRelease(signal);
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const manifestAsset = assets.get(MANIFEST_ASSET);
    if (!manifestAsset) {
      throw new ReleaseError('The release is missing ' + MANIFEST_ASSET + '.', 'MANIFEST_MISSING');
    }
    const bytes = await this.downloader.fetchSmallAsset(manifestAsset, signal);
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new ReleaseError('The speech-model manifest contains invalid JSON.', 'INVALID_MANIFEST');
    }
    if (!raw || raw.schemaVersion !== 1 || !raw.model) {
      throw new ReleaseError('The speech-model manifest format is not supported.', 'INVALID_MANIFEST');
    }
    const model = raw.model;
    if (!Array.isArray(model.parts) || !model.parts.length) {
      throw new ReleaseError('The speech-model manifest lists no weight parts.', 'INVALID_MANIFEST');
    }

    const describe = (entry, label) => this.downloader.describeAsset(
      assets.get(safeName(entry.asset, label)),
      safeName(entry.asset, label),
      { sha256: entry.sha256, size: entry.size }
    );

    return {
      id: safeId(model.id, 'model id'),
      source: String(model.source || '').slice(0, 120),
      weightsFile: safeName(model.weightsFile || 'model.bin', 'weights file'),
      weightsSize: Number(model.weightsSize),
      weightsSha256: String(model.weightsSha256 || '').toLowerCase(),
      parts: model.parts.map((entry) => describe(entry, 'weight part')),
      files: (Array.isArray(model.files) ? model.files : []).map((entry) => {
        const asset = describe(entry, 'model file');
        // Where the file lands inside the model directory, kept separate from
        // the asset name so a release asset can never name its own destination.
        asset.path = safeName(entry.path || entry.asset, 'model file destination');
        return asset;
      }),
    };
  }

  // The parts are one file cut into pieces, so the pieces are joined and the
  // result checked against the digest of the original rather than trusting that
  // correct pieces make a correct whole.
  async assembleWeights(manifest, partFiles, destination, signal) {
    const expected = { size: manifest.weightsSize, sha256: manifest.weightsSha256 };
    const already = await this.downloader.verifyFile(destination, expected);
    if (already) return already;

    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    const partial = destination + '.partial';
    await fsPromises.rm(partial, { force: true });
    const output = fs.createWriteStream(partial, { flags: 'w' });
    try {
      for (const filePath of partFiles) {
        if (signal && signal.aborted) throw new DownloadCancelledError('Speech model');
        await pipeline(fs.createReadStream(filePath), output, { end: false, signal });
      }
      await new Promise((resolve, reject) => {
        output.end(resolve);
        output.once('error', reject);
      });
    } catch (err) {
      output.destroy();
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) {
        throw new DownloadCancelledError('Speech model');
      }
      throw err;
    }
    const verified = await this.downloader.verifyFile(partial, expected);
    if (!verified) {
      await fsPromises.rm(partial, { force: true });
      throw new ReleaseError('The assembled speech model failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    return verified;
  }

  async install() {
    if (this.abortController) {
      throw new ReleaseError('The speech model is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    try {
      await fsPromises.mkdir(this.root, { recursive: true });
      this.onProgress({ status: 'preparing', progress: 0, message: 'Checking the GitHub release…' });
      const manifest = await this.getManifest(signal);

      const current = this.installed();
      if (current && current.id === manifest.id) {
        this.onProgress({ status: 'installed', progress: 100, message: 'The speech model is already installed.' });
        return { installed: current, reused: true };
      }

      const all = manifest.parts.concat(manifest.files);
      // Older Voxden versions downloaded Whisper into the Hub cache. Verify
      // those weights against the release before reusing them in explicit setup.
      let cachedWeights = null;
      if (this.cacheRoot) {
        const snapshots = path.join(this.cacheRoot, 'models--Systran--faster-whisper-large-v3', 'snapshots');
        for (const entry of await fsPromises.readdir(snapshots, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() || signal.aborted) continue;
          const candidate = path.join(snapshots, entry.name, manifest.weightsFile);
          if (await this.downloader.verifyFile(candidate, { size: manifest.weightsSize, sha256: manifest.weightsSha256 })) {
            cachedWeights = candidate;
            break;
          }
        }
      }
      const totalBytes = all.reduce((sum, asset) => sum + asset.size, 0);
      let completedBytes = 0;
      const report = (currentBytes) => {
        const downloaded = Math.min(totalBytes, completedBytes + currentBytes);
        this.onProgress({
          status: 'downloading',
          // Assembly is a 3 GB copy and is not instant, so it gets the last
          // slice of the bar rather than appearing as a stall at 100%.
          progress: totalBytes > 0 ? Math.floor((downloaded / totalBytes) * 96) : 0,
          downloadedBytes: downloaded,
          totalBytes,
          message: 'Downloading the speech model…',
        });
      };

      const staging = path.join(this.root, 'downloads', manifest.id);
      const partFiles = [];
      for (const asset of manifest.parts) {
        if (cachedWeights) { completedBytes += asset.size; continue; }
        const destination = path.join(staging, asset.asset);
        await this.downloader.downloadAsset(asset, destination, {
          signal,
          onBytes: (bytes) => report(bytes),
        });
        completedBytes += asset.size;
        partFiles.push(destination);
      }

      // Build beside the target and swap, so an interrupted install cannot
      // leave a directory that looks complete enough to load.
      const target = this.modelDir(manifest.id);
      const pending = target + '.pending';
      await fsPromises.rm(pending, { recursive: true, force: true });
      await fsPromises.mkdir(pending, { recursive: true });

      for (const asset of manifest.files) {
        const destination = path.join(pending, asset.path);
        if (!isInside(pending, destination)) {
          throw new ReleaseError('The manifest names a file outside the model directory.', 'UNSAFE_PATH');
        }
        await this.downloader.downloadAsset(asset, destination, {
          signal,
          onBytes: (bytes) => report(bytes),
        });
        completedBytes += asset.size;
      }

      this.onProgress({ status: 'installing', progress: 96, message: 'Assembling the speech model…' });
      const weightsPath = path.join(pending, manifest.weightsFile);
      if (cachedWeights) await fsPromises.copyFile(cachedWeights, weightsPath);
      const weights = await this.assembleWeights(manifest, partFiles, weightsPath, signal);
      if (signal.aborted) throw new DownloadCancelledError('Speech model');

      await fsPromises.rm(target, { recursive: true, force: true });
      await fsPromises.rename(pending, target);
      await fsPromises.rm(path.join(this.root, 'downloads'), { recursive: true, force: true });

      const records = [{
        path: path.relative(this.root, path.join(target, manifest.weightsFile)),
        size: weights.size,
        sha256: weights.sha256,
        verifiedMtimeMs: (await fsPromises.stat(path.join(target, manifest.weightsFile))).mtimeMs,
      }];
      for (const asset of manifest.files) {
        const absolute = path.join(target, asset.path);
        const stat = await fsPromises.stat(absolute);
        records.push({
          path: path.relative(this.root, absolute),
          size: stat.size,
          sha256: asset.sha256,
          verifiedMtimeMs: stat.mtimeMs,
        });
      }

      await writeJsonAtomic(this.receiptPath(), {
        schemaVersion: RECEIPT_SCHEMA,
        id: manifest.id,
        source: manifest.source,
        dir: path.relative(this.root, target),
        installedAt: new Date().toISOString(),
        releaseTag: this.releaseTag,
        files: records,
      });

      const installed = this.installed();
      if (!installed) {
        throw new ReleaseError('The installed speech model could not be opened.', 'INSTALL_FAILED');
      }
      this.onProgress({ status: 'installed', progress: 100, message: 'The speech model is installed and ready.' });
      return { installed, reused: false };
    } catch (err) {
      throw friendlyFetchError(err);
    } finally {
      this.abortController = null;
    }
  }

  async remove() {
    if (this.abortController) throw new ReleaseError('Cancel setup before removing the model.', 'DOWNLOAD_ACTIVE');
    const receiptPath = this.receiptPath();
    const receipt = await readJson(receiptPath);
    if (receipt && receipt.id) {
      const dir = this.modelDir(receipt.id);
      if (!isInside(this.root, dir) || path.resolve(dir) === path.resolve(this.root)) {
        throw new ReleaseError('Refusing to remove an unsafe model path.', 'UNSAFE_PATH');
      }
      await fsPromises.rm(dir, { recursive: true, force: true });
      await fsPromises.rm(dir + '.pending', { recursive: true, force: true });
    }
    await fsPromises.rm(path.join(this.root, 'downloads'), { recursive: true, force: true });
    // An interrupted first install has no receipt yet, but can still have
    // gigabytes in its pending directory. Remove only these managed stages.
    for (const entry of await fsPromises.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name.endsWith('.pending')) {
        await fsPromises.rm(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }
    await fsPromises.rm(receiptPath, { force: true });
    return !!receipt;
  }
}

module.exports = {
  AsrModelManager,
  DEFAULT_REPOSITORY,
  DEFAULT_RELEASE_TAG,
  MANIFEST_ASSET,
  ADVERTISED,
};
