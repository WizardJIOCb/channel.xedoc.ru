import { isAbsolute, relative, resolve } from 'node:path';

const CLOUD_TELEGRAM_API = 'https://api.telegram.org';

export function telegramRouting(environment = process.env) {
  const baseUrl = String(environment.TELEGRAM_LOCAL_API_URL || '').trim().replace(/\/$/, '');
  const sources = new Set(String(environment.TELEGRAM_LOCAL_SOURCES || '')
    .split(',')
    .map((source) => source.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean));
  const fileRoot = resolve(String(environment.TELEGRAM_LOCAL_FILE_ROOT || '/var/lib/telegram-bot-api'));
  return { baseUrl, sources, fileRoot };
}

export function usesLocalTelegram(connection, routing) {
  const source = String(connection?.source || '').replace(/^@/, '').toLowerCase();
  return Boolean(routing.baseUrl && (routing.sources.has('*') || routing.sources.has(source)));
}

export function telegramBotUrl(connection, token, method, routing) {
  const root = usesLocalTelegram(connection, routing) ? routing.baseUrl : CLOUD_TELEGRAM_API;
  return `${root}/bot${token}/${method}`;
}

export function telegramFileUrl(connection, token, filePath, routing) {
  const root = usesLocalTelegram(connection, routing) ? routing.baseUrl : CLOUD_TELEGRAM_API;
  return `${root}/file/bot${token}/${filePath}`;
}

export function trustedLocalTelegramPath(connection, filePath, routing) {
  if (!usesLocalTelegram(connection, routing) || !isAbsolute(filePath)) return null;
  const candidate = resolve(filePath);
  const nested = relative(routing.fileRoot, candidate);
  if (nested === '..' || nested.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(nested)) {
    throw new Error('Telegram local file path is outside the configured data directory');
  }
  return candidate;
}
