import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { telegramBotUrl, telegramFileUrl, telegramRouting, trustedLocalTelegramPath, usesLocalTelegram } from './telegram-routing.js';

test('routes only configured Telegram sources through the local Bot API', () => {
  const routing = telegramRouting({
    TELEGRAM_LOCAL_API_URL: 'http://127.0.0.1:8081/',
    TELEGRAM_LOCAL_SOURCES: '@anytin_sadik, another_channel',
    TELEGRAM_LOCAL_FILE_ROOT: '/var/lib/telegram-bot-api',
  });
  const local = { source: 'anytin_sadik' };
  const cloud = { source: 'losvprode' };

  assert.equal(usesLocalTelegram(local, routing), true);
  assert.equal(usesLocalTelegram(cloud, routing), false);
  assert.equal(telegramBotUrl(local, 'token', 'getFile', routing), 'http://127.0.0.1:8081/bottoken/getFile');
  assert.equal(telegramBotUrl(cloud, 'token', 'getFile', routing), 'https://api.telegram.org/bottoken/getFile');
  assert.equal(telegramFileUrl(cloud, 'token', 'videos/file.mp4', routing), 'https://api.telegram.org/file/bottoken/videos/file.mp4');
});

test('accepts local Bot API files only inside its configured data directory', () => {
  const routing = telegramRouting({
    TELEGRAM_LOCAL_API_URL: 'http://127.0.0.1:8081',
    TELEGRAM_LOCAL_SOURCES: 'anytin_sadik',
    TELEGRAM_LOCAL_FILE_ROOT: '/var/lib/telegram-bot-api',
  });
  const connection = { source: 'anytin_sadik' };

  assert.equal(trustedLocalTelegramPath(connection, '/var/lib/telegram-bot-api/123/videos/file.mp4', routing), resolve('/var/lib/telegram-bot-api/123/videos/file.mp4'));
  assert.throws(() => trustedLocalTelegramPath(connection, '/etc/passwd', routing), /outside the configured data directory/);
  assert.equal(trustedLocalTelegramPath({ source: 'losvprode' }, '/var/lib/telegram-bot-api/file.mp4', routing), null);
});
