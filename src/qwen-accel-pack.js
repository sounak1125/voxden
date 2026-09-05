'use strict';

// Isolated Qwen accelerator packs: CUDA PyTorch or Windows ROCm PyTorch.
//
// Each pack is its own embeddable Python tree. Nothing here is copied into
// the CPU speech runtime, and a failed GPU install cannot replace CPU Torch
// files. The Whisper cuBLAS pack (src/cuda-pack.js) is a different download.

const fs = require('fs');
const path = require('path');
const { removeTree } = require('./clean-remove');
const { pipeline } = require('stream/promises');
const {
  ReleaseError,
  DownloadCancelledError,
  ReleaseDownloader,
  isInside,
  readJson,
  readJsonSync,
  writeJsonAtomic,
  statMatches,
  safeId,
  safeName,
  normalizeSha256,
  sha256File,
} = require('./release-download');
const { extractZip } = require('./zip');
const { extractSevenZip } = require('./seven-zip');
const { INVENTORY, checkCancelled, validateInventory, reuseFiles, verifyFiles } = require('./qwen-pack-files');
const { validateQwenProbe } = require('./qwen-verification');
const { cleanupLegacyPack, installationKey, INSTALL_STATE } = require('./qwen-pack-cleanup');
const { catalogFor, catalog } = require('./qwen-accel');

const fsPromises = fs.promises;
const RECEIPT_SCHEMA = 1;
const DEFAULT_REPOSITORY = 'sounak1125/voxden';
const MARKER_NAME = 'voxden-qwen-accel.json';

function downloadSizeLabel(min, max = min) {
  const divisor = max >= 1e9 ? 1e9 : max >= 1e6 ? 1e6 : max >= 1e3 ? 1e3 : 1;
  const unit = divisor === 1e9 ? 'GB' : divisor === 1e6 ? 'MB' : divisor === 1e3 ? 'KB' : 'B';
  const number = bytes => divisor === 1 ? String(bytes) : (bytes / divisor).toFixed(2);
  return number(min) + (min === max ? '' : '–' + number(max)) + ' ' + unit;
}

function runtimeBinDirs(pythonPath) {
  const root = path.dirname(pythonPath || '');
  if (!root) return [];
  return [
    path.join(root, 'Lib', 'site-packages', '_rocm_sdk_core', 'bin'),
    path.join(root, 'Lib', 'site-packages', '_rocm_sdk_core', 'lib', 'llvm', 'bin'),
    path.join(root, 'Lib', 'site-packages', 'torch', 'lib'),
  ].filter((dir) => fs.existsSync(dir));
}

function pathWithRuntimeBins(pythonPath, basePath) {
  const extras = runtimeBinDirs(pythonPath);
  const current = String(basePath == null ? process.env.PATH || '' : basePath);
  return extras.concat(current.split(path.delimiter).filter(Boolean)).join(path.delimiter);
}

function advertisedFor(kind) {
  const spec = catalogFor(kind);
  return Object.freeze({
    name: kind === 'rocm' ? 'Qwen ROCm acceleration' : 'Qwen CUDA acceleration',
    downloadBytes: spec.downloadBytes,
    downloadSize: spec.downloadSize,
    installedSize: spec.installedSize,
    id: spec.id,
    torch: spec.torch,
    python: spec.python,
  });
}

function friendlyFetchError(err, label) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError(label);
  }
  if (err instanceof ReleaseError) return err;
  if (err && err.code === 'ENOSPC') {
    return new ReleaseError('There is not enough free disk space to install ' + label + '.', 'DISK_FULL');
  }
  return new ReleaseError(
    label + ' could not be installed. Check the connection and try again.',
    'NETWORK_ERROR'
  );
}

class QwenAccelPackManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('QwenAccelPackManager requires a persistent root directory.');
    const kind = String(opts.kind || '').trim().toLowerCase();
    if (kind !== 'cuda' && kind !== 'rocm') {
      throw new Error('QwenAccelPackManager kind must be cuda or rocm.');
    }
    this.kind = kind;
    this.spec = catalogFor(kind);
    this.label = advertisedFor(kind).name;
    this.root = path.resolve(opts.root);
    this.repository = String(opts.repository || DEFAULT_REPOSITORY);
    this.releaseTag = String(opts.releaseTag || this.spec.releaseTag);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.validateRuntime = typeof opts.validateRuntime === 'function' ? opts.validateRuntime : null;
    this.extractorPath = opts.extractorPath || '';
    this.baseRuntimeRoot = opts.baseRuntimeRoot || (() => null);
    this.abortController = null;
    this.cleanupTask = null;
    this.cleanupController = null;
    this.removing = false;
    this.downloadInfoTask = null;
    this.downloadInfoState = 'idle';
    this.downloadInfoRefreshAt = 0;
    this.availableAsset = null;
    this.onDownloadInfo = typeof opts.onDownloadInfo === 'function' ? opts.onDownloadInfo : () => {};
    this.downloader = new ReleaseDownloader({
      repository: this.repository,
      releaseTag: this.releaseTag,
      releaseApiUrl: opts.releaseApiUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: 'Voxden-Qwen-Accel-' + kind,
      cancelLabel: this.label,
      segmentSize: opts.segmentSize,
      segmentThreshold: opts.segmentThreshold,
      segmentConcurrency: opts.segmentConcurrency,
    });
  }

  receiptPath() {
    return path.join(this.root, 'current-qwen-' + this.kind + '-pack.json');
  }

  packDir() {
    return path.join(this.root, 'runtime');
  }

  pythonPath(root) {
    return path.join(root || this.packDir(), 'python.exe');
  }

  markerPath(root) {
    return path.join(root || this.packDir(), MARKER_NAME);
  }

  readMarker(root) {
    const marker = readJsonSync(this.markerPath(root));
    if (!marker || marker.kind !== this.kind) return null;
    if (String(marker.id || '') !== this.spec.id) return null;
    return marker;
  }

  filesPresent(root) {
    const dir = root || this.packDir();
    if (!fs.existsSync(this.pythonPath(dir))) return false;
    if (!this.readMarker(dir)) return false;
    const torchDir = path.join(dir, 'Lib', 'site-packages', 'torch');
    return fs.existsSync(torchDir);
  }

  installed() {
    const receipt = readJsonSync(this.receiptPath());
    if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA) return null;
    if (receipt.kind !== this.kind) return null;
    if (String(receipt.id || '') !== this.spec.id) return null;
    if (!receipt.proof) return null;
    const proofPath = path.resolve(this.root, receipt.proof.path || '');
    if (!isInside(this.root, proofPath)) return null;
    if (!statMatches(proofPath, receipt.proof)) return null;
    if (!this.filesPresent(this.packDir())) return null;
    return {
      id: receipt.id,
      kind: this.kind,
      version: receipt.version || this.spec.version,
      pythonPath: this.pythonPath(),
      packDir: this.packDir(),
      torch: receipt.torch || this.spec.torch,
      pythonVersion: receipt.pythonVersion || this.spec.python,
      installedAt: receipt.installedAt || '',
      runtimeVerified: !!(receipt.verified && receipt.verified.importOk && receipt.verified.tensorProbeOk),
      verified: !!(receipt.verified && receipt.verified.importOk && receipt.verified.tensorProbeOk && receipt.verified.qwenProbeOk),
      qwenProbeOk: !!(receipt.verified && receipt.verified.qwenProbeOk),
      // Older receipts predate the mandatory speech check. Let startup perform
      // the new check without invalidating a working, already downloaded pack.
      qwenProbePending: !!(receipt.verified && !receipt.verified.qwenProbeOk
        && (receipt.verified.qwenProbePending || !receipt.verificationVersion)),
      gpuName: (receipt.verified && receipt.verified.gpuName) || '',
      failureReason: receipt.failureReason || '',
    };
  }

  healthy() {
    const installed = this.installed();
    if (!installed || installed.failureReason) return null;
    if (!installed.runtimeVerified || (!installed.verified && !installed.qwenProbePending)) return null;
    return installed;
  }

  snapshot() {
    const installed = this.installed();
    const adv = advertisedFor(this.kind);
    return Object.assign({}, adv, {
      ...this.downloadInfo(),
      kind: this.kind,
      installed: !!installed,
      healthy: !!this.healthy(),
      verified: !!(installed && installed.verified),
      qwenProbeOk: !!(installed && installed.qwenProbeOk),
      qwenProbePending: !!(installed && installed.qwenProbePending),
      pythonPath: installed ? installed.pythonPath : null,
      packDir: installed ? installed.packDir : null,
      installedAt: installed ? installed.installedAt : null,
      torch: installed ? installed.torch : adv.torch,
      failureReason: installed ? installed.failureReason : '',
      root: this.root,
    });
  }

  downloadInfo() {
    const state = { downloadSizeStatus: this.downloadInfoState,
      downloadSizeRefreshAt: this.downloadInfoRefreshAt,
      downloadSize: '', downloadBytes: null, downloadMinBytes: null, downloadFormat: '' };
    if (this.downloadInfoState !== 'ready' || !this.availableAsset) return state;
    const asset = this.availableAsset;
    const max = asset.size + (asset.shared?.size || 0);
    const base = typeof this.baseRuntimeRoot === 'function' ? this.baseRuntimeRoot() : this.baseRuntimeRoot;
    const min = asset.shared && base && fs.existsSync(base) ? asset.size : max;
    return { ...state, downloadSize: downloadSizeLabel(min, max), downloadBytes: max,
      downloadMinBytes: min, downloadFormat: asset.format };
  }

  recordAvailableAsset(asset) {
    this.availableAsset = asset;
    this.downloadInfoState = 'ready';
    this.downloadInfoRefreshAt = Date.now() + 5 * 60 * 1000;
    this.onDownloadInfo();
    return asset;
  }

  refreshDownloadInfo() {
    if (this.downloadInfoTask) return this.downloadInfoTask;
    if (Date.now() < this.downloadInfoRefreshAt) return Promise.resolve(this.downloadInfo());
    this.downloadInfoState = 'checking';
    // Only the release listing and small manifest are fetched here. Rendering
    // a size never downloads pack data or hashes the installed Python tree.
    this.downloadInfoTask = Promise.resolve().then(async () => {
      try { await this.resolveAsset(AbortSignal.timeout(15000)); }
      catch (_) {
        this.availableAsset = null;
        this.downloadInfoState = 'unavailable';
        this.downloadInfoRefreshAt = Date.now() + 30000;
        this.onDownloadInfo();
      }
      return this.downloadInfo();
    }).finally(() => { this.downloadInfoTask = null; });
    return this.downloadInfoTask;
  }

  cancel() {
    if (this.cleanupController) this.cleanupController.abort();
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async stopCleanup() {
    if (this.cleanupController) this.cleanupController.abort();
    if (this.cleanupTask) await this.cleanupTask.catch(() => {});
  }

  cleanupLegacyFiles(confirmation, stillVerified = () => true) {
    if (this.cleanupTask) return this.cleanupTask;
    const current = this.healthy();
    if (this.abortController || this.removing || !current || !confirmation?.qwenProbeOk
        || !confirmation.importOk || !confirmation.tensorProbeOk
        || confirmation.kind !== this.kind || confirmation.id !== current.id
        || path.resolve(confirmation.pythonPath || '') !== path.resolve(current.pythonPath)) {
      return Promise.resolve({ skipped: 'not-verified' });
    }
    const receipt = readJsonSync(this.receiptPath());
    if (!receipt) return Promise.resolve({ skipped: 'not-verified' });
    const key = installationKey(receipt);
    const controller = new AbortController();
    this.cleanupController = controller;
    this.cleanupTask = cleanupLegacyPack({ root: this.root, kind: this.kind, receipt, signal: controller.signal,
      canContinue: () => !this.abortController && !this.removing && stillVerified(),
      isCurrent: () => {
        const latest = readJsonSync(this.receiptPath());
        return !this.abortController && !this.removing && stillVerified() && !!this.healthy()
          && !!latest && installationKey(latest) === key;
      },
    }).finally(() => { this.cleanupController = null; this.cleanupTask = null; });
    return this.cleanupTask;
  }

  async resolveAsset(signal) {
    const release = await this.downloader.fetchRelease(signal);
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    let declared = {};
    const manifestAsset = assets.get(this.spec.manifest);
    if (manifestAsset) {
      const bytes = await this.downloader.fetchSmallAsset(manifestAsset, signal);
      let parsed = null;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch (err) {
        throw new ReleaseError('The ' + this.label + ' manifest contains invalid JSON.', 'INVALID_MANIFEST');
      }
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.pack) {
        throw new ReleaseError('The ' + this.label + ' manifest format is not supported.', 'INVALID_MANIFEST');
      }
      if (parsed.pack.kind && parsed.pack.kind !== this.kind) {
        throw new ReleaseError('The ' + this.label + ' manifest names the wrong accelerator.', 'INVALID_MANIFEST');
      }
      declared = parsed.pack;
    }
    const name = String(declared.asset || this.spec.asset);
    if (name !== this.spec.asset) {
      throw new ReleaseError('The ' + this.label + ' manifest names an unexpected asset.', 'INVALID_MANIFEST');
    }
    const combinedSha = normalizeSha256(declared.sha256 || this.spec.sha256);
    const combinedSize = Number(declared.size || this.spec.downloadBytes);
    if (!combinedSha || !Number.isSafeInteger(combinedSize) || combinedSize < 1) {
      throw new ReleaseError('The ' + this.label + ' manifest has no verifiable size or SHA-256 digest.', 'INVALID_MANIFEST');
    }
    if (declared.id && declared.id !== this.spec.id) {
      throw new ReleaseError('The GPU manifest names a different runtime version.', 'INVALID_MANIFEST');
    }
    const optimized = declared.optimized;
    if (optimized && this.extractorPath && fs.existsSync(this.extractorPath)) {
      if (optimized.schemaVersion !== 1 || optimized.id !== this.spec.id
          || !normalizeSha256(optimized.inventorySha256)) {
        throw new ReleaseError('The compact GPU manifest is invalid.', 'INVALID_MANIFEST');
      }
      const complete = [optimized.core, optimized.shared].every(item =>
        item && Array.isArray(item.parts) && item.parts.length
        && item.parts.every(part => assets.has(part.asset)));
      // Publishing compact files alongside v1 must never break either client
      // during a partial upload. The complete old ZIP stays available.
      if (complete) {
        const describe = item => {
          const assetName = safeName(item.asset, 'compact pack');
          if (item.format !== '7z' || !assetName.endsWith('.7z')
              || !normalizeSha256(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1) {
            throw new ReleaseError('The compact GPU archive is invalid.', 'INVALID_MANIFEST');
          }
          const parts = item.parts.map(part => this.downloader.describeAsset(
            assets.get(safeName(part.asset, 'compact part')), part.asset,
            { size: part.size, sha256: part.sha256 }));
          if (new Set(parts.map(part => part.asset)).size !== parts.length
              || parts.reduce((sum, part) => sum + part.size, 0) !== item.size) {
            throw new ReleaseError('The compact GPU parts have invalid sizes.', 'INVALID_MANIFEST');
          }
          return { asset: assetName, size: item.size, sha256: item.sha256, parts, format: '7z' };
        };
        const core = describe(optimized.core);
        const shared = describe(optimized.shared);
        const componentNames = [...core.parts, ...shared.parts].map(part => part.asset);
        if (core.asset === shared.asset || new Set(componentNames).size !== componentNames.length
            || core.parts.some(part => part.asset === shared.asset)
            || shared.parts.some(part => part.asset === core.asset)
            || [core, shared].some(item => item.parts.length > 1 && item.parts.some(part => part.asset === item.asset))) {
          throw new ReleaseError('The compact GPU archives overlap.', 'INVALID_MANIFEST');
        }
        return this.recordAvailableAsset({ ...core, id: this.spec.id, kind: this.kind, shared,
          inventorySha256: optimized.inventorySha256 });
      }
    }
    const rawParts = Array.isArray(declared.parts) && declared.parts.length
      ? declared.parts
      : [{ asset: name, sha256: combinedSha, size: combinedSize }];
    const parts = rawParts.map((entry) => this.downloader.describeAsset(
      assets.get(safeName(entry.asset, 'pack part')),
      safeName(entry.asset, 'pack part'),
      { sha256: entry.sha256, size: entry.size }
    ));
    return this.recordAvailableAsset({
      id: safeId(declared.id || this.spec.id, 'pack id'),
      kind: this.kind,
      format: 'zip',
      asset: name,
      sha256: combinedSha,
      size: combinedSize,
      parts,
    });
  }

  async assembleArchive(asset, partFiles, destination, signal) {
    const expected = { size: asset.size, sha256: asset.sha256 };
    const already = await this.downloader.verifyFile(destination, expected);
    if (already) return already;
    if (partFiles.length === 1) {
      const single = await this.downloader.verifyFile(partFiles[0], expected);
      if (single) {
        await fsPromises.mkdir(path.dirname(destination), { recursive: true });
        if (path.resolve(partFiles[0]) !== path.resolve(destination)) {
          await fsPromises.copyFile(partFiles[0], destination);
        }
        return single;
      }
    }

    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    const partial = destination + '.partial';
    await fsPromises.rm(partial, { force: true });
    const output = fs.createWriteStream(partial, { flags: 'w' });
    try {
      for (const filePath of partFiles) {
        if (signal && signal.aborted) throw new DownloadCancelledError(this.label);
        await pipeline(fs.createReadStream(filePath), output, { end: false, signal });
      }
      await new Promise((resolve, reject) => {
        output.end(resolve);
        output.once('error', reject);
      });
    } catch (err) {
      output.destroy();
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) {
        throw new DownloadCancelledError(this.label);
      }
      throw err;
    }
    const verified = await this.downloader.verifyFile(partial, expected);
    if (!verified) {
      await fsPromises.rm(partial, { force: true });
      throw new ReleaseError(
        'The assembled ' + this.label + ' archive failed SHA-256 verification.',
        'CHECKSUM_MISMATCH'
      );
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    return verified;
  }

  async writeReceipt(asset, verification, installedAt) {
    const proofPath = this.markerPath();
    const stat = await fsPromises.stat(proofPath);
    const payload = {
      schemaVersion: RECEIPT_SCHEMA,
      id: asset.id,
      kind: this.kind,
      version: this.spec.version,
      torch: this.spec.torch,
      pythonVersion: this.spec.python,
      installedAt: installedAt === undefined ? new Date().toISOString() : installedAt,
      releaseTag: this.releaseTag,
      proof: {
        path: path.relative(this.root, proofPath),
        size: stat.size,
        verifiedMtimeMs: stat.mtimeMs,
      },
      verified: verification || { importOk: false, tensorProbeOk: false, qwenProbeOk: false },
      verificationVersion: 2,
      distribution: { asset: asset.asset, sha256: asset.sha256, format: asset.format || 'zip' },
    };
    await writeJsonAtomic(this.receiptPath(), payload);
  }

  async downloadArchive(asset, staging, signal, start = 0, end = 88) {
    const archive = path.join(staging, asset.asset);
    let completedBytes = 0;
    const partFiles = [];
    for (const part of asset.parts) {
      checkCancelled(signal);
      const destination = path.join(staging, part.asset);
      await this.downloader.downloadAsset(part, destination, {
        signal,
        onBytes: downloaded => this.onProgress({
          status: 'downloading', progress: Math.floor(start + (end - start) * Math.min(1, (completedBytes + downloaded) / asset.size)),
          downloadedBytes: completedBytes + downloaded, totalBytes: asset.size, asset: asset.asset,
          message: 'Downloading ' + this.label + '...',
        }),
      });
      completedBytes += part.size;
      partFiles.push(destination);
    }
    checkCancelled(signal);
    await this.assembleArchive(asset, partFiles, archive, signal);
    return archive;
  }

  async install(options = {}) {
    if (this.abortController || this.removing) {
      throw new ReleaseError(this.label + ' is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    const target = this.packDir();
    const pending = target + '.pending';
    try {
      await this.stopCleanup();
      await fsPromises.mkdir(this.root, { recursive: true });
      const current = this.installed();
      if (current && !options.force && this.validateRuntime) {
        this.onProgress({ status: 'installing', progress: 94, message: 'Verifying installed ' + this.label + '...' });
        try {
          const verification = validateQwenProbe(await this.validateRuntime(current.pythonPath, signal));
          checkCancelled(signal);
          const receipt = await readJson(this.receiptPath());
          await this.writeReceipt({ id: current.id,
            asset: receipt?.distribution?.asset || this.spec.asset,
            sha256: receipt?.distribution?.sha256 || this.spec.sha256,
            format: receipt?.distribution?.format || 'zip' }, verification, receipt?.installedAt || '');
          this.onProgress({ status: 'installed', progress: 100,
            message: verification.qwenProbeOk ? this.label + ' is installed and verified.'
              : 'GPU support is installed. Verification will finish after the Qwen model is downloaded.' });
          return { installed: this.installed(), reused: true, verification };
        } catch (err) {
          checkCancelled(signal);
          // Missing imports/files are repaired by reconstructing a full pack.
        }
      }

      // A healthy installed pack can be retried while offline. Only a new or
      // damaged installation needs release metadata and download access.
      await writeJsonAtomic(path.join(this.root, INSTALL_STATE), {
        schemaVersion: 1, id: this.spec.id, status: 'pending', startedAt: new Date().toISOString(),
      });
      this.onProgress({ status: 'preparing', progress: 0, message: 'Checking the GitHub release...' });
      const asset = await this.resolveAsset(signal);
      const staging = path.join(this.root, 'downloads');
      const compact = asset.format === '7z';
      const archive = await this.downloadArchive(asset, staging, signal, 0, compact ? 70 : 88);
      checkCancelled(signal);
      this.onProgress({ status: 'installing', progress: compact ? 72 : 91, message: 'Unpacking ' + this.label + '...' });

      await fsPromises.rm(pending, { recursive: true, force: true });
      if (compact) {
        await extractSevenZip(this.extractorPath, archive, pending, { signal });
        const inventoryPath = path.join(pending, INVENTORY);
        if (!fs.existsSync(inventoryPath) || (await fsPromises.stat(inventoryPath)).size > 32 * 1024 * 1024
            || await sha256File(inventoryPath) !== asset.inventorySha256) {
          throw new ReleaseError('The GPU file inventory failed verification.', 'CHECKSUM_MISMATCH');
        }
        const files = validateInventory(await readJson(inventoryPath), pending, asset.id);
        this.onProgress({ status: 'installing', progress: 75, message: 'Reusing verified speech support files...' });
        const baseRoot = typeof this.baseRuntimeRoot === 'function' ? this.baseRuntimeRoot() : this.baseRuntimeRoot;
        const missing = await reuseFiles(files, baseRoot, pending, signal);
        if (missing.length) {
          const sharedArchive = await this.downloadArchive(asset.shared, staging, signal, 75, 90);
          await extractSevenZip(this.extractorPath, sharedArchive, pending, { signal });
        }
        this.onProgress({ status: 'installing', progress: 92, message: 'Checking every GPU support file...' });
        await verifyFiles(files, pending, signal);
      } else await extractZip(archive, pending, { signal });

      if (!this.filesPresent(pending)) {
        await fsPromises.rm(pending, { recursive: true, force: true });
        throw new ReleaseError(this.label + ' download is missing Python or PyTorch.', 'PACK_INCOMPLETE');
      }

      let verification = { importOk: false, tensorProbeOk: false, qwenProbeOk: false };
      if (this.validateRuntime) {
        this.onProgress({ status: 'installing', progress: 94, message: 'Verifying ' + this.label + '...' });
        try {
          verification = validateQwenProbe(await this.validateRuntime(this.pythonPath(pending), signal));
        } catch (err) {
          await fsPromises.rm(pending, { recursive: true, force: true });
          checkCancelled(signal);
          throw new ReleaseError(
            this.label + ' could not be verified: ' + (err && err.message ? err.message : err),
            'PACK_UNHEALTHY'
          );
        }
      } else {
        throw new ReleaseError('GPU support could not be verified. Restart Voxden and retry.', 'PACK_UNHEALTHY');
      }

      checkCancelled(signal);
      const previous = fs.existsSync(target);
      const backup = target + '.previous';
      const oldReceipt = await readJson(this.receiptPath());
      await fsPromises.rm(backup, { recursive: true, force: true });
      try {
        if (previous) await fsPromises.rename(target, backup);
        await fsPromises.rename(pending, target);
        await this.writeReceipt(asset, verification);
        if (!this.installed()) throw new ReleaseError('The installed GPU pack could not be opened.', 'INSTALL_FAILED');
      } catch (err) {
        // If the first rename failed, target is still the previous installation.
        if (!previous || fs.existsSync(backup)) {
          await fsPromises.rm(target, { recursive: true, force: true });
          if (previous) await fsPromises.rename(backup, target);
        }
        if (oldReceipt) await writeJsonAtomic(this.receiptPath(), oldReceipt);
        else await fsPromises.rm(this.receiptPath(), { force: true });
        throw err;
      }
      // Cleanup must not turn a fully committed installation into an error.
      await writeJsonAtomic(path.join(this.root, INSTALL_STATE), {
        schemaVersion: 1, id: this.spec.id, status: 'complete', completedAt: new Date().toISOString(),
      }).catch(() => {});
      await fsPromises.rm(backup, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
      const installed = this.installed();
      if (!installed) {
        throw new ReleaseError('The installed ' + this.label + ' pack could not be opened.', 'INSTALL_FAILED');
      }
      this.onProgress({
        status: 'installed',
        progress: 100,
        message: verification.qwenProbeOk
          ? this.label + ' is installed and verified.'
          : 'GPU support is installed. Verification will finish after the Qwen model is downloaded.',
      });
      return { installed, reused: false, verification };
    } catch (err) {
      throw friendlyFetchError(err, this.label);
    } finally {
      this.abortController = null;
    }
  }

  async remove() {
    if (this.abortController || this.removing) throw new ReleaseError('GPU support is busy.', 'DOWNLOAD_ACTIVE');
    this.removing = true;
    try {
      await this.stopCleanup();
      const receiptPath = this.receiptPath();
      const receipt = await readJson(receiptPath);
      const target = this.packDir();
      if (!isInside(this.root, target) || path.resolve(target) === path.resolve(this.root)) {
        throw new ReleaseError('Refusing to remove an unsafe pack path.', 'UNSAFE_PATH');
      }
      for (const dir of [target, target + '.pending', target + '.previous', path.join(this.root, 'downloads')]) {
        await removeTree(dir);
      }
      await fsPromises.rm(receiptPath, { force: true });
      return !!receipt;
    } finally { this.removing = false; }
  }
}

module.exports = {
  QwenAccelPackManager,
  DEFAULT_REPOSITORY,
  RECEIPT_SCHEMA,
  MARKER_NAME,
  advertisedFor,
  downloadSizeLabel,
  catalog,
  runtimeBinDirs,
  pathWithRuntimeBins,
};
