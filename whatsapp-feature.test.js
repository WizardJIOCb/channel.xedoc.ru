import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWhatsAppFeature } from './whatsapp-feature.js';
import { normalizeMessages, primaryMessage } from './media-groups.js';

async function fixture(t, options = {}) {
  const connection = { id: 'c1', userId: 'u1', source: 'source_channel', name: 'Test', enabled: true, targetChatId: 'max-1', whatsapp: { groupId: '123456789@g.us', groupName: 'Test group', enabled: false } };
  const sourceMessages = [{ message_id: 101, date: 1750000000, text: 'Published Telegram post' }];
  const store = { connections: [connection], users: [{ id: 'u1', balanceKopecks: 500 }], history: [{ id: 'h1', connectionId: 'c1', source: 'source_channel', status: 'published', telegramMessageId: '101', maxMessageId: 'max-post-1', sourceMessages }], ledger: [{ type: 'delivery', amountKopecks: -100 }], telegramImports: [] };
  let accountState = 'connected';
  const sent = [];
  const client = {
    status: (id, options = {}) => ({ state: accountState, ...(options.includeQr && accountState === 'qr' ? { qr: 'data:image/png;base64,fake-qr' } : {}) }),
    start: async () => { accountState = 'qr'; }, resume: async () => {}, stop: async () => { accountState = 'stopped'; }, closeAll: async () => {},
    resolveGroup: options.resolveGroup || (async () => ({ id: '123456789@g.us', name: 'Test group' })),
    inspectGroup: options.inspectGroup || (async () => ({ id: '123456789@g.us', name: 'Test group', isCommunity: true })),
    resolveDestination: options.resolveDestination || (async () => ({ id: '123456790@g.us', name: 'Test group · Объявления' })),
    send: async (userId, groupId, payload, options) => { sent.push({ userId, groupId, payload, options }); return options.messageId; },
  };
  const feature = createWhatsAppFeature({
    client, getStore: () => store, save: async () => {}, page: (title, content) => content,
    html: (res, code, body) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(body); },
    go: (res, location) => { res.writeHead(303, { location }); res.end(); },
    needUser: (req, res) => { const id = req.headers['x-user']; if (!id) { res.writeHead(303, { location: '/login' }); res.end(); return null; } return { user: { id }, session: { csrf: 'csrf-test' } }; },
    forbidden: (res) => { res.writeHead(403); res.end(); },
    form: async (req) => { let body = ''; for await (const chunk of req) body += chunk; return Object.fromEntries(new URLSearchParams(body)); },
    csrf: (value, data) => data.csrf === value.session.csrf,
    loadMedia: options.loadMedia || (async () => { throw new Error('Unexpected media'); }),
    textOf: (messages) => primaryMessage(messages)?.text || '', filesOf: options.filesOf || (() => []), normalizeMessages, primaryMessage,
    refreshedPublicMessages: options.refreshedPublicMessages || (async (conn, id, fallback) => fallback),
  });
  await feature.init();
  const server = createServer(async (req, res) => { try { if (!await feature.handle(req, res, new URL(req.url, 'http://local.test'))) { res.writeHead(404); res.end(); } } catch (e) { res.writeHead(500); res.end(e.message); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await feature.close(); });
  const base = `http://127.0.0.1:${server.address().port}/connections/c1/whatsapp`;
  const request = (action = '', data, user = 'u1') => fetch(base + action, { method: data ? 'POST' : 'GET', headers: { ...(user ? { 'x-user': user } : {}) }, body: data ? new URLSearchParams(data) : undefined, redirect: 'manual' });
  return { request, store, feature, sent, connection, setState: (state) => { accountState = state; } };
}

test('WhatsApp routes isolate owner, QR and CSRF without sending', async (t) => {
  const { request, sent } = await fixture(t);
  assert.equal((await request('', undefined, '')).status, 303);
  assert.equal((await request('/status', undefined, 'u2')).status, 403);
  assert.equal((await request('/connect', { csrf: 'wrong' })).status, 403);
  assert.equal((await request('/connect', { csrf: 'csrf-test' })).status, 303);
  const status = await request('/status');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).qr, 'data:image/png;base64,fake-qr');
  assert.equal((await request('/status', undefined, 'u2')).status, 403);
  assert.equal(sent.length, 0);
});

test('saving a group does not publish or enable automatic reposting', async (t) => {
  const { request, connection, sent, store } = await fixture(t);
  const before = JSON.stringify({ history: store.history, ledger: store.ledger });
  const response = await request('/group', { csrf: 'csrf-test', invite: 'https://chat.whatsapp.com/abcdefghijklmnopqrstuv' });
  assert.equal(response.status, 303);
  assert.equal(connection.whatsapp.enabled, false);
  assert.equal(sent.length, 0);
  assert.equal(JSON.stringify({ history: store.history, ledger: store.ledger }), before);
});

test('destination inspection checks only the owning connection and never sends', async (t) => {
  const checks = [];
  const { request, sent } = await fixture(t, { inspectGroup: async (...args) => { checks.push(args); return { isCommunity: true }; } });
  assert.equal((await request('/status?inspectGroup=yes', undefined, 'u2')).status, 403);
  assert.equal(checks.length, 0);
  assert.equal((await (await request('/status?inspectGroup=yes')).json()).group.isCommunity, true);
  assert.deepEqual(checks, [['u1', '123456789@g.us']]);
  assert.equal(sent.length, 0);
});

