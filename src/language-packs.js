'use strict';

const fs = require('fs');
const path = require('path');
const { removeTree } = require('./clean-remove');
const { pipeline } = require('stream/promises');
const {
  ReleaseError,
  DownloadCancelledError,
  ReleaseDownloader,
  parseDigest,
  normalizeSha256,
  safeName,
  safeId,
  isInside,
  sha256File,
  readJson,
  readJsonSync,
  writeJsonAtomic,
  statMatches,
} = require('./release-download');

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

// Kept as the module's own name for the error type so callers that catch a
// LanguagePackError keep working; the implementation moved to release-download.
const LanguagePackError = ReleaseError;

function normalizeTier(value) {
  return value === 'enhanced' ? 'enhanced' : 'standard';
}

function friendlyFetchError(err) {
  if (err instanceof DownloadCancelledError || (err && err.name === 'AbortError')) {
    return new DownloadCancelledError('Language pack');
  }
  if (err instanceof ReleaseError) return err;
  return new ReleaseError(
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
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    this.abortController = null;
    this.downloader = new ReleaseDownloader({
      repository: this.repository,
      releaseTag: this.releaseTag,
      releaseApiUrl: opts.releaseApiUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: 'Voxden-Language-Packs',
      cancelLabel: 'Language pack',
      segmentSize: opts.segmentSize,
      segmentThreshold: opts.segmentThreshold,
      segmentConcurrency: opts.segmentConcurrency,
    });
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
    const release = await this.downloader.fetchRelease(signal);
    const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_ASSET);
    if (!manifestAsset) {
      throw new LanguagePackError('The GitHub release is missing ' + MANIFEST_ASSET + '.', 'MANIFEST_MISSING');
    }
    const bytes = await this.downloader.fetchSmallAsset(manifestAsset, signal);
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new LanguagePackError('The language-pack manifest contains invalid JSON.', 'INVALID_MANIFEST');
    }
    return this.validateManifest(raw, release);
  }

  async assembleModel(pack, partFiles, destination, signal) {
    const expected = { size: pack.modelSize, sha256: pack.modelSha256 };
    const alreadyInstalled = await this.downloader.verifyFile(destination, expected);
    if (alreadyInstalled) return alreadyInstalled;
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    if (partFiles.length === 1) {
      const verifiedPart = await this.downloader.verifyFile(partFiles[0], expected);
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
    const verified = await this.downloader.verifyFile(partial, expected);
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
        const verified = await this.downloader.downloadAsset(asset, destination, {
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
        await this.downloader.downloadAsset(asset, destination, {
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
    await removeTree(packPath);
    await removeTree(path.join(this.root, 'downloads', safeId(receipt.packId, 'pack id')));
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
