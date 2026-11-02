import { fetchTelegramPublicPage } from './telegram-public.js';

export const SOURCE_LIMIT = 500;
export function createHistorySource({ getStore, save, snapshot, preview, fetchPage = fetchTelegramPublicPage, now = Date.now, ttl = 60000 }) {
  const jobs = new Map();
  const status = (connection) => getStore().telegramSourceSync?.[connection.id] || {};
  const importsFor = (connection) => (getStore().telegramImports || []).filter((row) => row.connectionId === connection.id);
  async function sync(connection, { force = false, older = false } = {}) {
    if (jobs.has(connection.id)) {
      await jobs.get(connection.id);
      return older ? sync(connection, { force, older }) : importsFor(connection);
    }
    const previous = status(connection);
    if (!older && previous.lastAttemptAt && now() - Date.parse(previous.lastAttemptAt) < (force ? 5000 : ttl)) return importsFor(connection);
    if (older && (!previous.nextBefore || importsFor(connection).length >= SOURCE_LIMIT)) return importsFor(connection);
    const before = older ? previous.nextBefore : null;
    const job = (async () => {
      const attemptedAt = new Date(now()).toISOString();
      try {
        const page = await fetchPage(connection.source, { before });
        const store = getStore(), loadedAt = new Date(now()).toISOString();
        const existing = importsFor(connection), byId = new Map(existing.map((row) => [String(row.messageId), row]));
        for (const post of page.posts) {
          const media = post.media || [];
          byId.set(String(post.messageId), { id: `${connection.id}:${post.messageId}`, connectionId: connection.id, source: connection.source, messageId: String(post.messageId), preview: preview(post.sourceMessages), text: post.text, mediaType: media.length > 1 ? `альбом (${media.length})` : media[0]?.type || null, mediaCount: media.length, publishedAt: post.publishedAt, loadedAt, sourceMessages: post.sourceMessages.map(snapshot) });
        }
        const merged = [...byId.values()].sort((a, b) => Number(b.messageId) - Number(a.messageId)).slice(0, SOURCE_LIMIT);
        store.telegramImports = [...(store.telegramImports || []).filter((row) => row.connectionId !== connection.id), ...merged];
        store.telegramSourceSync ||= {};
        // Refreshing the newest page must not reset an older-page cursor.
        const old = status(connection);
        const cursor = older || !old.initialized ? page.nextBefore : old.nextBefore;
        store.telegramSourceSync[connection.id] = { ...old, initialized: true, lastAttemptAt: attemptedAt, updatedAt: loadedAt, error: null, nextBefore: cursor, capped: merged.length >= SOURCE_LIMIT };
        await save(); return merged;
      } catch {
        const store = getStore(); store.telegramSourceSync ||= {};
        store.telegramSourceSync[connection.id] = { ...status(connection), lastAttemptAt: attemptedAt, error: 'Не удалось обновить публичную ленту Telegram. Сохранённые посты остаются доступны; повторите обновление позже.' };
        await save(); return importsFor(connection);
      }
    })();
    jobs.set(connection.id, job);
    try { return await job; } finally { if (jobs.get(connection.id) === job) jobs.delete(connection.id); }
  }
  async function syncAll(connections, options) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, connections.length) }, async () => {
      while (cursor < connections.length) await sync(connections[cursor++], options);
    }));
  }
  return { sync, syncAll, status };
}
