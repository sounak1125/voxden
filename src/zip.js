'use strict';

// A zip reader, because the speech-engine runtime arrives as one archive of a
// few thousand small files and Node ships no unzip.
//
// It reads the central directory rather than scanning local headers, so an
// entry's declared name and sizes come from the one authoritative place, and
// every name is resolved against the destination before anything is written.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const fsPromises = fs.promises;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    this.code = 'ZIP_ERROR';
  }
}

async function readChunk(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// The end-of-central-directory record sits at the very end, behind a comment of
// up to 64KB, so it has to be found by scanning backwards for its signature.
async function findEocd(handle, fileSize) {
  const maxLookback = Math.min(fileSize, 0xffff + 22);
  const buffer = await readChunk(handle, maxLookback, fileSize - maxLookback);
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const base = fileSize - maxLookback + i;
    let entries = buffer.readUInt16LE(i + 10);
    let directorySize = buffer.readUInt32LE(i + 12);
    let directoryOffset = buffer.readUInt32LE(i + 16);
    // Zip64: the 32-bit fields saturate and the real values live in a separate
    // record pointed at by a locator immediately before this one.
    if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      const locator = await readChunk(handle, 20, base - 20);
      if (locator.length === 20 && locator.readUInt32LE(0) === EOCD64_LOCATOR_SIGNATURE) {
        const eocd64Offset = Number(locator.readBigUInt64LE(8));
        const eocd64 = await readChunk(handle, 56, eocd64Offset);
        if (eocd64.length >= 56 && eocd64.readUInt32LE(0) === EOCD64_SIGNATURE) {
          entries = Number(eocd64.readBigUInt64LE(32));
          directorySize = Number(eocd64.readBigUInt64LE(40));
          directoryOffset = Number(eocd64.readBigUInt64LE(48));
        }
      }
    }
    return { entries, directorySize, directoryOffset };
  }
  throw new ZipError('The archive is not a zip file, or is truncated.');
}

function zip64Extra(extra, entry) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === 0x0001) {
      let cursor = 0;
      if (entry.uncompressedSize === 0xffffffff && cursor + 8 <= body.length) {
        entry.uncompressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.compressedSize === 0xffffffff && cursor + 8 <= body.length) {
        entry.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localOffset === 0xffffffff && cursor + 8 <= body.length) {
        entry.localOffset = Number(body.readBigUInt64LE(cursor));
      }
      return;
    }
    offset += 4 + size;
  }
}

async function readCentralDirectory(handle, eocd) {
  const raw = await readChunk(handle, eocd.directorySize, eocd.directoryOffset);
  const entries = [];
  let offset = 0;
  while (offset + 46 <= raw.length) {
    if (raw.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const flags = raw.readUInt16LE(offset + 8);
    const method = raw.readUInt16LE(offset + 10);
    const nameLength = raw.readUInt16LE(offset + 28);
    const extraLength = raw.readUInt16LE(offset + 30);
    const commentLength = raw.readUInt16LE(offset + 32);
    const externalAttributes = raw.readUInt32LE(offset + 38);
    const entry = {
      // Bit 11 means the name is UTF-8. Everything this ships produces UTF-8
      // names; anything older is ASCII, where the two decodings agree.
      name: raw.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method,
      flags,
      compressedSize: raw.readUInt32LE(offset + 20),
      uncompressedSize: raw.readUInt32LE(offset + 24),
      localOffset: raw.readUInt32LE(offset + 42),
      externalAttributes,
    };
    const extra = raw.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    if (extra.length) zip64Extra(extra, entry);
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Everything that makes an archive able to write outside its destination.
function safeEntryPath(destination, name) {
  const raw = String(name || '');
  if (!raw) throw new ZipError('The archive contains an entry with no name.');
  if (raw.includes('\0')) throw new ZipError('The archive contains an invalid entry name.');
  // Zip always uses forward slashes; a backslash in a name is either an attack
  // or a broken writer, and on Windows it would be a separator either way.
  if (raw.includes('\\')) throw new ZipError('The archive contains an invalid entry name: ' + raw);
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new ZipError('The archive contains an absolute path: ' + raw);
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new ZipError('The archive tries to escape its destination: ' + raw);
  }
  const target = path.resolve(destination, ...parts);
  const root = path.resolve(destination);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new ZipError('The archive tries to escape its destination: ' + raw);
  }
  return target;
}

function isDirectoryEntry(entry) {
  if (entry.name.endsWith('/')) return true;
  // MS-DOS directory attribute, for writers that omit the trailing slash.
  return (entry.externalAttributes & 0x10) !== 0 && entry.uncompressedSize === 0;
}

async function extractEntry(handle, entry, target) {
  // The local header repeats the name and extra field, at its own lengths, so
  // the data offset can only be computed by reading it.
  const header = await readChunk(handle, 30, entry.localOffset);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ZipError('The archive has a damaged entry: ' + entry.name);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;

  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  const input = fs.createReadStream('', {
    fd: handle.fd,
    start: dataOffset,
    end: dataOffset + Math.max(0, entry.compressedSize) - 1,
    autoClose: false,
  });
  const output = fs.createWriteStream(target);
  if (entry.compressedSize === 0) {
    await fsPromises.writeFile(target, Buffer.alloc(0));
    input.destroy();
    output.destroy();
    return;
  }
  if (entry.method === STORED) {
    await pipeline(input, output);
    return;
  }
  if (entry.method === DEFLATED) {
    await pipeline(input, zlib.createInflateRaw(), output);
    return;
  }
  throw new ZipError('The archive uses an unsupported compression method for ' + entry.name + '.');
}

/**
 * Extract `zipPath` into `destination`.
 * `onProgress(done, total)` is called as entries complete.
 */
async function extractZip(zipPath, destination, options) {
  const opts = options || {};
  const handle = await fsPromises.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new ZipError('The archive is empty or truncated.');
    const eocd = await findEocd(handle, size);
    const entries = await readCentralDirectory(handle, eocd);
    if (!entries.length) throw new ZipError('The archive contains no files.');

    // Resolve every path before writing anything, so a hostile entry halfway
    // through cannot leave a half-extracted tree behind.
    const planned = entries.map((entry) => ({
      entry,
      target: safeEntryPath(destination, entry.name),
    }));

    await fsPromises.mkdir(destination, { recursive: true });
    let done = 0;
    for (const { entry, target } of planned) {
      if (opts.signal && opts.signal.aborted) throw new ZipError('Extraction cancelled.');
      if (isDirectoryEntry(entry)) {
        await fsPromises.mkdir(target, { recursive: true });
      } else {
        await extractEntry(handle, entry, target);
      }
      done += 1;
      if (opts.onProgress) opts.onProgress(done, planned.length);
    }
    return { files: planned.length };
  } finally {
    await handle.close();
  }
}

module.exports = { extractZip, safeEntryPath, ZipError };
