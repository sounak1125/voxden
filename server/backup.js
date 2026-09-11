'use strict';

// A consistent copy of the live database, safe to take while the service is
// running. VACUUM INTO writes a complete, compacted snapshot in one
// transaction; WAL mode means the service keeps serving meanwhile.
//
//   node server/backup.js [destination]
//
// Default destination: <VOXDEN_DB dir>/backups/voxden-<UTC timestamp>.sqlite.
// Keeps the newest 14 in that directory and deletes the rest.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;

function main(argv) {
  const source = process.env.VOXDEN_DB || path.join(__dirname, 'data', 'voxden.sqlite');
  if (!fs.existsSync(source)) {
    process.stderr.write('no database at ' + source + '\n');
    return 1;
  }
  const dir = path.join(path.dirname(source), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = argv[0] || path.join(dir, 'voxden-' + stamp + '.sqlite');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // A SQL string literal: single quotes, doubled inside the path.
    db.exec("VACUUM INTO '" + dest.replace(/\\/g, '/').replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }
  const size = fs.statSync(dest).size;
  process.stdout.write('backup written: ' + dest + ' (' + size + ' bytes)\n');
  if (!argv[0]) {
    const old = fs.readdirSync(dir).filter((f) => /^voxden-.*\.sqlite$/.test(f)).sort().reverse().slice(KEEP);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
    if (old.length) process.stdout.write('removed ' + old.length + ' older backup(s)\n');
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
