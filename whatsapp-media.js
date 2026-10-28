import { readFile, stat } from 'node:fs/promises';
import { safeTelegramMediaUrl } from './telegram-public.js';
import { telegramFileUrl, trustedLocalTelegramPath } from './telegram-routing.js';

const LIMIT = 100 * 1024 * 1024;
const mediaError = (message) => Object.assign(new Error(message), { code: 'WHATSAPP_MEDIA' });
export function createWhatsAppMediaLoader({ telegramApi, unseal, telegramRoute, fetchImpl = fetch }) {
  return async function loadMedia(connection, file) {
    try {
    let response;
    let buffer;
    if (file.url) {
      const url = safeTelegramMediaUrl(file.url);
      if (!url) throw mediaError('Недопустимая ссылка на вложение Telegram');
      response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    } else {
      const info = await telegramApi(connection, 'getFile', { file_id: file.id });
      if (!info?.file_path) throw mediaError('Telegram не вернул вложение');
      const localPath = trustedLocalTelegramPath(connection, info.file_path, telegramRoute);
      if (localPath) {
        if ((await stat(localPath)).size > LIMIT) throw mediaError('Вложение превышает 100 МБ');
        buffer = await readFile(localPath);
      } else {
        response = await fetchImpl(telegramFileUrl(connection, unseal(connection.telegramToken), info.file_path, telegramRoute), { signal: AbortSignal.timeout(60000), redirect: 'error' });
      }
    }
    if (response) {
      if (!response.ok) throw mediaError(`Telegram не отдал вложение (${response.status})`);
      if (Number(response.headers.get('content-length') || 0) > LIMIT) { await response.body?.cancel(); throw mediaError('Вложение превышает 100 МБ'); }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > LIMIT) { await reader.cancel(); throw mediaError('Вложение превышает 100 МБ'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      buffer = Buffer.concat(chunks);
    }
    if (!buffer?.length || buffer.length > LIMIT) throw mediaError('Вложение пустое или превышает 100 МБ');
    return { buffer, mimetype: file.mime || response?.headers.get('content-type') || 'application/octet-stream', fileName: file.name || 'telegram-file' };
    } catch (error) {
      if (error.code === 'WHATSAPP_MEDIA') throw error;
      throw mediaError('Не удалось получить вложение Telegram. Проверьте наличие файла и подключение.');
    }
  };
}
