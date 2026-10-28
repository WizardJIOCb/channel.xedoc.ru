import { normalizeMessages } from './media-groups.js';
import { parseTelegramPublicPosts, safeTelegramMediaUrl } from './telegram-public.js';
import { richMessageFiles, telegramMessageText } from './telegram-rich.js';

const PAGE_LIMIT = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 12000;

function channelName(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

function messageId(value) {
  const id = String(value ?? '');
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

function orderedIds(ids) {
  return [...ids].sort((left, right) => Number(left) - Number(right));
}

function publishedAt(messages, fallback = null) {
  const dates = messages.map((message) => Number(message.date)).filter((date) => date > 0 && Number.isFinite(date));
  const date = dates.length ? new Date(Math.min(...dates) * 1000) : new Date(fallback || NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasContent(message) {
  if (telegramMessageText(message).trim()) return true;
  if (message.imported_media) return Boolean(safeTelegramMediaUrl(message.imported_media.url));
  if (message.photo?.some((photo) => photo.file_id)) return true;
  if (['video', 'animation', 'video_note', 'audio', 'voice', 'document'].some((type) => message[type]?.file_id)) return true;
  if (message.sticker?.file_id && !message.sticker.is_animated && !message.sticker.is_video) return true;
  return richMessageFiles(message).length > 0;
}

function archiveIndex() {
  const records = new Set();
  const byId = new Map();
  const byGroup = new Map();

  function add(post, stored = false, extraIds = []) {
    const messages = normalizeMessages(post.sourceMessages).filter((message) => message && typeof message === 'object');
    if (!messages.some(hasContent)) return;
    const primary = messageId(post.messageId) || messages.map((message) => messageId(message.message_id)).find(Boolean);
    if (!primary) return;
    const ids = new Set([primary, ...extraIds, ...messages.map((message) => message.message_id)].map(messageId).filter(Boolean));
    const groups = new Set(messages.map((message) => message.media_group_id).filter(Boolean).map(String));
    if (post.mediaGroupId) groups.add(String(post.mediaGroupId));
    const overlaps = new Set([...ids].map((id) => byId.get(id)).concat([...groups].map((group) => byGroup.get(group))).filter(Boolean));
    let selected = { messageId: primary, sourceMessages: messages, publishedAt: publishedAt(messages, post.publishedAt), stored, ids, groups };

    for (const previous of overlaps) {
      records.delete(previous);
      for (const id of previous.ids) ids.add(id);
      for (const group of previous.groups) groups.add(group);
      if (previous.stored && selected.stored) {
        // History is ingested oldest first, so the latest snapshot wins per message.
        selected.sourceMessages = normalizeMessages([...previous.sourceMessages, ...selected.sourceMessages]);
        selected.publishedAt = publishedAt(selected.sourceMessages, selected.publishedAt || previous.publishedAt);
      } else if (previous.stored || (!selected.stored && previous.sourceMessages.length >= selected.sourceMessages.length)) {
        selected = { ...previous, ids, groups };
      }
      selected.messageId = orderedIds([selected.messageId, previous.messageId, primary])[0];
    }

    selected.ids = ids;
    selected.groups = groups;
    records.add(selected);
    for (const id of ids) byId.set(id, selected);
    for (const group of groups) byGroup.set(group, selected);
  }

  return {
    add,
    has: (id) => byId.has(id),
    // A saved snapshot enriches a post still visible in the channel; it must
    // never resurrect a deleted post merely because MAX retains its history.
    storedOnlyIds: (observed) => orderedIds([...records].filter((post) => post.stored && ![...post.ids].some((id) => observed.has(id))).map((post) => post.messageId)),
    posts: (observed) => [...records].filter((post) => [...post.ids].some((id) => observed.has(id))).sort((left, right) => Number(left.messageId) - Number(right.messageId)).map((post) => ({
      messageId: post.messageId,
      publishedAt: post.publishedAt,
      sourceMessages: post.sourceMessages,
      preview: (post.sourceMessages.map(telegramMessageText).filter(Boolean).join('\n\n').replace(/\s+/g, ' ').trim() || 'Вложение без подписи').slice(0, 320),
    })),
  };
}

function archiveError(reason, message) {
  return Object.assign(new Error(message), { reason });
}

async function fetchPage(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; MultiPost/1.0)' },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    // A source name can only address t.me; do not follow redirects to other hosts.
    redirect: 'error',
  });
  if (!response.ok) throw archiveError('fetch-error', `Telegram не открыл публичную ленту (${response.status})`);
  if (response.url && new URL(response.url).href !== new URL(url).href) throw archiveError('invalid-response', 'Telegram вернул другую страницу вместо публичной ленты');
  const contentType = response.headers.get('content-type');
  if (contentType && !/^text\/html\b/i.test(contentType)) throw archiveError('invalid-response', 'Telegram вернул ответ, который не является HTML-лентой');
  if (Number(response.headers.get('content-length') || 0) > PAGE_LIMIT) throw archiveError('page-too-large', 'Страница Telegram слишком большая');

  if (!response.body?.getReader) {
    const html = await response.text();
    if (Buffer.byteLength(html) > PAGE_LIMIT) throw archiveError('page-too-large', 'Страница Telegram слишком большая');
    return html;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PAGE_LIMIT) {
        await reader.cancel();
        throw archiveError('page-too-large', 'Страница Telegram слишком большая');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function rawPostIds(html, source) {
  const ids = new Set();
  for (const match of html.matchAll(/\bdata-post\s*=\s*["']([^/"']+)\/(\d+)["']/gi)) {
    if (channelName(match[1]) === source && messageId(match[2])) ids.add(match[2]);
  }
  return orderedIds(ids);
}

function servicePostIds(html, source) {
  const ids = new Set();
  for (const match of html.matchAll(/<div\b[^>]*\bdata-post\s*=\s*["']([^/"']+)\/(\d+)["'][^>]*>/gi)) {
    const classes = match[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    if (channelName(match[1]) === source && messageId(match[2]) && classes.split(/\s+/).includes('service_message')) ids.add(match[2]);
  }
  return ids;
}

function isChannelFeed(html, source) {
  // Empty responses, login pages, and missing/private channels are not exhaustion.
  return /\bclass=["'][^"']*\btgme_channel_history\b/i.test(html)
    && new RegExp(`https://t\\.me/(?:s/)?${source}(?:[/?#"'])`, 'i').test(html);
}

/** Read all reachable public pages. complete refers to scanning; skippedIds must
 * also be empty before an application claims that every post can be migrated.
 * onProgress receives the same report shape as the final return value.
 */
export async function collectTelegramArchive(source, { history = [], fetchImpl = fetch, maxPages = 100, onProgress = async () => {} } = {}) {
  const channel = channelName(source);
  if (!/^[a-z0-9_]{5,64}$/.test(channel)) throw new Error('Некорректное имя Telegram-канала');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('Лимит страниц должен быть целым числом от 1 до 1000');
  if (!Array.isArray(history)) throw new Error('История Telegram должна быть массивом');

  const index = archiveIndex();
  const seenIds = new Set();
  const serviceIds = new Set();
  let pages = 0;
  let before = null;
  let complete = false;
  let stopReason = 'max-pages';
  let error = null;
  const report = () => ({ source: channel, posts: index.posts(seenIds).filter((post) => !serviceIds.has(post.messageId)), pages, skippedIds: orderedIds([...seenIds].filter((id) => !serviceIds.has(id) && !index.has(id))), serviceIds: orderedIds(serviceIds), storedOnlyIds: index.storedOnlyIds(seenIds), complete, stopReason, ...(error ? { error } : {}) });

  const saved = history.filter((entry) => channelName(entry?.source) === channel)
    .sort((left, right) => (Date.parse(left.updatedAt || left.createdAt) || 0) - (Date.parse(right.updatedAt || right.createdAt) || 0));
  for (const entry of saved) {
    const messages = entry.sourceMessages?.length ? entry.sourceMessages : entry.sourceMessage ? [entry.sourceMessage] : [];
    index.add({
      messageId: entry.telegramMessageId || entry.messageId,
      sourceMessages: structuredClone(messages),
      mediaGroupId: entry.telegramMediaGroupId,
      publishedAt: entry.publishedAt,
    }, true, entry.telegramMessageIds || []);
  }

  for (let page = 0; page < maxPages; page += 1) {
    let html;
    try {
      html = await fetchPage(`https://t.me/s/${channel}${before ? `?before=${before}` : ''}`, fetchImpl);
    } catch (failure) {
      stopReason = failure.reason || 'fetch-error';
      // Deliberately avoid returning transport errors, which may include proxy credentials.
      error = failure.reason ? failure.message : 'Не удалось прочитать страницу Telegram; сохранена доступная часть архива';
      break;
    }
    pages += 1;
    const ids = rawPostIds(html, channel);
    for (const id of ids) seenIds.add(id);
    for (const id of servicePostIds(html, channel)) serviceIds.add(id);
    for (const post of parseTelegramPublicPosts(html, channel)) {
      if (!serviceIds.has(post.messageId)) index.add(post, false, post.media.map((media) => media.messageId));
    }

    if (!ids.length) {
      complete = isChannelFeed(html, channel);
      stopReason = complete ? 'exhausted' : 'source-unavailable';
    } else if (before && Number(ids[0]) >= Number(before)) {
      stopReason = 'stalled-pagination';
    } else {
      before = ids[0];
      stopReason = page + 1 === maxPages ? 'max-pages' : null;
    }
    await onProgress(report());
    if (!ids.length || stopReason === 'stalled-pagination') break;
  }
  return report();
}
