import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GROUP_ID = /^\d+(?:-\d+)?@g\.us$/;
const AUTH_TYPES = new Set(['pre-key', 'session', 'sender-key', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version', 'lid-mapping', 'device-list', 'tctoken', 'identity-key']);
const quiet = () => {};
const silentLogger = { level: 'silent', trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet, fatal: quiet, child() { return this; } };
const defaultDependencies = async () => {
  const [baileys, qrcode, libsignal] = await Promise.all([import('baileys'), import('qrcode'), import('libsignal')]);
  return { baileys, qrcode: qrcode.default || qrcode, libsignal: libsignal.default || libsignal };
};

function userKey(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 256) throw new Error('Некорректный аккаунт WhatsApp.');
  return createHash('sha256').update(userId).digest('hex');
}

function inviteCode(inviteLink) {
  const match = typeof inviteLink === 'string' && inviteLink.trim().match(/^https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]{22,128})\/?$/);
  if (!match) throw new Error('Укажите ссылку https://chat.whatsapp.com/… на группу WhatsApp.');
  return match[1];
}

function safeError(message, code = 'WHATSAPP_CLIENT_ERROR') {
  return Object.assign(new Error(message), { code });
}

function identityIds(contact) {
  return [contact?.id, contact?.lid, contact?.phoneNumber].filter((id) => typeof id === 'string').map((id) => id.replace(/:\d+@/, '@'));
}

function outgoingPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw safeError('Пустая публикация WhatsApp.');
  const kinds = ['text', 'image', 'video', 'audio', 'document'].filter((key) => Object.hasOwn(payload, key));
  if (kinds.length !== 1) throw safeError('Публикация WhatsApp должна содержать текст или одно вложение.');
  const kind = kinds[0];
  if (kind === 'text') {
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 65536) throw safeError('Некорректный текст WhatsApp.');
    return { text: payload.text };
  }
  if (!Buffer.isBuffer(payload[kind]) || !payload[kind].length) throw safeError('Вложение WhatsApp должно содержать данные файла.');
  const content = { [kind]: payload[kind] };
  for (const [field, limit] of [['caption', 65536], ['mimetype', 128], ['fileName', 512]]) {
    if (payload[field] === undefined) continue;
    if (typeof payload[field] !== 'string' || payload[field].length > limit) throw safeError('Некорректное описание вложения WhatsApp.');
    content[field] = payload[field];
  }
  return content;
}

