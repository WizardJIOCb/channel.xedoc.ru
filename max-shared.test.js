import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedMax } from './max-shared.js';
import { createMaxDeliveryQueue } from './max-delivery.js';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

function fixture() {
  const original = { id: 'original', userId: 'old-owner', maxToken: 'common', targetChatId: '-100', enabled: true };
  const child = { id: 'child', name: 'My channel', userId: 'new-owner', maxToken: 'common', targetChatId: null, enabled: false, maxSetupPending: true };
  const state = { connections: [original, child] };
  let clock = 1000000, sequence = 0, canWrite = true, userAdmin = true, type = 'channel';
  const service = createSharedMax({ getStore: () => state, save: async () => {}, token: 'common', unseal: (v) => v, rid: () => `code-${String(++sequence).padStart(20, '0')}`, queue: createMaxDeliveryQueue(), now: () => clock,
    api: async (path) => path.endsWith('/members/me') ? { is_admin: true, permissions: canWrite ? ['write'] : [] } : path.endsWith('/members/admins') ? { members: [{ user_id: 55, is_admin: userAdmin, is_bot: false }] } : { chat_id: -200, title: 'Chosen channel', type },
  });
  return { service, state, original, child, expire: () => { clock += 31 * 60 * 1000; }, write: (v) => { canWrite = v; }, admin: (v) => { userAdmin = v; }, chatType: (v) => { type = v; } };
}
const privateUpdate = (userId = 55, chatType = 'dialog') => ({ update_type: 'message_created', message: { sender: { user_id: userId }, recipient: { chat_type: chatType } } });
const added = (userId = 55, chatId = -200) => ({ update_type: 'bot_added', is_channel: true, chat_id: chatId, user: { user_id: userId } });

test('shared MAX requires private code confirmation, matching installer, rights and final cabinet confirmation', async () => {
  const f = fixture(), row = await f.service.begin(f.child);
  await f.service.event(added());
  assert.equal(row.chatId, undefined);
  assert.equal(await f.service.command(privateUpdate(55, 'chat'), `/connect ${row.code}`), null);
  assert.equal(row.maxUserId, undefined);
  await f.service.command(privateUpdate(), `/connect ${row.code}`);
  assert.match(await f.service.command(privateUpdate(56), `/connect ${row.code}`), /другим аккаунтом/);
  await f.service.event(added(56));
  assert.equal(row.chatId, undefined);
  await Promise.all([f.service.event(added()), f.service.event(added())]);
  assert.equal(row.chatId, '-200');
  assert.equal(f.child.targetChatId, null);
  assert.equal(f.original.targetChatId, '-100');
  f.write(false); await assert.rejects(f.service.confirm(f.child, row.code), /правом публикации/);
  f.write(true); f.admin(false); await assert.rejects(f.service.confirm(f.child, row.code), /администратором/);
  f.admin(true); f.chatType('chat'); await assert.rejects(f.service.confirm(f.child, row.code), /администратором/);
  f.chatType('channel'); await f.service.confirm(f.child, row.code);
  assert.equal(f.child.targetChatId, '-200'); assert.equal(f.child.enabled, true);
  assert.equal(f.child.maxSetupPending, undefined);
  assert.equal(f.state.maxBindings.length, 0);
  await assert.rejects(f.service.confirm(f.child, row.code));
  await f.service.event(added(55, -300));
  assert.equal(f.child.targetChatId, '-200');
  await f.service.event({ update_type: 'bot_removed', is_channel: true, chat_id: -200 });
  assert.equal(f.child.targetChatId, null);
  assert.equal(f.original.targetChatId, '-100');
});

test('MAX codes expire, rotate and cannot capture a target already used by another connection', async () => {
  const f = fixture(), old = await f.service.begin(f.child), row = await f.service.begin(f.child);
  assert.match(await f.service.command(privateUpdate(), `/connect ${old.code}`), /недействителен/);
  await f.service.command(privateUpdate(), `/connect ${row.code}`);
  await f.service.event(added(55, -100));
  await assert.rejects(f.service.confirm(f.child, row.code), /уже используется/);
  f.expire();
  assert.equal(f.service.pending(f.child), undefined);
  await assert.rejects(f.service.confirm(f.child, row.code));
  assert.equal(f.child.targetChatId, null);
});

