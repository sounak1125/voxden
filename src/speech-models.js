'use strict';

const fs = require('fs');
const path = require('path');
const { ReleaseDownloader, ReleaseError, DownloadCancelledError, isInside,
  readJsonSync, writeJsonAtomic, statMatches, safeId, safeName } = require('./release-download');
const catalog = require('./speech-model-catalog.json');

// Qwen and both Parakeet precisions are downloaded only by explicit setup.
// Receipts are committed last; partial files stay in staging for Resume.
class SpeechModelsManager {
  constructor(options) {
    this.root = path.resolve(options.root);
    this.packs = options.packs || catalog.packs;
    this.onProgress = options.onProgress || (() => {});
    this.cacheRoot = options.cacheRoot || null;
    this.downloader = new ReleaseDownloader({ ...options, cancelLabel: 'Speech models' });
    this.abortController = null;
    for (const pack of this.packs) {
      safeId(pack.id, 'model id');
      if (!Array.isArray(pack.files) || !pack.files.length) throw new Error('Empty speech model');
      for (const file of pack.files) safeName(file.path, 'model file');
    }
  }

  directory(id) { return path.join(this.root, safeId(id, 'model id')); }
  receiptPath(id) { return path.join(this.root, 'current-' + safeId(id, 'model id') + '.json'); }

  installed(id) {
    const pack = this.packs.find(p => p.id === id);
    const receipt = readJsonSync(this.receiptPath(id));
    if (!pack || !receipt || receipt.revision !== pack.revision || !Array.isArray(receipt.files)
      || receipt.files.length !== pack.files.length) return null;
    const dir = this.directory(id);
    for (const expected of pack.files) {
      const file = receipt.files.find(f => f.path === expected.path);
      if (!file || file.sha256 !== expected.sha256 || file.size !== expected.size
        || !statMatches(path.join(dir, expected.path), file)) return null;
    }
    return { id, path: dir };
  }

  snapshot() {
    const packs = this.packs.map(pack => ({ id: pack.id, name: pack.name,
      installed: !!this.installed(pack.id),
      downloadBytes: pack.files.reduce((n, file) => n + file.size, 0) }));
    return { installed: packs.every(p => p.installed), packs,
      downloadBytes: packs.filter(p => !p.installed).reduce((n, p) => n + p.downloadBytes, 0) };
  }

  cancel() { if (this.abortController) this.abortController.abort(); }

  async reuseCachedFile(pack, file, destination, signal) {
    if (!this.cacheRoot || fs.existsSync(destination)) return;
    const hubName = 'models--' + pack.repository.replaceAll('/', '--');
    const candidates = pack.id === 'qwen3-asr'
      ? [path.join(this.cacheRoot, 'huggingface', 'hub', hubName, 'snapshots', pack.revision, file.path)]
      : [path.join(this.cacheRoot, pack.id === 'parakeet'
        ? 'parakeet-tdt-0.6b-v2' : 'parakeet-tdt-0.6b-v2-fp32', file.path)];
    for (const candidate of candidates) {
      if (signal.aborted) throw new DownloadCancelledError('Speech models');
      if (await this.downloader.verifyFile(candidate, file)) {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(candidate, destination);
        return;
      }
    }
  }

  async install() {
    if (this.abortController) throw new ReleaseError('Speech model setup is busy.', 'DOWNLOAD_ACTIVE');
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      const pendingPacks = this.packs.filter(p => !this.installed(p.id));
      const total = pendingPacks.reduce((n, p) => n + p.files.reduce((a, f) => a + f.size, 0), 0);
      let completed = 0;
      for (const pack of pendingPacks) {
        const staging = path.join(this.root, 'downloads', pack.id);
        const records = [];
        for (const file of pack.files) {
          if (signal.aborted) throw new DownloadCancelledError('Speech models');
          this.onProgress({ status: 'installing', progress: Math.floor(99 * completed / total),
            message: 'Checking saved files for ' + pack.name + '…' });
          await this.reuseCachedFile(pack, file, path.join(staging, file.path), signal);
          const record = await this.downloader.downloadAsset({ ...file, asset: file.path }, path.join(staging, file.path), {
            signal,
            onBytes: bytes => this.onProgress({ status: 'downloading',
              progress: Math.floor(99 * (completed + bytes) / total),
              downloadedBytes: completed + bytes, totalBytes: total,
              message: 'Downloading ' + pack.name + '…' }),
          });
          records.push({ path: file.path, ...record });
          completed += file.size;
        }
        if (signal.aborted) throw new DownloadCancelledError('Speech models');
        const target = this.directory(pack.id);
        const backup = target + '.previous';
        await fs.promises.rm(backup, { recursive: true, force: true });
        const previous = fs.existsSync(target);
        if (previous) await fs.promises.rename(target, backup);
        try {
          await fs.promises.rename(staging, target);
          await writeJsonAtomic(this.receiptPath(pack.id), { revision: pack.revision, files: records });
        } catch (err) {
          await fs.promises.rm(target, { recursive: true, force: true });
          if (previous) await fs.promises.rename(backup, target);
          throw err;
        }
        await fs.promises.rm(backup, { recursive: true, force: true });
      }
      this.onProgress({ status: 'installed', progress: 100, message: 'All speech models are installed.' });
    } catch (err) {
      if (signal.aborted) throw new DownloadCancelledError('Speech models');
      throw err;
    } finally { this.abortController = null; }
  }

  async remove() {
    if (this.abortController) throw new ReleaseError('Cancel setup before removing models.', 'DOWNLOAD_ACTIVE');
    for (const pack of this.packs) {
      for (const target of [this.directory(pack.id), this.directory(pack.id) + '.previous', this.receiptPath(pack.id)]) {
        if (!isInside(this.root, target) || target === this.root) throw new Error('Unsafe speech model path');
        await fs.promises.rm(target, { recursive: true, force: true });
      }
    }
    await fs.promises.rm(path.join(this.root, 'downloads'), { recursive: true, force: true });
  }
}

module.exports = { SpeechModelsManager };
