import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

function seal(value, key) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

function webhook(port, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/webhooks/telegram/connection-1', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-telegram-bot-api-secret-token': 'telegram-secret' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postForm(port, path, values) {
  const body = new URLSearchParams(values).toString();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { cookie: 'session=session-1', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getPage(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { cookie: 'session=session-1' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForState(path, predicate, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the album delivery state');
}

function silenceWav(samples = 800) {
  const dataLength = samples * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF'); wav.writeUInt32LE(36 + dataLength, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataLength, 40);
  return wav;
}

test('two Telegram album updates become one MAX post and one charge', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-album-'));
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 7);
  const now = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'album@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [{ id: 'connection-1', userId: 'user-1', name: 'Album test', source: 'source_channel', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), maxSecret: 'max-secret', targetChatId: 'max-channel-1', enabled: true, error: null, createdAt: now, updatedAt: now }],
    history: [],
    ledger: [],
    pendingAlbums: [],
    settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 },
    migrated: true,
    connectionWebhooksMigrated: true,
    telegramAssistantWebhooksV1: true,
    telegramAssistantWebhooksV2: true,
    telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';
  process.env.TELEGRAM_ALBUM_SETTLE_MS = '500';

  const maxMessages = [];
  const maxMessageUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/getFile')) {
      const fileId = JSON.parse(options.body).file_id;
      return new Response(JSON.stringify({ ok: true, result: { file_path: `photos/${fileId}.jpg` } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/file/bot')) return new Response(Buffer.from('fake image bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith('https://platform-api2.max.ru/uploads?')) return new Response(JSON.stringify({ url: `https://upload.example.test/${maxMessages.length + 1}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://upload.example.test/')) return new Response(JSON.stringify({ token: `uploaded-${url.split('/').at(-1)}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://platform-api2.max.ru/messages?')) {
      maxMessageUrls.push(url);
      maxMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ message: { body: { mid: 'max-message-1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in integration test: ${url}`);
  };

  const { server } = await import(`./server.js?album-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  const base = { chat: { username: 'source_channel' }, media_group_id: 'telegram-album-1' };
  assert.equal(await webhook(port, { update_id: 1, channel_post: { ...base, message_id: 101, caption: 'Album caption', photo: [{ file_id: 'photo-1' }] } }), 200);
  assert.equal(await webhook(port, { update_id: 2, channel_post: { ...base, message_id: 102, photo: [{ file_id: 'photo-2' }] } }), 200);
  assert.equal(await webhook(port, { update_id: 3, channel_post: { ...base, message_id: 102, photo: [{ file_id: 'photo-2' }] } }), 200);

  const state = await waitForState(statePath, (value) => value.history?.[0]?.status === 'published' && value.pendingAlbums?.length === 0);
  assert.equal(maxMessages.length, 1);
  assert.equal(new URL(maxMessageUrls[0]).searchParams.has('disable_link_preview'), false);
  assert.equal(maxMessages[0].text, 'Album caption');
  assert.equal(maxMessages[0].attachments.length, 2);
  assert.deepEqual(maxMessages[0].attachments.map((attachment) => attachment.type), ['image', 'image']);
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.history[0].telegramMessageIds, ['101', '102']);
  assert.equal(state.history[0].mediaCount, 2);
  assert.equal(state.ledger.filter((item) => item.type === 'delivery').length, 1);
  assert.equal(state.users[0].balanceKopecks, 400);

  const historyPage = await getPage(port, '/history');
  assert.equal(historyPage.status, 200);
  assert.match(historyPage.body, new RegExp(`/history/${state.history[0].id}/replay`));
  assert.match(historyPage.body, /Отправить ещё раз/);

  const replay = await postForm(port, `/history/${state.history[0].id}/replay`, { csrf: 'csrf-token' });
  assert.deepEqual(replay, { status: 303, location: '/history?result=replayed' });
  const replayedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(maxMessages.length, 2);
  assert.equal(new URL(maxMessageUrls[1]).searchParams.has('disable_link_preview'), false);
  assert.equal(maxMessages[1].attachments.length, 2);
  assert.equal(replayedState.history.length, 1);
  assert.equal(replayedState.history[0].replayCount, 1);
  assert.equal(replayedState.ledger.filter((item) => item.type === 'delivery').length, 2);
  assert.equal(replayedState.ledger[0].replay, true);
  assert.equal(replayedState.users[0].balanceKopecks, 300);
});

test('loading public Telegram posts is non-publishing and each post can be sent explicitly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-import-'));
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 9);
  const now = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'import@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [{ id: 'connection-1', userId: 'user-1', name: 'Public import test', source: 'source_channel', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), maxSecret: 'max-secret', targetChatId: 'max-channel-1', enabled: true, error: null, createdAt: now, updatedAt: now }],
    history: [],
    ledger: [],
    pendingAlbums: [],
    telegramImports: [],
    settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 },
    migrated: true,
    connectionWebhooksMigrated: true,
    telegramAssistantWebhooksV1: true,
    telegramAssistantWebhooksV2: true,
    telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  const publicPage = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="source_channel/700"><div class="tgme_widget_message_text js-message_text">Праздник в садике</div><a class="tgme_widget_message_photo_wrap js-message_photo" href="https://t.me/source_channel/700" style="background-image:url('https://cdn4.telesco.pe/file/test-photo.jpg')"></a><time datetime="2026-08-26T08:00:00+00:00"></time></div></div>`;
  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';

  const maxMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === 'https://t.me/s/source_channel' || url === 'https://t.me/source_channel/700?embed=1&mode=tme') return new Response(publicPage, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === 'https://cdn4.telesco.pe/file/test-photo.jpg') return new Response(Buffer.from('fake public image bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith('https://platform-api2.max.ru/uploads?')) return new Response(JSON.stringify({ url: 'https://upload.example.test/public-import' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://upload.example.test/public-import') return new Response(JSON.stringify({ token: 'uploaded-public-image' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://platform-api2.max.ru/messages?')) {
      maxMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ message: { body: { mid: 'max-import-message-1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in public import test: ${url}`);
  };

  const { server } = await import(`./server.js?public-import-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  const loaded = await postForm(port, '/connections/connection-1/import', { csrf: 'csrf-token' });
  assert.deepEqual(loaded, { status: 303, location: '/dashboard?result=loaded&count=1#connection-connection-1' });
  assert.equal(maxMessages.length, 0);

  const loadedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(loadedState.telegramImports.length, 1);
  assert.equal(loadedState.telegramImports[0].messageId, '700');
  assert.equal(loadedState.history.length, 0);
  assert.equal(loadedState.ledger.filter((item) => item.type === 'delivery').length, 0);
  assert.equal(loadedState.users[0].balanceKopecks, 500);

  const dashboard = await getPage(port, '/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /Ваши каналы под контролем/);
  assert.match(dashboard.body, /Календарь публикаций/);
  assert.match(dashboard.body, /WhatsApp · доставлено/);
  assert.doesNotMatch(dashboard.body, /fake-telegram-token|fake-max-token/);
  assert.match(dashboard.body, /Подгрузить посты с канала/);
  assert.match(dashboard.body, /Праздник в садике/);
  assert.match(dashboard.body, /Загрузка ничего не публикует/);
  assert.match(dashboard.body, /\/connections\/connection-1\/imports\/700\/send/);

  const sent = await postForm(port, '/connections/connection-1/imports/700/send', { csrf: 'csrf-token' });
  assert.deepEqual(sent, { status: 303, location: '/dashboard?result=sent#connection-connection-1' });
  assert.equal(maxMessages.length, 1);
  assert.equal(maxMessages[0].text, 'Праздник в садике');
  assert.equal(maxMessages[0].attachments.length, 1);

  const sentState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(sentState.history.length, 1);
  assert.equal(sentState.history[0].telegramMessageId, '700');
  assert.equal(sentState.history[0].status, 'published');
  assert.equal(sentState.ledger.filter((item) => item.type === 'delivery').length, 1);
  assert.equal(sentState.users[0].balanceKopecks, 400);
});

test('a Telegram rich message is preserved and published to MAX', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-rich-message-'));
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 11);
  const now = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'rich@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [{ id: 'connection-1', userId: 'user-1', name: 'Rich message test', source: 'source_channel', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), maxSecret: 'max-secret', targetChatId: 'max-channel-1', enabled: true, error: null, createdAt: now, updatedAt: now }],
    history: [],
    ledger: [],
    pendingAlbums: [],
    settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 },
    migrated: true,
    connectionWebhooksMigrated: true,
    telegramAssistantWebhooksV1: true,
    telegramAssistantWebhooksV2: true,
    telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';

  const maxMessages = [];
  const maxRequestTimes = [];
  const maxRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('https://platform-api2.max.ru/messages?')) {
      maxRequestTimes.push(Date.now());
      maxMessages.push(options.body ? JSON.parse(options.body) : null);
      maxRequests.push({ method: options.method, id: new URL(url).searchParams.get('message_id') });
      return new Response(JSON.stringify({ message: { body: { mid: new URL(url).searchParams.get('message_id') || `max-rich-message-${maxMessages.length}` } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in rich message test: ${url}`);
  };

  const { server } = await import(`./server.js?rich-message-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  const richMessage = {
    message_id: 843,
    date: 1787774985,
    chat: { username: 'source_channel' },
    rich_message: {
      blocks: [
        { type: 'paragraph', text: ['OpenAI дала агентам ', { type: 'bold', text: 'сложный экзамен' }] },
        { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: 'Первый результат' }] }] },
        { type: 'buttons', buttons: [{ text: 'Технический отчёт', url: 'https://example.test/report.pdf' }] },
      ],
    },
  };
  assert.equal(await webhook(port, { update_id: 10, channel_post: richMessage }), 200);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(maxMessages.length, 1);
  assert.equal(maxMessages[0].format, 'html');
  assert.equal(maxMessages[0].text, 'OpenAI дала агентам <b>сложный экзамен</b>\n\n• Первый результат\n\n<a href="https://example.test/report.pdf">Технический отчёт</a>');
  assert.equal(state.history[0].status, 'published');
  assert.deepEqual(state.history[0].sourceMessage.rich_message, richMessage.rich_message);
  assert.equal(state.history[0].preview, 'OpenAI дала агентам сложный экзамен • Первый результат Технический отчёт: https://example.test/report.pdf');
  assert.equal(state.ledger.filter((item) => item.type === 'delivery').length, 1);
  assert.equal(state.users[0].balanceKopecks, 400);

  // Concurrent incoming posts must not interleave the parts of a long post.
  const longText = 'Long publication first. '.repeat(300);
  const longPost = { message_id: 844, chat: { username: 'source_channel' }, rich_message: { blocks: [{ type: 'paragraph', text: longText }] } };
  const nextPost = { message_id: 845, chat: { username: 'source_channel' }, text: 'The following publication' };
  assert.deepEqual(await Promise.all([
    webhook(port, { update_id: 11, channel_post: longPost }),
    webhook(port, { update_id: 12, channel_post: nextPost }),
  ]), [200, 200]);
  assert.equal(maxMessages.length, 4);
  assert.equal(maxMessages.slice(1, 3).map((part) => part.text).join(''), longText);
  assert.equal(maxMessages[3].text, nextPost.text);
  for (let index = 1; index < maxRequestTimes.length; index += 1) {
    assert.ok(maxRequestTimes[index] - maxRequestTimes[index - 1] >= 1100, 'MAX requests need a visible gap');
  }
  const orderedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(orderedState.history.filter((item) => item.status === 'published').length, 3);
  assert.equal(orderedState.ledger.filter((item) => item.type === 'delivery').length, 3);
  assert.deepEqual(orderedState.history.find((item) => item.telegramMessageId === '844').maxMessageIds, ['max-rich-message-2', 'max-rich-message-3']);

  // Editing an old multipart post after another post must update both parts.
  const editedPost = { ...longPost, rich_message: { blocks: [{ type: 'paragraph', text: longText.replaceAll('first', 'other') }] } };
  assert.deepEqual(await Promise.all([
    webhook(port, { update_id: 13, edited_channel_post: editedPost }),
    webhook(port, { update_id: 14, edited_channel_post: editedPost }),
  ]), [200, 200]);
  assert.deepEqual(maxRequests.slice(4), [
    { method: 'PUT', id: 'max-rich-message-2' }, { method: 'PUT', id: 'max-rich-message-3' },
    { method: 'PUT', id: 'max-rich-message-2' }, { method: 'PUT', id: 'max-rich-message-3' },
  ]);
  const shortened = { ...longPost, rich_message: { blocks: [{ type: 'paragraph', text: 'Shortened publication' }] } };
  assert.equal(await webhook(port, { update_id: 15, edited_channel_post: shortened }), 200);
  assert.deepEqual(maxRequests.slice(8), [{ method: 'PUT', id: 'max-rich-message-2' }, { method: 'DELETE', id: 'max-rich-message-3' }]);
  const editedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(editedState.history.find((item) => item.telegramMessageId === '844').maxMessageIds, ['max-rich-message-2']);
  assert.equal(editedState.ledger.filter((item) => item.type === 'delivery').length, 3);
  assert.equal(editedState.users[0].balanceKopecks, 200);

  const simultaneous = { message_id: 846, chat: { username: 'source_channel' }, text: 'Only one publication' };
  assert.deepEqual(await Promise.all([
    webhook(port, { update_id: 16, channel_post: simultaneous }),
    webhook(port, { update_id: 17, channel_post: simultaneous }),
  ]), [200, 200]);
  assert.equal(maxRequests.filter((call) => call.method === 'POST').length, 5);
  const deduplicatedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(deduplicatedState.history.filter((item) => item.telegramMessageId === '846').length, 1);
  assert.equal(deduplicatedState.ledger.filter((item) => item.type === 'delivery').length, 4);

});

test('legacy multipart edits recover existing IDs and failed edits never charge again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-legacy-'));
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 12);
  const now = new Date().toISOString();
  const source = { message_id: 901, chat: { username: 'source_channel' }, text: 'x'.repeat(6500) };
  await writeFile(statePath, JSON.stringify({
    users: [{ id: 'user-1', email: 'legacy@example.test', balanceKopecks: 500, walletInitializedAt: now }],
    connections: [{ id: 'connection-1', userId: 'user-1', source: 'source_channel', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), targetChatId: 'max-channel-1', enabled: true }],
    history: [{ id: 'legacy', connectionId: 'connection-1', telegramMessageId: '901', status: 'published', maxMessageId: 'legacy-head', costKopecks: 100, sourceMessage: source, createdAt: now }],
    ledger: [], settings: { pricePerMessageKopecks: 100 }, migrated: true, connectionWebhooksMigrated: true,
    telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }));
  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';
  const calls = [];
  let failTail = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ method: options.method || 'GET', path: url.pathname, id: url.searchParams.get('message_id') });
    if (url.pathname === '/messages/legacy-head') return Response.json({ timestamp: 1000, body: { mid: 'legacy-head' } });
    if (!options.method) return Response.json({ messages: [
      { timestamp: 1001, body: { mid: 'legacy-tail', text: 'x'.repeat(2500) } },
      { timestamp: 1000, body: { mid: 'legacy-head', text: 'x'.repeat(4000) } },
    ] });
    if (url.searchParams.get('message_id') === 'legacy-tail' && failTail) {
      failTail = false;
      return Response.json({ message: 'rejected edit' }, { status: 400 });
    }
    return Response.json({ success: true });
  };
  const { server } = await import(`./server.js?legacy-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  const edited = { ...source, text: 'y'.repeat(6500) };
  assert.equal(await webhook(port, { edited_channel_post: edited }), 200);
  const failed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(failed.history[0].status, 'failed');
  assert.deepEqual(failed.history[0].maxMessageIds, ['legacy-head', 'legacy-tail']);
  assert.equal(failed.users[0].balanceKopecks, 500);
  assert.equal(await webhook(port, { edited_channel_post: edited }), 200);
  const completed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(completed.history[0].status, 'published');
  assert.deepEqual(completed.history[0].maxMessageIds, ['legacy-head', 'legacy-tail']);
  assert.equal(completed.users[0].balanceKopecks, 500);
  assert.equal(completed.ledger.length, 0);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.id]), [
    ['PUT', 'legacy-head'], ['PUT', 'legacy-tail'], ['PUT', 'legacy-head'], ['PUT', 'legacy-tail'],
  ]);
});

test('a configured local Telegram source uploads a file-backed Blob without a Telegram file download request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-local-telegram-'));
  const telegramRoot = join(directory, 'telegram-bot-api');
  const videoPath = join(telegramRoot, 'bot-data', 'videos', 'large.mp4');
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 13);
  const now = new Date().toISOString();
  await mkdir(join(telegramRoot, 'bot-data', 'videos'), { recursive: true });
  await writeFile(videoPath, Buffer.from('file-backed-video'));
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'local@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [{ id: 'connection-1', userId: 'user-1', name: 'Local Telegram test', source: 'anytin_sadik', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), maxSecret: 'max-secret', targetChatId: 'max-channel-1', enabled: true, error: null, createdAt: now, updatedAt: now }],
    history: [], ledger: [], pendingAlbums: [], settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 }, migrated: true,
    connectionWebhooksMigrated: true, telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';
  process.env.TELEGRAM_LOCAL_API_URL = 'http://127.0.0.1:8081';
  process.env.TELEGRAM_LOCAL_SOURCES = 'anytin_sadik';
  process.env.TELEGRAM_LOCAL_FILE_ROOT = telegramRoot;

  const fetches = [];
  let uploadedSize = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    fetches.push(url);
    if (url === 'http://127.0.0.1:8081/botfake-telegram-token/getFile') {
      return new Response(JSON.stringify({ ok: true, result: { file_path: videoPath } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://platform-api2.max.ru/uploads?type=video') return new Response(JSON.stringify({ url: 'https://upload.example.test/local-video' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://upload.example.test/local-video') {
      uploadedSize = options.body.get('data').size;
      return new Response(JSON.stringify({ token: 'uploaded-local-video' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://platform-api2.max.ru/messages?')) return new Response(JSON.stringify({ message: { body: { mid: 'max-local-video-1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected fetch in local Telegram test: ${url}`);
  };

  const { server } = await import(`./server.js?local-telegram-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_LOCAL_API_URL;
    delete process.env.TELEGRAM_LOCAL_SOURCES;
    delete process.env.TELEGRAM_LOCAL_FILE_ROOT;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  assert.equal(await webhook(port, { update_id: 20, channel_post: { message_id: 900, date: 1787932800, chat: { username: 'anytin_sadik' }, caption: 'Большое видео', video: { file_id: 'large-video-id', file_name: 'large.mp4', mime_type: 'video/mp4' } } }), 200);

  const state = await waitForState(statePath, (value) => value.history?.[0]?.status === 'published');
  assert.equal(uploadedSize, Buffer.byteLength('file-backed-video'));
  assert.equal(fetches.some((url) => url.includes('/file/bot')), false);
  assert.equal(state.history[0].mediaType, 'video');
  assert.equal(state.ledger.filter((item) => item.type === 'delivery').length, 1);
});

test('a local WAV post is converted to MP3 before MAX audio upload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-wav-'));
  const telegramRoot = join(directory, 'telegram-bot-api');
  const audioPath = join(telegramRoot, 'bot-data', 'audio', 'source.bin');
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 14);
  const now = new Date().toISOString();
  await mkdir(join(telegramRoot, 'bot-data', 'audio'), { recursive: true });
  await writeFile(audioPath, silenceWav());
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'wav@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [{ id: 'connection-1', userId: 'user-1', name: 'WAV test', source: 'anytin_sadik', telegramToken: seal('fake-telegram-token', key), telegramSecret: 'telegram-secret', maxToken: seal('fake-max-token', key), maxSecret: 'max-secret', targetChatId: 'max-channel-1', enabled: true, error: null, createdAt: now, updatedAt: now }],
    history: [], ledger: [], pendingAlbums: [], settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 }, migrated: true,
    connectionWebhooksMigrated: true, telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';
  process.env.TELEGRAM_LOCAL_API_URL = 'http://127.0.0.1:8081';
  process.env.TELEGRAM_LOCAL_SOURCES = 'anytin_sadik';
  process.env.TELEGRAM_LOCAL_FILE_ROOT = telegramRoot;
  process.env.MEDIA_CONVERSION_DIR = join(directory, 'transcode');

  let uploadedAudio;
  let maxMessage;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:8081/botfake-telegram-token/getFile') return new Response(JSON.stringify({ ok: true, result: { file_path: audioPath } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://platform-api2.max.ru/uploads?type=audio') return new Response(JSON.stringify({ url: 'https://upload.example.test/wav', token: 'audio-upload-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://upload.example.test/wav') {
      const file = options.body.get('data');
      uploadedAudio = { name: file.name, type: file.type, size: file.size };
      return new Response('<retval>1</retval>', { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    if (url.startsWith('https://platform-api2.max.ru/messages?')) {
      maxMessage = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { body: { mid: 'max-wav-message-1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in WAV test: ${url}`);
  };

  const { server } = await import(`./server.js?wav-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_LOCAL_API_URL;
    delete process.env.TELEGRAM_LOCAL_SOURCES;
    delete process.env.TELEGRAM_LOCAL_FILE_ROOT;
    delete process.env.MEDIA_CONVERSION_DIR;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  assert.equal(await webhook(port, { update_id: 21, channel_post: { message_id: 901, date: 1787932800, chat: { username: 'anytin_sadik' }, caption: 'WAV audio', audio: { file_id: 'wav-audio-id', file_name: 'Rollin.wav', mime_type: 'audio/wav' } } }), 200);
  const state = await waitForState(statePath, (value) => value.history?.[0]?.status === 'published');
  assert.deepEqual(uploadedAudio && { name: uploadedAudio.name, type: uploadedAudio.type }, { name: 'Rollin.mp3', type: 'audio/mpeg' });
  assert.ok(uploadedAudio.size > 0);
  assert.deepEqual(maxMessage.attachments, [{ type: 'audio', payload: { token: 'audio-upload-token' } }]);
  assert.equal(state.history[0].mediaType, 'audio');
});

test('a new connection logs the bot out of the cloud before configuring its local webhook', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-reposter-new-local-'));
  const statePath = join(directory, 'app.json');
  const key = Buffer.alloc(32, 17);
  const now = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify({
    users: [{ id: 'user-1', email: 'new-local@example.test', role: 'user', balanceKopecks: 500, walletInitializedAt: now, createdAt: now }],
    sessions: [{ id: 'session-1', userId: 'user-1', csrf: 'csrf-token', expiresAt: Date.now() + 60000 }],
    connections: [], history: [], ledger: [], pendingAlbums: [], settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 }, migrated: true,
    connectionWebhooksMigrated: true, telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }, null, 2)}\n`);

  process.env.APP_ENCRYPTION_KEY = key.toString('base64');
  process.env.PUBLIC_BASE_URL = 'https://channel.example.test';
  process.env.STATE_PATH = statePath;
  process.env.PORT = '0';
  process.env.TELEGRAM_LOCAL_API_URL = 'http://127.0.0.1:8081';
  process.env.TELEGRAM_LOCAL_SOURCES = '*';
  process.env.TELEGRAM_LOCAL_FILE_ROOT = join(directory, 'telegram-bot-api');

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === 'https://api.telegram.org/botnew-telegram-token/logOut') {
      calls.push('cloud-logOut');
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://127.0.0.1:8081/botnew-telegram-token/setWebhook') {
      calls.push('local-setWebhook');
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://127.0.0.1:8081/botnew-telegram-token/setMyCommands') {
      calls.push('local-setMyCommands');
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://platform-api2.max.ru/subscriptions') {
      calls.push('max-subscription');
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in new local connection test: ${url}`);
  };

  const { server } = await import(`./server.js?new-local-connection-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_LOCAL_API_URL;
    delete process.env.TELEGRAM_LOCAL_SOURCES;
    delete process.env.TELEGRAM_LOCAL_FILE_ROOT;
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  const created = await postForm(port, '/connections', {
    csrf: 'csrf-token',
    name: 'Future local channel',
    source: '@future_channel',
    telegramToken: 'new-telegram-token',
    maxToken: 'new-max-token',
    targetChatId: 'max-future-channel',
  });
  assert.deepEqual(created, { status: 303, location: '/dashboard' });
  assert.deepEqual(calls, ['cloud-logOut', 'local-setWebhook', 'local-setMyCommands', 'max-subscription']);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].source, 'future_channel');
  assert.equal(state.connections[0].telegramApiMode, 'local');
  assert.ok(state.connections[0].telegramApiMigratedAt);
  assert.equal(state.connections[0].error, null);
});
