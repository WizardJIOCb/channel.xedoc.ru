import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppMediaLoader } from './whatsapp-media.js';

test('media loader rejects untrusted URLs and oversized bodies before delivery', async () => {
  let calls = 0;
  const loader = createWhatsAppMediaLoader({ fetchImpl: async () => { calls++; return new Response('x', { headers: { 'content-length': String(101 * 1024 * 1024) } }); } });
  await assert.rejects(loader({}, { url: 'https://internal.example/file' }), /Недопустимая/);
  assert.equal(calls, 0);
  await assert.rejects(loader({}, { url: 'https://cdn4.telesco.pe/file/test' }), /100 МБ/);
  assert.equal(calls, 1);
});

test('media loader redacts token-bearing API, filesystem and transport errors', async () => {
  const secret = 'fake-sensitive-bot-token';
  const loader = createWhatsAppMediaLoader({ telegramApi: async () => { throw new Error(`ENOENT /var/lib/telegram-bot-api/${secret}/file.mp4`); } });
  await assert.rejects(loader({}, { id: 'file-1' }), (error) => !error.message.includes(secret) && /Не удалось получить/.test(error.message));
  const publicLoader = createWhatsAppMediaLoader({ fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(publicLoader({}, { url: 'https://cdn4.telesco.pe/file/test' }), (error) => !error.message.includes(secret));
});

test('media loader returns trusted bytes without redirecting or exposing credentials', async () => {
  const loader = createWhatsAppMediaLoader({ fetchImpl: async (url, options) => { assert.equal(options.redirect, 'error'); return new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } }); } });
  const result = await loader({}, { url: 'https://cdn4.telesco.pe/file/test', name: 'photo.jpg' });
  assert.equal(result.buffer.toString(), 'image-bytes');
  assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(result.fileName, 'photo.jpg');
});