test('repairing a saved community target selects announcements without sending', async (t) => {
  const { request, connection, sent } = await fixture(t);
  connection.whatsapp.enabled = true;
  assert.equal((await request('/group', { csrf: 'csrf-test', useSaved: 'yes' })).status, 303);
  assert.equal(connection.whatsapp.groupId, '123456790@g.us');
  assert.equal(connection.whatsapp.enabled, false);
  assert.equal(sent.length, 0);
});

test('manual history delivery reaches only WhatsApp with auto disabled, and is deduplicated', async (t) => {
  const { request, sent, store } = await fixture(t);
  const before = JSON.stringify({ users: store.users, history: store.history, ledger: store.ledger });
  const values = { csrf: 'csrf-test', messageId: '101' };
  const responses = await Promise.all([request('/send', values), request('/send', values)]);
  assert.ok(responses.every((r) => r.status === 200 || r.status === 400));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].groupId, '123456789@g.us');
  assert.match(sent[0].payload.text, /Архив Telegram/);
  assert.equal(store.whatsappDeliveries[0].status, 'published');
  await request('/send', values);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify({ users: store.users, history: store.history, ledger: store.ledger }), before);
});

test('automatic WhatsApp delivery is opt-in and ignores edits', async (t) => {
  const { feature, connection, sent } = await fixture(t);
  const message = { message_id: 102, text: 'New post' };
  await feature.auto(connection, message);
  assert.equal(sent.length, 0);
  connection.whatsapp.enabled = true;
  await feature.auto(connection, message, true);
  assert.equal(sent.length, 0);
  await feature.auto(connection, message);
  assert.equal(sent.length, 1);
});

test('cannot change groups while a historical source refresh is in flight', async (t) => {
  let releaseRefresh;
  let refreshStarted;
  let resolvedGroups = 0;
  const refreshing = new Promise((resolve) => { refreshStarted = resolve; });
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const { request, store, connection, sent } = await fixture(t, {
    refreshedPublicMessages: async (conn, id, fallback) => { refreshStarted(); await refreshGate; return fallback; },
    resolveGroup: async () => { resolvedGroups += 1; return { id: '987654321@g.us', name: 'Different group' }; },
  });
  store.history[0].sourceMessages[0].public_import = true;
  const sending = request('/send', { csrf: 'csrf-test', messageId: '101' });
  await refreshing;
  let groupResponse;
  try {
    groupResponse = await request('/group', { csrf: 'csrf-test', invite: 'https://chat.whatsapp.com/abcdefghijklmnopqrstuv' });
  } finally { releaseRefresh(); }
  assert.equal(groupResponse.status, 400);
  assert.equal((await sending).status, 200);
  assert.equal(resolvedGroups, 0);
  assert.equal(connection.whatsapp.groupId, '123456789@g.us');
  assert.deepEqual(sent.map((entry) => entry.groupId), ['123456789@g.us']);
});

test('explicit batch restart retries an old pre-network failure outside the visible last 100 posts', async (t) => {
  let downloads = 0;
  const { request, store, connection, sent } = await fixture(t, {
    filesOf: (message) => message.photo ? [{ type: 'image', id: 'photo' }] : [],
    loadMedia: async () => {
      downloads += 1;
      if (downloads === 1) throw new Error('Temporary media failure before sending');
      return { buffer: Buffer.from('test-image'), mimetype: 'image/jpeg', fileName: 'photo.jpg' };
    },
  });
  const posts = Array.from({ length: 101 }, (_, index) => ({ messageId: String(index + 1), preview: `Archive ${index + 1}`, sourceMessages: [{ message_id: index + 1, text: `Archive ${index + 1}`, ...(index === 0 ? { photo: [{ file_id: 'photo' }] } : {}) }] }));
  store.whatsappArchives.c1 = { posts, complete: true, pages: 6, skippedIds: [] };
  for (const post of posts.slice(1)) {
    store.whatsappDeliveries.push({ key: `already-published-${post.messageId}`, connectionId: 'c1', groupId: connection.whatsapp.groupId, telegramMessageId: post.messageId, telegramMessageIds: [post.messageId], status: 'published', sentMessageIds: [`wa-${post.messageId}`] });
  }
  const waitForBatch = async (status) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = await (await request('/status')).json();
      if (result.batch?.status === status) return result.batch;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Batch did not become ${status}`);
  };
  assert.equal((await request('/batch', { csrf: 'csrf-test' })).status, 303);
  assert.equal((await waitForBatch('paused')).cursor, 0);
  const entry = store.whatsappDeliveries.find((item) => item.telegramMessageId === '1');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.networkStartedAt, undefined);
  assert.equal(sent.length, 0);
  assert.doesNotMatch(await (await request()).text(), /name="messageId" value="1"/);
  assert.equal((await request('/batch', { csrf: 'csrf-test' })).status, 303);
  assert.equal((await waitForBatch('completed')).cursor, 101);
  assert.equal(entry.status, 'published');
  assert.equal(entry.attempts, 2);
  assert.equal(downloads, 2);
  assert.equal(sent.length, 2);
});
