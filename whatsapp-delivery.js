import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const TEXT_LIMIT = 16000;
const MAX_FILES = 50;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const errorText = (error) => String(error?.message || error).slice(0, 300);

function chunks(value) {
  const result = [];
  let rest = value;
  while (rest.length > TEXT_LIMIT) {
    let end = TEXT_LIMIT;
    // Never split a UTF-16 surrogate pair (including emoji).
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end -= 1;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) result.push(rest);
  return result;
}

function sourceDate(message) {
  const value = Number(message?.date);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function linkedUrls(value, result = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 30) return result;
  if (typeof value.url === 'string' && /^(https?:|tg:|mailto:|tel:)/i.test(value.url)) result.add(value.url);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') linkedUrls(child, result, depth + 1);
  }
  return result;
}

function richMediaCount(blocks, depth = 0) {
  if (depth > 16) throw new Error('WhatsApp: слишком глубокая структура Rich Message');
  const mediaTypes = ['photo', 'video', 'animation', 'audio', 'voice_note', 'document'];
  const textTypes = ['paragraph', 'heading', 'footer', 'pre', 'list', 'table', 'divider', 'mathematical_expression', 'details', 'expandable_blockquote', 'pullquote', 'blockquote', 'collage', 'slideshow', 'map', 'buttons'];
  let count = 0;
  for (const block of blocks || []) {
    if (!block || ![...mediaTypes, ...textTypes].includes(block.type)) throw new Error(`WhatsApp: неподдерживаемый блок Rich Message: ${block?.type || 'unknown'}`);
    if (mediaTypes.includes(block.type)) count += 1;
    if (block.blocks) count += richMediaCount(block.blocks, depth + 1);
    for (const item of block.items || []) if (item.blocks) count += richMediaCount(item.blocks, depth + 1);
  }
  return count;
}

function verifyContent(message, files) {
  const unsupported = ['poll', 'dice', 'location', 'venue', 'contact', 'game', 'invoice', 'story', 'paid_media'];
  const kind = unsupported.find((field) => message[field]);
  if (kind) throw new Error(`WhatsApp: тип публикации Telegram пока не поддержан: ${kind}`);
  if (message.sticker?.is_animated || message.sticker?.is_video) throw new Error('WhatsApp: анимированные и видеостикеры пока не поддержаны');
  const hasMedia = ['imported_media', 'photo', 'video', 'animation', 'video_note', 'sticker', 'audio', 'voice', 'document'].some((field) => message[field]);
  if (hasMedia && !files.length) throw new Error('WhatsApp: вложение Telegram недоступно');
  if (message.rich_message && richMediaCount(message.rich_message.blocks) > files.length) throw new Error('WhatsApp: одно или несколько вложений Rich Message недоступны');
  if (files.some((file) => !['image', 'video', 'audio', 'file'].includes(file.type))) throw new Error('WhatsApp: неподдерживаемый тип вложения');
}

