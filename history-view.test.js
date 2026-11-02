import test from 'node:test';
import assert from 'node:assert/strict';
import { historyData, renderHistory } from './history-view.js';

const connection = { id: 'own', userId: 'user', source: 'my_channel', name: 'My channel', enabled: true, targetChatId: '-100', maxTargetTitle: 'My MAX', telegramToken: 'secret-tg', maxToken: 'secret-max' };
const imported = (id) => ({ connectionId: 'own', messageId: String(id), text: `Source post ${id}`, publishedAt: '2026-11-02T10:00:00Z', mediaCount: 2, mediaType: 'альбом (2)', sourceMessages: [{ message_id: id, text: `Source post ${id}` }, { message_id: id + 1 }] });
const state = () => ({ users: [{ id: 'user', balanceKopecks: 1000 }], connections: [connection, { ...connection, id: 'other', userId: 'other-user', source: 'private_source' }], telegramImports: [imported(10), imported(20), { ...imported(30), connectionId: 'other', text: 'private other text' }], history: [{ id: 'delivery', connectionId: 'own', telegramMessageId: '10', telegramMessageIds: ['10', '11'], telegramMediaGroupId: 'real-group', sourceMessages: [{ message_id: 10, text: 'Canonical album', date: 1793613600 }], status: 'published', maxMessageId: 'max-1', maxMessageIds: ['max-1'], createdAt: '2026-11-02T10:00:00Z' }], settings: { pricePerMessageKopecks: 100 } });

test('history merges imported albums and delivery aliases, isolates accounts and exposes explicit actions', () => {
  const s = state(), model = historyData(s, 'user');
  assert.equal(model.rows.length, 2); assert.deepEqual(model.counts, { all: 2, new: 1, published: 1, issues: 0 });
  const published = model.rows.find((r) => r.delivered), draft = model.rows.find((r) => !r.delivered);
  assert.equal(published.text, 'Canonical album'); assert.equal(published.action.repeat, true);
  assert.equal(published.action.path, '/history/delivery/replay');
  assert.equal(draft.action.path, '/connections/own/imports/20/send');
  assert.equal(draft.action.repeat, false);
  const html = renderHistory(model, { csrf: 'csrf' });
  assert.doesNotMatch(html, /secret-tg|secret-max|private other text|private_source/);
  assert.match(html, /Отправить в MAX/); assert.match(html, /Повторная публикация/);
  assert.match(html, /name="returnTo" value="history"/);
  assert.equal(historyData(s, 'user', { filter: 'new' }).rows.length, 1);
  assert.equal(historyData(s, 'user', { connectionId: 'other' }).rows.length, 0);
});

test('partial sends and ambiguous replays cannot be offered as a new post or an automatic retry', () => {
  const s = state(); s.history[0].status = 'failed'; s.history[0].maxPendingPart = 1;
  const row = historyData(s, 'user').rows.find((r) => r.messageId === '10');
  assert.equal(row.state, 'uncertain'); assert.equal(row.delivered, false); assert.equal(row.action, null);
  assert.match(row.disabled, /сверьте/);
  s.history[0].status = 'published'; delete s.history[0].maxPendingPart;
  s.history[0].activeMaxReplay = { maxPendingPart: 0 };
  assert.equal(historyData(s, 'user').rows.find((r) => r.messageId === '10').action, null);
});

test('confirmation text cannot escape into script and cached source failures remain visible', () => {
  const s = state(); s.connections = [{ ...connection, maxTargetTitle: "MAX');alert(1);//\"><img src=x>" }];
  s.telegramImports[1].text = '<script>alert(2)</script>';
  s.telegramSourceSync = { own: { updatedAt: '2026-11-02T10:00:00Z', error: '<svg onload=alert(3)>', nextBefore: '10' } };
  const html = renderHistory(historyData(s, 'user'), { csrf: 'csrf"' });
  assert.doesNotMatch(html, /<script>|<img src=x>|<svg onload/);
  assert.match(html, /confirm\(this.dataset.confirm\)/);
  assert.doesNotMatch(html, /confirm\('Отправить/);
  assert.match(html, /Более ранние посты @my_channel/);
  s.users[0].balanceKopecks = 0;
  assert.equal(historyData(s, 'user').rows.every((r) => !r.action), true);
});

test('WhatsApp manual actions use the saved destination and its own delivery ledger regardless of auto forwarding', () => {
  const s = state(); s.connections[0] = { ...connection, whatsapp: { groupId: 'group@g.us', groupName: 'My WhatsApp', enabled: false } };
  const available = historyData(s, 'user', { waState: 'connected' });
  assert.equal(available.rows.every((row) => row.whatsapp.action === '/connections/own/whatsapp/send'), true);
  const html = renderHistory(available, { csrf: 'csrf' });
  assert.match(html, /Отправить в WhatsApp/); assert.match(html, /name="messageId"/);
  s.whatsappDeliveries = [{ connectionId: 'own', userId: 'user', groupId: 'group@g.us', telegramMessageId: '20', status: 'published' }];
  let model = historyData(s, 'user', { waState: 'connected' });
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows.find((r) => r.messageId === '20').whatsapp.action, null);
  assert.equal(model.rows.find((r) => r.messageId === '20').delivered, false);
  s.whatsappDeliveries[0].status = 'uncertain';
  model = historyData(s, 'user', { filter: 'issues', waState: 'connected' });
  assert.equal(model.rows.length, 1); assert.equal(model.rows[0].whatsapp.action, null);
  assert.match(model.rows[0].whatsapp.disabled, /сверьте/);
  s.whatsappDeliveries[0].groupId = 'other-destination@g.us';
  model = historyData(s, 'user', { waState: 'connected' });
  assert.ok(model.rows.find((r) => r.messageId === '20').whatsapp.action);
  assert.equal(historyData(s, 'user').rows.every((r) => !r.whatsapp.action), true);
});
