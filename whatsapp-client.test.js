import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { BufferJSON, DisconnectReason, proto } from 'baileys';
import libsignal from 'libsignal';
import { createWhatsAppClient } from './whatsapp-client.js';

const USER = 'owner-user';
const INVITE = 'https://chat.whatsapp.com/HUHQJhRerXkGbuYlPbTTwr';
const GROUP = '120363000000000000@g.us';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for mocked WhatsApp state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-client-test-'));
  const authDirectory = join(directory, 'auth');
  const key = randomBytes(32);
  const seal = (text) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
  };
  const unseal = (text) => {
    const [iv, tag, encrypted] = text.split('.').map((value) => Buffer.from(value, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
  };
  const sockets = [];
  let dependencyLoads = 0;
  const dependencies = {
    baileys: {
      BufferJSON,
      proto,
      DisconnectReason,
      initAuthCreds: () => ({ registered: false, noiseKey: { private: Buffer.from('synthetic-auth-secret') }, processedHistoryMessages: [] }),
      makeWASocket(config) {
        const socket = {
          config,
          ev: new EventEmitter(),
          ws: new EventEmitter(),
          endCalls: 0,
          logoutCalls: 0,
          joinCalls: 0,
          inviteCalls: [],
          metadataCalls: [],
          sent: [],
          get user() { return config.auth.creds.me; },
          metadata: { id: GROUP, subject: 'Лось в проде', participants: [{ id: '777@lid', admin: 'admin' }] },
          async end() { this.endCalls += 1; this.ws.emit('close'); },
          async logout() { this.logoutCalls += 1; },
          async groupAcceptInvite() { this.joinCalls += 1; throw new Error('Automatic joining is forbidden'); },
          async groupGetInviteInfo(code) { this.inviteCalls.push(code); return { id: GROUP, subject: 'Unverified invite title' }; },
          async groupMetadata(id) { this.metadataCalls.push(id); return this.metadataById?.get(id) || this.metadata; },
          async communityFetchLinkedGroups(id) { this.communityQueries = [...(this.communityQueries || []), id]; return this.linkedGroups; },
          async sendMessage(id, payload, options) {
            this.sent.push({ id, payload, options });
            if (this.sendError) throw this.sendError;
            if (!this.skipAck) this.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: options.messageId, from: id, ...(this.ackError ? { error: this.ackError } : {}) } });
            return this.sendResult || { key: { id: options.messageId } };
          },
        };
        sockets.push(socket);
        return socket;
      },
    },
    qrcode: { async toDataURL() { return 'data:image/png;base64,cG5n'; } },
    libsignal,
  };
  const loadDependencies = async () => { dependencyLoads += 1; return dependencies; };
  const options = { directory: authDirectory, seal, unseal, loadDependencies, onDiagnostic() {}, ...overrides };
  const client = createWhatsAppClient(options);
  const clients = [client];
  t.after(async () => { await Promise.all(clients.map((item) => item.closeAll())); await rm(directory, { recursive: true, force: true }); });
  return { client, clients, directory, authDirectory, sockets, dependencies, options, unseal, get dependencyLoads() { return dependencyLoads; } };
}

async function paired(f, userId = USER) {
  await f.client.start(userId);
  const socket = f.sockets.at(-1);
  socket.ev.emit('creds.update', { registered: true, me: { id: '15551234567:4@s.whatsapp.net', lid: '777:4@lid' } });
  socket.ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => f.client.status(userId).state === 'connected');
  return socket;
}

test('constructor/status and resume without saved auth are inert', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.client.status(USER), { state: 'disconnected' });
  assert.deepEqual(await f.client.resume([USER]), [{ userId: USER, state: 'disconnected' }]);
  assert.equal(f.dependencyLoads, 0);
  assert.equal(f.sockets.length, 0);
  await assert.rejects(stat(f.authDirectory), { code: 'ENOENT' });
  assert.throws(() => f.client.status(''), /Некорректный аккаунт/);
});

