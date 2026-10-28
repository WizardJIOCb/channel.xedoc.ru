import test from 'node:test';
import assert from 'node:assert/strict';
import { plainMaxText, publishMaxParts, recoverMaxPartIds } from './max-publication.js';

function fixture(state = {}, fail = () => {}) {
  const calls = [];
  const snapshots = [];
  const messages = new Map();
  let serial = 0;
  return {
    state, calls, snapshots, messages,
    publish: (parts, options = {}) => publishMaxParts({
      parts, state, send: (request) => request(), token: 'test', chatId: 'chat',
      persist: async () => snapshots.push(structuredClone(state)),
      canAppend: async () => true,
      request: async (url, options) => {
        const id = new URL(url).searchParams.get('message_id');
        const body = options.body && JSON.parse(options.body);
        calls.push({ method: options.method, id, body });
        const failure = fail(calls.at(-1), calls.length);
        if (failure) return failure;
        const mid = id || `mid-${++serial}`;
        if (options.method === 'DELETE') messages.delete(mid);
        else messages.set(mid, body.text);
        return new Response(JSON.stringify({ success: true, message: { body: { mid } } }));
      },
      ...options,
    }),
  };
}

test('multipart edits keep all original IDs; shortening removes only obsolete tails', async () => {
  const f = fixture();
  await f.publish(['first', 'second', 'third']);
  assert.deepEqual(f.state.maxMessageIds, ['mid-1', 'mid-2', 'mid-3']);
  assert.ok(f.snapshots.some((snapshot) => snapshot.maxMessageIds?.length === 1 && !snapshot.maxPartsComplete));
  await f.publish(['first edited', 'second edited', 'third edited']);
  assert.deepEqual(f.calls.slice(3).map((call) => [call.method, call.id, call.body.notify]), [
    ['PUT', 'mid-1', false], ['PUT', 'mid-2', false], ['PUT', 'mid-3', false],
  ]);
  await f.publish(['short']);
  assert.deepEqual(f.calls.slice(6).map((call) => [call.method, call.id]), [['PUT', 'mid-1'], ['DELETE', 'mid-3'], ['DELETE', 'mid-2']]);
  assert.deepEqual(f.state.maxMessageIds, ['mid-1']);
  assert.deepEqual([...f.messages.values()], ['short']);
});

test('a rejected tail resumes from durable IDs without duplicating accepted parts', async () => {
  let rejected = false;
  const f = fixture({}, (call) => {
    if (!rejected && call.body?.text === 'second') {
      rejected = true;
      return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    }
  });
  await assert.rejects(f.publish(['first', 'second']), /400/);
  assert.deepEqual(f.state.maxMessageIds, ['mid-1']);
  assert.equal(f.state.maxPendingPart, null);
  await f.publish(['first', 'second']);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'POST', 'PUT', 'POST']);
  assert.deepEqual([...f.messages.values()], ['first', 'second']);
});

test('uncertain POST failures are never retried automatically, even after reload', async () => {
  const f = fixture({}, () => new Response('server error', { status: 500 }));
  await assert.rejects(f.publish(['first']), /500/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.maxPendingPart, 0);
  const restored = fixture(structuredClone(f.state));
  await assert.rejects(restored.publish(['first']), /не подтверждён/);
  assert.equal(restored.calls.length, 0);
});

test('network failures and missing acknowledgements preserve the uncertain marker', async () => {
  for (const request of [async () => { throw new Error('connection lost'); }, async () => new Response('{}')]) {
    const f = fixture();
    await assert.rejects(f.publish(['first'], { request }));
    assert.equal(f.state.maxPendingPart, 0);
    await assert.rejects(f.publish(['first']), /не подтверждён/);
    assert.equal(f.calls.length, 0);
  }
});

test('growing a historical post cannot append new parts after a later post', async () => {
  const f = fixture({ maxMessageId: 'old-1', maxMessageIds: ['old-1'] });
  await assert.rejects(f.publish(['first', 'second'], { canAppend: async () => false }), /другие публикации/);
  assert.equal(f.calls.length, 0);
  await f.publish(['first', 'second']);
  assert.deepEqual(f.calls.map((call) => call.method), ['PUT', 'POST']);
});

test('a failed obsolete-tail deletion retains its ID for a safe retry', async () => {
  let rejected = false;
  const f = fixture({ maxMessageId: 'old-1', maxMessageIds: ['old-1', 'old-2'] }, (call) => {
    if (call.method === 'DELETE' && !rejected) {
      rejected = true;
      return new Response(JSON.stringify({ success: false, message: 'no permission' }));
    }
  });
  await assert.rejects(f.publish(['short']), /no permission/);
  assert.deepEqual(f.state.maxMessageIds, ['old-1', 'old-2']);
  await f.publish(['short']);
  assert.deepEqual(f.state.maxMessageIds, ['old-1']);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('legacy recovery requires exact consecutive content beside the original ID', () => {
  const messages = [
    { timestamp: 3, body: { mid: 'later', text: 'unrelated' } },
    { timestamp: 2, body: { mid: 'tail', text: 'second' } },
    { timestamp: 1, body: { mid: 'head', text: 'first' } },
  ];
  assert.deepEqual(recoverMaxPartIds(messages, 'head', ['first', 'second']), ['head', 'tail']);
  assert.throws(() => recoverMaxPartIds(messages, 'missing', ['first']), /безопасно/);
  assert.throws(() => recoverMaxPartIds(messages, 'head', ['first', 'changed']), /безопасно/);
  assert.throws(() => recoverMaxPartIds(messages, 'head', ['first', 'second', 'third']), /безопасно/);
  assert.equal(plainMaxText('<b>&lt;A&gt; &amp; B</b> &amp;lt;'), '<A> & B &lt;');
});
