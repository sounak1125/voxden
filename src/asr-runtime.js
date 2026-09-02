'use strict';

// Installs the self-contained speech runtime from the Windows app bundle.
// Legacy/source configurations can still resolve a verified release archive.
// Runtime receipts are persistent and independent of the desktop app version.

const fs = require('fs');
const path = require('path');
const { removeTree } = require('./clean-remove');
const {
  ReleaseError,
  DownloadCancelledError,
  ReleaseDownloader,
  isInside,
  readJson,
  readJsonSync,
  writeJsonAtomic,
  statMatches,
} = require('./release-download');
const { extractZip } = require('./zip');

const fsPromises = fs.promises;

const DEFAULT_REPOSITORY = 'sounak1125/voxden';
const DEFAULT_RELEASE_TAG = 'asr-runtime-v1';
const MANIFEST_ASSET = 'voxden-asr-runtime.json';
const RUNTIME_ASSET = 'voxden-asr-runtime-win-x64.zip';
const RECEIPT_SCHEMA = 1;

// What the download is worth telling the user before they commit to it.
// Refresh these from what prepare-asr-runtime.js prints when the runtime is
// rebuilt. The jump from 99/266 is the DirectML build of ONNX Runtime, which
// costs 11 MB compressed and 28 MB on disk over the CPU-only one -- the price
// of an AMD or Intel GPU having any backend here at all.
const ADVERTISED = Object.freeze({
  name: 'Speech engine',
  downloadBytes: 110 * 1000 * 1000,
  downloadSize: '110 MB',
  installedSize: '294 MB',
});

function friendlyFetchError(err) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError('Speech engine');
  }
  if (err instanceof ReleaseError) return err;
  if (err && err.code === 'ENOSPC') return new ReleaseError('There is not enough free disk space to install the speech engine.', 'DISK_FULL');
  if (err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
    return new ReleaseError('Windows could not replace the speech engine files. Close other copies of Voxden and try again.', 'FILES_IN_USE');
  }
  return new ReleaseError(
    'Speech engine setup failed: ' + (err && err.message || 'Unknown error. Please try again.'),
    'INSTALL_FAILED'
  );
}

class AsrRuntimeManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('AsrRuntimeManager requires a persistent root directory.');
    this.root = path.resolve(opts.root);
    this.bundledRoot = opts.bundledRoot ? path.resolve(opts.bundledRoot) : null;
    this.bundledManifest = this.bundledRoot
      ? readJsonSync(path.join(this.bundledRoot, MANIFEST_ASSET)) : null;
    this.validateRuntime = opts.validateRuntime || null;
    this.repository = String(opts.repository || DEFAULT_REPOSITORY);
    this.releaseTag = String(opts.releaseTag || DEFAULT_RELEASE_TAG);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.abortController = null;
    this.downloader = new ReleaseDownloader({
      repository: this.repository,
      releaseTag: this.releaseTag,
      releaseApiUrl: opts.releaseApiUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: 'Voxden-Asr-Runtime',
      cancelLabel: 'Speech engine',
      segmentSize: opts.segmentSize,
      segmentThreshold: opts.segmentThreshold,
      segmentConcurrency: opts.segmentConcurrency,
    });
  }

  receiptPath() {
    return path.join(this.root, 'current-runtime.json');
  }

  runtimeDir() {
    return path.join(this.root, 'runtime');
  }

  /**
   * The installed interpreter, or null. Checked on every snapshot, so it only
   * stats the one file it is going to spawn rather than the whole tree.
   */
  installed() {
    const receipt = readJsonSync(this.receiptPath());
    if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA || !receipt.python) return null;
    const pythonPath = path.resolve(this.root, receipt.python.path || '');
    if (!isInside(this.root, pythonPath)) return null;
    if (!statMatches(pythonPath, receipt.python)) return null;
    return {
      id: receipt.id,
      pythonPath,
      pythonVersion: receipt.pythonVersion || '',
      installedAt: receipt.installedAt || '',
      files: receipt.files || 0,
      engines: receipt.engines || ['whisper', 'parakeet'],
      torchDevice: receipt.torchDevice || '',
    };
  }

  snapshot() {
    const installed = this.installed();
    return Object.assign({}, ADVERTISED, {
      downloadBytes: this.bundledManifest ? 0 : ADVERTISED.downloadBytes,
      bundled: !!this.bundledManifest,
      downloadSize: this.bundledManifest ? 'Included with Voxden' : ADVERTISED.downloadSize,
      installedSize: this.bundledManifest
        ? Math.ceil(this.bundledManifest.runtime.installedBytes / 1e6) + ' MB' : ADVERTISED.installedSize,
      needsUpgrade: !!(installed && this.bundledManifest
        && installed.id !== this.bundledManifest.runtime.id),
      installed: !!installed,
      pythonPath: installed ? installed.pythonPath : null,
      pythonVersion: installed ? installed.pythonVersion : null,
      installedAt: installed ? installed.installedAt : null,
      root: this.root,
    });
  }

  cancel() {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async resolveAsset(signal) {
    if (this.bundledManifest) {
      const declared = this.bundledManifest.runtime;
      if (!declared || declared.asset !== RUNTIME_ASSET) {
        throw new ReleaseError('The bundled speech engine is incomplete. Reinstall Voxden.', 'RUNTIME_INCOMPLETE');
      }
      const localPath = path.join(this.bundledRoot, RUNTIME_ASSET);
      return { ...declared, python: 'python.exe', localPath };
    }
    const release = await this.downloader.fetchRelease(signal);
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));

    // The manifest is a fallback for the digest, not a source of trust: size
    // and SHA-256 come from the release asset itself wherever GitHub supplies
    // them, so editing the manifest alone cannot describe a payload into being
    // accepted.
    let declared = {};
    const manifestAsset = assets.get(MANIFEST_ASSET);
    if (manifestAsset) {
      const bytes = await this.downloader.fetchSmallAsset(manifestAsset, signal);
      let raw = null;
      try {
        raw = JSON.parse(bytes.toString('utf8'));
      } catch (_) {
        throw new ReleaseError('The speech-engine manifest contains invalid JSON.', 'INVALID_MANIFEST');
      }
      if (!raw || raw.schemaVersion !== 1 || !raw.runtime) {
        throw new ReleaseError('The speech-engine manifest format is not supported.', 'INVALID_MANIFEST');
      }
      declared = raw.runtime;
    }

    const name = String(declared.asset || RUNTIME_ASSET);
    if (name !== RUNTIME_ASSET) {
      throw new ReleaseError('The speech-engine manifest names an unexpected asset.', 'INVALID_MANIFEST');
    }
    const asset = this.downloader.describeAsset(assets.get(name), name, {
      sha256: declared.sha256,
      size: declared.size,
    });
    asset.id = String(declared.id || 'asr-win-x64');
    asset.python = 'python.exe';
    asset.pythonVersion = String(declared.pythonVersion || '');
    asset.files = Number.isSafeInteger(declared.files) ? declared.files : 0;
    asset.engines = Array.isArray(declared.engines) ? declared.engines : ['whisper', 'parakeet'];
    return asset;
  }

  async install() {
    if (this.abortController) {
      throw new ReleaseError('The speech engine is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    try {
      await fsPromises.mkdir(this.root, { recursive: true });
      this.onProgress({ status: 'preparing', progress: 0, message: 'Checking the GitHub release…' });
      const asset = await this.resolveAsset(signal);

      const current = this.installed();
      if (current && current.id === asset.id) {
        let healthy = true;
        if (this.validateRuntime) {
          try { await this.validateRuntime(current.pythonPath, signal); }
          catch (err) { if (signal.aborted) throw err; healthy = false; }
        }
        if (healthy) {
          this.onProgress({ status: 'installed', progress: 100, message: 'The speech engine is already installed.' });
          return { installed: current, reused: true };
        }
      }

      const staging = path.join(this.root, 'downloads');
      const archive = asset.localPath || path.join(staging, asset.asset);
      if (asset.localPath) {
        this.onProgress({ status: 'installing', progress: 10, message: 'Verifying the bundled speech engine…' });
        if (!await this.downloader.verifyFile(archive, asset)) {
          throw new ReleaseError('The bundled speech engine failed verification. Reinstall Voxden.', 'CHECKSUM_MISMATCH');
        }
      } else await this.downloader.downloadAsset(asset, archive, {
        signal,
        onBytes: (downloaded, total) => {
          // Downloading is most of the wait but not all of it; leave the last
          // tenth of the bar for unpacking so it does not sit at 100% while
          // two thousand files are still being written.
          const ratio = total > 0 ? downloaded / total : 0;
          this.onProgress({
            status: 'downloading',
            progress: Math.floor(ratio * 90),
            downloadedBytes: downloaded,
            totalBytes: total,
            message: 'Downloading the speech engine…',
          });
        },
      });

      if (signal.aborted) throw new DownloadCancelledError('Speech engine');
      this.onProgress({ status: 'installing', progress: 90, message: 'Unpacking the speech engine…' });

      // Extract beside the target and swap, so an interrupted unpack can never
      // leave a half-written runtime that looks installed.
      const target = this.runtimeDir();
      const pending = target + '.pending';
      await fsPromises.rm(pending, { recursive: true, force: true });
      await extractZip(archive, pending, {
        signal,
        onProgress: (done, total) => {
          const ratio = total > 0 ? done / total : 0;
          this.onProgress({
            status: 'installing',
            progress: 90 + Math.floor(ratio * 9),
            message: 'Unpacking the speech engine…',
          });
        },
      });

      const pythonPath = path.join(pending, asset.python);
      if (!fs.existsSync(pythonPath)) {
        await fsPromises.rm(pending, { recursive: true, force: true });
        throw new ReleaseError('The speech-engine download is missing its interpreter.', 'RUNTIME_INCOMPLETE');
      }
      if (this.validateRuntime) await this.validateRuntime(pythonPath, signal);
      if (signal.aborted) throw new DownloadCancelledError('Speech engine');

      // Keep the working runtime until its replacement and receipt commit.
      const backup = target + '.previous';
      await fsPromises.rm(backup, { recursive: true, force: true });
      const previous = fs.existsSync(target);
      if (previous) await fsPromises.rename(target, backup);
      try {
        await fsPromises.rename(pending, target);

        const finalPython = path.join(target, asset.python);
        const stat = await fsPromises.stat(finalPython);
        await writeJsonAtomic(this.receiptPath(), {
          schemaVersion: RECEIPT_SCHEMA,
          id: asset.id,
          pythonVersion: asset.pythonVersion,
          files: asset.files,
          engines: asset.engines,
          torchDevice: asset.torchDevice || '',
          installedAt: new Date().toISOString(),
          releaseTag: this.releaseTag,
          python: {
            path: path.relative(this.root, finalPython),
            size: stat.size,
            verifiedMtimeMs: stat.mtimeMs,
          },
        });
      } catch (err) {
        await fsPromises.rm(target, { recursive: true, force: true });
        if (previous) await fsPromises.rename(backup, target);
        throw err;
      }
      await fsPromises.rm(backup, { recursive: true, force: true });
      await fsPromises.rm(staging, { recursive: true, force: true });

      const installed = this.installed();
      if (!installed) {
        throw new ReleaseError('The installed speech engine could not be opened.', 'INSTALL_FAILED');
      }
      this.onProgress({ status: 'installed', progress: 100, message: 'The speech engine is installed and ready.' });
      return { installed, reused: false };
    } catch (err) {
      throw friendlyFetchError(err);
    } finally {
      this.abortController = null;
    }
  }

  async remove() {
    if (this.abortController) throw new ReleaseError('Cancel setup before removing the engine.', 'DOWNLOAD_ACTIVE');
    const receiptPath = this.receiptPath();
    const receipt = await readJson(receiptPath);
    const target = this.runtimeDir();
    if (!isInside(this.root, target) || path.resolve(target) === path.resolve(this.root)) {
      throw new ReleaseError('Refusing to remove an unsafe runtime path.', 'UNSAFE_PATH');
    }
    for (const dir of [target, target + '.pending', target + '.previous', path.join(this.root, 'downloads')]) {
      await removeTree(dir);
    }
    await fsPromises.rm(receiptPath, { force: true });
    return !!receipt;
  }
}

module.exports = {
  AsrRuntimeManager,
  DEFAULT_REPOSITORY,
  DEFAULT_RELEASE_TAG,
  RUNTIME_ASSET,
  MANIFEST_ASSET,
  ADVERTISED,
};
