import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMaxTargetUpdate } from './max-target.js';

test('a shared MAX bot cannot overwrite an existing connection target', () => {
  const connection = { targetChatId: '-77867253715521', error: null };
  const changed = applyMaxTargetUpdate(connection, { update_type: 'bot_added', is_channel: true, chat_id: -71264814284921 });
  assert.equal(changed, false);
  assert.equal(connection.targetChatId, '-77867253715521');
});

test('a new connection captures its first MAX channel and only its own removal', () => {
  const connection = { targetChatId: null, error: 'waiting' };
  assert.equal(applyMaxTargetUpdate(connection, { update_type: 'bot_added', is_channel: true, chat_id: -71264814284921 }), true);
  assert.deepEqual(connection, { targetChatId: '-71264814284921', error: null });
  assert.equal(applyMaxTargetUpdate(connection, { update_type: 'bot_removed', is_channel: true, chat_id: -77867253715521 }), false);
  assert.equal(applyMaxTargetUpdate(connection, { update_type: 'bot_removed', is_channel: true, chat_id: -71264814284921 }), true);
  assert.deepEqual(connection, { targetChatId: null, error: 'MAX-бот удалён из целевого канала' });
});
