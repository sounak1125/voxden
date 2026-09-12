'use strict';
// Feedback into Discord: the webhook posts (discord.js) and Voxden Desk
// (desk.js) against a fake Discord: a recording fetch and a scripted socket.
const assert = require('assert');
const { createStore } = require('../server/store');
const { createDiscordNotifier, threadName } = require('../server/discord');
const { createDesk, COMMANDS } = require('../server/desk');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body };
}

async function main() {
  // --- a database from before tickets existed ---------------------------------
  // The feedback table shipped without thread or status columns; opening such
  // a file must add them rather than fail on the index that needs them.
  const { DatabaseSync } = require('node:sqlite');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const oldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-store-')), 'old.sqlite');
  const old = new DatabaseSync(oldFile);
  old.exec("CREATE TABLE feedback (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, message TEXT NOT NULL, diagnostics TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);");
  old.exec("INSERT INTO feedback (kind, message, created_at) VALUES ('bug', 'from before', '2026-09-12T00:00:00.000Z');");
  old.close();
  const upgraded = createStore(oldFile);
  eq('an older database gains the ticket columns and keeps its rows', [upgraded.recentFeedback(1)[0].message, upgraded.recentFeedback(1)[0].status, upgraded.openFeedbackCount()], ['from before', 'open', 1]);
  upgraded.close();

  // --- webhook posts --------------------------------------------------------
  const calls = [];
  let forum = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (!init) return jsonResponse(200, { channel_id: url.includes('/bugs') ? 'chan-bugs' : 'chan-ideas', guild_id: 'guild-1', name: 'hook' });
    const body = JSON.parse(init.body);
    if (body.thread_name && !forum) return jsonResponse(400, { message: 'Invalid Form Body', code: 50035 });
    return jsonResponse(200, { id: 'msg-1', channel_id: body.thread_name ? 'thread-1' : 'chan-1' });
  };
  const notifier = createDiscordNotifier({ bugsWebhook: 'https://discord.com/api/webhooks/bugs/x', ideasWebhook: 'https://discord.com/api/webhooks/ideas/y', fetchImpl });
  eq('two webhooks make it configured', notifier.configured, true);
  eq('an unconfigured notifier posts nothing', createDiscordNotifier({}).configured, false);

  const report = { id: 7, kind: 'bug', message: 'Paste lands twice\nin Slack', email: 'me@example.com', diagnostics: 'version: 2.1.2\nplan: pro', createdAt: '2026-09-12T10:00:00.000Z' };
  const posted = await notifier.post(report);
  eq('a bug goes to the bugs webhook, waiting for the message', calls.at(-1).url, 'https://discord.com/api/webhooks/bugs/x?wait=true');
  const sent = JSON.parse(calls.at(-1).init.body);
  eq('the forum post is named after the kind and first line', sent.thread_name, 'Bug: Paste lands twice');
  eq('nothing in it can ping anyone', sent.allowed_mentions, { parse: [] });
  eq('the embed carries the words, the sender and the details',
    [sent.embeds[0].description, sent.embeds[0].fields[0].value, sent.embeds[0].fields[1].value, sent.embeds[0].footer.text],
    ['Paste lands twice\nin Slack', 'me@example.com', '```\nversion: 2.1.2\nplan: pro\n```', 'Voxden feedback #7 · Bug']);
  eq('the thread and message ids come back', posted, { threadId: 'thread-1', messageId: 'msg-1' });

  await notifier.post({ id: 8, kind: 'idea', message: 'Dark icons' });
  eq('an idea goes to the ideas webhook', calls.at(-1).url.startsWith('https://discord.com/api/webhooks/ideas/y'), true);
  await notifier.post({ id: 9, kind: 'other', message: 'Just saying hi' });
  eq('other feedback goes with the ideas', [calls.at(-1).url.startsWith('https://discord.com/api/webhooks/ideas/y'), JSON.parse(calls.at(-1).init.body).thread_name], [true, 'Feedback: Just saying hi']);
  eq('an anonymous report says so', JSON.parse(calls.at(-1).init.body).embeds[0].fields[0].value, 'no address given');

  forum = false;
  const before = calls.length;
  const plain = await notifier.post({ id: 10, kind: 'bug', message: 'Not a forum' });
  eq('a text channel refuses the thread name, so it is retried without one', [calls.length - before, 'thread_name' in JSON.parse(calls.at(-1).init.body)], [2, false]);
  eq('and the message itself is the ticket there', plain, { threadId: 'chan-1', messageId: 'msg-1' });
  forum = true;

  eq('a long first line is trimmed for the title', threadName({ kind: 'idea', message: 'x'.repeat(200) }).length, 90);
  eq('the webhooks say where they point', await notifier.describe(), {
    bugs: { channelId: 'chan-bugs', guildId: 'guild-1' }, ideas: { channelId: 'chan-ideas', guildId: 'guild-1' },
  });

  // --- the Desk ---------------------------------------------------------------
  const store = createStore(':memory:');
  const t1 = store.createFeedback({ kind: 'bug', message: 'Paste lands twice', createdAt: '2026-09-12T10:00:00.000Z' });
  store.setFeedbackThread(t1, 'thread-1', 'msg-1');
  const t2 = store.createFeedback({ kind: 'idea', message: 'Dark icons', createdAt: '2026-09-12T10:01:00.000Z' });
  store.setFeedbackThread(t2, 'thread-2', 'msg-2');
  eq('a report starts open', store.feedbackById(t1).status, 'open');
  eq('a thread finds its row', store.feedbackByThread('thread-2').id, t2);

  const rest = [];
  const channels = {
    'chan-bugs': { id: 'chan-bugs', type: 15, guild_id: 'guild-1', available_tags: [{ id: 'tag-open', name: 'Open' }] },
    'chan-ideas': { id: 'chan-ideas', type: 15, guild_id: 'guild-1', available_tags: [] },
  };
  const deskFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = url.replace('https://discord.com/api/v10', '');
    rest.push({ method, path, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (path === '/users/@me') return jsonResponse(200, { id: 'bot-1', username: 'Voxden Desk' });
    if (path === '/oauth2/applications/@me') return jsonResponse(200, { id: 'app-1' });
    if (path === '/gateway/bot') return jsonResponse(200, { url: 'wss://gateway.test' });
    const chan = /^\/channels\/(chan-[a-z]+)$/.exec(path);
    if (chan && method === 'GET') return jsonResponse(200, channels[chan[1]]);
    if (chan && method === 'PATCH') {
      const body = JSON.parse(init.body);
      channels[chan[1]].available_tags = body.available_tags.map((t, i) => Object.assign({ id: t.id || ('new-' + chan[1] + '-' + i) }, t));
      return jsonResponse(200, channels[chan[1]]);
    }
    return jsonResponse(204);
  };
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  const timers = [];
  const desk = createDesk({
    token: 'bot-token', store, notifier, fetchImpl: deskFetch, WebSocketImpl: FakeSocket,
    // Zero-delay waits (the ticket lookup retries) run at once; everything
    // else is recorded so the test can fire it by hand.
    setTimeout: (fn, ms) => { if (ms === 0) { fn(); return 0; } timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    log: () => {}, lookupDelayMs: 0,
  });
  eq('the desk starts', await desk.start(), true);
  eq('it learned who it is', [desk.state.botId, desk.state.appId, desk.state.guildId], ['bot-1', 'app-1', 'guild-1']);
  eq('the bugs forum kept its Open tag and gained Done', channels['chan-bugs'].available_tags.map((t) => t.name), ['Open', 'Done']);
  eq('the ideas forum gained both', channels['chan-ideas'].available_tags.map((t) => t.name), ['Open', 'Done']);
  eq('the tags are remembered per channel', desk.state.channels['chan-bugs'].tags, { open: 'tag-open', done: 'new-chan-bugs-1' });
  const registered = rest.find((c) => c.method === 'PUT' && c.path === '/applications/app-1/guilds/guild-1/commands');
  eq('the slash commands are registered for the server', registered.body.map((c) => c.name), COMMANDS.map((c) => c.name));
  eq('one gateway socket was opened', [sockets.length, sockets[0].url], [1, 'wss://gateway.test/?v=10&encoding=json']);
  // Once the Desk knows the tags, posts are born Open instead of waiting
  // for the thread event.
  await notifier.post({ id: 11, kind: 'bug', message: 'Born tagged' });
  eq('a bug post now carries the bugs forum Open tag', JSON.parse(calls.at(-1).init.body).applied_tags, ['tag-open']);
  await notifier.post({ id: 12, kind: 'idea', message: 'Born tagged too' });
  eq('an idea post carries the ideas forum Open tag', JSON.parse(calls.at(-1).init.body).applied_tags, ['new-chan-ideas-0']);

  const socket = sockets[0];
  socket.onmessage({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
  eq('hello is answered with identify', [socket.sent.at(-1).op, socket.sent.at(-1).d.intents, socket.sent.at(-1).d.token], [2, 1025, 'bot-token']);
  eq('and a heartbeat is scheduled', timers.at(-1).ms <= 41250, true);
  timers.at(-1).fn();
  eq('the heartbeat carries the last sequence', socket.sent.at(-1), { op: 1, d: null });
  socket.onmessage({ data: JSON.stringify({ op: 0, s: 3, t: 'READY', d: { user: { username: 'Voxden Desk' }, session_id: 'sess-1', resume_gateway_url: 'wss://resume.test' } }) });
  eq('ready is noted, with the session to resume', [desk.state.ready, desk.state.sessionId, desk.state.resumeUrl], [true, 'sess-1', 'wss://resume.test']);

  // A new forum post from the webhook gets the Open tag.
  rest.length = 0;
  await desk.onEvent('THREAD_CREATE', { id: 'thread-2', parent_id: 'chan-ideas', newly_created: true, applied_tags: [] });
  eq('a new ticket is tagged Open', rest.at(-1), { method: 'PATCH', path: '/channels/thread-2', body: { applied_tags: ['new-chan-ideas-0'] } });
  rest.length = 0;
  await desk.onEvent('THREAD_CREATE', { id: 'thread-unknown', parent_id: 'chan-ideas', newly_created: true, applied_tags: [] });
  eq('a thread that is not a ticket is left alone', rest.length, 0);
  // The thread event usually beats the row update; the row arriving a moment
  // later is still found.
  const t3 = store.createFeedback({ kind: 'idea', message: 'Late row', createdAt: '2026-09-12T10:02:00.000Z' });
  rest.length = 0;
  const pending = desk.onEvent('THREAD_CREATE', { id: 'thread-3', parent_id: 'chan-ideas', newly_created: true, applied_tags: [] });
  store.setFeedbackThread(t3, 'thread-3', 'msg-3');
  await pending;
  eq('a ticket whose row lands after the event is still tagged', rest.at(-1), { method: 'PATCH', path: '/channels/thread-3', body: { applied_tags: ['new-chan-ideas-0'] } });
  store.setFeedbackStatus(t3, 'done', '2026-09-12T10:03:00.000Z', 'test');
  await desk.onEvent('THREAD_CREATE', { id: 'thread-2', parent_id: 'chan-ideas', newly_created: true, applied_tags: ['new-chan-ideas-0'] });
  eq('a thread already tagged Open is not touched again', rest.at(-1).path, '/channels/thread-3');

  // /done inside a ticket.
  rest.length = 0;
  const interaction = (name, channelId, parentId) => ({
    type: 2, id: 'i-' + name, token: 'tok', channel_id: channelId, channel: { id: channelId, parent_id: parentId },
    member: { user: { username: 'sounak', global_name: 'Sounak' } }, data: { name },
  });
  await desk.onEvent('INTERACTION_CREATE', interaction('done', 'thread-1', 'chan-bugs'));
  eq('/done is acknowledged at once, privately', rest[0], { method: 'POST', path: '/interactions/i-done/tok/callback', body: { type: 5, data: { flags: 64 } } });
  eq('then says so in the thread', rest[1].body.content, '✅ Done, marked by Sounak.');
  eq('then confirms to whoever asked, while the thread is still open', rest[2], { method: 'PATCH', path: '/webhooks/app-1/tok/messages/@original', body: { content: 'Marked #' + t1 + ' done.', allowed_mentions: { parse: [] } } });
  eq('and archives it last, tagged Done', rest[3], { method: 'PATCH', path: '/channels/thread-1', body: { applied_tags: ['new-chan-bugs-1'], archived: true, locked: false } });
  eq('the row is resolved with who did it', [store.feedbackById(t1).status, store.feedbackById(t1).resolved_by, typeof store.feedbackById(t1).resolved_at], ['done', 'Sounak', 'string']);

  rest.length = 0;
  await desk.onEvent('INTERACTION_CREATE', interaction('done', 'thread-1', 'chan-bugs'));
  eq('/done twice just says so', [rest.length, rest[0].body.data.content], [1, 'Ticket #' + t1 + ' is already done.']);

  rest.length = 0;
  await desk.onEvent('INTERACTION_CREATE', interaction('reopen', 'thread-1', 'chan-bugs'));
  eq('/reopen tags it Open again and unarchives', [rest[3].body, store.feedbackById(t1).status, store.feedbackById(t1).resolved_at], [{ applied_tags: ['tag-open'], archived: false }, 'open', null]);
  // A replayed command is past Discord's reply window; the change still lands.
  rest.length = 0;
  const strictFetch = deskFetch;
  desk.state.sequence = 40;
  const lateDesk = createDesk({
    token: 'bot-token', store, notifier, WebSocketImpl: FakeSocket, log: () => {}, lookupDelayMs: 0,
    setTimeout: (fn, ms) => { if (ms === 0) { fn(); return 0; } timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetchImpl: async (url, init) => (url.includes('/interactions/') ? jsonResponse(404, { message: 'Unknown interaction' }) : strictFetch(url, init)),
  });
  await lateDesk.setup();
  rest.length = 0;
  await lateDesk.onEvent('INTERACTION_CREATE', interaction('done', 'thread-1', 'chan-bugs'));
  eq('a late command is swallowed and the ticket is still done', store.feedbackById(t1).status, 'done');
  eq('with no confirmation attempted for it', rest.some((c) => c.path.includes('/messages/@original')), false);
  store.setFeedbackStatus(t1, 'open', null, '');

  rest.length = 0;
  await desk.onEvent('INTERACTION_CREATE', interaction('done', 'random-channel', 'chan-bugs'));
  eq('/done outside a ticket explains itself', rest[0].body.data.content, 'This is not a feedback ticket thread. Run it inside a ticket.');

  rest.length = 0;
  await desk.onEvent('INTERACTION_CREATE', interaction('open', 'random-channel', ''));
  eq('/open lists what is left, newest first, with links', rest[0].body.data.content,
    '2 open:\n• #' + t2 + ' Idea — Dark icons https://discord.com/channels/guild-1/thread-2\n• #' + t1 + ' Bug — Paste lands twice https://discord.com/channels/guild-1/thread-1');

  // A ✅ on the ticket's first post also closes it.
  rest.length = 0;
  await desk.onEvent('MESSAGE_REACTION_ADD', { channel_id: 'thread-2', message_id: 'msg-2', user_id: 'user-9', emoji: { name: '✅' }, member: { user: { username: 'ria' } } });
  eq('a tick on the first post marks it done by that person', [store.feedbackById(t2).status, store.feedbackById(t2).resolved_by], ['done', 'ria']);
  rest.length = 0;
  await desk.onEvent('MESSAGE_REACTION_ADD', { channel_id: 'thread-1', message_id: 'some-reply', user_id: 'user-9', emoji: { name: '✅' } });
  eq('a tick on a reply does nothing', [rest.length, store.feedbackById(t1).status], [0, 'open']);
  await desk.onEvent('MESSAGE_REACTION_ADD', { channel_id: 'thread-1', message_id: 'msg-1', user_id: 'bot-1', emoji: { name: '✅' } });
  eq('the bot\'s own reactions do not count', store.feedbackById(t1).status, 'open');
  eq('/open then shows the one left', desk.openList(), '1 open:\n• #' + t1 + ' Bug — Paste lands twice https://discord.com/channels/guild-1/thread-1');

  // Losing the gateway resumes the session on Discord's resume address, so
  // missed events are replayed; stopping does not.
  const timersBefore = timers.length;
  socket.close();
  eq('a dropped gateway schedules a quick reconnect', [timers.length - timersBefore, timers.at(-1).ms], [1, 1000]);
  await timers.at(-1).fn();
  const resumed = sockets.at(-1);
  eq('it reconnects to the resume address', resumed.url, 'wss://resume.test/?v=10&encoding=json');
  resumed.onmessage({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
  eq('and resumes instead of identifying', resumed.sent.at(-1), { op: 6, d: { token: 'bot-token', session_id: 'sess-1', seq: 40 } });
  resumed.onmessage({ data: JSON.stringify({ op: 0, s: 41, t: 'RESUMED', d: {} }) });
  eq('resumed is online again', desk.state.ready, true);
  resumed.onmessage({ data: JSON.stringify({ op: 9, d: false }) });
  eq('an unresumable session forgets its id', [desk.state.sessionId, sockets.at(-1).readyState], ['', 3]);
  timers.at(-1).fn();
  // A fresh identify looks the gateway address up first; let that settle.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  eq('and the next connection identifies afresh', sockets.at(-1).url, 'wss://gateway.test/?v=10&encoding=json');
  desk.stop();
  eq('stopping closes the socket and reconnects no more', [desk.state.socket, sockets.at(-1).readyState], [null, 3]);

  // An uninvited bot is a retry, not a crash.
  const lonely = createDesk({
    token: 'bot-token', store, notifier: { describe: async () => ({ bugs: { channelId: 'chan-missing', guildId: '' } }) },
    fetchImpl: async (url, init) => {
      const path = url.replace('https://discord.com/api/v10', '');
      if (path === '/users/@me') return jsonResponse(200, { id: 'bot-1' });
      if (path === '/oauth2/applications/@me') return jsonResponse(200, { id: 'app-1' });
      return jsonResponse(403, { message: 'Missing Access' });
    },
    WebSocketImpl: FakeSocket, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout: () => {}, log: () => {}, retryMs: 1234,
  });
  eq('a bot that cannot see its channels does not start', await lonely.start(), false);
  eq('but tries again later', timers.at(-1).ms, 1234);

  store.close();
  process.stdout.write('all ' + checks + ' discord checks passed\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
