import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistorySource, SOURCE_LIMIT } from './history-source.js';

const post = (id, text = `Post ${id}`) => ({ messageId: String(id), text, media: [], publishedAt: '2026-11-01T10:00:00Z', sourceMessages: [{ message_id: id, text, public_import: true }] });
test('source synchronization is single-flight, cached, merged and scoped to one connection', async () => {
  const connection = { id: 'own', source: 'my_channel' }, other = { connectionId: 'other', messageId: '500', text: 'Private other user' };
  const store = { telegramImports: [other], history: [{ status: 'published' }], ledger: [{ amountKopecks: -100 }] };
  const unchanged = JSON.stringify({ history: store.history, ledger: store.ledger });
  let clock = Date.parse('2026-11-02T10:00:00Z'), count = 0, fail = false;
  const source = createHistorySource({ getStore: () => store, save: async () => {}, snapshot: (m) => m, preview: (m) => m[0].text, now: () => clock,
    fetchPage: async (_channel, { before }) => { count++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw Error('offline'); return before ? { posts: [post(9)], nextBefore: '9' } : { posts: [post(10), post(11)], nextBefore: '10' }; },
  });
  await Promise.all([source.sync(connection), source.sync(connection)]);
  assert.equal(count, 1); assert.equal(store.telegramImports.length, 3);
  await source.sync(connection); assert.equal(count, 1);
  await source.sync(connection, { older: true });
  assert.equal(count, 2); assert.equal(source.status(connection).nextBefore, '9');
  clock += 61000; await source.sync(connection);
  assert.equal(source.status(connection).nextBefore, '9');
  assert.deepEqual(store.telegramImports.filter((r) => r.connectionId === 'own').map((r) => r.messageId), ['11', '10', '9']);
  clock += 61000; fail = true; await source.sync(connection);
  assert.match(source.status(connection).error, /Сохранённые посты/);
  assert.equal(store.telegramImports.length, 4);
  assert.deepEqual(store.telegramImports.find((r) => r.connectionId === 'other'), other);
  assert.equal(JSON.stringify({ history: store.history, ledger: store.ledger }), unchanged);
});

test('a per-connection retention limit never evicts another user or loops past the end', async () => {
  const connection = { id: 'one', source: 'source_one' }, other = { connectionId: 'two', messageId: '999' };
  const store = { telegramImports: [other] }; let calls = 0;
  const source = createHistorySource({ getStore: () => store, save: async () => {}, snapshot: (m) => m, preview: () => '', fetchPage: async () => { calls++; return { posts: Array.from({ length: SOURCE_LIMIT + 10 }, (_, i) => post(i + 1)), nextBefore: '1' }; } });
  await source.sync(connection); await source.sync(connection, { older: true });
  assert.equal(calls, 1); assert.equal(store.telegramImports.length, SOURCE_LIMIT + 1);
  assert.equal(source.status(connection).capped, true); assert.deepEqual(store.telegramImports[0], other);
});
