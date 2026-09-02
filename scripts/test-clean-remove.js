'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeTree, sweepRemoved, REMOVING } = require('../src/clean-remove');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-clean-remove-'));
  try {
    const tree = path.join(root, 'runtime');
    fs.mkdirSync(path.join(tree, 'Lib', 'site-packages', 'pkg'), { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(tree, 'Lib', 'site-packages', 'pkg', 'f' + i + '.py'), 'x');
    fs.writeFileSync(path.join(tree, 'python.exe'), 'bin');
    fs.mkdirSync(path.join(root, 'keep'));
    fs.writeFileSync(path.join(root, 'keep', 'receipt.json'), '{}');

    assert.strictEqual(await removeTree(tree), true, 'a present tree reports removal');
    assert.strictEqual(fs.existsSync(tree), false, 'the tree is gone');
    assert.deepStrictEqual(fs.readdirSync(root), ['keep'], 'nothing set aside is left behind, and siblings stay');
    assert.strictEqual(await removeTree(tree), false, 'a missing tree is not an error');
    assert.strictEqual(await removeTree(''), false);

    const file = path.join(root, 'keep', 'receipt.json');
    assert.strictEqual(await removeTree(file), true, 'a single file is removed too');
    assert.strictEqual(fs.existsSync(file), false);

    // What an interrupted or locked delete leaves: the renamed tree. The next
    // launch sweeps it, and touches nothing else.
    const leftover = path.join(root, 'runtime' + REMOVING + 'dead');
    fs.mkdirSync(path.join(leftover, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(leftover, 'deep', 'a.bin'), 'x');
    fs.mkdirSync(path.join(root, 'runtime.pending'));
    const swept = await sweepRemoved(root);
    assert.deepStrictEqual(swept, [leftover]);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['keep', 'runtime.pending']);
    assert.deepStrictEqual(await sweepRemoved(path.join(root, 'never-existed')), [], 'a missing root is fine');
    console.log('all clean remove tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