test('pairing diagnostics report stages without QR data, protocol nodes or identifiers', async (t) => {
  const events = [];
  const f = await fixture(t, { onDiagnostic: (event) => events.push(event) });
  await f.client.start(USER);
  const socket = f.sockets[0];
  socket.ev.emit('connection.update', { qr: 'private-qr-material' });
  await waitFor(() => f.client.status(USER).state === 'qr');
  socket.ws.emit('CB:notification,type:companion_reg_refresh', { attrs: { id: 'private-id', from: 'private-account' }, content: 'private-protocol-data' });
  socket.ws.emit('CB:iq,,pair-success', { content: 'private-credentials' });
  socket.ws.emit('CB:failure', { attrs: { reason: '401', from: 'private-account' } });
  assert.deepEqual(events, [
    { event: 'pairing_qr_ready' },
    { event: 'pairing_registration_refresh' },
    { event: 'pairing_success_received' },
    { event: 'login_failure', code: 401 },
  ]);
  await f.client.stop(USER);
  assert.equal(socket.ws.listenerCount('CB:notification,type:companion_reg_refresh'), 0);
  assert.equal(socket.ws.listenerCount('CB:iq,,pair-success'), 0);
  assert.equal(socket.ws.listenerCount('CB:failure'), 0);
});

test('community invite resolves only to its accessible announcement subgroup', async (t) => {
  const f = await fixture(t);
  const socket = await paired(f);
  const parent = '120363000000000001@g.us';
  const general = '120363000000000002@g.us';
  const member = { id: '777@lid', admin: 'admin' };
  socket.metadataById = new Map([
    [GROUP, { id: GROUP, subject: 'Лось в проде', isCommunity: true, participants: [member] }],
    [parent, { id: parent, subject: 'Объявления', isCommunityAnnounce: true, linkedParent: GROUP, announce: true, participants: [member] }],
    [general, { id: general, subject: 'Общая', linkedParent: GROUP, participants: [member] }],
  ]);
  socket.linkedGroups = { communityJid: GROUP, linkedGroups: [{ id: general }, { id: parent }] };
  assert.deepEqual(await f.client.resolveGroup(USER, INVITE), { id: parent, name: 'Лось в проде · Объявления' });
  assert.deepEqual(socket.communityQueries, [GROUP]);
  await assert.rejects(f.client.send(USER, GROUP, { text: 'Do not send to a community root' }), /корень сообщества/);
  assert.equal(socket.sent.length, 0);
  socket.metadataById.get(parent).linkedParent = general;
  await assert.rejects(f.client.resolveDestination(USER, GROUP), /единственная/);
  assert.equal(socket.joinCalls, 0);
});

test('explicit pairing hides QR by default and disables history/content retention', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client.start(USER)).state, 'connecting');
  const socket = f.sockets[0];
  socket.ev.emit('connection.update', { qr: 'raw-pairing-secret' });
  await waitFor(() => f.client.status(USER).state === 'qr');
  assert.deepEqual(f.client.status(USER), { state: 'qr' });
  assert.equal(f.client.status(USER, { includeQr: true }).qr, 'data:image/png;base64,cG5n');
  assert.equal((await f.client.start(USER)).qr, 'data:image/png;base64,cG5n');
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.config.logger.level, 'silent');
  assert.equal(socket.config.logger.child({ private: true }), socket.config.logger);
  const signalSession = libsignal.SessionRecord.createEntry();
  signalSession.privateKey = Buffer.from('PRIVATE_KEY_MUST_NEVER_LOG');
  assert.equal(inspect(signalSession), '[WhatsApp session redacted]');
  assert.equal(socket.config.syncFullHistory, false);
  assert.equal(socket.config.shouldSyncHistoryMessage({ syncType: 0 }), false);
  assert.equal(socket.config.fireInitQueries, false);
  assert.equal(socket.config.emitOwnEvents, false);
  assert.equal(socket.config.enableRecentMessageCache, false);
  assert.equal(socket.config.enableAutoSessionRecreation, false);
  assert.equal(socket.config.maxMsgRetryCount, 0);
  assert.equal(await socket.config.getMessage({}), undefined);
  assert.equal(socket.ev.listenerCount('messages.upsert'), 0);
  assert.equal(socket.ev.listenerCount('messaging-history.set'), 0);
  assert.equal(socket.config.shouldIgnoreJid('111@s.whatsapp.net'), true);
  assert.equal(socket.config.shouldIgnoreJid(GROUP), true);
  assert.equal(socket.config.shouldIgnoreJid('s.whatsapp.net'), false);
  await f.client.stop(USER);
  assert.deepEqual(f.client.status(USER, { includeQr: true }), { state: 'disconnected' });
  assert.equal(socket.endCalls, 1);
  assert.equal(socket.logoutCalls, 0);
});

