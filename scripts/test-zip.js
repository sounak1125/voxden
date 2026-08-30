'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { extractZip, safeEntryPath, ZipError } = require('../src/zip');

let failed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n  ' + (err && err.message));
  }
}

async function okAsync(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n  ' + (err && err.message));
  }
}

// --- a minimal zip writer, so the tests do not depend on an external tool ----

function dosTime() {
  // Fixed date; nothing under test reads it.
  return { time: 0, date: 0x2100 };
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data || Buffer.alloc(0);
    const deflated = entry.stored ? raw : zlib.deflateRawSync(raw);
    const method = entry.stored ? 0 : 8;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const { time, date } = dosTime();

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(entry.directory ? 0x10 : 0, 38);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);

    offset += local.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-zip-'));

  // --- path safety: the guards that stop an archive writing outside itself ---
  const dest = path.join(root, 'dest');

  ok('a plain name resolves inside', () => {
    assert.strictEqual(safeEntryPath(dest, 'python.exe'), path.resolve(dest, 'python.exe'));
  });
  ok('a nested name resolves inside', () => {
    assert.strictEqual(
      safeEntryPath(dest, 'Lib/site-packages/x.py'),
      path.resolve(dest, 'Lib', 'site-packages', 'x.py')
    );
  });
  ok('a leading ./ is stripped', () => {
    assert.strictEqual(safeEntryPath(dest, './python.exe'), path.resolve(dest, 'python.exe'));
  });
  ok('traversal is refused', () => {
    assert.throws(() => safeEntryPath(dest, '../evil.exe'), ZipError);
  });
  ok('traversal in the middle is refused', () => {
    assert.throws(() => safeEntryPath(dest, 'Lib/../../evil.exe'), ZipError);
  });
  ok('a posix absolute path is refused', () => {
    assert.throws(() => safeEntryPath(dest, '/etc/passwd'), ZipError);
  });
  ok('a windows drive path is refused', () => {
    assert.throws(() => safeEntryPath(dest, 'C:/Windows/System32/evil.dll'), ZipError);
  });
  ok('a backslash separator is refused', () => {
    assert.throws(() => safeEntryPath(dest, '..\\evil.exe'), ZipError);
  });
  ok('a UNC path is refused', () => {
    assert.throws(() => safeEntryPath(dest, '\\\\server\\share\\evil.exe'), ZipError);
  });
  ok('a null byte is refused', () => {
    assert.throws(() => safeEntryPath(dest, 'ok\0.exe'), ZipError);
  });
  ok('an empty name is refused', () => {
    assert.throws(() => safeEntryPath(dest, ''), ZipError);
  });
  ok('a sibling directory sharing a prefix is refused', () => {
    // dest is <root>/dest, so <root>/dest-evil must not pass a prefix check.
    assert.throws(() => safeEntryPath(dest, '../dest-evil/x'), ZipError);
  });

  // --- round trip -----------------------------------------------------------
  await okAsync('extracts deflated and stored entries', async () => {
    const big = Buffer.from('voxden '.repeat(5000), 'utf8');
    const zipPath = path.join(root, 'ok.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'python.exe', data: Buffer.from('MZ fake binary') },
      { name: 'Lib/', directory: true, data: Buffer.alloc(0) },
      { name: 'Lib/site-packages/mod.py', data: big },
      { name: 'stored.txt', data: Buffer.from('no compression'), stored: true },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]));
    const out = path.join(root, 'out');
    const result = await extractZip(zipPath, out);
    assert.strictEqual(result.files, 5);
    assert.strictEqual(fs.readFileSync(path.join(out, 'python.exe'), 'utf8'), 'MZ fake binary');
    assert.deepStrictEqual(fs.readFileSync(path.join(out, 'Lib', 'site-packages', 'mod.py')), big);
    assert.strictEqual(fs.readFileSync(path.join(out, 'stored.txt'), 'utf8'), 'no compression');
    assert.strictEqual(fs.readFileSync(path.join(out, 'empty.txt'), 'utf8'), '');
    assert.ok(fs.statSync(path.join(out, 'Lib')).isDirectory());
  });

  await okAsync('reports progress once per entry', async () => {
    const zipPath = path.join(root, 'progress.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b.txt', data: Buffer.from('b') },
      { name: 'c.txt', data: Buffer.from('c') },
    ]));
    const seen = [];
    await extractZip(zipPath, path.join(root, 'out2'), {
      onProgress: (done, total) => seen.push(done + '/' + total),
    });
    assert.deepStrictEqual(seen, ['1/3', '2/3', '3/3']);
  });

  await okAsync('a hostile entry writes nothing at all', async () => {
    const zipPath = path.join(root, 'evil.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'safe.txt', data: Buffer.from('harmless') },
      { name: '../escaped.txt', data: Buffer.from('owned') },
    ]));
    const out = path.join(root, 'out3');
    await assert.rejects(() => extractZip(zipPath, out), ZipError);
    // Paths are resolved up front, so the safe entry never reached the disk.
    assert.strictEqual(fs.existsSync(path.join(out, 'safe.txt')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'escaped.txt')), false);
  });

  await okAsync('a truncated archive is refused', async () => {
    const zipPath = path.join(root, 'bad.zip');
    fs.writeFileSync(zipPath, Buffer.from('not a zip at all, really'));
    await assert.rejects(() => extractZip(zipPath, path.join(root, 'out4')), ZipError);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all zip tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