/** WhatsApp delivery has its own durable ledger; it never touches MAX or balances. */
export function createWhatsAppDelivery({
  getStore, save, client, loadMedia, textOf, filesOf, normalizeMessages, primaryMessage,
  now = () => new Date().toISOString(), spacingMs = 1200, sleep = delay,
}) {
  const active = new Set();
  const accountQueues = new Map();
  const lastAttempt = new Map();
  let recoveryPromise;

  function entries() {
    const store = getStore();
    store.whatsappDeliveries ??= [];
    if (!Array.isArray(store.whatsappDeliveries)) throw new Error('WhatsApp: некорректный журнал доставки');
    return store.whatsappDeliveries;
  }

  // Call on startup. The same one-time promise is also used by send(), so a
  // second concurrent send cannot misclassify a running delivery as stale.
  function recover() {
    if (!recoveryPromise) {
      let changed = false;
      for (const entry of entries()) {
        if (entry.status !== 'processing') continue;
        entry.status = 'uncertain';
        entry.error = 'Сервис перезапущен во время отправки. Проверьте сообщения в группе; автоматический повтор отключён.';
        entry.updatedAt = now();
        changed = true;
      }
      recoveryPromise = changed ? Promise.resolve().then(() => save()) : Promise.resolve();
    }
    return recoveryPromise;
  }

  function enqueue(account, task) {
    const previous = accountQueues.get(account) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    accountQueues.set(account, current);
    void current.then(() => {
      if (accountQueues.get(account) === current) accountQueues.delete(account);
    }, () => {
      if (accountQueues.get(account) === current) accountQueues.delete(account);
    });
    return current;
  }

  async function prepare(connection, messages, entry) {
    if ((!entry.historical && !connection.whatsapp?.enabled) || connection.whatsapp?.groupId !== entry.groupId) throw new Error('WhatsApp: подключение группы выключено или изменилось');
    const status = await client.status(connection.userId);
    if (!['ready', 'connected'].includes(status?.state || status?.status || status)) throw new Error('WhatsApp: сначала подключите аккаунт');
    const files = [];
    const textParts = [];
    const links = new Set();
    for (const message of messages) {
      const messageFiles = filesOf(message) || [];
      verifyContent(message, messageFiles);
      files.push(...messageFiles);
      const text = String(textOf(message) || '').trim();
      if (text && !textParts.includes(text)) textParts.push(text);
      linkedUrls(message.entities, links);
      linkedUrls(message.caption_entities, links);
      linkedUrls(message.rich_message, links);
      linkedUrls(message.reply_markup, links);
    }
    if (files.length > MAX_FILES) throw new Error(`WhatsApp: не более ${MAX_FILES} вложений в одном посте`);
    let text = textParts.join('\n\n');
    const extraLinks = [...links].filter((url) => !text.includes(url));
    if (extraLinks.length) text = [text, extraLinks.join('\n')].filter(Boolean).join('\n\n');
    if (!text && !files.length) throw new Error('WhatsApp: в публикации нет поддерживаемого текста или вложений');
    if (entry.historical) {
      const date = entry.sourceDate ? ` · ${entry.sourceDate.slice(0, 16).replace('T', ' ')} UTC` : '';
      text = [text, [`Архив Telegram${date}`, entry.sourceUrl].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
    }
    entry.preview = text.slice(0, 220);
    const payloads = chunks(text).map((part) => ({ text: part }));
    if (payloads.length + files.length > 100) throw new Error('WhatsApp: публикация слишком большая');
    let bytes = 0;
    // Load the complete batch before sending anything. Missing media must never
    // turn an album into a silently incomplete publication.
    for (const file of files) {
      const media = await loadMedia(connection, file);
      if (!Buffer.isBuffer(media?.buffer) || !media.buffer.length) throw new Error('WhatsApp: получено пустое вложение');
      bytes += media.buffer.length;
      if (bytes > MAX_BATCH_BYTES) throw new Error('WhatsApp: общий размер вложений превышает 100 МБ');
      const kind = file.type === 'file' ? 'document' : file.type;
      payloads.push({
        [kind]: media.buffer,
        mimetype: media.mimetype || file.mime || 'application/octet-stream',
        fileName: media.fileName || file.name || 'telegram-file',
      });
    }
    entry.parts = payloads.map((payload, index) => {
      const type = ['text', 'image', 'video', 'audio', 'document'].find((key) => payload[key] !== undefined);
      return {
        index, type, status: 'prepared',
        messageId: `3EB0${hash(`${entry.key}:${index}`).slice(0, 28).toUpperCase()}`,
        ...(type === 'text' ? {} : { fileName: payload.fileName, bytes: payload[type].length }),
      };
    });
    entry.updatedAt = now();
    await save();
    return payloads;
  }

  async function deliver(connection, messages, entry, recovered) {
    try {
      await recovered;
      await save();
      const payloads = await prepare(connection, messages, entry);
      for (let index = 0; index < payloads.length; index += 1) {
        const account = String(connection.userId);
        const previous = lastAttempt.get(account);
        if (previous !== undefined && spacingMs > 0) await sleep(Math.max(0, spacingMs - (Date.now() - previous)));
        // Configuration can change while this post waits in the account queue.
        if ((!entry.historical && !connection.whatsapp?.enabled) || connection.whatsapp?.groupId !== entry.groupId) throw new Error('WhatsApp: подключение группы выключено или изменилось');
        const part = entry.parts[index];
        part.status = 'processing';
        part.attemptedAt = now();
        entry.status = 'processing';
        entry.networkStartedAt ||= part.attemptedAt;
        entry.updatedAt = part.attemptedAt;
        // Commit the attempt before invoking the network: crashes here require
        // inspection, never automatic replay, even with deterministic IDs.
        await save();
        lastAttempt.set(account, Date.now());
        const response = await client.send(connection.userId, entry.groupId, payloads[index], { messageId: part.messageId });
        const id = typeof response === 'string' ? response : response?.id || response?.key?.id;
        if (!id) throw new Error('WhatsApp: сервер не вернул идентификатор сообщения');
        part.id = String(id);
        part.status = 'sent';
        part.sentAt = now();
        entry.sentMessageIds.push(part.id);
        entry.updatedAt = part.sentAt;
        await save();
        payloads[index] = null;
      }
      entry.status = 'published';
      entry.deliveredAt = now();
      entry.error = null;
      entry.updatedAt = entry.deliveredAt;
      await save();
    } catch (error) {
      entry.status = entry.sentMessageIds.length ? 'partial' : entry.networkStartedAt ? 'uncertain' : 'failed';
      entry.error = errorText(error);
      entry.updatedAt = now();
      try { await save(); } catch (persistenceError) {
        entry.error = `${entry.error}; журнал не сохранён: ${errorText(persistenceError)}`.slice(0, 500);
      }
    }
    return { ...entry };
  }

  async function send(connection, value, { historical = false, retry = false } = {}) {
    const recovered = recover();
    const messages = normalizeMessages(value);
    const groupId = String(connection?.whatsapp?.groupId || '');
    if (!connection?.id || !connection?.userId || !/^\d+(?:-\d+)?@g\.us$/.test(groupId)) return { status: 'failed', error: 'WhatsApp: не выбрана корректная группа' };
    const ids = messages.map((message) => String(message.message_id ?? ''));
    if (!ids.length || ids.some((id) => !id)) return { status: 'failed', error: 'WhatsApp: нет идентификатора исходной публикации' };
    const mediaGroups = [...new Set(messages.map((message) => message.media_group_id).filter(Boolean).map(String))];
    if (mediaGroups.length > 1) return { status: 'failed', error: 'WhatsApp: в одной отправке обнаружены разные альбомы' };
    const identity = mediaGroups.length ? ['album', mediaGroups[0]] : ['messages', ...[...ids].sort()];
    const key = JSON.stringify([String(connection.id), groupId, identity]);
    // Public history imports use a synthetic album ID. Match original message
    // IDs too, so the same Telegram post cannot be resent via another path.
    let entry = entries().find((candidate) => candidate.key === key || (
      String(candidate.connectionId) === String(connection.id) && candidate.groupId === groupId
      && (candidate.telegramMessageIds || [candidate.telegramMessageId]).some((id) => ids.includes(String(id)))
    ));
    const safeRetry = entry && retry && ['failed', 'prepared'].includes(entry.status) && !entry.networkStartedAt && !(entry.sentMessageIds || []).length && !(entry.parts || []).some((part) => ['processing', 'sent'].includes(part.status));
    if (active.has(key) || (entry && (active.has(entry.key) || !safeRetry))) {
      await recovered;
      return { ...entry, duplicate: true };
    }
    // Reserve synchronously before any await, including disk IO and status calls.
    const reservationKey = entry?.key || key;
    active.add(reservationKey);
    if (!entry) {
      const first = primaryMessage(messages);
      const source = String(connection.source || '').replace(/^@/, '');
      entry = {
        id: `wa-${hash(key).slice(0, 24)}`, key,
        connectionId: connection.id, userId: connection.userId, source,
        groupId, groupName: connection.whatsapp.groupName || groupId,
        telegramMessageId: ids[0], telegramMessageIds: ids,
        telegramMediaGroupId: mediaGroups[0] || null,
        sourceDate: sourceDate(first),
        sourceUrl: /^[a-z0-9_]{5,64}$/i.test(source) && /^\d+$/.test(ids[0]) ? `https://t.me/${source}/${ids[0]}` : null,
        historical: Boolean(historical), createdAt: now(),
        parts: [], sentMessageIds: [], attempts: 0,
      };
      entries().push(entry);
    }
    entry.status = 'prepared';
    entry.historical ||= Boolean(historical);
    entry.error = null;
    entry.parts = [];
    entry.sentMessageIds ||= [];
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = now();
    try {
      return await enqueue(String(connection.userId), () => deliver(connection, messages, entry, recovered));
    } finally {
      active.delete(reservationKey);
    }
  }

  return { send, recover };
}
