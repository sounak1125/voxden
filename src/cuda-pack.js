'use strict';

// Installs the optional CUDA pack: the two cuBLAS DLLs CTranslate2 needs
// before Whisper will run on an NVIDIA GPU.
//
// It is optional because it is large and because most machines cannot use it.
// It is a separate download rather than part of the speech engine for the same
// reason a game installs DirectX only where it is missing: folding 553 MB into
// the base runtime would charge every AMD, Intel and GPU-less user for a file
// their machine will never load.
//
// AMD and Intel have no counterpart here and need none. DirectML is already in
// the base runtime, so their GPU path costs nothing to reach -- see gpu.js,
// which is where the three vendors are reconciled into one plan the UI can
// render.
//
// Nothing in the sidecar changed to support this. find_cuda_bin_dirs already
// scans nvidia/*/bin below whatever root it is given, and already honours
// VOXDEN_CUDA_BIN, so the pack is installed in the layout pip would have
// produced and pointed at with that variable.

const fs = require('fs');
const path = require('path');
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
const DEFAULT_RELEASE_TAG = 'cuda-pack-v1';
const MANIFEST_ASSET = 'voxden-cuda-pack.json';
const PACK_ASSET = 'voxden-cuda-pack-win-x64.zip';
const RECEIPT_SCHEMA = 1;

// The file whose presence proves the install: it is the one CTranslate2 opens,
// and the one cublas_available() in the sidecar tests for.
const PROOF_DLL = path.join('nvidia', 'cublas', 'bin', 'cublas64_12.dll');

const ADVERTISED = Object.freeze({
  name: 'NVIDIA GPU support',
  downloadBytes: 553 * 1000 * 1000,
  downloadSize: '553 MB',
  installedSize: '771 MB',
});

function friendlyFetchError(err) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError('NVIDIA GPU support');
  }
  if (err instanceof ReleaseError) return err;
  return new ReleaseError(
    'Could not reach the Voxden GPU-support release on GitHub. Check the connection and try again.',
    'NETWORK_ERROR'
  );
}

class CudaPackManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('CudaPackManager requires a persistent root directory.');
    this.root = path.resolve(opts.root);
    this.repository = String(opts.repository || DEFAULT_REPOSITORY);
    this.releaseTag = String(opts.releaseTag || DEFAULT_RELEASE_TAG);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.abortController = null;
    this.downloader = new ReleaseDownloader({
      repository: this.repository,
      releaseTag: this.releaseTag,
      releaseApiUrl: opts.releaseApiUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: 'Voxden-Cuda-Pack',
      cancelLabel: 'NVIDIA GPU support',
      segmentSize: opts.segmentSize,
      segmentThreshold: opts.segmentThreshold,
      segmentConcurrency: opts.segmentConcurrency,
    });
  }

  receiptPath() {
    return path.join(this.root, 'current-cuda-pack.json');
  }

  // What VOXDEN_CUDA_BIN is set to. The sidecar scans for nvidia/*/bin below
  // whatever it is given, so this is the directory that contains 'nvidia'.
  packDir() {
    return path.join(this.root, 'pack');
  }

  installed() {
    const receipt = readJsonSync(this.receiptPath());
    if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA || !receipt.proof) return null;
    const proofPath = path.resolve(this.root, receipt.proof.path || '');
    if (!isInside(this.root, proofPath)) return null;
    if (!statMatches(proofPath, receipt.proof)) return null;
    return {
      id: receipt.id,
      packDir: this.packDir(),
      installedAt: receipt.installedAt || '',
    };
  }

  snapshot() {
    const installed = this.installed();
    return Object.assign({}, ADVERTISED, {
      installed: !!installed,
      packDir: installed ? installed.packDir : null,
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
    const release = await this.downloader.fetchRelease(signal);
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    let declared = {};
    const manifestAsset = assets.get(MANIFEST_ASSET);
    if (manifestAsset) {
      const bytes = await this.downloader.fetchSmallAsset(manifestAsset, signal);
      let parsed = null;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch (err) {
        throw new ReleaseError('The GPU-support manifest contains invalid JSON.', 'INVALID_MANIFEST');
      }
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.pack) {
        throw new ReleaseError('The GPU-support manifest format is not supported.', 'INVALID_MANIFEST');
      }
      declared = parsed.pack;
    }
    const name = String(declared.asset || PACK_ASSET);
    if (name !== PACK_ASSET) {
      throw new ReleaseError('The GPU-support manifest names an unexpected asset.', 'INVALID_MANIFEST');
    }
    // Size and digest come from GitHub's own asset metadata, the same as every
    // other download here: the manifest is a fallback, never a source of trust.
    const asset = this.downloader.describeAsset(assets.get(name), name, {
      sha256: declared.sha256,
      size: declared.size,
    });
    asset.id = String(declared.id || 'cuda-win-x64');
    return asset;
  }

  async install() {
    if (this.abortController) {
      throw new ReleaseError('NVIDIA GPU support is already downloading.', 'DOWNLOAD_ACTIVE');
    }
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    try {
      await fsPromises.mkdir(this.root, { recursive: true });
      this.onProgress({ status: 'preparing', progress: 0, message: 'Checking the GitHub release...' });
      const asset = await this.resolveAsset(signal);

      const current = this.installed();
      if (current && current.id === asset.id) {
        this.onProgress({
          status: 'installed',
          progress: 100,
          message: 'NVIDIA GPU support is already installed.',
        });
        return { installed: current, reused: true };
      }

      const staging = path.join(this.root, 'downloads');
      const archive = path.join(staging, asset.asset);
      await this.downloader.downloadAsset(asset, archive, {
        signal,
        onBytes: (downloaded, total) => {
          // Two files unpack in a moment, unlike the runtime's two thousand,
          // so the bar can spend almost all of itself on the transfer.
          const ratio = total > 0 ? downloaded / total : 0;
          this.onProgress({
            status: 'downloading',
            progress: Math.floor(ratio * 95),
            downloadedBytes: downloaded,
            totalBytes: total,
            message: 'Downloading NVIDIA GPU support...',
          });
        },
      });

      if (signal.aborted) throw new DownloadCancelledError('NVIDIA GPU support');
      this.onProgress({ status: 'installing', progress: 95, message: 'Unpacking NVIDIA GPU support...' });

      // Two files, but the same extract-beside-and-swap the runtime uses. Half
      // a pack that looks installed fails inside CTranslate2 rather than here,
      // which is a much worse place to find out.
      const target = this.packDir();
      const pending = target + '.pending';
      await fsPromises.rm(pending, { recursive: true, force: true });
      await extractZip(archive, pending, { signal });

      if (!fs.existsSync(path.join(pending, PROOF_DLL))) {
        await fsPromises.rm(pending, { recursive: true, force: true });
        throw new ReleaseError('The GPU-support download is missing cuBLAS.', 'PACK_INCOMPLETE');
      }

      await fsPromises.rm(target, { recursive: true, force: true });
      await fsPromises.rename(pending, target);
      await fsPromises.rm(staging, { recursive: true, force: true });

      const proofPath = path.join(target, PROOF_DLL);
      const stat = await fsPromises.stat(proofPath);
      await writeJsonAtomic(this.receiptPath(), {
        schemaVersion: RECEIPT_SCHEMA,
        id: asset.id,
        installedAt: new Date().toISOString(),
        releaseTag: this.releaseTag,
        proof: {
          path: path.relative(this.root, proofPath),
          size: stat.size,
          verifiedMtimeMs: stat.mtimeMs,
        },
      });

      const installed = this.installed();
      if (!installed) {
        throw new ReleaseError('The installed GPU support could not be opened.', 'INSTALL_FAILED');
      }
      this.onProgress({
        status: 'installed',
        progress: 100,
        message: 'NVIDIA GPU support is installed. Restart dictation to use it.',
      });
      return { installed, reused: false };
    } catch (err) {
      throw friendlyFetchError(err);
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
    await fsPromises.rm(target, { recursive: true, force: true });
    await fsPromises.rm(target + '.pending', { recursive: true, force: true });
    await fsPromises.rm(path.join(this.root, 'downloads'), { recursive: true, force: true });
    await fsPromises.rm(receiptPath, { force: true });
    return !!receipt;
  }
}

module.exports = {
  CudaPackManager,
  DEFAULT_REPOSITORY,
  DEFAULT_RELEASE_TAG,
  MANIFEST_ASSET,
  PACK_ASSET,
  PROOF_DLL,
  ADVERTISED,
};
