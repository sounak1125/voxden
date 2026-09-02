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
} = require('./release-download');
const { extractZip } = require('./zip');
const { catalogFor, catalog } = require('./qwen-accel');

const fsPromises = fs.promises;
const RECEIPT_SCHEMA = 1;
const DEFAULT_REPOSITORY = 'sounak1125/voxden';
const MARKER_NAME = 'voxden-qwen-accel.json';

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
    this.abortController = null;
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
      verified: !!(receipt.verified && receipt.verified.importOk && receipt.verified.tensorProbeOk),
      qwenProbeOk: !!(receipt.verified && receipt.verified.qwenProbeOk),
      gpuName: (receipt.verified && receipt.verified.gpuName) || '',
      failureReason: receipt.failureReason || '',
    };
  }

  healthy() {
    const installed = this.installed();
    if (!installed || installed.failureReason) return null;
    if (!installed.verified) return null;
    return installed;
  }

  snapshot() {
    const installed = this.installed();
    const adv = advertisedFor(this.kind);
    return Object.assign({}, adv, {
      kind: this.kind,
      installed: !!installed,
      healthy: !!this.healthy(),
      verified: !!(installed && installed.verified),
      qwenProbeOk: !!(installed && installed.qwenProbeOk),
      pythonPath: installed ? installed.pythonPath : null,
      packDir: installed ? installed.packDir : null,
      installedAt: installed ? installed.installedAt : null,
      torch: installed ? installed.torch : adv.torch,
      failureReason: installed ? installed.failureReason : '',
      root: this.root,
    });
  }

  cancel() {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
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
    const rawParts = Array.isArray(declared.parts) && declared.parts.length
      ? declared.parts
      : [{ asset: name, sha256: combinedSha, size: combinedSize }];
    const parts = rawParts.map((entry) => this.downloader.describeAsset(
      assets.get(safeName(entry.asset, 'pack part')),
      safeName(entry.asset, 'pack part'),
      { sha256: entry.sha256, size: entry.size }
    ));
    return {
      id: safeId(declared.id || this.spec.id, 'pack id'),
      kind: this.kind,
      asset: name,
      sha256: combinedSha,
      size: combinedSize,
      parts,
    };
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

  async writeReceipt(asset, verification) {
    const proofPath = this.markerPath();
    const stat = await fsPromises.stat(proofPath);
    const payload = {
      schemaVersion: RECEIPT_SCHEMA,
      id: asset.id,
      kind: this.kind,
      version: this.spec.version,
      torch: this.spec.torch,
      pythonVersion: this.spec.python,
      installedAt: new Date().toISOString(),
      releaseTag: this.releaseTag,
      proof: {
        path: path.relative(this.root, proofPath),
        size: stat.size,
        verifiedMtimeMs: stat.mtimeMs,
      },
      verified: verification || { importOk: false, tensorProbeOk: false, qwenProbeOk: false },
    };
    await writeJsonAtomic(this.receiptPath(), payload);
  }

  async install() {
    if (this.abortController) {
      throw new ReleaseError(this.label + ' is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    const target = this.packDir();
    const pending = target + '.pending';
    try {
      await fsPromises.mkdir(this.root, { recursive: true });
      this.onProgress({ status: 'preparing', progress: 0, message: 'Checking the GitHub release...' });
      const asset = await this.resolveAsset(signal);

      const current = this.installed();
      if (current && current.id === asset.id && current.verified) {
        this.onProgress({
          status: 'installed',
          progress: 100,
          message: this.label + ' is already installed.',
        });
        return { installed: current, reused: true };
      }

      const staging = path.join(this.root, 'downloads');
      const archive = path.join(staging, asset.asset);
      const parts = Array.isArray(asset.parts) && asset.parts.length
        ? asset.parts
        : [asset];
      const totalBytes = parts.reduce((sum, part) => sum + part.size, 0) || asset.size;
      let completedBytes = 0;
      const partFiles = [];
      for (const part of parts) {
        const destination = path.join(staging, part.asset);
        await this.downloader.downloadAsset(part, destination, {
          signal,
          onBytes: (downloaded) => {
            const soFar = completedBytes + downloaded;
            const ratio = totalBytes > 0 ? Math.min(1, soFar / totalBytes) : 0;
            this.onProgress({
              status: 'downloading',
              progress: Math.floor(ratio * 88),
              downloadedBytes: soFar,
              totalBytes,
              message: 'Downloading ' + this.label + '...',
            });
          },
        });
        completedBytes += part.size;
        partFiles.push(destination);
      }
      if (signal.aborted) throw new DownloadCancelledError(this.label);
      this.onProgress({ status: 'installing', progress: 89, message: 'Assembling ' + this.label + '...' });
      await this.assembleArchive(asset, partFiles, archive, signal);

      if (signal.aborted) throw new DownloadCancelledError(this.label);
      this.onProgress({ status: 'installing', progress: 91, message: 'Unpacking ' + this.label + '...' });

      await fsPromises.rm(pending, { recursive: true, force: true });
      await extractZip(archive, pending, { signal });

      if (!this.filesPresent(pending)) {
        await fsPromises.rm(pending, { recursive: true, force: true });
        throw new ReleaseError(this.label + ' download is missing Python or PyTorch.', 'PACK_INCOMPLETE');
      }

      let verification = { importOk: false, tensorProbeOk: false, qwenProbeOk: false };
      if (this.validateRuntime) {
        this.onProgress({ status: 'installing', progress: 94, message: 'Verifying ' + this.label + '...' });
        try {
          verification = (await this.validateRuntime(this.pythonPath(pending), signal)) || verification;
        } catch (err) {
          await fsPromises.rm(pending, { recursive: true, force: true });
          throw new ReleaseError(
            this.label + ' could not be verified: ' + (err && err.message ? err.message : err),
            'PACK_UNHEALTHY'
          );
        }
      } else {
        verification.importOk = true;
      }

      const previous = fs.existsSync(target);
      const backup = target + '.previous';
      await fsPromises.rm(backup, { recursive: true, force: true });
      try {
        if (previous) await fsPromises.rename(target, backup);
        await fsPromises.rename(pending, target);
      } catch (err) {
        await fsPromises.rm(target, { recursive: true, force: true });
        if (previous && fs.existsSync(backup)) await fsPromises.rename(backup, target);
        throw err;
      }
      await fsPromises.rm(backup, { recursive: true, force: true });
      await fsPromises.rm(staging, { recursive: true, force: true });

      await this.writeReceipt(asset, verification);
      const installed = this.installed();
      if (!installed) {
        throw new ReleaseError('The installed ' + this.label + ' pack could not be opened.', 'INSTALL_FAILED');
      }
      this.onProgress({
        status: 'installed',
        progress: 100,
        message: verification.tensorProbeOk
          ? this.label + ' is installed and verified.'
          : this.label + ' is installed. Dictation will confirm the GPU before using it.',
      });
      return { installed, reused: false, verification };
    } catch (err) {
      throw friendlyFetchError(err, this.label);
    } finally {
      this.abortController = null;
    }
  }

  async remove() {
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
  }
}

module.exports = {
  QwenAccelPackManager,
  DEFAULT_REPOSITORY,
  RECEIPT_SCHEMA,
  MARKER_NAME,
  advertisedFor,
  catalog,
  runtimeBinDirs,
  pathWithRuntimeBins,
};