// This optional linked-device adapter is not the official WhatsApp Business API.
// Keep pairing explicit, never join groups automatically, and never retry a send
// whose outcome is unknown. The delivery queue owns publication consent/deduping.
export function createWhatsAppClient({
  directory,
  seal,
  unseal,
  loadDependencies = defaultDependencies,
  reconnectDelays = [1000, 3000, 10000, 30000],
  pairingTimeoutMs = 120000,
  connectTimeoutMs = 25000,
  reconnectResetMs = 60000,
  sendAckTimeoutMs = 25000,
  sendPrepareTimeoutMs = 120000,
  onDiagnostic = (event) => console.info('[WhatsApp]', JSON.stringify(event)),
} = {}) {
  if (typeof directory !== 'string' || !directory || typeof seal !== 'function' || typeof unseal !== 'function') throw new Error('WhatsApp requires a private auth directory and encryption functions.');
  const authDirectory = resolve(directory);
  const entries = new Map();
  let dependencies;
  // Never pass protocol nodes, QR data, credentials or account identifiers to
  // diagnostics. Pairing failures otherwise look like an ordinary QR timeout.
  const diagnostic = (event, code) => {
    try { onDiagnostic({ event, ...(Number.isSafeInteger(code) && code >= 0 ? { code } : {}) }); } catch { /* Diagnostics must not affect the connection. */ }
  };

  const entryFor = (userId) => {
    const key = userKey(userId);
    if (!entries.has(key)) entries.set(key, { key, file: join(authDirectory, `${key}.auth`), state: 'disconnected', wanted: false, generation: 0, attempts: 0, eventTail: Promise.resolve() });
    return entries.get(key);
  };
  const status = (userId, { includeQr = false } = {}) => {
    const entry = entries.get(userKey(userId));
    return { state: entry?.state || 'disconnected', ...(includeQr && entry?.qr ? { qr: entry.qr } : {}), ...(entry?.error ? { error: entry.error } : {}) };
  };
  const snapshot = (entry, includeQr = false) => ({ state: entry.state, ...(includeQr && entry.qr ? { qr: entry.qr } : {}), ...(entry.error ? { error: entry.error } : {}) });
  const clearTimers = (entry) => {
    for (const name of ['reconnectTimer', 'connectTimer', 'pairingTimer', 'stableTimer']) { clearTimeout(entry[name]); entry[name] = null; }
  };
  const timer = (handler, delay) => { const handle = setTimeout(handler, Math.max(1, delay)); handle.unref?.(); return handle; };
  const detach = async (entry) => {
    const socket = entry.socket;
    entry.socket = null;
    if (!socket) return;
    socket.ev.off('connection.update', entry.onConnection);
    socket.ev.off('creds.update', entry.onCredentials);
    socket.ws.off('CB:notification,type:companion_reg_refresh', entry.onPairingRefresh);
    socket.ws.off('CB:iq,,pair-success', entry.onPairingSuccess);
    socket.ws.off('CB:failure', entry.onLoginFailure);
    try { await socket.end(undefined); } catch { /* A closed transport has no further local work. */ }
  };
  const fail = async (entry, message) => {
    entry.wanted = false;
    entry.generation += 1;
    entry.state = 'error';
    entry.error = message;
    entry.qr = null;
    clearTimers(entry);
    await detach(entry);
  };
  const deps = async () => {
    dependencies ||= Promise.resolve().then(loadDependencies).then((loaded) => {
      // libsignal 6 logs SessionEntry directly, bypassing Baileys' logger. Its
      // legacy inspect() hook is ignored by modern Node; redact inspection only,
      // without changing cryptography or suppressing the application's console.
      if (loaded.libsignal?.SessionRecord?.createEntry) {
        const prototype = Object.getPrototypeOf(loaded.libsignal.SessionRecord.createEntry());
        Object.defineProperty(prototype, Symbol.for('nodejs.util.inspect.custom'), { configurable: true, value() { return '[WhatsApp session redacted]'; } });
      }
      return loaded;
    }).catch(() => { dependencies = null; throw safeError('Не удалось запустить модуль WhatsApp. Обратитесь к администратору.'); });
    return dependencies;
  };

  async function loadAuth(entry, baileys, existingOnly) {
    let saved;
    try {
      const encrypted = await readFile(entry.file, 'utf8');
      saved = JSON.parse(await unseal(encrypted), baileys.BufferJSON.reviver);
      if (saved?.version !== 1 || !saved.creds || !saved.keys || typeof saved.keys !== 'object' || Array.isArray(saved.keys)) throw new Error('Invalid auth');
    } catch (error) {
      if (error.code !== 'ENOENT') throw safeError('Не удалось прочитать защищённую сессию WhatsApp.');
      if (existingOnly) return null;
    }
    if (existingOnly && !saved?.creds?.registered && !saved?.creds?.me?.id) return null;
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await chmod(authDirectory, 0o700);
    const data = saved || { version: 1, creds: baileys.initAuthCreds(), keys: {} };
    let tail = Promise.resolve();
    let disabled = false;
    const persist = async () => {
      if (disabled) return;
      // Authentication records only: never persist messages, chat/contact lists,
      // decrypted history, QR codes, or library error objects.
      const json = JSON.stringify(data, baileys.BufferJSON.replacer);
      const operation = tail.catch(() => {}).then(async () => {
        if (disabled) return;
        const encrypted = await seal(json);
        if (typeof encrypted !== 'string' || !encrypted) throw new Error('Encryption failed');
        await writeFile(`${entry.file}.tmp`, encrypted, { mode: 0o600 });
        await chmod(`${entry.file}.tmp`, 0o600);
        await rename(`${entry.file}.tmp`, entry.file);
        await chmod(entry.file, 0o600);
      });
      tail = operation;
      try { await operation; } catch { throw safeError('Не удалось сохранить защищённую сессию WhatsApp.'); }
    };
    return {
      state: {
        creds: data.creds,
        keys: {
          get: async (type, ids) => {
            if (!AUTH_TYPES.has(type)) throw safeError('Неподдерживаемый тип ключей WhatsApp.');
            const values = {};
            for (const id of ids) {
              let value = Object.hasOwn(data.keys, type) && Object.hasOwn(data.keys[type], id) ? data.keys[type][id] : undefined;
              if (type === 'app-state-sync-key' && value) value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
              Object.defineProperty(values, id, { value, enumerable: true, configurable: true, writable: true });
            }
            return values;
          },
          set: async (updates) => {
            if (disabled) return;
            for (const [type, values] of Object.entries(updates)) {
              if (!AUTH_TYPES.has(type)) throw safeError('Неподдерживаемый тип ключей WhatsApp.');
              if (!Object.hasOwn(data.keys, type)) data.keys[type] = Object.create(null);
              for (const [id, value] of Object.entries(values)) {
                if (value == null) delete data.keys[type][id];
                else Object.defineProperty(data.keys[type], id, { value, enumerable: true, configurable: true, writable: true });
              }
            }
            await persist();
          },
        },
      },
      persist,
      async drain() { await tail; },
      async clear() {
        disabled = true;
        await tail.catch(() => {});
        for (const file of [entry.file, `${entry.file}.tmp`]) {
          try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw safeError('Не удалось удалить истёкшую сессию WhatsApp.'); }
        }
      },
    };
  }

  async function connect(entry, existingOnly = false) {
    const generation = ++entry.generation;
    const current = () => entry.wanted && entry.generation === generation;
    const { baileys, qrcode } = await deps();
    if (!current()) return;
    entry.auth ||= await loadAuth(entry, baileys, existingOnly);
    if (!current()) return;
    if (!entry.auth || (existingOnly && !entry.auth.state.creds.registered && !entry.auth.state.creds.me?.id)) { entry.wanted = false; entry.state = 'disconnected'; return; }
    entry.baileys = baileys;
    entry.state = 'connecting';
    entry.error = null;
    entry.qr = null;
    const socket = (baileys.makeWASocket || baileys.default)({
      auth: entry.auth.state,
      logger: silentLogger,
      browser: ['Multi Post', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      fireInitQueries: false,
      emitOwnEvents: false,
      enableRecentMessageCache: false,
      enableAutoSessionRecreation: false,
      maxMsgRetryCount: 0,
      getMessage: async () => undefined,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs,
      defaultQueryTimeoutMs: 30000,
      qrTimeout: 45000,
      transactionOpts: { maxCommitRetries: 1, delayBetweenTriesMs: 100 },
      // Own-device protocol messages carry auth-required app-state keys. Ignore
      // other direct chats, status broadcasts and incoming group conversations.
      shouldIgnoreJid: (jid) => !identityIds(entry.auth?.state.creds.me).includes(String(jid).replace(/:\d+@/, '@')) && jid !== 's.whatsapp.net',
    });
    entry.socket = socket;
    entry.onPairingRefresh = () => { if (current()) diagnostic('pairing_registration_refresh'); };
    entry.onPairingSuccess = () => { if (current()) diagnostic('pairing_success_received'); };
    entry.onLoginFailure = (node) => { if (current()) diagnostic('login_failure', Number(node?.attrs?.reason)); };
    socket.ws.on('CB:notification,type:companion_reg_refresh', entry.onPairingRefresh);
    socket.ws.on('CB:iq,,pair-success', entry.onPairingSuccess);
    socket.ws.on('CB:failure', entry.onLoginFailure);
    entry.onCredentials = (update) => {
      if (!current()) return;
      Object.assign(entry.auth.state.creds, update);
      entry.auth.persist().catch(() => { if (current()) return fail(entry, 'Не удалось сохранить защищённую сессию WhatsApp.'); }).catch(quiet);
    };
    entry.onConnection = (update) => {
      entry.eventTail = entry.eventTail.catch(quiet).then(async () => {
        if (!current()) return;
        if (update.qr) {
          if (!entry.explicit || Date.now() >= entry.pairingDeadline) {
            await fail(entry, 'Сессия WhatsApp истекла. Нажмите «Подключить WhatsApp», чтобы войти заново.');
            return;
          }
          clearTimeout(entry.connectTimer);
          const qr = await qrcode.toDataURL(update.qr, { type: 'image/png', width: 300, margin: 2, errorCorrectionLevel: 'M' });
          if (!current()) return;
          entry.qr = qr;
          entry.state = 'qr';
          diagnostic('pairing_qr_ready');
        }
        if (update.connection === 'open') {
          clearTimers(entry);
          entry.state = 'connected';
          entry.qr = null;
          entry.error = null;
          entry.explicit = false;
          diagnostic('connected');
          entry.stableTimer = timer(() => { if (current()) entry.attempts = 0; }, reconnectResetMs);
          await entry.auth.persist();
        } else if (update.connection === 'close') {
          clearTimers(entry);
          entry.qr = null;
          const code = Number(update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode || 0);
          diagnostic('connection_closed', code);
          await detach(entry);
          if (!current()) return;
          if (code === baileys.DisconnectReason.loggedOut) {
            entry.wanted = false;
            entry.state = 'logged_out';
            entry.error = 'WhatsApp отключил сессию. Подключите аккаунт заново.';
            const auth = entry.auth;
            entry.auth = null;
            await auth.clear();
            return;
          }
          const registered = entry.auth.state.creds.registered || entry.auth.state.creds.me?.id;
          const terminal = [baileys.DisconnectReason.connectionReplaced, baileys.DisconnectReason.badSession, baileys.DisconnectReason.multideviceMismatch, baileys.DisconnectReason.forbidden].includes(code);
          if (!registered || terminal || entry.attempts >= reconnectDelays.length) {
            await fail(entry, 'Соединение WhatsApp прервано. Нажмите «Подключить WhatsApp» для новой попытки.');
            return;
          }
          entry.state = 'reconnecting';
          const delay = reconnectDelays[entry.attempts++];
          entry.reconnectTimer = timer(() => {
            entry.reconnectTimer = null;
            if (current()) launch(entry, true).catch(quiet);
          }, delay);
        }
      }).catch(() => { if (current()) return fail(entry, 'Не удалось обработать состояние WhatsApp. Подключите аккаунт заново.'); }).catch(quiet);
    };
    socket.ev.on('creds.update', entry.onCredentials);
    socket.ev.on('connection.update', entry.onConnection);
    entry.connectTimer = timer(() => { if (current()) fail(entry, 'WhatsApp не ответил вовремя. Повторите подключение.').catch(quiet); }, connectTimeoutMs + 1000);
    if (entry.explicit) entry.pairingTimer = timer(() => { if (current()) fail(entry, 'Время входа в WhatsApp истекло. Нажмите «Подключить WhatsApp» для нового QR-кода.').catch(quiet); }, entry.pairingDeadline - Date.now());
  }

  async function launch(entry, existingOnly) {
    if (entry.startPromise) return entry.startPromise;
    entry.startPromise = connect(entry, existingOnly).catch((error) => { if (entry.wanted) return fail(entry, error.code === 'WHATSAPP_CLIENT_ERROR' ? error.message : 'Не удалось запустить подключение WhatsApp.'); }).finally(() => { entry.startPromise = null; });
    return entry.startPromise;
  }

  async function start(userId) {
    const entry = entryFor(userId);
    await entry.stopPromise;
    if (entry.wanted && (entry.socket || entry.reconnectTimer || entry.startPromise)) return snapshot(entry, true);
    await entry.eventTail;
    entry.explicit = true;
    entry.pairingDeadline = Date.now() + pairingTimeoutMs;
    entry.attempts = 0;
    entry.wanted = true;
    await launch(entry, false);
    return snapshot(entry, true);
  }

  async function stopEntry(entry) {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      entry.wanted = false;
      entry.generation += 1;
      entry.qr = null;
      entry.error = null;
      entry.state = 'disconnected';
      clearTimers(entry);
      await detach(entry);
      await entry.startPromise;
      await entry.eventTail;
      try { await entry.auth?.drain(); } catch { entry.error = 'Не удалось сохранить защищённую сессию WhatsApp.'; }
      return snapshot(entry);
    })().finally(() => { entry.stopPromise = null; });
    return entry.stopPromise;
  }

  async function stop(userId) { return stopEntry(entryFor(userId)); }

  function connected(userId) {
    const entry = entryFor(userId);
    if (entry.state !== 'connected' || !entry.socket) throw safeError('Сначала подключите аккаунт WhatsApp.', 'WHATSAPP_NOT_CONNECTED');
    return entry;
  }

  async function groupAccess(entry, groupId, inspect = false) {
    if (!GROUP_ID.test(groupId)) throw safeError('Некорректная группа WhatsApp.', 'WHATSAPP_GROUP_ACCESS');
    const socket = entry.socket;
    let metadata;
    try { metadata = await socket.groupMetadata(groupId); } catch { throw safeError('Не удалось проверить группу. Аккаунт WhatsApp должен уже состоять в ней.', 'WHATSAPP_GROUP_ACCESS'); }
    if (entry.state !== 'connected' || entry.socket !== socket || !entry.auth) throw safeError('Соединение WhatsApp изменилось. Повторите после подключения.', 'WHATSAPP_NOT_CONNECTED');
    const ids = new Set([...identityIds(entry.auth.state.creds.me), ...identityIds(socket.user)]);
    const participant = metadata?.participants?.find((item) => identityIds(item).some((id) => ids.has(id)));
    if (metadata?.id !== groupId || !participant) throw safeError('Сначала вступите в эту группу через приложение WhatsApp.', 'WHATSAPP_GROUP_ACCESS');
    if (metadata.announce && !['admin', 'superadmin'].includes(participant.admin) && !participant.isAdmin && !participant.isSuperAdmin) throw safeError('В этой группе публикуют только администраторы. Подключённому аккаунту нужны права администратора.', 'WHATSAPP_GROUP_ACCESS');
    return { id: groupId, name: String(metadata.subject || 'Группа WhatsApp').slice(0, 200), ...(inspect ? { isCommunity: !!metadata.isCommunity, isCommunityAnnounce: !!metadata.isCommunityAnnounce, linkedParent: metadata.linkedParent || null, announcementsOnly: !!metadata.announce } : {}) };
  }

  async function resolveGroup(userId, inviteLink) {
    const code = inviteCode(inviteLink);
    const entry = connected(userId);
    let info;
    try { info = await entry.socket.groupGetInviteInfo(code); } catch { throw safeError('Не удалось открыть приглашение WhatsApp. Проверьте, что ссылка действительна.', 'WHATSAPP_GROUP_ACCESS'); }
    return resolveDestination(userId, info?.id);
  }

  async function resolveDestination(userId, groupId) {
    const entry = connected(userId);
    const target = await groupAccess(entry, groupId, true);
    if (!target.isCommunity) return { id: target.id, name: target.name };
    let linked;
    try { linked = await entry.socket.communityFetchLinkedGroups(groupId); }
    catch { throw safeError('Не удалось найти группу объявлений сообщества WhatsApp.', 'WHATSAPP_GROUP_ACCESS'); }
    if (linked.communityJid !== groupId || !Array.isArray(linked.linkedGroups) || linked.linkedGroups.length > 100) throw safeError('Не удалось проверить группы сообщества WhatsApp.', 'WHATSAPP_GROUP_ACCESS');
    const announcements = [];
    for (const group of linked.linkedGroups) {
      if (!GROUP_ID.test(group.id || '') || group.id === groupId) continue;
      let candidate;
      try { candidate = await groupAccess(entry, group.id, true); } catch { continue; }
      if (candidate.isCommunityAnnounce && candidate.linkedParent === groupId) announcements.push(candidate);
    }
    if (announcements.length !== 1) throw safeError('Не найдена единственная доступная группа объявлений этого сообщества.', 'WHATSAPP_GROUP_ACCESS');
    return { id: announcements[0].id, name: `${target.name} · Объявления`.slice(0, 200) };
  }

  async function send(userId, groupId, payload, { messageId } = {}) {
    const content = outgoingPayload(payload);
    if (messageId !== undefined && (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId))) throw safeError('Некорректный идентификатор публикации WhatsApp.');
    const entry = connected(userId);
    const socket = entry.socket;
    const target = await groupAccess(entry, groupId, true);
    if (target.isCommunity) throw safeError('Выбран корень сообщества. Уточните группу объявлений перед отправкой.', 'WHATSAPP_GROUP_ACCESS');
    if (entry.state !== 'connected' || entry.socket !== socket) throw safeError('Соединение WhatsApp изменилось. Повторите после подключения.', 'WHATSAPP_NOT_CONNECTED');
    const id = messageId || `3EB0${randomBytes(18).toString('hex').toUpperCase()}`;
    let settled = false;
    let resolveReceipt;
    let rejectReceipt;
    let timeout;
    const receipt = new Promise((resolveReceiptPromise, rejectReceiptPromise) => { resolveReceipt = resolveReceiptPromise; rejectReceipt = rejectReceiptPromise; });
    const uncertain = () => safeError('WhatsApp не подтвердил отправку. Проверьте группу перед повтором.', 'WHATSAPP_SEND_UNCERTAIN');
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectReceipt(error); else resolveReceipt();
    };
    // Baileys rc14 returns a locally generated message after sendNode(), before
    // the server ACK. Successful group ACKs are not emitted as messages.update.
    // Observe only this outgoing stanza ID; no incoming content is retained.
    const onAck = (node) => {
      if (node?.tag !== 'ack' || node.attrs?.class !== 'message' || node.attrs.id !== id || node.attrs.from !== groupId) return;
      finish(node.attrs.error ? safeError('WhatsApp отклонил публикацию.', 'WHATSAPP_SEND_REJECTED') : null);
    };
    const onMessageUpdate = (updates) => {
      for (const update of updates || []) {
        if (update.key?.id !== id || update.key.remoteJid !== groupId || update.key.fromMe === false) continue;
        if (update.update?.status === 0) finish(safeError('WhatsApp отклонил публикацию.', 'WHATSAPP_SEND_REJECTED'));
        else if (Number(update.update?.status) >= 2) finish();
      }
    };
    const onDisconnect = () => finish(uncertain());
    const onConnection = (update) => { if (update.connection === 'close') onDisconnect(); };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.ws.off('CB:ack,class:message', onAck);
      socket.ws.off('close', onDisconnect);
      socket.ws.off('error', onDisconnect);
      socket.ev.off('messages.update', onMessageUpdate);
      socket.ev.off('connection.update', onConnection);
    };
    if (!socket.ws?.on || !socket.ws?.off) throw safeError('Модуль WhatsApp не поддерживает подтверждение отправки.', 'WHATSAPP_CLIENT_ERROR');
    socket.ws.on('CB:ack,class:message', onAck);
    socket.ws.on('close', onDisconnect);
    socket.ws.on('error', onDisconnect);
    socket.ev.on('messages.update', onMessageUpdate);
    socket.ev.on('connection.update', onConnection);
    timeout = setTimeout(onDisconnect, sendPrepareTimeoutMs);
    // A disconnect or timeout can occur after WhatsApp accepted the message.
    // Do not retry here or expose raw provider errors (they may contain secrets).
    try {
      const sending = Promise.resolve().then(() => socket.sendMessage(groupId, content, { messageId: id })).then((result) => {
        if (result?.key?.id !== id) throw uncertain();
        if (!settled) { clearTimeout(timeout); timeout = setTimeout(onDisconnect, sendAckTimeoutMs); }
        return result;
      });
      await Promise.all([sending, receipt]);
      return id;
    } catch (error) {
      if (error.code === 'WHATSAPP_SEND_REJECTED') throw error;
      throw uncertain();
    } finally {
      cleanup();
    }
  }

  async function resume(userIds = []) {
    const results = [];
    for (const userId of new Set(userIds)) {
      const entry = entryFor(userId);
      await entry.stopPromise;
      if (entry.wanted) { results.push({ userId, ...snapshot(entry) }); continue; }
      try { await stat(entry.file); } catch (error) {
        if (error.code !== 'ENOENT') { entry.state = 'error'; entry.error = 'Не удалось прочитать защищённую сессию WhatsApp.'; }
        results.push({ userId, ...snapshot(entry) });
        continue;
      }
      entry.explicit = false;
      entry.attempts = 0;
      entry.wanted = true;
      await launch(entry, true);
      results.push({ userId, ...snapshot(entry) });
    }
    return results;
  }

  async function closeAll() {
    // Use entries directly: filenames are hashes, never user identifiers.
    await Promise.all([...entries.values()].map(stopEntry));
  }

  return { start, status, stop, resolveGroup, resolveDestination, send, resume, closeAll, inspectGroup: (userId, groupId) => groupAccess(connected(userId), groupId, true) };
}
