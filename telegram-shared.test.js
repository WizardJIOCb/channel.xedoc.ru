import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSharedTelegram } from './telegram-shared.js';

test('shared routing isolates bot identities, channel IDs, pauses and ambiguous sources', () => {
  const anchor = { id: 'original', source: 'old_channel', telegramToken: 'common', enabled: false };
  const child = { id: 'new', source: 'new_channel', telegramSourceChatId: '-200', telegramToken: 'common', enabled: true };
  const other = { id: 'other', source: 'other_channel', telegramToken: 'private', enabled: true };
  const state = { connections: [anchor, child, other] };
  const shared = createSharedTelegram({ getStore: () => state, token: 'common', unseal: (v) => v });
  assert.equal(shared.anchorFor(child), anchor);
  assert.equal(shared.postConnection(anchor, { chat: { username: 'NEW_CHANNEL', id: -200 } }), child);
  assert.equal(shared.postConnection(other, { chat: { username: 'new_channel', id: -200 } }), null);
  assert.equal(shared.postConnection(anchor, { chat: { username: 'new_channel', id: -201 } }), null);
  assert.equal(shared.postConnection(anchor, { chat: { username: 'old_channel' } }), null);
  assert.equal(shared.postConnection(anchor, {}), null);
  child.enabled = false;
  assert.equal(shared.postConnection(anchor, { chat: { username: 'new_channel', id: -200 } }), null);
  child.enabled = true;
  state.connections.push({ ...child, id: 'duplicate' });
  assert.equal(shared.postConnection(anchor, { chat: { username: 'new_channel', id: -200 } }), null);
});

