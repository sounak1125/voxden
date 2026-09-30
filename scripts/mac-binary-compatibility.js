'use strict';

// Read ARM64 Mach-O deployment targets instead of trusting wheel filenames.
// Layout: https://github.com/apple-oss-distributions/xnu/tree/main/EXTERNAL_HEADERS/mach-o
// Read only headers/load commands, including for very large native libraries.
const fs = require('fs');
const path = require('path');
const { MINIMUM_MACOS_VERSION } = require('../src/mac-compatibility');
const ARM64 = 0x0100000c;

function packedVersion(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(String(version))) throw new Error('Invalid macOS version: ' + version);
  const [major, minor, patch = 0] = String(version).split('.').map(Number);
  if (major > 65535 || minor > 255 || patch > 255) throw new Error('Invalid macOS version: ' + version);
  return major * 65536 + minor * 256 + patch;
}
function versionString(value) { return [value >>> 16, (value >>> 8) & 255, value & 255].join('.'); }

function inspectMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    const read = (offset, size) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > length) throw new Error('Truncated Mach-O: ' + file);
      const data = Buffer.alloc(size);
      if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error('Could not read Mach-O: ' + file);
      return data;
    };
    if (length < 4) return [];
    const magic = read(0, 4).readUInt32BE();
    let slices = [{ offset: 0, size: length }];
    if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      const little = [0xbebafeca, 0xbfbafeca].includes(magic);
      const wide = [0xcafebabf, 0xbfbafeca].includes(magic);
      const head = read(0, 8);
      const count = little ? head.readUInt32LE(4) : head.readUInt32BE(4);
      // 0xCAFEBABE also opens every Java class file, whose next word is
      // minor << 16 | major with major >= 45. A real universal binary lists a
      // handful of architectures (file(1) reads fewer than 20 as one), so a
      // larger count is a class file, not a Mach-O.
      if (magic === 0xcafebabe && count >= 20) return [];
      if (!count || count > 64) throw new Error('Invalid Mach-O architecture count: ' + file);
      const size = wide ? 32 : 20;
      const arches = read(8, count * size);
      slices = [];
      for (let i = 0; i < count; i++) {
        const at = i * size;
        const u32 = relative => little ? arches.readUInt32LE(at + relative) : arches.readUInt32BE(at + relative);
        const u64 = relative => Number(little ? arches.readBigUInt64LE(at + relative) : arches.readBigUInt64BE(at + relative));
        if (u32(0) === ARM64) slices.push({ offset: wide ? u64(8) : u32(8), size: wide ? u64(16) : u32(12) });
      }
      if (!slices.length) throw new Error('Packaged Mach-O has no Apple silicon slice: ' + file);
    } else if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) return [];

    const results = [];
    for (const slice of slices) {
      if (!Number.isSafeInteger(slice.size) || slice.size < 32 || slice.offset + slice.size > length) throw new Error('Invalid Mach-O slice bounds: ' + file);
      const header = read(slice.offset, 32);
      const bigMagic = header.readUInt32BE(0);
      const little = [0xcefaedfe, 0xcffaedfe].includes(bigMagic);
      const u32 = offset => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
      if (![0xfeedface, 0xfeedfacf].includes(u32(0))) throw new Error('Invalid Mach-O slice: ' + file);
      // Relocatable object/debug files are not executable dependencies.
      const fileType = u32(12);
      if (![2, 6, 7, 8].includes(fileType)) continue;
      if (u32(4) !== ARM64) throw new Error('Packaged Mach-O has no Apple silicon slice: ' + file);
      const headSize = u32(0) === 0xfeedfacf ? 32 : 28;
      const count = u32(16);
      const commandsSize = u32(20);
      if (commandsSize > 4 * 1024 * 1024 || headSize + commandsSize > slice.size) throw new Error('Invalid Mach-O load-command size: ' + file);
      const commands = read(slice.offset + headSize, commandsSize);
      const field = offset => little ? commands.readUInt32LE(offset) : commands.readUInt32BE(offset);
      let cursor = 0;
      let minimum = null;
      for (let index = 0; index < count; index++) {
        if (cursor + 8 > commands.length) throw new Error('Truncated Mach-O load command: ' + file);
        const command = field(cursor);
        const size = field(cursor + 4);
        if (size < 8 || cursor + size > commands.length) throw new Error('Invalid Mach-O load command: ' + file);
        if (command === 0x32) { // LC_BUILD_VERSION
          if (size < 24 || field(cursor + 8) !== 1) throw new Error('Native binary does not target macOS: ' + file);
          minimum = Math.max(minimum || 0, field(cursor + 12));
        } else if (command === 0x24) { // LC_VERSION_MIN_MACOSX
          if (size < 16) throw new Error('Invalid macOS minimum-version command: ' + file);
          minimum = Math.max(minimum || 0, field(cursor + 8));
        }
        cursor += size;
      }
      if (minimum === null) throw new Error('Native binary has no macOS deployment target: ' + file);
      results.push({ architecture: 'arm64', minimumSystemVersion: versionString(minimum) });
    }
    return results;
  } finally { fs.closeSync(fd); }
}

function assertMacBinaryFloor(root, minimumSystemVersion = MINIMUM_MACOS_VERSION) {
  const ceiling = packedVersion(minimumSystemVersion);
  const binaries = [];
  let ignoredSymlinks = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { ignoredSymlinks++; continue; }
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        for (const item of inspectMachO(file)) binaries.push({ path: path.relative(root, file).replaceAll('\\', '/'), ...item });
      }
    }
  }
  visit(root);
  if (!binaries.length) throw new Error('No ARM64 native binaries found to verify under ' + root);
  const incompatible = binaries.filter(item => packedVersion(item.minimumSystemVersion) > ceiling);
  if (incompatible.length) throw new Error('Native dependencies exceed the declared macOS ' + minimumSystemVersion
    + ' minimum: ' + incompatible.slice(0, 8).map(item => item.path + ' requires ' + item.minimumSystemVersion).join('; '));
  return { minimumSystemVersion, architecture: 'arm64', checkedBinaries: binaries.length,
    highestBinaryMinimum: versionString(Math.max(...binaries.map(item => packedVersion(item.minimumSystemVersion)))),
    ignoredSymlinks, binaries };
}

module.exports = { assertMacBinaryFloor, inspectMachO, packedVersion };