test('encrypted auth restores BufferJSON and app-state protobuf keys after local stop', async (t) => {
  const f = await fixture(t);
  const userId = '../../unsafe/path';
  const socket = await paired(f, userId);
  assert.equal(socket.config.shouldIgnoreJid('777@lid'), false);
  const appKey = { keyData: Buffer.from('synthetic-app-state-secret'), timestamp: 123 };
  await socket.config.auth.keys.set({
    'app-state-sync-key': { 'secret/id:one': appKey },
    'pre-key': { one: { public: Buffer.from('public'), private: Buffer.from('private') }, deleted: Buffer.from('delete') },
  });
  await socket.config.auth.keys.set({ 'pre-key': { deleted: null } });
  socket.ev.emit('messages.upsert', { messages: [{ message: { conversation: 'private-incoming-text' } }] });
  await f.client.stop(userId);
  const filenames = await readdir(f.authDirectory);
  assert.equal(filenames.length, 1);
  assert.match(filenames[0], /^[0-9a-f]{64}\.auth$/);
  const ciphertext = await readFile(join(f.authDirectory, filenames[0]), 'utf8');
  assert.equal(ciphertext.includes('synthetic'), false);
  assert.equal(ciphertext.includes('private-incoming-text'), false);
  assert.equal(ciphertext.includes('15551234567'), false);
  const saved = JSON.parse(f.unseal(ciphertext), BufferJSON.reviver);
  assert.deepEqual(saved.creds.noiseKey.private, Buffer.from('synthetic-auth-secret'));
  assert.equal(Object.hasOwn(saved.keys['pre-key'], 'deleted'), false);
  assert.deepEqual(Object.keys(saved).sort(), ['creds', 'keys', 'version']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.authDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.authDirectory, filenames[0]))).mode & 0o777, 0o600);
  }
  const restored = createWhatsAppClient(f.options);
  f.clients.push(restored);
  assert.equal((await restored.resume([userId]))[0].state, 'connecting');
  const restoredSocket = f.sockets.at(-1);
  assert.deepEqual(restoredSocket.config.auth.creds.noiseKey.private, Buffer.from('synthetic-auth-secret'));
  const values = await restoredSocket.config.auth.keys.get('app-state-sync-key', ['secret/id:one', 'missing']);
  assert.ok(values['secret/id:one'] instanceof proto.Message.AppStateSyncKeyData);
  assert.deepEqual(values['secret/id:one'].keyData, Buffer.from('synthetic-app-state-secret'));
  assert.equal(values.missing, undefined);
  assert.equal(socket.logoutCalls, 0);
});

test('group resolution strictly validates invitations and checks actual membership/admin rights without joining', async (t) => {
  const f = await fixture(t);
  const socket = await paired(f);
  for (const invalid of ['http://chat.whatsapp.com/HUHQJhRerXkGbuYlPbTTwr', `${INVITE}?next=external`, `${INVITE}#fragment`, 'https://chat.whatsapp.com.evil.example/HUHQJhRerXkGbuYlPbTTwr', 'https://other:password@chat.whatsapp.com/HUHQJhRerXkGbuYlPbTTwr', 'https://chat.whatsapp.com/short']) await assert.rejects(f.client.resolveGroup(USER, invalid), /Укажите ссылку/);
  assert.equal(socket.inviteCalls.length, 0);
  assert.deepEqual(await f.client.resolveGroup(USER, INVITE), { id: GROUP, name: 'Лось в проде' });
  assert.equal(socket.inviteCalls[0], 'HUHQJhRerXkGbuYlPbTTwr');
  socket.metadata.participants = [{ id: 'someone-else@lid' }];
  await assert.rejects(f.client.resolveGroup(USER, INVITE), /Сначала вступите/);
  socket.metadata.participants = [{ id: '777@lid' }];
  socket.metadata.announce = true;
  await assert.rejects(f.client.resolveGroup(USER, INVITE), /только администраторы/);
  socket.metadata.participants[0].admin = 'superadmin';
  assert.equal((await f.client.resolveGroup(USER, INVITE)).id, GROUP);
  assert.equal(socket.joinCalls, 0);
  assert.equal(socket.sent.length, 0);
});

