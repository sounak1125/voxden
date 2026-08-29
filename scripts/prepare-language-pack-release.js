'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const fsPromises = fs.promises;
const MAX_PART_BYTES = 1800 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  node scripts/prepare-language-pack-release.js --runtime-dir <llama.cpp bin dir> --standard <standard.gguf> --enhanced <enhanced.gguf> --out <empty staging dir>',
    '',
    'The output files are uploaded as assets of the language-packs-v1 GitHub Release.',
  ].join('\n');
}

function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length) throw new Error(usage());
    out[key.slice(2)] = argv[++i];
  }
  return out;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyAsset(source, destination) {
  await pipeline(fs.createReadStream(source), fs.createWriteStream(destination, { flags: 'wx' }));
  const stat = await fsPromises.stat(destination);
  return { size: stat.size, sha256: await hashFile(destination) };
}

async function splitModel(source, outputDir, prefix) {
  const sourceStat = await fsPromises.stat(source);
  if (!sourceStat.isFile()) throw new Error(source + ' is not a file.');
  const partCount = Math.ceil(sourceStat.size / MAX_PART_BYTES);
  const parts = [];
  const input = await fsPromises.open(source, 'r');
  try {
    for (let index = 0; index < partCount; index += 1) {
      const suffix = partCount === 1 ? '.gguf' : '.part' + String(index + 1).padStart(2, '0');
      const asset = prefix + suffix;
      const destination = path.join(outputDir, asset);
      const start = index * MAX_PART_BYTES;
      const end = Math.min(sourceStat.size, start + MAX_PART_BYTES);
      const output = await fsPromises.open(destination, 'wx');
      const hash = crypto.createHash('sha256');
      let position = start;
      try {
        const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
        while (position < end) {
          const wanted = Math.min(buffer.length, end - position);
          const { bytesRead } = await input.read(buffer, 0, wanted, position);
          if (!bytesRead) throw new Error('Unexpected end of ' + source);
          const chunk = buffer.subarray(0, bytesRead);
          await output.write(chunk);
          hash.update(chunk);
          position += bytesRead;
        }
      } finally {
        await output.close();
      }
      parts.push({ asset, size: end - start, sha256: hash.digest('hex') });
    }
  } finally {
    await input.close();
  }
  return {
    parts,
    modelSize: sourceStat.size,
    modelSha256: await hashFile(source),
  };
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (!args['runtime-dir'] || !args.standard || !args.enhanced || !args.out) {
    throw new Error(usage());
  }
  const runtimeDir = path.resolve(args['runtime-dir']);
  const standardPath = path.resolve(args.standard);
  const enhancedPath = path.resolve(args.enhanced);
  const outputDir = path.resolve(args.out);
  await fsPromises.mkdir(outputDir, { recursive: true });
  const existing = await fsPromises.readdir(outputDir);
  if (existing.length) throw new Error('Output directory must be empty: ' + outputDir);

  const runtimeNames = (await fsPromises.readdir(runtimeDir)).sort();
  if (!runtimeNames.includes('llama-server.exe')) {
    throw new Error('The runtime directory must contain llama-server.exe.');
  }
  const runtimeFiles = [];
  for (const name of runtimeNames) {
    const source = path.join(runtimeDir, name);
    const stat = await fsPromises.stat(source);
    if (!stat.isFile()) continue;
    if (/\.exe$/i.test(name) && name.toLowerCase() !== 'llama-server.exe') continue;
    const asset = 'runtime-' + name;
    const verified = await copyAsset(source, path.join(outputDir, asset));
    runtimeFiles.push({ asset, path: name, size: verified.size, sha256: verified.sha256 });
  }

  const standard = await splitModel(standardPath, outputDir, 'voxden-standard-qwen3-1.7b-q4-v1');
  const enhanced = await splitModel(enhancedPath, outputDir, 'voxden-enhanced-qwen3-4b-q4-v1');
  const manifest = {
    schemaVersion: 1,
    runtime: {
      id: args['runtime-id'] || 'llama-cpp-win-x64-v1',
      executable: 'llama-server.exe',
      files: runtimeFiles,
    },
    packs: {
      standard: {
        id: args['standard-id'] || 'qwen3-1.7b-q4-v1',
        version: 1,
        displayName: 'Standard',
        modelAlias: 'voxden-standard',
        modelFile: 'qwen3-1.7b-q4.gguf',
        modelSize: standard.modelSize,
        modelSha256: standard.modelSha256,
        parts: standard.parts,
      },
      enhanced: {
        id: args['enhanced-id'] || 'qwen3-4b-q4-v1',
        version: 1,
        displayName: 'Enhanced',
        modelAlias: 'voxden-enhanced',
        modelFile: 'qwen3-4b-q4.gguf',
        modelSize: enhanced.modelSize,
        modelSha256: enhanced.modelSha256,
        parts: enhanced.parts,
      },
    },
  };
  await fsPromises.writeFile(
    path.join(outputDir, 'voxden-language-packs.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' }
  );
  console.log('Prepared ' + (runtimeFiles.length + standard.parts.length + enhanced.parts.length + 1) + ' release assets in ' + outputDir);
  console.log('Standard parts: ' + standard.parts.length + '; Enhanced parts: ' + enhanced.parts.length);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
