'use strict';

// Voxden Desk: the bot that keeps the feedback threads honest. It lives in
// the account service process, talks to Discord over REST with fetch and to
// the gateway with Node's own WebSocket, and needs no npm package.
//
// What it does:
//   - keeps an "Open" and a "Done" tag on each feedback forum channel and
//     tags every new ticket Open;
//   - /done, /reopen and /open slash commands in the server, plus a ✅
//     reaction on the ticket's first post, which also marks it done;
//   - writes the status back to the feedback table, so the service and the
//     server never disagree about what is left.
//
// Everything it needs is behind `deps`, so the tests can drive it with a
// fake fetch and a fake socket.

const API = 'https://discord.com/api/v10';
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGE_REACTIONS = 1 << 10;
const CHANNEL_FORUM = 15;
const OPEN_TAG = 'Open';
const DONE_TAG = 'Done';
const EPHEMERAL = 1 << 6;

const COMMANDS = [
  { name: 'done', description: 'Mark this ticket done', type: 1 },
  { name: 'reopen', description: 'Reopen this ticket', type: 1 },
  { name: 'open', description: 'List the tickets still open', type: 1 },
];

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

function createDesk(opts) {
  const o = opts || {};
  const token = String(o.token || '');
  const store = o.store;
  const notifier = o.notifier;
  const log = o.log || (() => {});
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const WebSocketImpl = o.WebSocketImpl || globalThis.WebSocket;
  const setTimer = o.setTimeout || setTimeout;
  const clearTimer = o.clearTimeout || clearTimeout;
  const retryMs = Number.isFinite(o.retryMs) ? o.retryMs : 60e3;
  if (!store) throw new Error('createDesk needs a store');

  const state = {
    appId: '',
    botId: '',
    guildId: '',
    channels: {},       // channelId -> { kind, tags: { open, done } }
    socket: null,
    heartbeat: null,
    sequence: null,
    stopped: false,
    ready: false,
  };

  async function rest(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: Object.assign({ Authorization: 'Bot ' + token }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    const text = await res.text().catch(() => '');
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      const err = new Error('Discord ' + method + ' ' + path + ' returned ' + res.status + (text ? ': ' + text.slice(0, 160) : ''));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // --- setup ---------------------------------------------------------------

  async function ensureTags(channelId) {
    const channel = await rest('GET', '/channels/' + channelId);
    if (channel.type !== CHANNEL_FORUM) {
      log('desk: channel ' + channelId + ' is not a forum; tickets there cannot be tagged');
      return { open: '', done: '' };
    }
    const tags = Array.isArray(channel.available_tags) ? channel.available_tags.slice() : [];
    const find = (name) => tags.find((t) => String(t.name).toLowerCase() === name.toLowerCase());
    let changed = false;
    for (const name of [OPEN_TAG, DONE_TAG]) {
      if (!find(name)) {
        tags.push({ name, moderated: false });
        changed = true;
      }
    }
    let final = tags;
    if (changed) {
      const updated = await rest('PATCH', '/channels/' + channelId, { available_tags: tags.map((t) => (t.id ? t : { name: t.name, moderated: false })) });
      final = Array.isArray(updated.available_tags) ? updated.available_tags : tags;
    }
    const open = final.find((t) => String(t.name).toLowerCase() === OPEN_TAG.toLowerCase());
    const done = final.find((t) => String(t.name).toLowerCase() === DONE_TAG.toLowerCase());
    return { open: open ? String(open.id) : '', done: done ? String(done.id) : '', guildId: String(channel.guild_id || '') };
  }

  async function setup() {
    const me = await rest('GET', '/users/@me');
    state.botId = String(me.id);
    const application = await rest('GET', '/oauth2/applications/@me');
    state.appId = String(application.id);
    const targets = notifier && typeof notifier.describe === 'function' ? await notifier.describe() : {};
    state.channels = {};
    for (const [kind, target] of Object.entries(targets)) {
      const tags = await ensureTags(target.channelId);
      state.channels[target.channelId] = { kind, tags: { open: tags.open, done: tags.done } };
      if (tags.guildId) state.guildId = tags.guildId;
      else if (target.guildId) state.guildId = target.guildId;
    }
    if (!state.guildId) throw new Error('no feedback channel is reachable; is the bot invited to the server?');
    await rest('PUT', '/applications/' + state.appId + '/guilds/' + state.guildId + '/commands', COMMANDS);
  }

  // --- tickets -------------------------------------------------------------

  function ticketFor(threadId) {
    return store.feedbackByThread(String(threadId)) || null;
  }

  function threadLink(threadId) {
    return 'https://discord.com/channels/' + state.guildId + '/' + threadId;
  }

  async function applyStatus(ticket, status, byName) {
    const channel = state.channels[String(ticket.parent_channel_id || '')] || Object.values(state.channels).find((c) => c.kind === (ticket.kind === 'bug' ? 'bugs' : 'ideas'));
    const tags = channel ? channel.tags : { open: '', done: '' };
    const done = status === 'done';
    const now = new Date().toISOString();
    store.setFeedbackStatus(ticket.id, status, done ? now : null, done ? byName : '');
    const patch = {};
    const tagId = done ? tags.done : tags.open;
    if (tagId) patch.applied_tags = [tagId];
    patch.archived = done;
    if (done) patch.locked = false;
    try {
      await rest('POST', '/channels/' + ticket.thread_id + '/messages', {
        content: done ? '✅ Done, marked by ' + byName + '.' : '↩️ Reopened by ' + byName + '.',
        allowed_mentions: { parse: [] },
      });
      await rest('PATCH', '/channels/' + ticket.thread_id, patch);
    } catch (err) {
      log('desk: could not update thread ' + ticket.thread_id + ': ' + ((err && err.message) || err));
    }
  }

  async function markNewThread(thread) {
    const channel = state.channels[String(thread.parent_id || '')];
    if (!channel) return;
    const ticket = ticketFor(thread.id);
    if (!ticket) return;
    if (!channel.tags.open) return;
    const applied = Array.isArray(thread.applied_tags) ? thread.applied_tags.map(String) : [];
    if (applied.includes(channel.tags.open)) return;
    try {
      await rest('PATCH', '/channels/' + thread.id, { applied_tags: [channel.tags.open] });
    } catch (err) {
      log('desk: could not tag new ticket ' + thread.id + ': ' + ((err && err.message) || err));
    }
  }

  function openList() {
    const rows = store.openFeedback(25);
    if (!rows.length) return 'Nothing open. Inbox zero.';
    const lines = rows.map((row) => {
      const label = row.kind === 'bug' ? 'Bug' : row.kind === 'idea' ? 'Idea' : 'Feedback';
      const where = row.thread_id ? threadLink(row.thread_id) : '(no thread)';
      return '• #' + row.id + ' ' + label + ' — ' + firstLine(row.message).slice(0, 60) + ' ' + where;
    });
    const total = store.openFeedbackCount();
    return (total > rows.length ? total + ' open, newest ' + rows.length + ':\n' : rows.length + ' open:\n') + lines.join('\n');
  }

  // --- gateway events --------------------------------------------------------

  async function respond(interaction, content, ephemeral) {
    await rest('POST', '/interactions/' + interaction.id + '/' + interaction.token + '/callback', {
      type: 4,
      data: { content, allowed_mentions: { parse: [] }, flags: ephemeral ? EPHEMERAL : 0 },
    });
  }

  function nameOf(interactionOrUser) {
    const user = interactionOrUser.member && interactionOrUser.member.user ? interactionOrUser.member.user : interactionOrUser.user || interactionOrUser;
    return String((user && (user.global_name || user.username)) || 'someone');
  }

  async function onInteraction(interaction) {
    if (!interaction || interaction.type !== 2 || !interaction.data) return;
    const name = String(interaction.data.name || '');
    const by = nameOf(interaction);
    if (name === 'open') {
      await respond(interaction, openList(), true);
      return;
    }
    if (name !== 'done' && name !== 'reopen') return;
    const ticket = ticketFor(interaction.channel_id);
    if (!ticket) {
      await respond(interaction, 'This is not a feedback ticket thread. Run it inside a ticket.', true);
      return;
    }
    const status = name === 'done' ? 'done' : 'open';
    if (ticket.status === status) {
      await respond(interaction, 'Ticket #' + ticket.id + ' is already ' + (status === 'done' ? 'done' : 'open') + '.', true);
      return;
    }
    await respond(interaction, (status === 'done' ? 'Marking #' + ticket.id + ' done.' : 'Reopening #' + ticket.id + '.'), true);
    await applyStatus(Object.assign({}, ticket, { parent_channel_id: interaction.channel && interaction.channel.parent_id }), status, by);
  }

  async function onReaction(event) {
    if (!event || !event.emoji || event.emoji.name !== '✅') return;
    if (String(event.user_id) === state.botId) return;
    const ticket = ticketFor(event.channel_id);
    if (!ticket || ticket.status === 'done') return;
    // Only the ticket's own first post counts, not a reaction on chatter.
    if (ticket.message_id && String(event.message_id) !== String(ticket.message_id) && String(event.message_id) !== String(ticket.thread_id)) return;
    let by = 'someone';
    if (event.member && event.member.user) by = nameOf(event.member);
    await applyStatus(ticket, 'done', by);
  }

  async function onEvent(name, data) {
    try {
      if (name === 'READY') {
        state.ready = true;
        log('desk: online as ' + ((data.user && data.user.username) || state.botId));
      } else if (name === 'INTERACTION_CREATE') {
        await onInteraction(data);
      } else if (name === 'THREAD_CREATE') {
        if (data && data.newly_created) await markNewThread(data);
      } else if (name === 'MESSAGE_REACTION_ADD') {
        await onReaction(data);
      }
    } catch (err) {
      log('desk: ' + name + ' failed: ' + ((err && err.message) || err));
    }
  }

  // --- gateway connection ---------------------------------------------------

  function sendOp(op, d) {
    if (!state.socket || state.socket.readyState !== 1) return;
    state.socket.send(JSON.stringify({ op, d }));
  }

  function stopHeartbeat() {
    if (state.heartbeat) clearTimer(state.heartbeat);
    state.heartbeat = null;
  }

  function startHeartbeat(intervalMs) {
    stopHeartbeat();
    const beat = () => {
      sendOp(1, state.sequence);
      state.heartbeat = setTimer(beat, intervalMs);
    };
    state.heartbeat = setTimer(beat, Math.max(1000, Math.floor(intervalMs * Math.random())));
  }

  function identify() {
    sendOp(2, {
      token,
      intents: INTENT_GUILDS | INTENT_GUILD_MESSAGE_REACTIONS,
      properties: { os: process.platform, browser: 'voxden-desk', device: 'voxden-desk' },
    });
  }

  function onMessage(raw) {
    let packet;
    try { packet = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (_) { return; }
    if (packet.s !== undefined && packet.s !== null) state.sequence = packet.s;
    if (packet.op === 10) {
      startHeartbeat(Number(packet.d && packet.d.heartbeat_interval) || 41250);
      identify();
    } else if (packet.op === 1) {
      sendOp(1, state.sequence);
    } else if (packet.op === 7 || packet.op === 9) {
      // Reconnect or invalid session: start over with a fresh identify.
      if (state.socket) { try { state.socket.close(); } catch (_) {} }
    } else if (packet.op === 0) {
      onEvent(packet.t, packet.d);
    }
  }

  async function connect() {
    if (state.stopped) return;
    const gateway = await rest('GET', '/gateway/bot');
    const url = String(gateway.url || 'wss://gateway.discord.gg') + '/?v=10&encoding=json';
    const socket = new WebSocketImpl(url);
    state.socket = socket;
    state.ready = false;
    socket.onmessage = (event) => onMessage(event.data);
    socket.onerror = (event) => log('desk: socket error ' + ((event && event.message) || ''));
    socket.onclose = (event) => {
      stopHeartbeat();
      state.ready = false;
      if (state.socket === socket) state.socket = null;
      if (state.stopped) return;
      log('desk: gateway closed (' + ((event && event.code) || '?') + '), reconnecting');
      setTimer(() => { connect().catch(scheduleRetry); }, 5000);
    };
  }

  function scheduleRetry(err) {
    if (state.stopped) return;
    log('desk: not started (' + ((err && err.message) || err) + '); retrying in ' + Math.round(retryMs / 1000) + 's');
    setTimer(() => { start().catch(() => {}); }, retryMs);
  }

  async function start() {
    if (!token) throw new Error('no bot token');
    state.stopped = false;
    try {
      await setup();
      await connect();
    } catch (err) {
      scheduleRetry(err);
      return false;
    }
    return true;
  }

  function stop() {
    state.stopped = true;
    stopHeartbeat();
    if (state.socket) { try { state.socket.close(); } catch (_) {} }
    state.socket = null;
  }

  return {
    start, stop, setup, state,
    onEvent, onInteraction, onReaction, onMessage, openList, applyStatus, markNewThread,
    configured: !!token,
  };
}

module.exports = { createDesk, COMMANDS, OPEN_TAG, DONE_TAG };