test('a forwarded post recovers an already-added bot only for the confirmed private MAX user', async () => {
  const f = fixture(), row = await f.service.begin(f.child);
  const forwarded = (sender = 55, chatType = 'dialog', chatId = -200) => {
    const update = privateUpdate(sender, chatType);
    update.message.link = { type: 'forward', chat_id: chatId, message: { text: 'Existing post' } };
    return update;
  };
  await f.service.forward(forwarded());
  assert.equal(row.chatId, undefined);
  await f.service.command(privateUpdate(), `/connect ${row.code}`);
  await f.service.forward(forwarded(56));
  await f.service.forward(forwarded(55, 'chat'));
  assert.equal(row.chatId, undefined);
  assert.match(await f.service.forward(forwarded()), /найден/);
  assert.equal(row.chatId, '-200');
  assert.equal(f.child.targetChatId, null);
  assert.match(await f.service.forward(forwarded(55, 'dialog', -300)), /новый код/);
  f.admin(false);
  await assert.rejects(f.service.confirm(f.child, row.code), /администратором/);
  f.admin(true); await f.service.confirm(f.child, row.code);
  assert.equal(f.child.targetChatId, '-200');
  assert.equal(f.original.targetChatId, '-100');
});

test('a bot permission change recovers a channel added before the code was confirmed', async () => {
  const f = fixture(), row = await f.service.begin(f.child);
  await f.service.command(privateUpdate(), `/connect ${row.code}`);
  await f.service.event({ update_type: 'bot_admin_permissions_changed', is_channel: true, chat_id: -200, user_id: 56, is_admin: true });
  assert.equal(row.chatId, undefined);
  await f.service.event({ update_type: 'bot_admin_permissions_changed', is_channel: true, chat_id: -200, user_id: 55, is_admin: true });
  assert.equal(row.chatId, '-200');
  assert.equal(f.child.targetChatId, null);
});

