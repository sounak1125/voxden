'use strict';

// Feedback into Discord. Each report becomes a post in a forum channel through
// a webhook: bugs in one channel, ideas and everything else in the other. The
// post's thread is the ticket; the Desk bot (desk.js) tracks its status.
//
// Webhooks need no bot and no gateway, so delivery works even when the bot is
// not invited yet.

const KIND_LABELS = { bug: 'Bug', idea: 'Idea', other: 'Feedback' };
const KIND_COLORS = { bug: 0xe07070, idea: 0x9ef0c4, other: 0x9ba5ad };
const MAX_DESCRIPTION = 1800;
const MAX_TITLE = 90;

function firstLine(message) {
  return String(message || '').split('\n')[0].trim();
}

function threadName(report) {
  const label = KIND_LABELS[report.kind] || 'Feedback';
  const line = firstLine(report.message) || 'from the app';
  const title = label + ': ' + line;
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + '…' : title;
}

// The post body. Plain fields, no mentions ever, the report number in the
// footer so a thread can be traced back to its row.
function embedFor(report) {
  const description = String(report.message || '');
  const fields = [];
  fields.push({ name: 'From', value: report.email || 'no address given', inline: true });
  if (report.diagnostics) fields.push({ name: 'App details', value: '```\n' + String(report.diagnostics).slice(0, 900) + '\n```' });
  return {
    title: threadName(report),
    description: description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION - 1) + '…' : description,
    color: KIND_COLORS[report.kind] || KIND_COLORS.other,
    fields,
    footer: { text: 'Voxden feedback #' + report.id + ' · ' + (KIND_LABELS[report.kind] || 'Feedback') },
    timestamp: report.createdAt || new Date().toISOString(),
  };
}

function createDiscordNotifier(opts) {
  const o = opts || {};
  const hooks = { bugs: String(o.bugsWebhook || ''), ideas: String(o.ideasWebhook || '') };
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const log = o.log || (() => {});
  const configured = !!(hooks.bugs || hooks.ideas);

  function hookFor(kind) {
    if (kind === 'bug') return hooks.bugs || hooks.ideas;
    return hooks.ideas || hooks.bugs;
  }

  async function send(url, body) {
    const res = await fetchImpl(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: res.status, ok: res.ok, body: json, text };
  }

  // Posts one report. Resolves with the thread and message ids, or null when
  // nothing is configured. Throws when Discord refuses, so the caller can log
  // it without losing the stored report.
  async function post(report) {
    const url = hookFor(report.kind);
    if (!url) return null;
    const payload = {
      embeds: [embedFor(report)],
      allowed_mentions: { parse: [] },
      thread_name: threadName(report),
    };
    let res = await send(url, payload);
    if (res.status === 400) {
      // Not a forum channel: post without a thread name and open a thread
      // on the message instead is more than a webhook can do, so the message
      // itself is the ticket there.
      delete payload.thread_name;
      res = await send(url, payload);
    }
    if (!res.ok) throw new Error('Discord returned ' + res.status + (res.text ? ': ' + res.text.slice(0, 200) : ''));
    const message = res.body || {};
    return { threadId: String(message.channel_id || ''), messageId: String(message.id || '') };
  }

  // Where each webhook points, for the bot. Webhook GET needs no token.
  async function describe() {
    const out = {};
    for (const [kind, url] of Object.entries(hooks)) {
      if (!url) continue;
      try {
        const res = await fetchImpl(url);
        const info = await res.json();
        if (info && info.channel_id) out[kind] = { channelId: String(info.channel_id), guildId: String(info.guild_id || '') };
      } catch (err) {
        log('discord webhook lookup failed for ' + kind + ': ' + ((err && err.message) || err));
      }
    }
    return out;
  }

  return { configured, post, describe, threadName, embedFor };
}

module.exports = { createDiscordNotifier, threadName, embedFor, KIND_LABELS };
