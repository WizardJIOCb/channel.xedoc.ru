import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppDelivery } from './whatsapp-delivery.js';
import { normalizeMessages, primaryMessage } from './media-groups.js';

function fixture(overrides = {}) {
  const store = { whatsappDeliveries: [], deliveries: [{ id: 'max-existing', status: 'published' }], users: [{ id: 'u1', balanceKopecks: 7123 }], transactions: [] };
  const calls = [];
  const snapshots = [];
  const connection = { id: 'c1', userId: 'u1', source: 'losvprode', whatsapp: { enabled: true, groupId: '12345@g.us', groupName: 'Лось' } };
  const client = {
    status: () => ({ state: 'connected' }),
    send: async (userId, groupId, payload, options) => { calls.push({ userId, groupId, payload, options }); return `wa-${calls.length}`; },
  };
  const deps = {
    getStore: () => store, save: async () => { snapshots.push(structuredClone(store)); }, client,
    loadMedia: async (_connection, file) => ({ buffer: Buffer.from(file.id || 'media'), mimetype: file.mime, fileName: file.name }),
    textOf: (message) => primaryMessage(message).text || primaryMessage(message).caption || '',
    filesOf: (message) => message.files || [], normalizeMessages, primaryMessage,
    spacingMs: 0, ...overrides,
  };
  return { store, calls, snapshots, connection, client, deps, delivery: createWhatsAppDelivery(deps) };
}

test('concurrent duplicate deliveries reserve before the first await; MAX and billing are untouched', async () => {
  const f = fixture();
  const before = JSON.stringify({ deliveries: f.store.deliveries, users: f.store.users, transactions: f.store.transactions });
  const message = { message_id: 4, text: 'Hello' };
  const results = await Promise.all([f.delivery.send(f.connection, message), f.delivery.send(f.connection, message)]);
  assert.equal(f.calls.length, 1);
  assert.equal(results[0].status, 'published');
  assert.equal(results[1].duplicate, true);
  assert.equal(f.store.whatsappDeliveries.length, 1);
  assert.equal(JSON.stringify({ deliveries: f.store.deliveries, users: f.store.users, transactions: f.store.transactions }), before);
  const again = await f.delivery.send(f.connection, message, { retry: true });
  assert.equal(again.status, 'published');
  assert.equal(again.duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('concurrent live and public-import album aliases share a lock even on explicit retry', async () => {
  const f = fixture();
  const live = { message_id: 8, media_group_id: 'live-album', text: 'Same source post' };
  const imported = { ...live, media_group_id: 'public:losvprode:8', public_import: true };
  const results = await Promise.all([
    f.delivery.send(f.connection, live),
    f.delivery.send(f.connection, imported, { historical: true, retry: true }),
  ]);
  assert.equal(results[1].duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.whatsappDeliveries.length, 1);
});

test('manual historical delivery works with automatic posts disabled', async () => {
  const f = fixture();
  f.connection.whatsapp.enabled = false;
  assert.equal((await f.delivery.send(f.connection, { message_id: 1, text: 'New automatic post' })).status, 'failed');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.delivery.send(f.connection, { message_id: 2, text: 'Historical post' }, { historical: true })).status, 'published');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].payload.text, /Исторический|Historical post/);
});

test('album stores every provider ID before the next send and does not duplicate its caption', async () => {
  const f = fixture();
  f.client.send = async (_userId, _groupId, payload, options) => {
    if (f.calls.length) assert.equal(f.snapshots.at(-1).whatsappDeliveries[0].sentMessageIds.length, f.calls.length);
    f.calls.push({ payload, options });
    return `part-${f.calls.length}`;
  };
  const messages = [
    { message_id: 10, media_group_id: 'a1', caption: 'One caption', files: [{ type: 'image', id: 'image', mime: 'image/jpeg' }] },
    { message_id: 11, media_group_id: 'a1', files: [{ type: 'video', id: 'video', mime: 'video/mp4' }] },
  ];
  const result = await f.delivery.send(f.connection, messages);
  assert.equal(result.status, 'published');
  assert.deepEqual(result.sentMessageIds, ['part-1', 'part-2', 'part-3']);
  assert.equal(f.calls[0].payload.text, 'One caption');
  assert.ok(Buffer.isBuffer(f.calls[1].payload.image));
  assert.ok(Buffer.isBuffer(f.calls[2].payload.video));
  assert.equal(f.calls.filter((call) => call.payload.caption).length, 0);
  assert.equal(new Set(f.calls.map((call) => call.options.messageId)).size, 3);
  const subset = await f.delivery.send(f.connection, messages[1]);
  assert.equal(subset.duplicate, true);
  const imported = await f.delivery.send(f.connection, messages.map((message) => ({ ...message, media_group_id: 'public:losvprode:10', public_import: true })), { historical: true });
  assert.equal(imported.duplicate, true);
  assert.equal(f.calls.length, 3);
});

