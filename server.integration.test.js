import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/getFile?')) {
      const fileId = new URL(url).searchParams.get('file_id');
      return new Response(JSON.stringify({ ok: true, result: { file_path: `photos/${fileId}.jpg` } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/file/bot')) return new Response(Buffer.from('fake image bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith('https://platform-api2.max.ru/uploads?')) return new Response(JSON.stringify({ url: `https://upload.example.test/${maxMessages.length + 1}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://upload.example.test/')) return new Response(JSON.stringify({ token: `uploaded-${url.split('/').at(-1)}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://platform-api2.max.ru/messages?')) {
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
  assert.equal(maxMessages[1].attachments.length, 2);
  assert.equal(replayedState.history.length, 1);
  assert.equal(replayedState.history[0].replayCount, 1);
  assert.equal(replayedState.ledger.filter((item) => item.type === 'delivery').length, 2);
  assert.equal(replayedState.ledger[0].replay, true);
  assert.equal(replayedState.users[0].balanceKopecks, 300);
});
