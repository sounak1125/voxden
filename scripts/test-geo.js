'use strict';

// The country table behind regional pricing: parsing addresses, looking them
// up in a DB-IP style CSV, and fetching the month's table.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createCountryLookup, parseAddress, isPrivate, monthOf, previousMonth } = require('../server/geo');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

// A table in DB-IP's layout: first,last,country, no header, IPv4 then IPv6.
const SAMPLE = [
  '1.0.0.0,1.0.0.255,AU',
  '1.6.0.0,1.7.255.255,IN',
  '8.8.8.0,8.8.8.255,US',
  '49.32.0.0,49.63.255.255,IN',
  '192.0.2.0,192.0.2.255,ZZ',
  '223.255.255.0,223.255.255.255,AU',
  '2001:200::,2001:200:ffff:ffff:ffff:ffff:ffff:ffff,JP',
  '2401:4900::,2401:4900:ffff:ffff:ffff:ffff:ffff:ffff,IN',
  '2600:1f00::,2600:1fff:ffff:ffff:ffff:ffff:ffff:ffff,US',
].join('\n') + '\n';

function checkAddresses() {
  eq('an IPv4 address parses', parseAddress('49.36.10.1'), { v: 4, n: 49 * 16777216 + 36 * 65536 + 10 * 256 + 1 });
  eq('an IPv4 client on a dual-stack socket comes back as IPv4', parseAddress('::ffff:49.36.10.1'), parseAddress('49.36.10.1'));
  eq('the same in hex groups', parseAddress('::ffff:3124:a01'), parseAddress('49.36.10.1'));
  eq('a compressed IPv6 address parses', parseAddress('2401:4900::1'), { v: 6, n: (0x2401n << 112n) | (0x4900n << 96n) | 1n });
  eq('brackets and a zone are ignored', parseAddress('[fe80::1%eth0]'), { v: 6, n: (0xfe80n << 112n) | 1n });
  eq('an IPv4 tail after :: parses', parseAddress('::1.2.3.4'), { v: 6, n: 0x01020304n });
  for (const bad of ['', 'nope', '1.2.3', '1.2.3.256', '1.2.3.4.5', '2001::db8::1', '1:2:3:4:5:6:7:8:9', '12345::', ':::']) {
    eq('junk is no address: ' + JSON.stringify(bad), parseAddress(bad), null);
  }
  eq('loopback, LAN and link-local addresses are private',
    ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', '169.254.3.3', '100.64.0.1', '::1', 'fd12::1', 'fe80::9'].map((ip) => isPrivate(parseAddress(ip))),
    [true, true, true, true, true, true, true, true, true]);
  eq('public addresses are not',
    ['49.36.10.1', '172.32.0.1', '8.8.8.8', '2401:4900::1'].map((ip) => isPrivate(parseAddress(ip))), [false, false, false, false]);
  eq('months count back across a year', [monthOf(Date.parse('2026-01-15T00:00:00Z')), previousMonth('2026-01')], ['2026-01', '2025-12']);
}

