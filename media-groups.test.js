import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaGroupKey, mergeMessages, normalizeMessages, primaryMessage } from './media-groups.js';

test('normalizeMessages orders an album and removes duplicate Telegram deliveries', () => {
  const messages = normalizeMessages([
    { message_id: 12, photo: ['second'] },
    { message_id: 11, photo: ['first-old'] },
    { message_id: 11, photo: ['first-new'] },
  ]);
  assert.deepEqual(messages.map((message) => message.message_id), [11, 12]);
  assert.deepEqual(messages[0].photo, ['first-new']);
});

test('mergeMessages replaces an edited album item without dropping the others', () => {
  const messages = mergeMessages(
    [{ message_id: 21, caption: 'Before' }, { message_id: 22, photo: ['second'] }],
    { message_id: 21, caption: 'After' },
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].caption, 'After');
  assert.equal(messages[1].message_id, 22);
});

test('primaryMessage uses the album item that contains the caption', () => {
  const message = primaryMessage([
    { message_id: 31, photo: ['first'] },
    { message_id: 32, caption: 'Album caption', photo: ['second'] },
  ]);
  assert.equal(message.message_id, 32);
});

test('mediaGroupKey keeps connections with the same Telegram group separate', () => {
  assert.notEqual(mediaGroupKey('connection-a', 'group-1'), mediaGroupKey('connection-b', 'group-1'));
});