test('send passes deterministic ID once, rejects unsafe payloads and reports ambiguous errors without retry', async (t) => {
  const f = await fixture(t);
  const socket = await paired(f);
  assert.equal(await f.client.send(USER, GROUP, { text: 'Пост', ignored: 'stripped' }, { messageId: 'WA_STABLE_123' }), 'WA_STABLE_123');
  assert.deepEqual(socket.sent[0], { id: GROUP, payload: { text: 'Пост' }, options: { messageId: 'WA_STABLE_123' } });
  const image = Buffer.from('image-file');
  await f.client.send(USER, GROUP, { image, caption: 'Фото', mimetype: 'image/png', fileName: 'photo.png' });
  assert.deepEqual(socket.sent[1].payload, { image, caption: 'Фото', mimetype: 'image/png', fileName: 'photo.png' });
  await assert.rejects(f.client.send(USER, GROUP, { image: { url: 'https://private.example' } }), /данные файла/);
  await assert.rejects(f.client.send(USER, GROUP, { text: 'text', video: image }), /одно вложение/);
  await assert.rejects(f.client.send(USER, '111@s.whatsapp.net', { text: 'text' }), /Некорректная группа/);
  await assert.rejects(f.client.send(USER, GROUP, { text: 'text' }, { messageId: '../invalid' }), /Некорректный идентификатор/);
  assert.equal(socket.sent.length, 2);
  socket.sendError = new Error('PRIVATE_PROVIDER_DETAIL_AND_TOKEN');
  await assert.rejects(f.client.send(USER, GROUP, { text: 'uncertain' }), (error) => error.code === 'WHATSAPP_SEND_UNCERTAIN' && !error.message.includes('PRIVATE_PROVIDER'));
  assert.equal(socket.sent.length, 3);
  socket.sendError = null;
  socket.sendResult = {};
  await assert.rejects(f.client.send(USER, GROUP, { text: 'missing receipt' }), { code: 'WHATSAPP_SEND_UNCERTAIN' });
  assert.equal(socket.sent.length, 4);
  socket.metadata.participants = [];
  await assert.rejects(f.client.send(USER, GROUP, { text: 'revoked' }), { code: 'WHATSAPP_GROUP_ACCESS' });
  assert.equal(socket.sent.length, 4);
  assert.equal(socket.ws.listenerCount('CB:ack,class:message'), 0);
  assert.equal(socket.ev.listenerCount('messages.update'), 0);
});

test('local send completion requires a matching server ACK and rejected/absent ACK never succeeds', async (t) => {
  const f = await fixture(t, { sendAckTimeoutMs: 25 });
  const socket = await paired(f);
  socket.skipAck = true;
  const sending = f.client.send(USER, GROUP, { text: 'Await server' }, { messageId: 'SERVER_ACK_TEST' });
  await tick();
  let completed = false;
  sending.then(() => { completed = true; }, () => {});
  socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: 'OTHER_ID', from: GROUP } });
  socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: 'SERVER_ACK_TEST', from: '999@g.us' } });
  await tick();
  assert.equal(completed, false);
  socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: 'SERVER_ACK_TEST', from: GROUP } });
  assert.equal(await sending, 'SERVER_ACK_TEST');
  await assert.rejects(f.client.send(USER, GROUP, { text: 'No ACK' }), { code: 'WHATSAPP_SEND_UNCERTAIN' });
  socket.skipAck = false;
  socket.ackError = '403';
  await assert.rejects(f.client.send(USER, GROUP, { text: 'Rejected' }), { code: 'WHATSAPP_SEND_REJECTED' });
  assert.equal(socket.sent.length, 3);
  assert.equal(socket.ws.listenerCount('CB:ack,class:message'), 0);
  assert.equal(socket.ws.listenerCount('close'), 0);
  assert.equal(socket.ev.listenerCount('messages.update'), 0);
});