test('token-free shared MAX onboarding stays owner-only and does not bind from a broadcast bot_added', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'max-shared-integration-')), path = join(dir, 'app.json'), key = Buffer.alloc(32, 31), now = new Date().toISOString();
  const seal = (v) => { const iv = Buffer.alloc(12, 4), c = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([c.update(v), c.final()]); return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`; };
  const original = { id: 'original', source: 'old_channel', userId: 'old-owner', telegramToken: seal('tg-common'), telegramSecret: 'tg-secret', telegramApiMode: 'local', maxToken: seal('max-common'), maxSecret: 'old-max-secret', targetChatId: '-100', enabled: true };
  await writeFile(path, JSON.stringify({ users: [{ id: 'user', email: 'new@example.test', walletInitializedAt: now, telegramChatId: '42', telegramConnectionId: 'original' }], sessions: [{ id: 's', userId: 'user', csrf: 'csrf', expiresAt: Date.now() + 60000 }], connections: [original], migrated: true, connectionWebhooksMigrated: true, telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true }));
  Object.assign(process.env, { APP_ENCRYPTION_KEY: key.toString('base64'), PUBLIC_BASE_URL: 'https://channel.example.test', STATE_PATH: path, PORT: '0', TELEGRAM_SHARED_BOT_TOKEN: 'tg-common', TELEGRAM_LOCAL_API_URL: 'http://127.0.0.1:8081', TELEGRAM_LOCAL_SOURCES: '*', MAX_APP_BOT_TOKEN: 'max-common', MAX_APP_WEBHOOK_SECRET: 'app-secret', MAX_APP_BOT_USERNAME: 'service_bot' });
  const realFetch = globalThis.fetch, replies = [], subscriptions = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input), body = options.body ? JSON.parse(options.body) : {};
    if (url.endsWith('/getChat')) return Response.json({ ok: true, result: { id: -300, type: 'channel', username: 'new_channel' } });
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 77 } });
    if (url.endsWith('/getChatMember')) return Response.json({ ok: true, result: { status: 'administrator' } });
    if (url.endsWith('/setWebhook') || url.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
    if (url.endsWith('/me/commands')) return Response.json({ success: true });
    if (url.endsWith('/subscriptions')) { subscriptions.push(body); return Response.json({ success: true }); }
    if (url.endsWith('/members/me')) return Response.json({ is_admin: true, permissions: ['write'] });
    if (url.endsWith('/members/admins')) return Response.json({ members: [{ user_id: 55, is_admin: true }] });
    if (url.endsWith('/chats/-200')) return Response.json({ chat_id: -200, type: 'channel', title: 'My MAX channel' });
    if (url.includes('/messages?user_id=55')) { replies.push(body); return Response.json({ message: { body: { mid: 'reply' } } }); }
    throw new Error(`Unexpected API call: ${url}`);
  };
  let server;
  t.after(async () => { if (server?.listening) await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; for (const k of ['TELEGRAM_SHARED_BOT_TOKEN', 'TELEGRAM_LOCAL_API_URL', 'TELEGRAM_LOCAL_SOURCES', 'MAX_APP_BOT_TOKEN', 'MAX_APP_WEBHOOK_SECRET', 'MAX_APP_BOT_USERNAME']) delete process.env[k]; await rm(dir, { recursive: true, force: true }); });
  ({ server } = await import(`./server.js?shared-max-test=${Date.now()}`)); if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (route, values, headers = {}) => { const r = await realFetch(base + route, { method: values ? 'POST' : 'GET', headers: { cookie: 'session=s', ...headers }, body: values ? new URLSearchParams(values) : undefined, redirect: 'manual' }); return { status: r.status, location: r.headers.get('location'), body: await r.text() }; };
  const webhook = async (update, route = '/webhooks/max/app', secret = 'app-secret') => { const r = await realFetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': secret }, body: JSON.stringify(update) }); await r.text(); return r.status; };
  const state = async () => JSON.parse(await readFile(path, 'utf8'));
  const page = await http('/dashboard?new=1');
  for (const name of ['telegramToken', 'maxToken']) assert.doesNotMatch(page.body.match(new RegExp(`<input name="${name}"[^>]*>`))[0], /required/);
  assert.equal((await http('/connections', { csrf: 'csrf', source: 'new_channel', targetChatId: '-999' })).status, 400);
  const result = await http('/connections', { csrf: 'csrf', source: 'new_channel', name: 'New channel' });
  assert.equal(result.status, 303); assert.match(result.location, /\/max$/);
  let saved = await state(); const child = saved.connections[1], row = saved.maxBindings[0], setup = result.location;
  assert.equal(child.maxMode, 'shared'); assert.equal(child.enabled, false); assert.equal(child.targetChatId, null);
  assert.deepEqual(saved.connections[0], original);
  assert.match((await http(setup)).body, new RegExp(row.code));
  assert.equal((await http('/connections/original/max')).status, 403);
  assert.equal((await http(setup + '/confirm', { code: row.code, csrf: 'bad' })).status, 403);
  assert.equal(await webhook(added(), '/webhooks/max/app', 'bad'), 401);
  assert.equal(await webhook(added(), '/webhooks/max/original', 'old-max-secret'), 200);
  assert.equal((await state()).maxBindings[0].chatId, undefined);
  await webhook({ ...privateUpdate(), message: { ...privateUpdate().message, body: { text: `/connect ${row.code}` } } });
  assert.equal(replies.length, 1);
  const forwarded = privateUpdate(); forwarded.message.link = { type: 'forward', chat_id: -200, message: { text: 'Existing channel post' } };
  await webhook(forwarded);
  assert.equal(replies.length, 2);
  saved = await state(); assert.equal(saved.maxBindings[0].chatId, '-200'); assert.equal(saved.connections[1].targetChatId, null);
  assert.match((await http(setup)).body, /My MAX channel/);
  assert.equal((await http(setup + '/confirm', { csrf: 'csrf', code: row.code })).status, 303);
  saved = await state(); assert.equal(saved.connections[1].targetChatId, '-200'); assert.equal(saved.connections[1].enabled, true); assert.equal(saved.connections[0].targetChatId, '-100');
  assert.equal(subscriptions.every((s) => s.url === 'https://channel.example.test/webhooks/max/app'), true);
  assert.equal(subscriptions[0].update_types.includes('bot_added'), true);
  assert.equal(subscriptions[0].update_types.includes('bot_admin_permissions_changed'), true);
  assert.equal((saved.history || []).length, 0); assert.equal((saved.ledger || []).length, 0);
});
