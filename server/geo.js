'use strict';

// Which country an internet address is in, so each account sees its own
// region's price.
//
// The table is DB-IP's free IP to Country Lite database (IP Geolocation by
// DB-IP, https://db-ip.com, CC BY 4.0): a gzipped CSV of `first,last,country`
// rows with no header, IPv4 and IPv6 together, published at the start of each
// month under a URL named for that month. The service keeps one copy beside
// its database, loads it into typed arrays, and fetches the new month's copy
// on its own.
//
// Private, loopback and unparseable addresses have no country, unless a
// local country is configured for testing on a developer's PC.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const DOWNLOAD_URL = 'https://download.db-ip.com/free/dbip-country-lite-{month}.csv.gz';
// A real table has hundreds of thousands of ranges. Far fewer means a broken
// download or the wrong file, and the table in use is kept instead.
const MIN_RANGES = 10000;
const MASK64 = (1n << 64n) - 1n;

function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

// A 128-bit BigInt, or null. An IPv4 tail (::ffff:1.2.3.4) is the last two
// groups.
function parseIPv6(text) {
  let s = String(text);
  const tail = [];
  if (s.includes('.')) {
    const at = s.lastIndexOf(':');
    const v4 = at === -1 ? null : parseIPv4(s.slice(at + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536).toString(16), (v4 % 65536).toString(16));
    s = s.slice(0, at + 1).endsWith('::') ? s.slice(0, at + 1) : s.slice(0, at);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - rest.length - tail.length;
    if (missing < 1) return null;
    groups = head.concat(new Array(missing).fill('0'), rest, tail);
  } else {
    groups = head.concat(tail);
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

// { v: 4, n } or { v: 6, n }, or null. An IPv4 client that a dual-stack
// socket reports as ::ffff:a.b.c.d comes back as IPv4.
function parseAddress(text) {
  let s = String(text || '').trim();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    s = close === -1 ? '' : s.slice(1, close);
  }
  s = s.replace(/%.*$/, '');
  if (!s) return null;
  if (!s.includes(':')) {
    const n = parseIPv4(s);
    return n === null ? null : { v: 4, n };
  }
  const n = parseIPv6(s);
  if (n === null) return null;
  if ((n >> 32n) === 0xffffn) return { v: 4, n: Number(n & 0xffffffffn) };
  return { v: 6, n };
}

// Addresses that never leave a local network, so no table can place them.
function isPrivate(address) {
  if (address.v === 4) {
    const a = Math.floor(address.n / 16777216);
    const b = Math.floor(address.n / 65536) % 256;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return address.n === 0n || address.n === 1n || (address.n >> 121n) === 0x7en || (address.n >> 118n) === 0x3fan;
}

// Parallel arrays of ranges, in the order they are pushed.
function rangeList() {
  return { start: [], end: [], country: [] };
}

// Sorted typed arrays from a range list. DB-IP's file is already in order;
// one that is not is sorted here once.
function packV4(list, code) {
  const order = [...list.start.keys()];
  if (!list.start.every((value, i) => i === 0 || list.start[i - 1] <= value)) order.sort((x, y) => list.start[x] - list.start[y]);
  const out = { start: new Uint32Array(order.length), end: new Uint32Array(order.length), country: new Uint16Array(order.length) };
  order.forEach((from, i) => { out.start[i] = list.start[from]; out.end[i] = list.end[from]; out.country[i] = code(list.country[from]); });
  return out;
}

function packV6(list, code) {
  const order = [...list.start.keys()];
  if (!list.start.every((value, i) => i === 0 || list.start[i - 1] <= value)) {
    order.sort((x, y) => (list.start[x] < list.start[y] ? -1 : list.start[x] > list.start[y] ? 1 : 0));
  }
  const n = order.length;
  const out = {
    startHi: new BigUint64Array(n), startLo: new BigUint64Array(n),
    endHi: new BigUint64Array(n), endLo: new BigUint64Array(n), country: new Uint16Array(n),
  };
  order.forEach((from, i) => {
    out.startHi[i] = list.start[from] >> 64n; out.startLo[i] = list.start[from] & MASK64;
    out.endHi[i] = list.end[from] >> 64n; out.endLo[i] = list.end[from] & MASK64;
    out.country[i] = code(list.country[from]);
  });
  return out;
}

// Whether a file starts with gzip's magic bytes. A download is checked before
// it takes the table's name, so its name says nothing.
function isGzip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    fs.closeSync(fd);
  }
}

