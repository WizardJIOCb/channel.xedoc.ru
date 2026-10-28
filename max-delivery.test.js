import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaxDeliveryQueue } from './max-delivery.js';

test('parts of concurrent publications stay together and are paced after acknowledgement', async () => {
  let clock = 0;
  const calls = [];
  const queue = createMaxDeliveryQueue({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  const first = queue.run('chat', async (send) => {
    await send(async () => { calls.push(['part-1', clock]); clock += 700; });
    await send(async () => { calls.push(['part-2', clock]); clock += 50; });
  });
  const second = queue.run('chat', (send) => send(async () => { calls.push(['next-post', clock]); }));
  await Promise.all([first, second]);
  assert.deepEqual(calls, [['part-1', 0], ['part-2', 1900], ['next-post', 3150]]);
});

test('a blocked channel does not block another channel', async () => {
  const queue = createMaxDeliveryQueue();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = queue.run('chat-1', (send) => send(() => blocked));
  const other = queue.run('chat-2', (send) => send(async () => 'delivered'));
  assert.equal(await other, 'delivered');
  release();
  await first;
});

test('a failed publication is not retried and does not poison the queue', async () => {
  let clock = 0;
  const queue = createMaxDeliveryQueue({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  let attempts = 0;
  const failed = queue.run('chat', (send) => send(async () => { attempts += 1; throw new Error('uncertain'); }));
  const next = queue.run('chat', (send) => send(async () => clock));
  await assert.rejects(failed, /uncertain/);
  assert.equal(await next, 1200);
  assert.equal(attempts, 1);
});
