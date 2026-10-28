import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardData, dashboardDay, renderDashboard } from './dashboard.js';

const now = new Date('2026-10-28T07:50:00Z');
const connection = { id: 'c1', userId: 'u1', source: 'example', name: 'Мой канал', enabled: true, targetChatId: 'max-1', telegramToken: 'PRIVATE-TG', maxToken: 'PRIVATE-MAX', whatsapp: { groupId: 'g1', groupName: 'Объявления', enabled: true } };
const fixture = () => ({ connections: [structuredClone(connection), { ...connection, id: 'other', userId: 'u2', source: 'PRIVATE-SOURCE' }], history: [], whatsappDeliveries: [], telegramImports: [] });

test('dashboard isolates owners, counts confirmed parts and preserves recovered MAX deliveries', () => {
  const store = fixture();
  store.history = [
    { connectionId: 'c1', telegramMessageId: 1, status: 'published', createdAt: now.toISOString() },
    { connectionId: 'c1', telegramMessageId: 2, status: 'failed', lastReplayMaxMessageId: 'recovered', lastReplayAt: now.toISOString() },
    { connectionId: 'c1', telegramMessageId: 3, status: 'failed' },
    { connectionId: 'other', telegramMessageId: 5, status: 'published', preview: 'PRIVATE-POST' },
  ];
  store.whatsappDeliveries = [
    { connectionId: 'c1', userId: 'u1', telegramMessageId: 1, status: 'published', sourceDate: '2026-10-25T10:00:00Z', deliveredAt: now.toISOString(), groupId: 'g1', sentMessageIds: ['m1', 'm2'], parts: [{ status: 'sent', messageId: 'm1' }] },
    { connectionId: 'c1', userId: 'u1', telegramMessageId: 3, status: 'uncertain', parts: [{ status: 'processing', messageId: 'unconfirmed' }] },
    { connectionId: 'c1', userId: 'u1', telegramMessageId: 4, status: 'partial', groupId: 'g1', sentMessageIds: ['m3'] },
    { connectionId: 'c1', userId: 'u2', telegramMessageId: 6, status: 'published', sentMessageIds: ['PRIVATE-MESSAGE'] },
  ];
  const model = dashboardData(store, 'u1', now);
  assert.deepEqual(model.totals, { max: 2, whatsapp: 1, messages: 3, issues: 3 });
  assert.equal(model.channels[0].whatsapp.groupName, 'Объявления');
  assert.equal(model.posts.find((p) => p.messageId === '1').date, '2026-10-25T10:00:00.000Z');
  assert.equal(model.deliveries.find((d) => d.platform === 'whatsapp').date, now.toISOString());
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE/);
});

test('albums and duplicate records count once across destinations, including late alias bridges', () => {
  const store = fixture();
  store.history = [1, 2].map((id) => ({ connectionId: 'c1', telegramMessageId: id, status: 'published', createdAt: now.toISOString() }));
  store.whatsappDeliveries = [
    { connectionId: 'c1', telegramMessageId: 1, telegramMessageIds: [1, 2], telegramMediaGroupId: 'album', status: 'published', sentMessageIds: ['m1'], createdAt: now.toISOString() },
    { connectionId: 'c1', telegramMessageId: 2, status: 'published', sentMessageIds: ['m1'], createdAt: now.toISOString() },
  ];
  store.telegramImports = [{ connectionId: 'c1', messageId: 1, sourceMessages: [{ message_id: 1, date: 1792900000 }, { message_id: 2, date: 1792900000 }] }];
  const model = dashboardData(store, 'u1', now);
  assert.equal(model.posts.length, 1);
  assert.deepEqual(model.totals, { max: 1, whatsapp: 1, messages: 1, issues: 0 });
  assert.equal(model.deliveries.length, 2);
  assert.equal(model.posts[0].estimated, false);
});

test('calendar uses UTC+5, real month lengths, separate publication and delivery dates', () => {
  assert.equal(dashboardDay('2026-10-27T20:00:00Z'), '2026-10-28');
  const store = fixture();
  store.whatsappDeliveries = [{ connectionId: 'c1', telegramMessageId: 1, status: 'published', preview: 'Старый пост', sourceDate: '2026-10-25T10:00:00Z', deliveredAt: now.toISOString() }];
  const model = dashboardData(store, 'u1', now);
  const posts = renderDashboard(model, { month: '2026-10', day: '2026-10-25' });
  assert.match(posts, /2026-10-25: 1 публикация/);
  assert.match(posts, /2026-10-28: 0 публикаций/);
  const deliveries = renderDashboard(model, { month: '2026-10', view: 'deliveries', day: '2026-10-28' });
  assert.match(deliveries, /2026-10-28: 1 доставка/);
  assert.match(deliveries, /Старый пост/);
  const february = renderDashboard(model, { month: '2024-02' });
  assert.match(february, /2024-02-29:/);
  assert.doesNotMatch(february, /2024-02-30:/);
});

test('saved WhatsApp group is not presented as connected when the live session is offline', () => {
  const model = dashboardData(fixture(), 'u1', now);
  const offline = renderDashboard(model, { waState: 'disconnected' });
  assert.match(offline, /Аккаунт отключён/);
  assert.match(offline, /Восстановить подключение/);
  const online = renderDashboard(model, { waState: 'connected' });
  assert.match(online, /Настроить WhatsApp/);
  assert.doesNotMatch(online, /Аккаунт отключён/);
});

test('empty, paused, missing target and failed states retain available setup and CSRF actions', () => {
  const empty = renderDashboard(dashboardData({}, 'u1', now));
  for (const name of ['Telegram', 'MAX', 'WhatsApp', 'Подключите первый канал']) assert.ok(empty.includes(name));
  const store = fixture();
  store.connections[0].targetChatId = null;
  store.connections[0].whatsapp = {};
  const html = renderDashboard(dashboardData(store, 'u1', now), { csrf: 'csrf-test' });
  assert.match(html, /Подключить MAX/);
  assert.match(html, /Подключить WhatsApp/);
  assert.match(html, /name="csrf" value="csrf-test"/);
  store.connections[0].targetChatId = 'max';
  store.connections[0].enabled = false;
  assert.match(renderDashboard(dashboardData(store, 'u1', now)), /Возобновить репост/);
});

test('untrusted preview, connection names and calendar query cannot inject markup', () => {
  const store = fixture();
  store.connections[0].name = '<script>alert(1)</script>';
  store.telegramImports = [{ connectionId: 'c1', messageId: 1, preview: '<img src=x onerror=alert(1)>', publishedAt: now.toISOString() }];
  const html = renderDashboard(dashboardData(store, 'u1', now), { month: '"><script>', day: '2026-10-28', notice: '<script>oops</script>' });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /2026-10-28: 1 публикация/);
});
