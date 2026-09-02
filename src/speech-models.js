'use strict';

const fs = require('fs');
const path = require('path');
const { ReleaseDownloader, ReleaseError, DownloadCancelledError, isInside,
  readJsonSync, writeJsonAtomic, statMatches, safeId, safeName } = require('./release-download');
const catalog = require('./speech-model-catalog.json');
const { removeTree } = require('./clean-remove');

// Qwen and both Parakeet precisions are downloaded only by explicit setup, and
// only the ones src/model-plan.js says this configuration can use -- install()
// takes the list. Receipts are committed last; partial files stay in staging
// so an interrupted download resumes rather than restarting.
class SpeechModelsManager {
  constructor(options) {
    this.root = path.resolve(options.root);
    this.packs = options.packs || catalog.packs;
    this.onProgress = options.onProgress || (() => {});
    this.cacheRoot = options.cacheRoot || null;
    this.purgeLegacyCopies = options.purgeLegacy !== false;
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

  // Where an older Voxden put the same weights: the Hugging Face cache for
  // Qwen, a bare directory per precision for Parakeet. The first entry is the
  // model itself; the rest are its lock files.
  legacyDirs(pack) {
    if (!this.cacheRoot) return [];
    if (pack.id === 'qwen3-asr') {
      const hub = path.join(this.cacheRoot, 'huggingface', 'hub');
      const hubName = 'models--' + pack.repository.replaceAll('/', '--');
      return [path.join(hub, hubName), path.join(hub, '.locks', hubName)];
    }
    return [path.join(this.cacheRoot, pack.id === 'parakeet' ? 'parakeet-tdt-0.6b-v2' : 'parakeet-tdt-0.6b-v2-fp32')];
  }

  legacyFile(pack, file) {
    const [dir] = this.legacyDirs(pack);
    if (!dir) return null;
    return pack.id === 'qwen3-asr' ? path.join(dir, 'snapshots', pack.revision, file.path) : path.join(dir, file.path);
  }

  // Setup used to copy a cached model into the managed store and leave the
  // original, which is how a PC ended up holding every model twice. Once the
  // managed copy is what the engine loads, the cached one is only disk space.
  // Best effort: a copy that cannot go yet is not worth failing an install
  // or a removal over.
  async purgeLegacy(ids) {
    if (!this.purgeLegacyCopies || !this.cacheRoot) return [];
    const purged = [];
    for (const pack of this.select(ids)) {
      for (const dir of this.legacyDirs(pack)) {
        if (!isInside(this.cacheRoot, dir) || dir === this.cacheRoot) continue;
        try {
          if (await removeTree(dir)) purged.push(dir);
        } catch (_) { /* still open somewhere; the next launch sweeps it */ }
      }
    }
    return purged;
  }

  async reuseCachedFile(pack, file, destination, signal) {
    if (!this.cacheRoot || fs.existsSync(destination)) return;
    const candidate = this.legacyFile(pack, file);
    if (!candidate) return;
    if (signal.aborted) throw new DownloadCancelledError('Speech models');
    if (await this.downloader.verifyFile(candidate, file)) {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(candidate, destination);
    }
  }

  // Which packs a request covers. No argument means every pack, which is what
  // the all-or-nothing setup used to do and what an older caller still expects;
  // a list means exactly those. src/model-plan.js decides what goes in the list
  // so that a first run fetches the engine it will actually use rather than all
  // three plus a duplicate of one of them.
  select(ids) {
    if (ids == null) return this.packs.slice();
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const packs = this.packs.filter(p => wanted.has(p.id));
    for (const id of wanted) {
      if (!packs.some(p => p.id === id)) throw new ReleaseError('Unknown speech model: ' + id, 'UNKNOWN_MODEL');
    }
    return packs;
  }

  pendingBytes(ids) {
    return this.select(ids)
      .filter(p => !this.installed(p.id))
      .reduce((n, p) => n + p.files.reduce((a, f) => a + f.size, 0), 0);
  }

  async install(ids) {
    if (this.abortController) throw new ReleaseError('Speech model setup is busy.', 'DOWNLOAD_ACTIVE');
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      const pendingPacks = this.select(ids).filter(p => !this.installed(p.id));
      if (!pendingPacks.length) {
        this.onProgress({ status: 'installed', progress: 100, message: 'Speech models are up to date.' });
        return;
      }
      const total = pendingPacks.reduce((n, p) => n + p.files.reduce((a, f) => a + f.size, 0), 0) || 1;
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
        // The managed copy is now the one the engine loads; the cached copy
        // it may have been taken from is a duplicate from here on.
        await this.purgeLegacy([pack.id]);
      }
      this.onProgress({ status: 'installed', progress: 100,
        message: pendingPacks.map(p => p.name).join(' and ') + ' installed.' });
    } catch (err) {
      if (signal.aborted) throw new DownloadCancelledError('Speech models');
      throw err;
    } finally { this.abortController = null; }
  }

  async remove(ids) {
    if (this.abortController) throw new ReleaseError('Cancel setup before removing models.', 'DOWNLOAD_ACTIVE');
    for (const pack of this.select(ids)) {
      for (const target of [this.directory(pack.id), this.directory(pack.id) + '.previous', this.receiptPath(pack.id)]) {
        if (!isInside(this.root, target) || target === this.root) throw new Error('Unsafe speech model path');
        await removeTree(target);
      }
    }
    // Staging only belongs to a whole-store removal; a single pack leaves any
    // other pack's resumable download alone.
    if (ids == null) await removeTree(path.join(this.root, 'downloads'));
    await this.purgeLegacy(ids);
  }
}

module.exports = { SpeechModelsManager };