test('ambiguous send failure is uncertain and cannot be retried even explicitly', async () => {
  const f = fixture();
  f.client.send = async () => { f.calls.push('attempt'); throw new Error('Socket closed after write'); };
  const message = { message_id: 9, text: 'May have arrived' };
  const first = await f.delivery.send(f.connection, message);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.parts[0].status, 'processing');
  assert.equal(first.sentMessageIds.length, 0);
  const retry = await f.delivery.send(f.connection, message, { retry: true });
  assert.equal(retry.duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('failure after one successful message remains partial and never replays the post', async () => {
  const f = fixture();
  f.client.send = async () => { f.calls.push('attempt'); if (f.calls.length === 2) throw new Error('Disconnected'); return 'first'; };
  const message = { message_id: 7, text: 'Text', files: [{ type: 'image', id: 'file' }] };
  const result = await f.delivery.send(f.connection, message);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.sentMessageIds, ['first']);
  await f.delivery.send(f.connection, message, { retry: true });
  assert.equal(f.calls.length, 2);
});

test('all media is checked before any send and only explicit preflight retry is allowed', async () => {
  let missing = true;
  const f = fixture({ loadMedia: async () => { if (missing) throw new Error('File expired'); return { buffer: Buffer.from('file') }; } });
  const message = { message_id: 6, text: 'Must stay with photo', files: [{ type: 'image', id: 'missing' }] };
  assert.equal((await f.delivery.send(f.connection, message)).status, 'failed');
  assert.equal(f.calls.length, 0);
  missing = false;
  assert.equal((await f.delivery.send(f.connection, message)).duplicate, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.delivery.send(f.connection, message, { retry: true })).status, 'published');
  assert.equal(f.calls.length, 2);
});

test('recovery changes stale processing to uncertain and runs once without touching active work', async () => {
  const f = fixture();
  f.store.whatsappDeliveries.push({ id: 'old', status: 'processing' });
  await f.delivery.recover();
  assert.equal(f.store.whatsappDeliveries[0].status, 'uncertain');
  const pending = f.delivery.send(f.connection, { message_id: 20, text: 'Fresh' });
  await f.delivery.recover();
  assert.equal((await pending).status, 'published');
  assert.equal(f.store.whatsappDeliveries[0].status, 'uncertain');
});

test('different posts for the same account serialize all parts and respect spacing', async () => {
  const sleeps = [];
  const f = fixture({ spacingMs: 1200, sleep: async (ms) => { sleeps.push(ms); } });
  const started = [];
  let active = 0;
  f.client.send = async (_user, _group, payload) => {
    active += 1;
    assert.equal(active, 1);
    started.push(payload.text);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `message-${started.length}`;
  };
  await Promise.all([
    f.delivery.send(f.connection, { message_id: 31, text: 'a'.repeat(16001) }),
    f.delivery.send(f.connection, { message_id: 32, text: 'second' }),
  ]);
  assert.deepEqual(started.map((value) => value.length), [16000, 1, 6]);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1200));
});

test('historical copies preserve date, source link, hidden links and Unicode text', async () => {
  const f = fixture();
  const text = `${'x'.repeat(15999)}😀`;
  const result = await f.delivery.send(f.connection, { message_id: 905, date: 1789300800, public_import: true, text, entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://example.org/article' }] }, { historical: true });
  assert.equal(result.status, 'published');
  assert.equal(result.sourceUrl, 'https://t.me/losvprode/905');
  const complete = f.calls.map((call) => call.payload.text).join('');
  assert.ok(complete.startsWith(text));
  assert.match(complete, /https:\/\/example.org\/article/);
  assert.match(complete, /Архив Telegram · .* UTC\nhttps:\/\/t.me\/losvprode\/905/);
  assert.ok(f.calls.every((call) => call.payload.text.length <= 16000));
  assert.ok(f.calls.every((call) => !/[\uD800-\uDBFF]$/.test(call.payload.text)));
});

test('larger albums are supported while unsupported content and excessive media fail before sending', async () => {
  const f = fixture();
  const files = Array.from({ length: 13 }, (_, index) => ({ type: 'image', id: `file-${index}` }));
  assert.equal((await f.delivery.send(f.connection, { message_id: 40, files })).status, 'published');
  assert.equal(f.calls.length, 13);
  assert.equal((await f.delivery.send(f.connection, { message_id: 41, files: Array(51).fill(files[0]) })).status, 'failed');
  assert.equal((await f.delivery.send(f.connection, { message_id: 42, text: 'Poll caption', poll: {} })).status, 'failed');
  assert.equal((await f.delivery.send(f.connection, { message_id: 43, imported_media: { url: 'invalid' } })).status, 'failed');
  assert.equal((await f.delivery.send(f.connection, { message_id: 44, text: 'A rich post', rich_message: { blocks: [{ type: 'photo', photo: [] }] } })).status, 'failed');
  assert.equal(f.calls.length, 13);
});

test('successful send followed by disk failure remains protected from replay', async () => {
  const f = fixture();
  let rejectWrites = false;
  f.deps.save = async () => { if (rejectWrites) throw new Error('Disk unavailable'); };
  f.client.send = async () => { f.calls.push('sent'); rejectWrites = true; return 'already-sent'; };
  const delivery = createWhatsAppDelivery(f.deps);
  const message = { message_id: 45, text: 'Written to WhatsApp' };
  const result = await delivery.send(f.connection, message);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.sentMessageIds, ['already-sent']);
  assert.match(result.error, /журнал не сохранён/);
  assert.equal((await delivery.send(f.connection, message, { retry: true })).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('delivery identity includes destination group and stores ledger without a history cap', async () => {
  const f = fixture();
  f.store.whatsappDeliveries.push(...Array.from({ length: 1001 }, (_, index) => ({ id: `old-${index}`, key: `old-${index}`, status: 'published' })));
  const message = { message_id: 50, text: 'One post, two destinations' };
  await f.delivery.send(f.connection, message);
  const other = { ...f.connection, whatsapp: { ...f.connection.whatsapp, groupId: '67890@g.us' } };
  await f.delivery.send(other, message);
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.whatsappDeliveries.length, 1003);
  assert.notEqual(f.calls[0].options.messageId, f.calls[1].options.messageId);
});