test('shared channel creation, Telegram linking and tenant delivery retain the original webhook', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-shared-'));
  const path = join(directory, 'app.json');
  const key = Buffer.alloc(32, 25);
  const now = new Date().toISOString();
  const seal = (value) => {
    const iv = Buffer.alloc(12, 5);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  };
  const connection = (id, source, token, userId) => ({ id, source, userId, telegramToken: seal(token), telegramSecret: id === 'connection-1' ? 'telegram-secret' : 'other-secret', maxToken: seal(`max-${id}`), maxSecret: 'max-secret', targetChatId: `target-${id}`, enabled: true, telegramApiMode: 'local', createdAt: now, updatedAt: now });
  const original = connection('connection-1', 'old_channel', 'common-token', 'owner');
  const privateConnection = connection('private', 'private_channel', 'private-token', 'owner');
  await writeFile(path, JSON.stringify({
    users: [{ id: 'new-user', email: 'new@example.test', balanceKopecks: 500, walletInitializedAt: now }, { id: 'owner', email: 'owner@example.test', balanceKopecks: 500, walletInitializedAt: now }],
    sessions: [{ id: 'session-1', userId: 'new-user', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [original, privateConnection], history: [], ledger: [], pendingAlbums: [],
    migrated: true, connectionWebhooksMigrated: true, telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }));
  Object.assign(process.env, { APP_ENCRYPTION_KEY: key.toString('base64'), PUBLIC_BASE_URL: 'https://channel.example.test', STATE_PATH: path, PORT: '0', TELEGRAM_SHARED_BOT_TOKEN: 'common-token', TELEGRAM_LOCAL_API_URL: 'http://127.0.0.1:8081', TELEGRAM_LOCAL_SOURCES: 'old_channel' });
  const originalFetch = globalThis.fetch;
  const calls = [], sends = [];
  let userStatus = 'administrator', botStatus = 'administrator';
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input), payload = options.body ? JSON.parse(options.body) : {};
    calls.push({ url, payload });
    let result;
    if (url.endsWith('/getMe')) result = { id: 77, username: 'MultiPoostBot' };
    else if (url.endsWith('/getChat')) result = { id: -200, type: 'channel', username: 'new_channel' };
    else if (url.endsWith('/getChatMember')) result = { status: payload.user_id === 77 ? botStatus : userStatus };
    else if (url.endsWith('/setWebhook') || url.endsWith('/setMyCommands') || url.endsWith('/sendMessage')) result = true;
    else if (url === 'https://platform-api2.max.ru/subscriptions') return Response.json({ success: true });
    else if (url.startsWith('https://platform-api2.max.ru/messages?') && options.method === 'POST') {
      sends.push({ url, payload, token: options.headers.Authorization });
      return Response.json({ message: { body: { mid: `mid-${sends.length}` } } });
    } else throw new Error(`Unexpected request: ${url}`);
    return Response.json({ ok: true, result });
  };
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    for (const name of ['TELEGRAM_SHARED_BOT_TOKEN', 'TELEGRAM_LOCAL_API_URL', 'TELEGRAM_LOCAL_SOURCES']) delete process.env[name];
    await rm(directory, { recursive: true, force: true });
  });
  ({ server } = await import(`./server.js?shared-test=${Date.now()}`));
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (route, values) => {
    const response = await originalFetch(`${base}${route}`, { method: values ? 'POST' : 'GET', headers: { cookie: 'session=session-1' }, body: values ? new URLSearchParams(values) : undefined, redirect: 'manual' });
    return { status: response.status, body: await response.text() };
  };
  const webhook = async (payload, endpoint = 'connection-1', secret = 'telegram-secret') => {
    const response = await originalFetch(`${base}/webhooks/telegram/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(payload) });
    await response.text(); return response.status;
  };
  const form = { csrf: 'csrf-token', source: '@new_channel', name: 'New channel', maxToken: 'max-new', targetChatId: 'target-new' };
  const readState = async () => JSON.parse(await readFile(path, 'utf8'));
  const page = await http('/dashboard?new=1');
  assert.match(page.body, /общий бот @MultiPoostBot/);
  assert.match(page.body, /name="telegramToken"[^>]+>/);
  assert.doesNotMatch(page.body.match(/<input name="telegramToken"[^>]*>/)[0], /required/);
  assert.match(page.body.match(/<input name="maxToken"[^>]*>/)[0], /required/);
  assert.equal((await http('/connections', { ...form, csrf: 'wrong' })).status, 403);
  const unlinked = await http('/connections', form);
  assert.equal(unlinked.status, 400);
  assert.match(unlinked.body, /отправьте \/link/);
  assert.equal((await readState()).connections.length, 2);
  assert.equal(calls.length, 0);

  assert.equal(await webhook({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/link' } }), 200);
  const link = (await readState()).telegramLinks[0];
  assert.equal((await http('/telegram/link', { csrf: 'csrf-token', token: link.token })).status, 200);
  assert.equal((await readState()).users[0].telegramChatId, '42');
  userStatus = 'member';
  assert.equal((await http('/connections', form)).status, 400);
  userStatus = 'administrator'; botStatus = 'member';
  assert.equal((await http('/connections', form)).status, 400);
  botStatus = 'administrator';
  assert.equal((await http('/connections', { ...form, telegramToken: 'private-token' })).status, 409);
  const created = await Promise.all([http('/connections', form), http('/connections', form)]);
  assert.deepEqual(created.map((r) => r.status).sort(), [303, 409]);
  let state = await readState();
  assert.equal(state.connections.length, 3);
  assert.deepEqual(state.connections[0], original);
  assert.deepEqual(state.connections[1], privateConnection);
  const child = state.connections[2];
  assert.equal(child.userId, 'new-user');
  assert.equal(child.telegramSourceChatId, '-200');
  assert.equal(child.telegramApiMode, 'local');
  assert.equal(child.error, null);
  const hooks = calls.filter((c) => c.url.endsWith('/setWebhook'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.url, 'https://channel.example.test/webhooks/telegram/connection-1');
  assert.equal(hooks[0].payload.secret_token, 'telegram-secret');
  assert.equal(calls.some((c) => c.url.endsWith('/logOut')), false);
  assert.equal(calls.filter((c) => c.url.includes('/botcommon-token/')).every((c) => c.url.startsWith('http://127.0.0.1:8081/')), true);
  const post = (source, id, chatId) => ({ channel_post: { message_id: id, date: 1793600000, text: `Post ${source}`, chat: { username: source, id: chatId } } });
  assert.equal(await webhook(post('new_channel', 10, -200), 'private', 'other-secret'), 200);
  assert.equal(await webhook(post('new_channel', 10, -200), 'connection-1', 'wrong-secret'), 401);
  assert.equal(await webhook(post('new_channel', 10, -201)), 200);
  assert.equal(sends.length, 0);
  assert.equal(await webhook(post('old_channel', 1, -100)), 200);
  assert.equal(await webhook(post('new_channel', 10, -200)), 200);
  assert.equal(sends.length, 2);
  assert.equal(new URL(sends[0].url).searchParams.get('chat_id'), 'target-connection-1');
  assert.equal(sends[0].token, 'max-connection-1');
  assert.equal(new URL(sends[1].url).searchParams.get('chat_id'), 'target-new');
  assert.equal(sends[1].token, 'max-new');
  assert.equal(await webhook(post('new_channel', 10, -200)), 200);
  assert.equal(sends.length, 2);
  state = await readState();
  assert.equal(state.users.find((u) => u.id === 'new-user').balanceKopecks, 400);
  assert.equal(state.users.find((u) => u.id === 'owner').balanceKopecks, 400);
  assert.equal(state.history.filter((h) => h.connectionId === child.id).length, 1);
  assert.equal(state.history.filter((h) => h.connectionId === 'connection-1').length, 1);
  assert.equal((await http(`/connections/${child.id}/toggle`, { csrf: 'csrf-token' })).status, 303);
  assert.equal(await webhook(post('new_channel', 11, -200)), 200);
  assert.equal(sends.length, 2);
});
