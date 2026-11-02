import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('administrator can inspect an isolated read-only cabinet and return safely', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-inspection-'));
  const statePath = join(directory, 'app.json');
  const now = new Date().toISOString();
  const expiresAt = Date.now() + 600000;
  const users = [
    { id: 'admin', email: 'admin@example.test', role: 'admin' },
    { id: 'target', email: 'target@example.test', role: 'user' },
    { id: 'other', email: 'other@example.test', role: 'user' },
    { id: 'second-admin', email: 'second-admin@example.test', role: 'admin' },
  ].map((user) => ({ ...user, balanceKopecks: 30000, walletInitializedAt: now, createdAt: now }));
  const targetSession = { id: 'target-session', userId: 'target', csrf: 'target-csrf', expiresAt };
  await writeFile(statePath, JSON.stringify({
    users,
    sessions: [
      { id: 'admin-session', userId: 'admin', csrf: 'admin-csrf', expiresAt },
      { id: 'admin-other-tab', userId: 'admin', csrf: 'other-csrf', expiresAt },
      { id: 'expired-session', userId: 'admin', csrf: 'expired-csrf', expiresAt: Date.now() - 1000 },
      targetSession,
    ],
    connections: users.map((user) => ({ id: `${user.id}-connection`, userId: user.id, name: `Connection ${user.id}`, source: `source_${user.id}`, enabled: false, createdAt: now })),
    history: users.map((user) => ({ id: `${user.id}-history`, connectionId: `${user.id}-connection`, telegramMessageId: 1, preview: `Private history ${user.id}`, status: 'published', maxMessageId: `${user.id}-max`, createdAt: now })),
    ledger: users.map((user) => ({ id: `${user.id}-ledger`, userId: user.id, type: 'welcome', amountKopecks: 30000, note: `Private balance ${user.id}`, createdAt: now })),
    settings: { welcomeBonusKopecks: 30000, pricePerMessageKopecks: 100 },
    migrated: true, connectionWebhooksMigrated: true,
    telegramAssistantWebhooksV1: true, telegramAssistantWebhooksV2: true, telegramAssistantWebhooksV3: true,
  }));
  const savedEnv = { ...process.env };
  Object.assign(process.env, { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), PUBLIC_BASE_URL: 'https://channel.example.test', STATE_PATH: statePath, PORT: '0' });
  for (const key of ['MAX_APP_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_SHARED_BOT_TOKEN', 'MAX_BOT_TOKEN']) delete process.env[key];
  const originalFetch = globalThis.fetch;
  const externalCalls = [];
  globalThis.fetch = async (input) => {
    externalCalls.push(String(input));
    if (String(input).startsWith('https://t.me/')) return new Response('<html></html>');
    throw new Error(`Unexpected external request: ${input}`);
  };
  let server;
  let version = 0;
  async function start() {
    ({ server } = await import(`./server.js?inspection-test=${Date.now()}-${version++}`));
    if (!server.listening) await once(server, 'listening');
  }
  async function stop() {
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  async function editState(edit) {
    await stop();
    const data = await state(); edit(data);
    await writeFile(statePath, JSON.stringify(data));
    await start();
  }
  t.after(async () => {
    await stop();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  let cookie = 'admin-session';
  let token = 'admin-csrf';
  async function call(path, values = null, sessionId = cookie, method = values ? 'POST' : 'GET') {
    const body = values ? new URLSearchParams(values).toString() : '';
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        ...(sessionId ? { cookie: `session=${sessionId}` } : {}),
        ...(values ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
      } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  async function switchAccount(path) {
    const previousCookie = cookie, previousToken = token;
    const response = await call(path, { csrf: token });
    assert.equal(response.status, 303);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=None; Partitioned/);
    cookie = response.headers['set-cookie'][0].match(/^session=([^;]+)/)[1];
    const session = (await state()).sessions.find((item) => item.id === cookie);
    token = session.csrf;
    assert.notEqual(cookie, previousCookie); assert.notEqual(token, previousToken);
    assert.equal(session.userId, 'admin'); assert.equal(session.expiresAt, expiresAt);
    assert.equal((await call('/profile', null, previousCookie)).status, 303);
    return response;
  }

  await t.test('entry requires an administrator, valid CSRF, and an existing other user', async () => {
    const admin = await call('/admin');
    assert.equal(admin.status, 200);
    assert.match(admin.body, /action="\/admin\/users\/target\/impersonate"/);
    assert.doesNotMatch(admin.body, /action="\/admin\/users\/admin\/impersonate"/);
    for (const [session, csrf] of [['', 'admin-csrf'], ['target-session', 'target-csrf'], ['expired-session', 'expired-csrf'], [cookie, 'bad'], [cookie, 'я'.repeat(token.length)]]) {
      assert.equal((await call('/admin/users/target/impersonate', { csrf }, session)).status, 403);
    }
    assert.equal((await call('/admin/users/missing/impersonate', { csrf: token })).status, 403);
    assert.equal((await call('/admin/users/admin/impersonate', { csrf: token })).status, 403);
    assert.equal((await call('/admin/impersonation/stop', { csrf: token })).status, 403);
    assert.equal((await call('/admin/users/target/impersonate')).status, 404);
    assert.equal((await switchAccount('/admin/users/target/impersonate')).headers.location, '/dashboard');
  });
  const unchanged = await state();
  await t.test('all cabinet screens and live history fragments are scoped to the target', async () => {
    for (const path of ['/dashboard', '/history', '/profile', '/connections/target-connection/whatsapp']) {
      const response = await call(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.body, /Просмотр кабинета: target@example.test/);
      assert.match(response.body, /Вернуться в админку/);
      assert.doesNotMatch(response.body, /href="\/admin"/);
      assert.doesNotMatch(response.body, /Private history (other|admin)|Private balance (other|admin)|Connection (other|admin)/);
      assert.doesNotMatch(response.body.match(/<form[^>]*action="\/admin\/impersonation\/stop"[^>]*>/)?.[0] || '', /inert/);
    }
    assert.match((await call('/dashboard')).body, /Connection target/);
    assert.match((await call('/history')).body, /Private history target/);
    assert.match((await call('/profile')).body, /Private balance target/);
    const fragment = await call('/history/fragment');
    assert.equal(fragment.status, 200);
    assert.match(fragment.body, /method="post"[^>]*inert aria-disabled="true"/);
    assert.equal((await call('/connections/other-connection/whatsapp')).status, 403);
    assert.equal((await call('/history?connection=other-connection')).status, 403);
    assert.doesNotMatch((await call('/profile', null, 'target-session')).body, /Просмотр кабинета:/);
    assert.doesNotMatch((await call('/profile', null, 'admin-other-tab')).body, /Просмотр кабинета:/);
  });
  await t.test('direct mutations, nested impersonation, admin and payment GET are blocked', async () => {
    for (const path of ['/connections', '/connections/target-connection/toggle', '/connections/target-connection/configure', '/connections/target-connection/max-token', '/connections/target-connection/imports/1/send', '/history/target-history/replay', '/connections/target-connection/whatsapp/connect', '/connections/target-connection/whatsapp/send', '/connections/target-connection/whatsapp/group', '/payments/yookassa', '/telegram/link', '/admin/settings', '/admin/users/target/credit', '/admin/users/other/impersonate', '/login', '/register']) {
      assert.equal((await call(path, { csrf: token, amount: '100', password: 'some-password' })).status, 403, path);
    }
    assert.equal((await call('/admin')).status, 403);
    assert.equal((await call('/payments/yookassa/return?local_payment_id=fake')).status, 403);
    assert.equal((await call('/admin/impersonation/stop', { csrf: 'admin-csrf' })).status, 403);
    const data = await state();
    assert.deepEqual(data.users, unchanged.users); assert.deepEqual(data.ledger, unchanged.ledger);
    assert.deepEqual(data.connections, unchanged.connections); assert.deepEqual(data.history, unchanged.history);
    assert.deepEqual(data.sessions.find((s) => s.id === 'target-session'), targetSession);
    assert.ok(externalCalls.every((url) => url.startsWith('https://t.me/')));
  });
  await t.test('inspection survives restart and returns to the original administrator', async () => {
    await stop(); await start();
    assert.match((await call('/profile')).body, /Просмотр кабинета: target@example.test/);
    assert.equal((await switchAccount('/admin/impersonation/stop')).headers.location, '/admin');
    assert.equal((await call('/admin')).status, 200);
    assert.doesNotMatch((await call('/profile')).body, /Просмотр кабинета:/);
    assert.match((await call('/profile')).body, /Private balance admin/);
    assert.equal((await call('/admin/settings', { csrf: 'admin-csrf', price: '0', bonus: '300' })).status, 403);
    const log = (await state()).adminAccessLog;
    assert.deepEqual(log.map(({ administratorId, userId, action }) => ({ administratorId, userId, action })), [
      { administratorId: 'admin', userId: 'target', action: 'start' },
      { administratorId: 'admin', userId: 'target', action: 'stop' },
    ]);
  });
  await t.test('viewing another administrator grants no administration or nested access', async () => {
    await switchAccount('/admin/users/second-admin/impersonate');
    assert.equal((await call('/admin')).status, 403);
    assert.doesNotMatch((await call('/profile')).body, /href="\/admin"/);
    assert.equal((await call('/admin/users/other/impersonate', { csrf: token })).status, 403);
    await switchAccount('/admin/impersonation/stop');
  });
  await t.test('deleted target still allows return, revoked administrator loses inspection', async () => {
    await switchAccount('/admin/users/other/impersonate');
    await editState((data) => { data.users = data.users.filter((user) => user.id !== 'other'); });
    const missing = await call('/profile');
    assert.equal(missing.status, 403); assert.match(missing.body, /Вернуться в админку/);
    await switchAccount('/admin/impersonation/stop');
    await switchAccount('/admin/users/target/impersonate');
    await editState((data) => { data.users.find((user) => user.id === 'admin').role = 'user'; });
    assert.equal((await call('/profile')).status, 303);
    assert.equal((await call('/admin/impersonation/stop', { csrf: token })).status, 403);
    await editState((data) => { data.users.find((user) => user.id === 'admin').role = 'admin'; });
    assert.equal((await call('/logout', { csrf: token })).status, 303);
    assert.equal((await call('/profile')).status, 303);
    assert.equal((await call('/profile', null, 'target-session')).status, 200);
  });
});
