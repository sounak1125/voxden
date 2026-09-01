'use strict';

// Verified downloads of GitHub Release assets.
//
// This was the download half of language-packs.js. The speech-engine runtime
// needs exactly the same guarantees -- SHA-256 against GitHub's own digest,
// resumable, several connections for a large asset -- so it lives here and both
// managers share one implementation rather than two that drift apart.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const fsPromises = fs.promises;

class ReleaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code || 'RELEASE_ERROR';
  }
}

class DownloadCancelledError extends ReleaseError {
  constructor(label) {
    super((label || 'Language pack')
      + ' download cancelled. The partial download was kept so it can resume later.', 'CANCELLED');
    this.name = 'DownloadCancelledError';
  }
}

function parseDigest(value) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(value || '').trim());
  return match ? match[1].toLowerCase() : null;
}

function normalizeSha256(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

// Network streams report progress once per chunk. Calling a renderer or tray
// refresh from every one of those callbacks can turn a fast download into
// thousands of synchronous UI rebuilds. Give each download its own gate so it
// reports status transitions immediately and byte progress once per integer
// percentage point.
function createDownloadProgressGate() {
  let lastKey = '';
  return function shouldReportProgress(state) {
    const current = state || {};
    if (current.status !== 'downloading') {
      lastKey = '';
      return true;
    }
    const percent = Number.isFinite(current.progress) ? Math.floor(current.progress) : -1;
    const key = percent + ':' + String(current.asset || '');
    if (key === lastKey) return false;
    lastKey = key;
    return true;
  };
}

function safeName(value, label) {
  const raw = String(value || '').trim();
  if (!raw || raw !== path.basename(raw) || raw === '.' || raw === '..' || /[\\/]/.test(raw)) {
    throw new ReleaseError('Invalid ' + label + ' in the release manifest.', 'INVALID_MANIFEST');
  }
  return raw;
}

function safeId(value, label) {
  const raw = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(raw)) {
    throw new ReleaseError('Invalid ' + label + ' in the release manifest.', 'INVALID_MANIFEST');
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

function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

class ReleaseDownloader {
  constructor(options) {
    const opts = options || {};
    this.repository = String(opts.repository || '');
    this.releaseTag = String(opts.releaseTag || '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.userAgent = String(opts.userAgent || 'Voxden');
    this.cancelLabel = String(opts.cancelLabel || 'Language pack');
    this.releaseApiUrl = opts.releaseApiUrl
      || 'https://api.github.com/repos/' + this.repository + '/releases/tags/' + encodeURIComponent(this.releaseTag);
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

  cancelled() {
    return new DownloadCancelledError(this.cancelLabel);
  }

  async fetchRelease(signal) {
    if (typeof this.fetch !== 'function') {
      throw new ReleaseError('Downloads are unavailable in this build.', 'NO_FETCH');
    }
    const response = await this.fetch(this.releaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
      },
      signal,
    });
    if (response && response.status === 404) {
      throw new ReleaseError('That Voxden release has not been published yet.', 'RELEASE_NOT_FOUND');
    }
    if (!response || !response.ok) {
      throw new ReleaseError('GitHub could not provide the release.', 'RELEASE_UNAVAILABLE');
    }
    const release = await response.json();
    if (!release || !Array.isArray(release.assets)) {
      throw new ReleaseError('GitHub returned an invalid release.', 'INVALID_RELEASE');
    }
    return release;
  }

  async fetchSmallAsset(asset, signal) {
    const response = await this.fetch(asset.browser_download_url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': this.userAgent },
      signal,
    });
    if (!response || !response.ok) {
      throw new ReleaseError('Could not download the release manifest.', 'MANIFEST_UNAVAILABLE');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1024 * 1024) {
      throw new ReleaseError('The release manifest is unexpectedly large.', 'INVALID_MANIFEST');
    }
    const expected = parseDigest(asset.digest);
    if (expected && sha256Buffer(buffer) !== expected) {
      throw new ReleaseError('The release manifest failed verification.', 'CHECKSUM_MISMATCH');
    }
    return buffer;
  }

  // Turns a release asset into the shape downloadAsset expects: a verifiable
  // size and digest, taken from GitHub rather than from the manifest, so a
  // tampered manifest cannot describe an asset into being trusted.
  describeAsset(releaseAsset, name, extra) {
    if (!releaseAsset || !releaseAsset.browser_download_url) {
      throw new ReleaseError('Release asset "' + name + '" is missing.', 'ASSET_MISSING');
    }
    const item = Object.assign({}, extra || {});
    item.asset = name;
    item.url = releaseAsset.browser_download_url;
    item.size = Number(releaseAsset.size || item.size);
    item.sha256 = parseDigest(releaseAsset.digest) || normalizeSha256(item.sha256);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || !item.sha256) {
      throw new ReleaseError(
        'Release asset "' + name + '" has no verifiable size or SHA-256 digest.',
        'INVALID_ASSET'
      );
    }
    return item;
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

  // The release CDN gives a single connection roughly a fifth of the bandwidth
  // this link can carry, so large assets are pulled as concurrent byte ranges
  // written straight into their final offsets.
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
          'User-Agent': this.userAgent,
          Range: 'bytes=' + segment.start + '-' + segment.end,
        },
        signal,
      });
      if (signal && signal.aborted) throw this.cancelled();
      if (!response || !response.body || response.status !== 206) {
        throw new ReleaseError('The download server ignored a range request.', 'RANGE_UNSUPPORTED');
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
          failure = this.cancelled();
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
      throw new ReleaseError('"' + asset.asset + '" failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
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
        // Otherwise a corrupt set of "completed" segments is reused forever
        // and Retry can never repair the download.
        if (err && err.code === 'CHECKSUM_MISMATCH') {
          await fsPromises.rm(partial, { force: true });
          await fsPromises.rm(partial + '.segments', { force: true });
        }
        if (!(err instanceof ReleaseError) || err.code !== 'RANGE_UNSUPPORTED') throw err;
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

    const headers = { Accept: 'application/octet-stream', 'User-Agent': this.userAgent };
    if (offset > 0) headers.Range = 'bytes=' + offset + '-';
    let response = await this.fetch(asset.url, { headers, signal });
    if (signal && signal.aborted) throw this.cancelled();
    if (offset > 0 && response && response.status === 416) {
      await fsPromises.truncate(partial, 0);
      offset = 0;
      delete headers.Range;
      response = await this.fetch(asset.url, { headers, signal });
    }
    if (!response || !response.ok || !response.body) {
      throw new ReleaseError('Could not download "' + asset.asset + '".', 'DOWNLOAD_FAILED');
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
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) throw this.cancelled();
      throw err;
    }
    const verified = await this.verifyFile(partial, asset);
    if (!verified) {
      throw new ReleaseError('"' + asset.asset + '" failed SHA-256 verification.', 'CHECKSUM_MISMATCH');
    }
    await fsPromises.rm(destination, { force: true });
    await fsPromises.rename(partial, destination);
    return verified;
  }
}

module.exports = {
  ReleaseError,
  DownloadCancelledError,
  ReleaseDownloader,
  parseDigest,
  normalizeSha256,
  createDownloadProgressGate,
  safeName,
  safeId,
  isInside,
  sha256File,
  sha256Buffer,
  readJson,
  readJsonSync,
  writeJsonAtomic,
  statMatches,
};
