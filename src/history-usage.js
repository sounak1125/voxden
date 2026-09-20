'use strict';

const metrics = require('./metrics');
const insights = require('./insights');
const DAY_MS = 86400000;

function timeZoneKey(now) {
  return Intl.DateTimeFormat().resolvedOptions().timeZone + ':' + new Date(now).getTimezoneOffset();
}

// Preserve the existing inclusive rolling windows, and also refresh calendar
// displays at midnight. Stored timestamps let a timezone change regroup the
// original activity without keeping its transcript.
function expiresAt(entries, now, days) {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  let expires = tomorrow.getTime();
  for (const entry of entries) {
    const ts = Number(entry.ts);
    for (const boundary of [ts, ts + days * DAY_MS + 1, ts + 2 * days * DAY_MS + 1]) {
      if (boundary > now) expires = Math.min(expires, boundary);
    }
  }
  return expires;
}

function createHistoryUsage() {
  let cachedEntries = null;
  let cachedArchive = null;
  let cachedRevision = null;
  let all = [];
  let stats = null;
  let statsZone = '';
  const insightResults = new Map();

  function invalidate() {
    cachedEntries = null;
    cachedArchive = null;
    cachedRevision = null;
    all = [];
    stats = null;
    insightResults.clear();
  }

  function entriesFor(history, revision) {
    if (cachedEntries !== history.entries || cachedArchive !== history.archived || cachedRevision !== revision) {
      cachedEntries = history.entries;
      cachedArchive = history.archived;
      cachedRevision = revision;
      all = (history.entries || []).concat(history.archived || []);
      stats = null;
      insightResults.clear();
    }
    return all;
  }

  function getStats(history, revision, now = Date.now()) {
    const entries = entriesFor(history, revision);
    const zone = timeZoneKey(now);
    if (stats && statsZone === zone && now >= stats.computedAt && now < stats.expiresAt) return stats;
    let wordCount = 0;
    let weekWords = 0;
    // One figure per weekday, Monday first, over the very same rolling window
    // weekWords uses, so the dashboard's seven bars add up to that number.
    // Archived entries keep their timestamp and word count, so a history whose
    // transcripts were dropped by retention still fills the week.
    const weekDays = [0, 0, 0, 0, 0, 0, 0];
    const paceSamples = [];
    for (const entry of entries) {
      const words = metrics.entryWordCount(entry);
      wordCount += words;
      if (entry.ts >= now - 7 * DAY_MS) {
        weekWords += words;
        weekDays[(new Date(Number(entry.ts)).getDay() + 6) % 7] += words;
      }
      if (paceSamples.length < 8 && metrics.isPaceSample(entry)) {
        paceSamples.push({ statsOnly: true, id: entry.id, ts: entry.ts, wordCount: words, durationMs: entry.durationMs });
      }
    }
    statsZone = zone;
    stats = {
      revision, computedAt: now, expiresAt: expiresAt(entries, now, 7),
      dictations: entries.length, wordCount, weekWords, weekDays,
      ...metrics.computeMetrics(entries), paceSamples,
    };
    return stats;
  }

  function getInsights(history, phrases, revision, options = {}, now = Date.now()) {
    const entries = entriesFor(history, revision);
    const range = ['all', '7d', '30d'].includes(options.range) ? options.range : 'all';
    const year = options.year != null && Number.isInteger(Number(options.year)) ? Number(options.year) : null;
    const zone = timeZoneKey(now);
    const key = range + ':' + year;
    const cached = insightResults.get(key);
    if (cached && cached.phraseCount === phrases.length && cached.zone === zone
        && now >= cached.reply.computedAt && now < cached.reply.expiresAt) return cached.reply;
    const reply = {
      revision, computedAt: now, expiresAt: expiresAt(entries, now, range === '7d' ? 7 : 30),
      result: insights.computeInsights(entries, phrases, range, now, { year }),
    };
    // A bounded cache covers the current range/year without retaining every
    // year the user has ever opened in this process.
    if (insightResults.size >= 12) insightResults.delete(insightResults.keys().next().value);
    insightResults.set(key, { reply, phraseCount: phrases.length, zone });
    return reply;
  }

  return { getStats, getInsights, invalidate };
}

module.exports = { createHistoryUsage };