test('existing sessions reconnect with a finite backoff budget', async (t) => {
  const f = await fixture(t, { reconnectDelays: [5, 5], reconnectResetMs: 60000 });
  const first = await paired(f);
  const closed = { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } } };
  first.ev.emit('connection.update', closed);
  await waitFor(() => f.sockets.length === 2);
  f.sockets[1].ev.emit('connection.update', closed);
  await waitFor(() => f.sockets.length === 3);
  f.sockets[2].ev.emit('connection.update', closed);
  await waitFor(() => f.client.status(USER).state === 'error');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.sockets.length, 3);
  assert.ok(f.sockets.every((socket) => socket.sent.length === 0 && socket.logoutCalls === 0));
});

test('unpaired QR sessions expire and never reconnect automatically', async (t) => {
  const f = await fixture(t, { pairingTimeoutMs: 25, reconnectDelays: [2] });
  await f.client.start(USER);
  f.sockets[0].ev.emit('connection.update', { qr: 'temporary-qr' });
  await waitFor(() => f.client.status(USER).state === 'error');
  assert.match(f.client.status(USER).error, /Время входа/);
  assert.equal(f.client.status(USER, { includeQr: true }).qr, undefined);
  assert.equal(f.sockets[0].endCalls, 1);
  assert.equal(f.sockets.length, 1);
  await f.client.start('other-user');
  f.sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } } });
  await waitFor(() => f.client.status('other-user').state === 'error');
  assert.equal(f.sockets.length, 2);
});

test('resume does not reuse a stopped unregistered in-memory auth state', async (t) => {
  const f = await fixture(t);
  await f.client.start(USER);
  await f.sockets[0].config.auth.keys.set({ 'pre-key': { one: Buffer.from('unregistered') } });
  await f.client.stop(USER);
  await f.client.resume([USER]);
  assert.deepEqual(f.client.status(USER), { state: 'disconnected' });
  assert.equal(f.sockets.length, 1);
});

test('logged-out sessions remove encrypted auth and cannot be resumed', async (t) => {
  const f = await fixture(t);
  const socket = await paired(f);
  await socket.config.auth.keys.set({ 'pre-key': { one: Buffer.from('key') } });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await waitFor(() => f.client.status(USER).state === 'logged_out');
  await f.client.stop(USER);
  assert.deepEqual(await readdir(f.authDirectory), []);
  await socket.config.auth.keys.set({ 'pre-key': { stale: Buffer.from('stale') } });
  assert.deepEqual(await readdir(f.authDirectory), []);
  await f.client.resume([USER]);
  assert.equal(f.sockets.length, 1);
  await f.client.start(USER);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].config.auth.creds.registered, false);
});

test('resume does not produce QR and stop cancels dependency-loading startup', async (t) => {
  const f = await fixture(t);
  await paired(f);
  await f.client.stop(USER);
  const restored = createWhatsAppClient(f.options);
  f.clients.push(restored);
  await restored.resume([USER]);
  f.sockets.at(-1).ev.emit('connection.update', { qr: 'should-not-be-shown' });
  await waitFor(() => restored.status(USER).state === 'error');
  assert.equal(restored.status(USER, { includeQr: true }).qr, undefined);

  let release;
  const loading = createWhatsAppClient({ ...f.options, loadDependencies: () => new Promise((resolve) => { release = resolve; }) });
  f.clients.push(loading);
  const starting = loading.start('stopped-user');
  await tick();
  const stopping = loading.stop('stopped-user');
  const socketCount = f.sockets.length;
  release(f.dependencies);
  await Promise.all([starting, stopping]);
  assert.equal(f.sockets.length, socketCount);
  assert.deepEqual(loading.status('stopped-user'), { state: 'disconnected' });
});

test('dependency failures remain local and expose no library error or secret', async (t) => {
  const f = await fixture(t, { loadDependencies: async () => { throw new Error('PRIVATE_ENV_PATH_AND_SECRET'); } });
  const result = await f.client.start(USER);
  assert.equal(result.state, 'error');
  assert.match(result.error, /модуль WhatsApp/);
  assert.equal(result.error.includes('PRIVATE_ENV'), false);
  assert.equal(f.sockets.length, 0);
});
