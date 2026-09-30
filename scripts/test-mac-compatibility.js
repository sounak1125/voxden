'use strict';

// OS boundaries and native-header fixtures run on every supported CI host.
// Actual model loading on Sonoma remains a separate native macos-14 CI job.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MINIMUM_MACOS_VERSION, macCompatibilityIssue, checkMacStartup } = require('../src/mac-compatibility');
const { AsrRuntimeManager, runtimeSpec } = require('../src/asr-runtime');
const { inspectMachO, assertMacBinaryFloor, packedVersion } = require('./mac-binary-compatibility');
const { speechPackages } = require('./prepare-asr-runtime');
let checks = 0;
function test(name, run) { run(); checks++; console.log('ok ' + name); }
const mac = release => ({ platform: 'darwin', arch: 'arm64', darwinRelease: release });

for (const [version, release] of [[12, '21.6.0'], [13, '22.6.0']]) {
  test('macOS ' + version + ' receives an actionable upgrade error', () => {
    const issue = macCompatibilityIssue(mac(release));
    assert.match(issue, /requires macOS 14/);
    assert.match(issue, new RegExp('Detected macOS ' + version));
    assert.match(issue, /System Settings > General > Software Update/);
  });
}
for (const release of ['23.0.0', '23.6.0', '25.0.0', '26.0.0']) {
  test('Darwin ' + release + ' is supported', () => assert.strictEqual(macCompatibilityIssue(mac(release)), ''));
}
test('an unknown native OS version fails closed', () => assert.match(macCompatibilityIssue(mac('unknown')), /requires macOS 14/));
test('Intel Macs retain the Apple silicon restriction', () => assert.match(macCompatibilityIssue({ ...mac('23.0.0'), arch: 'x64' }), /Intel Macs are not supported/));
for (const arch of ['x64', 'arm64']) {
  test('Windows ' + arch + ' is unchanged', () => {
    assert.strictEqual(macCompatibilityIssue({ platform: 'win32', arch, darwinRelease: '10.0.26100' }), '');
    assert.strictEqual(runtimeSpec('win32', arch).id, 'asr-win-x64');
  });
}
test('unsupported startup explains the requirement then quits', () => {
  const actions = [];
  assert.strictEqual(checkMacStartup({ quit: () => actions.push('quit') },
    { showErrorBox: (title, message) => actions.push([title, message]) }, mac('22.6.0')), false);
  assert.strictEqual(actions[0][0], 'This Mac cannot run Voxden');
  assert.match(actions[0][1], /macOS 14/);
  assert.strictEqual(actions[1], 'quit');
  assert.strictEqual(actions.length, 2);
});
test('supported startup neither prompts nor quits', () => {
  const unexpected = () => assert.fail('Supported system was stopped');
  assert.strictEqual(checkMacStartup({ quit: unexpected }, { showErrorBox: unexpected }, mac('23.0.0')), true);
  assert.strictEqual(checkMacStartup({ quit: unexpected }, { showErrorBox: unexpected }, { platform: 'win32' }), true);
});
test('the packaged floor and startup gate precede initialization', () => {
  assert.strictEqual(require('../package.json').build.mac.minimumSystemVersion, MINIMUM_MACOS_VERSION);
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /app\.whenReady\(\)\.then\(async \(\) => \{\s*if \(!checkMacStartup\([^\n]+\)\) return;\s*initPaths\(\);/);
});

test('Mac resolution selects the hashed compatible wheel instead of a same-version macOS 15 wheel', () => {
  const pinned = speechPackages('darwin').filter(requirement => requirement.startsWith('orjson @ '));
  assert.strictEqual(pinned.length, 1);
  const url = new URL(pinned[0].slice('orjson @ '.length));
  assert.strictEqual(url.protocol, 'https:');
  assert.strictEqual(url.hostname, 'files.pythonhosted.org');
  assert.match(url.pathname, /orjson-3\.12\.0-cp312-cp312-.*macosx_11_0_arm64.*universal2\.whl$/);
  assert.strictEqual(url.hash, '#sha256=aa3e43a6846e91d7bde3d5a9c66090fcd8744f569a9b6cffc5e1ca38f6a461c0');
  assert(!speechPackages('win32').some(requirement => requirement.includes('orjson')));
  assert.deepStrictEqual(speechPackages('darwin').filter(requirement => !requirement.startsWith('orjson @ ')), speechPackages('win32'));
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-mac-compatibility-'));
try {
  test('the speech manager refuses old macOS before any file or network activity', () => {
    for (const release of ['21.6.0', '22.6.0']) {
      const runtimeRoot = path.join(root, release);
      assert.throws(() => new AsrRuntimeManager({ root: runtimeRoot, ...mac(release),
        fetchImpl: () => assert.fail('Unsupported Mac attempted a download') }),
      error => error.code === 'UNSUPPORTED_PLATFORM' && /macOS 14/.test(error.message));
      assert.strictEqual(fs.existsSync(runtimeRoot), false);
    }
    assert.strictEqual(new AsrRuntimeManager({ root: path.join(root, 'supported'), ...mac('23.0.0') }).spec.id, 'asr-mac-arm64');
  });

  // A minimal real Mach-O header/load command, independent of the host OS.
  function macho(version = '14.0', { legacy = false, arch = 0x0100000c, platform = 1, little = true, fileType = 6 } = {}) {
    const bytes = Buffer.alloc(legacy ? 48 : 56);
    const u32 = (value, at) => little ? bytes.writeUInt32LE(value, at) : bytes.writeUInt32BE(value, at);
    u32(0xfeedfacf, 0); u32(arch, 4); u32(fileType, 12); u32(1, 16); u32(bytes.length - 32, 20);
    u32(legacy ? 0x24 : 0x32, 32); u32(bytes.length - 32, 36);
    if (legacy) u32(packedVersion(version), 40);
    else { u32(platform, 40); u32(packedVersion(version), 44); u32(packedVersion('26.0'), 48); }
    return bytes;
  }
  function write(name, bytes) { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; }
  test('ARM64 Sonoma deployment target is read independently of the build SDK', () => {
    assert.deepStrictEqual(inspectMachO(write('arm64', macho())), [{ architecture: 'arm64', minimumSystemVersion: '14.0.0' }]);
  });
  test('legacy and byte-swapped deployment commands are understood', () => {
    assert.strictEqual(inspectMachO(write('legacy', macho('11.0', { legacy: true })))[0].minimumSystemVersion, '11.0.0');
    assert.strictEqual(inspectMachO(write('big-endian', macho('12.3', { little: false })))[0].minimumSystemVersion, '12.3.0');
  });
  test('universal binaries validate their ARM64 slice independently of Intel', () => {
    const intel = macho('15.0', { arch: 0x01000007 });
    const arm = macho('14.0');
    const head = Buffer.alloc(48);
    head.writeUInt32BE(0xcafebabe, 0); head.writeUInt32BE(2, 4);
    head.writeUInt32BE(0x01000007, 8); head.writeUInt32BE(48, 16); head.writeUInt32BE(intel.length, 20);
    head.writeUInt32BE(0x0100000c, 28); head.writeUInt32BE(48 + intel.length, 36); head.writeUInt32BE(arm.length, 40);
    assert.deepStrictEqual(inspectMachO(write('universal', Buffer.concat([head, intel, arm]))), [{ architecture: 'arm64', minimumSystemVersion: '14.0.0' }]);
  });
  test('ordinary resources and relocatable debug objects are not executable dependencies', () => {
    assert.deepStrictEqual(inspectMachO(write('readme', Buffer.from('ordinary resource'))), []);
    assert.deepStrictEqual(inspectMachO(write('object', macho('15.0', { fileType: 1 }))), []);
  });
  // The same first four bytes as a universal binary. Java 1.1 through 26 use
  // major versions 45 through 70, all far above any real architecture count.
  function javaClass(major) {
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt16BE(0, 4); bytes.writeUInt16BE(major, 6);
    return bytes;
  }
  test('Java class files share the universal-binary magic but are not Mach-O', () => {
    for (const major of [45, 52, 65, 70]) {
      assert.deepStrictEqual(inspectMachO(write('Example' + major + '.class', javaClass(major))), [], 'class file major ' + major);
    }
  });
  test('the packaged tree report includes native binaries and their actual deployment floor', () => {
    const report = assertMacBinaryFloor(root);
    assert.strictEqual(report.checkedBinaries, 4);
    assert.strictEqual(report.minimumSystemVersion, '14.0');
    assert.strictEqual(report.highestBinaryMinimum, '14.0.0');
  });
  for (const version of ['14.1', '15.0']) {
    test('a dependency requiring macOS ' + version + ' fails the declared 14.0 floor', () => {
      const file = write('too-new', macho(version));
      try { assert.throws(() => assertMacBinaryFloor(root), /too-new requires/); } finally { fs.unlinkSync(file); }
    });
  }
  for (const [name, bytes, expected] of [
    ['intel-only', macho('12.0', { arch: 0x01000007 }), /no Apple silicon slice/],
    ['ios', macho('14.0', { platform: 2 }), /does not target macOS/],
    ['truncated', macho().subarray(0, 50), /slice bounds|load-command size/],
  ]) {
    test(name + ' cannot pass the native dependency audit', () => {
      const file = write(name, bytes);
      try { assert.throws(() => inspectMachO(file), expected); } finally { fs.unlinkSync(file); }
    });
  }
  test('a missing deployment command cannot silently pass', () => {
    const bytes = macho(); bytes.writeUInt32LE(0x1b, 32);
    const file = write('missing-minimum', bytes);
    try { assert.throws(() => inspectMachO(file), /no macOS deployment target/); } finally { fs.unlinkSync(file); }
  });
  test('invalid load-command bounds are rejected', () => {
    const bytes = macho(); bytes.writeUInt32LE(64, 36);
    const file = write('bad-command', bytes);
    try { assert.throws(() => inspectMachO(file), /Invalid Mach-O load command/); } finally { fs.unlinkSync(file); }
  });
  test('an empty tree cannot report a successful compatibility audit', () => {
    const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
    assert.throws(() => assertMacBinaryFloor(empty), /No ARM64 native binaries/);
  });
} finally {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('voxden-mac-compatibility-')) throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('All ' + checks + ' macOS compatibility checks passed');