// Reads a DB-IP country CSV, gzipped or not, into a lookup table.
async function readTable(file) {
  const v4 = rangeList();
  const v6 = rangeList();
  const raw = fs.createReadStream(file);
  const input = isGzip(file) ? raw.pipe(zlib.createGunzip()) : raw;
  const failed = new Promise((_, reject) => { raw.on('error', reject); input.on('error', reject); });
  failed.catch(() => {});
  const reading = (async () => {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const [first, last, rawCountry] = line.split(',');
      const country = String(rawCountry || '').trim();
      if (!first || !last || !/^[A-Z]{2}$/.test(country)) continue;
      const a = parseAddress(first);
      const b = parseAddress(last);
      if (!a || !b || a.v !== b.v) continue;
      const list = a.v === 4 ? v4 : v6;
      list.start.push(a.n); list.end.push(b.n); list.country.push(country);
    }
  })();
  await Promise.race([reading, failed]);
  const countries = [];
  const indexOf = new Map();
  const code = (country) => {
    if (!indexOf.has(country)) { indexOf.set(country, countries.length); countries.push(country); }
    return indexOf.get(country);
  };
  return { countries, v4: packV4(v4, code), v6: packV6(v6, code) };
}

function rangesIn(table) {
  return table.v4.start.length + table.v6.startHi.length;
}

// The last range starting at or before `n`, if `n` is inside it.
function lookupV4(table, n) {
  const { start, end, country } = table.v4;
  let lo = 0;
  let hi = start.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (start[mid] <= n) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found !== -1 && n <= end[found] ? table.countries[country[found]] : '';
}

function lookupV6(table, n) {
  const { startHi, startLo, endHi, endLo, country } = table.v6;
  const nHi = n >> 64n;
  const nLo = n & MASK64;
  const atMost = (aHi, aLo, bHi, bLo) => aHi < bHi || (aHi === bHi && aLo <= bLo);
  let lo = 0;
  let hi = startHi.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (atMost(startHi[mid], startLo[mid], nHi, nLo)) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found !== -1 && atMost(nHi, nLo, endHi[found], endLo[found]) ? table.countries[country[found]] : '';
}

function monthOf(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function previousMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return monthOf(Date.UTC(y, m - 2, 1));
}

function createCountryLookup(options) {
  const opts = options || {};
  const file = opts.file || '';
  const localCountry = /^[A-Za-z]{2}$/.test(String(opts.localCountry || '')) ? String(opts.localCountry).toUpperCase() : '';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const urlFor = (month) => String(opts.downloadUrl || DOWNLOAD_URL).replace('{month}', month);
  const minRanges = Number(opts.minRanges) > 0 ? Number(opts.minRanges) : MIN_RANGES;
  // Which month's table the file on disk holds, kept beside it.
  const monthFile = file + '.month';
  let table = null;

  function countryOf(ip) {
    const address = parseAddress(ip);
    if (!address) return '';
    if (isPrivate(address)) return localCountry;
    if (!table) return '';
    const country = address.v === 4 ? lookupV4(table, address.n) : lookupV6(table, address.n);
    // DB-IP marks reserved space ZZ, which is no country.
    return country === 'ZZ' ? '' : country;
  }

  async function load() {
    if (!file || !fs.existsSync(file)) return false;
    const next = await readTable(file);
    if (rangesIn(next) < minRanges) throw new Error('the country table at ' + file + ' is too small to be real');
    table = next;
    log('geo table loaded: ' + next.v4.start.length + ' IPv4 and ' + next.v6.startHi.length + ' IPv6 ranges');
    return true;
  }

  function heldMonth() {
    try { return fs.readFileSync(monthFile, 'utf8').trim(); } catch (_) { return ''; }
  }

  // Fetches this month's table when the copy on disk is from an earlier month.
  // Early on the 1st this month's may not be published yet; last month's is
  // then fetched only when there is no copy at all.
  async function refresh() {
    if (!file) return false;
    const month = monthOf(now());
    const held = fs.existsSync(file) ? heldMonth() : '';
    if (held === month) return false;
    for (const candidate of held ? [month] : [month, previousMonth(month)]) {
      const res = await fetchImpl(urlFor(candidate));
      if (res.status === 404) continue;
      if (!res.ok) throw new Error('the country table download answered ' + res.status);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.download';
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      try {
        const next = await readTable(tmp);
        if (rangesIn(next) < minRanges) throw new Error('the downloaded country table is too small to be real');
        fs.renameSync(tmp, file);
        fs.writeFileSync(monthFile, candidate + '\n');
        table = next;
        log('geo table ' + candidate + ' downloaded: ' + next.v4.start.length + ' IPv4 and ' + next.v6.startHi.length + ' IPv6 ranges');
        return true;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return false;
  }

  return {
    countryOf,
    load,
    refresh,
    get loaded() { return !!table; },
  };
}

module.exports = { createCountryLookup, parseAddress, isPrivate, monthOf, previousMonth, DOWNLOAD_URL, MIN_RANGES };
