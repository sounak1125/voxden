'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// A failed write never truncates the committed store. The backup mirrors the
// latest successful save, including deletions, and can recover damaged JSON.
function replace(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function writeJson(file, value) {
  const body = JSON.stringify(value, null, 2);
  replace(file, body);
  try { replace(file + '.bak', body); } catch (err) {
    console.warn('Could not refresh store backup:', err.message);
  }
}

function readJson(file, fallback, validate = value => value && typeof value === 'object') {
  for (const candidate of [file, file + '.bak']) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!validate(value)) throw new Error('Invalid store');
      if (candidate !== file) console.warn('Recovered store from backup:', file);
      return value;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('Could not read store:', candidate, err.message);
    }
  }
  return fallback;
}

module.exports = { replace, writeJson, readJson };
