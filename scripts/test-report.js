// Runs every command in the package.json "test" chain and reports each one separately.
// The chain in package.json is joined by && , so it stops at the first failure and hides
// every test after it. On a platform where several tests are expected to fail (a fresh
// macOS CI runner, for example) that single stop tells you almost nothing, so this script
// splits the chain apart and runs each file on its own with its own pass/fail verdict.
// The default exit code is 0 so a CI step using it stays informational; pass --strict to
// restore the fail-fast meaning and exit 1 when anything failed.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAIL_LINES = 30;

function parseArgs(argv) {
  const opts = { skip: [], only: [], strict: false, timeout: 300, json: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--skip') opts.skip = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--timeout') opts.timeout = Number(argv[++i]) || 300;
    else if (arg === '--json') opts.json = argv[++i];
    else {
      console.log(`Unknown option: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

const USAGE = [
  'Usage: node scripts/test-report.js [options]',
  '',
  'Runs every command in the package.json "test" chain separately and reports each result.',
  '',
  'Options:',
  '  --only a,b        only run commands whose text contains one of these substrings',
  '  --skip a,b        skip commands whose text contains one of these substrings',
  '  --timeout <secs>  per-command timeout in seconds (default 300)',
  '  --json <file>     write the results array to this file as JSON',
  '  --strict          exit 1 when any command failed (default exit code is always 0)',
  '  --help            print this help',
].join('\n');

function tail(text, count) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = String((pkg.scripts && pkg.scripts.test) || '');
  const commands = chain.split('&&').map((c) => c.trim()).filter(Boolean);
  if (!commands.length) {
    console.log('No commands found in package.json scripts.test');
    process.exit(0);
  }

  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = path.join(ROOT, 'node_modules', '.bin') + path.delimiter + (env[pathKey] || '');

  const selected = commands.filter((c) => !opts.only.length || opts.only.some((s) => c.includes(s)));
  console.log(`Running ${selected.length} of ${commands.length} commands from package.json scripts.test`);
  console.log('');

  const results = [];
  for (const command of selected) {
    if (opts.skip.some((s) => command.includes(s))) {
      console.log(`SKIP    0.0s  ${command}`);
      results.push({ command, status: 'skipped', code: null, signal: null, durationMs: 0, output: [] });
      continue;
    }
    const started = Date.now();
    const run = spawnSync(command, {
      shell: true,
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeout * 1000,
    });
    const durationMs = Date.now() - started;
    const secs = (durationMs / 1000).toFixed(1);
    const combined = `${run.stdout || ''}${run.stderr || ''}`;
    const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');
    let status = 'pass';
    if (timedOut) status = 'timeout';
    else if (run.status !== 0 || run.error) status = 'fail';

    const entry = {
      command,
      status,
      code: typeof run.status === 'number' ? run.status : null,
      signal: run.signal || null,
      durationMs,
      output: status === 'pass' ? [] : tail(combined, TAIL_LINES),
    };
    results.push(entry);

    if (status === 'pass') console.log(`PASS  ${secs.padStart(6)}s  ${command}`);
    else if (status === 'timeout') console.log(`TIME  ${secs.padStart(6)}s  ${command} (timed out after ${opts.timeout}s)`);
    else {
      const why = entry.code !== null ? `exit ${entry.code}` : `signal ${entry.signal || (run.error && run.error.code) || 'unknown'}`;
      console.log(`FAIL  ${secs.padStart(6)}s  ${command} (${why})`);
    }
  }

  const passed = results.filter((r) => r.status === 'pass');
  const failed = results.filter((r) => r.status === 'fail');
  const timedOut = results.filter((r) => r.status === 'timeout');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log('');
  console.log('----------------------------------------');
  console.log(`passed: ${passed.length}  failed: ${failed.length}  timed out: ${timedOut.length}  skipped: ${skipped.length}`);

  const broken = failed.concat(timedOut);
  for (const entry of broken) {
    console.log('');
    console.log(`${entry.status.toUpperCase()}: ${entry.command}`);
    for (const line of entry.output) console.log(`  ${line}`);
  }

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log('');
    console.log(`Wrote JSON results to ${path.resolve(opts.json)}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| \`${r.command}\` | ${r.status} | ${(r.durationMs / 1000).toFixed(1)} |`);
    const table = [
      '',
      `### Test report (${passed.length} passed, ${failed.length} failed, ${timedOut.length} timed out, ${skipped.length} skipped)`,
      '',
      '| command | status | seconds |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table, 'utf8');
    } catch (err) {
      console.log(`Could not write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }

  process.exit(opts.strict && broken.length ? 1 : 0);
}

main();