async function checkLookup(dir) {
  const file = path.join(dir, 'sample.csv.gz');
  fs.writeFileSync(file, zlib.gzipSync(SAMPLE));
  const lookup = createCountryLookup({ file, minRanges: 5 });
  eq('before loading, nobody has a country', lookup.countryOf('49.36.10.1'), '');
  eq('a gzipped table loads', await lookup.load(), true);
  eq('an Indian IPv4 address is IN', lookup.countryOf('49.36.10.1'), 'IN');
  eq('both ends of a range are inside it', [lookup.countryOf('1.6.0.0'), lookup.countryOf('1.7.255.255')], ['IN', 'IN']);
  eq('an American one is US', lookup.countryOf('8.8.8.8'), 'US');
  eq('an address between ranges has no country', lookup.countryOf('9.9.9.9'), '');
  eq('below the first range and above the last', [lookup.countryOf('0.255.255.255'), lookup.countryOf('224.0.0.1')], ['', '']);
  eq('reserved space marked ZZ is no country', lookup.countryOf('192.0.2.10'), '');
  eq('an Indian IPv6 address is IN', lookup.countryOf('2401:4900:1234::5'), 'IN');
  eq('a Japanese one is JP', lookup.countryOf('2001:200::1'), 'JP');
  eq('a mapped IPv4 client is looked up as IPv4', lookup.countryOf('::ffff:49.36.10.1'), 'IN');
  eq('a private address has no country', lookup.countryOf('127.0.0.1'), '');

  const local = createCountryLookup({ file, minRanges: 5, localCountry: 'us' });
  eq('a developer can give private addresses a country', local.countryOf('::1'), 'US');

  const shuffled = path.join(dir, 'shuffled.csv');
  fs.writeFileSync(shuffled, SAMPLE.trim().split('\n').reverse().join('\r\n') + '\r\nnot,a row\n,,\n');
  const unsorted = createCountryLookup({ file: shuffled, minRanges: 5 });
  await unsorted.load();
  eq('a plain CSV out of order, with CRLF and junk lines, still answers',
    [unsorted.countryOf('49.36.10.1'), unsorted.countryOf('8.8.8.8'), unsorted.countryOf('2600:1f00::9')], ['IN', 'US', 'US']);

  const tiny = createCountryLookup({ file });
  await assert.rejects(() => tiny.load(), /too small/);
  eq('a table far smaller than DB-IP\'s is refused', tiny.countryOf('49.36.10.1'), '');
  eq('a missing file loads nothing', await createCountryLookup({ file: path.join(dir, 'none.csv.gz') }).load(), false);
}

async function checkRefresh(dir) {
  const published = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = published.get(req.url);
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let clock = Date.parse('2026-09-01T03:00:00Z');
  const file = path.join(dir, 'data', 'dbip-country-lite.csv.gz');
  const lookup = createCountryLookup({ file, minRanges: 5, now: () => clock, downloadUrl: base + '/free/dbip-country-lite-{month}.csv.gz' });
  try {
    published.set('/free/dbip-country-lite-2026-08.csv.gz', zlib.gzipSync(SAMPLE));
    eq('with no table on disk and this month not out yet, last month\'s is fetched', await lookup.refresh(), true);
    eq('it asked for this month first', requests, ['/free/dbip-country-lite-2026-09.csv.gz', '/free/dbip-country-lite-2026-08.csv.gz']);
    eq('and answers from it at once', lookup.countryOf('49.36.10.1'), 'IN');
    eq('the month it holds is written down', fs.readFileSync(file + '.month', 'utf8').trim(), '2026-08');

    requests.length = 0;
    eq('with last month on disk, a missing new month fetches nothing', await lookup.refresh(), false);
    eq('it only asked for the new month', requests, ['/free/dbip-country-lite-2026-09.csv.gz']);

    published.set('/free/dbip-country-lite-2026-09.csv.gz', zlib.gzipSync('garbage,,\n'));
    await assert.rejects(() => lookup.refresh(), /too small/);
    eq('a broken download keeps the table in use', lookup.countryOf('49.36.10.1'), 'IN');
    eq('and the file and month on disk', fs.readFileSync(file + '.month', 'utf8').trim(), '2026-08');
    eq('and leaves no partial file behind', fs.existsSync(file + '.download'), false);

    published.set('/free/dbip-country-lite-2026-09.csv.gz', zlib.gzipSync(SAMPLE.replace('8.8.8.0,8.8.8.255,US', '8.8.8.0,8.8.8.255,CA')));
    eq('once this month is published it replaces last month\'s', await lookup.refresh(), true);
    eq('the new table answers', lookup.countryOf('8.8.8.8'), 'CA');
    requests.length = 0;
    eq('and the same month is not fetched twice', [await lookup.refresh(), requests.length], [false, 0]);

    const again = createCountryLookup({ file, minRanges: 5 });
    await again.load();
    eq('a restart loads the downloaded table from disk', again.countryOf('8.8.8.8'), 'CA');

    clock = Date.parse('2026-10-02T00:00:00Z');
    published.clear();
    const failing = createCountryLookup({ file, minRanges: 5, now: () => clock, fetchImpl: async () => ({ ok: false, status: 503 }) });
    await failing.load();
    await assert.rejects(() => failing.refresh(), /503/);
    eq('a download error keeps the table it has', failing.countryOf('8.8.8.8'), 'CA');
  } finally {
    server.close();
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-geo-'));
  try {
    checkAddresses();
    await checkLookup(dir);
    await checkRefresh(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write('all ' + checks + ' geo checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
