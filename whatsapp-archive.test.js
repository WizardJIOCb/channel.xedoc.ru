import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTelegramArchive } from './whatsapp-archive.js';

const SOURCE = 'losvprode';
const post = (id, { text = `Пост ${id}`, source = SOURCE, mediaIds = [] } = {}) => `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="${source}/${id}">
    ${text ? `<div class="tgme_widget_message_text js-message_text">${text}</div>` : ''}
    ${mediaIds.map((mediaId) => `<a class="js-message_photo" href="https://t.me/${source}/${mediaId}" style="background-image:url('https://cdn4.telesco.pe/file/${mediaId}.jpg')"></a>`).join('')}
    <time datetime="2026-09-01T10:00:00+00:00"></time>
  </div>
</div>`;
const feed = (...posts) => `<a href="https://t.me/${SOURCE}">Лось в проде</a><section class="tgme_channel_history js-message_history">${posts.join('')}</section>`;
const response = (html, init = {}) => new Response(html, { headers: { 'content-type': 'text/html' }, ...init });

function pages(...htmlPages) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.ok(htmlPages.length, `Unexpected archive request: ${url}`);
      const value = htmlPages.shift();
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : response(value);
    },
  };
}

test('walks the complete archive by raw IDs, orders posts, and reports unsupported posts', async () => {
  const fixture = pages(feed(post(30), post(28, { text: '' })), feed(post(12), post(2)), feed());
  const progress = [];
  const archive = await collectTelegramArchive('@LoSvPrOdE', { fetchImpl: fixture.fetchImpl, onProgress: async (report) => progress.push(report) });

  assert.equal(archive.source, SOURCE);
  assert.equal(archive.complete, true);
  assert.equal(archive.stopReason, 'exhausted');
  assert.equal(archive.pages, 3);
  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['2', '12', '30']);
  assert.deepEqual(archive.skippedIds, ['28']);
  assert.deepEqual(fixture.requests.map((request) => request.url), [
    'https://t.me/s/losvprode', 'https://t.me/s/losvprode?before=28', 'https://t.me/s/losvprode?before=2',
  ]);
  assert.ok(fixture.requests.every(({ options }) => options.redirect === 'error' && options.signal instanceof AbortSignal));
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).complete, true);
});

test('saved rich history takes priority, resolves skipped IDs, and excludes other sources', async () => {
  const rich = { message_id: 8, date: 1725700000, rich_message: { blocks: [{ type: 'paragraph', text: 'Полный сохранённый Rich Message' }] } };
  const history = [
    { source: SOURCE, telegramMessageId: '8', sourceMessages: [rich], updatedAt: '2026-09-23T10:00:00Z' },
    { source: SOURCE, telegramMessageId: '11', sourceMessage: { message_id: 11, text: 'Полная версия' } },
    { source: 'other_channel', telegramMessageId: '9', sourceMessage: { message_id: 9, text: 'Пост чужого канала' } },
  ];
  const fixture = pages(feed(post(11, { text: 'Обрезанная публичная версия' }), post(9, { text: '' }), post(8, { text: '' })), feed());
  const archive = await collectTelegramArchive(SOURCE, { history, fetchImpl: fixture.fetchImpl });

  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['8', '11']);
  assert.equal(archive.posts[0].preview, 'Полный сохранённый Rich Message');
  assert.equal(archive.posts[1].preview, 'Полная версия');
  assert.deepEqual(archive.posts[0].sourceMessages, [rich]);
  assert.deepEqual(archive.skippedIds, ['9']);
  archive.posts[0].sourceMessages[0].rich_message.blocks[0].text = 'Changed';
  assert.equal(rich.rich_message.blocks[0].text, 'Полный сохранённый Rich Message');
});

test('excludes structural Telegram service notices without treating them as unsupported posts', async () => {
  // Telegram /s/losvprode/930 uses these classes for its channel-photo notice.
  const service = post(930, { text: 'Channel photo updated' }).replace('class="tgme_widget_message"', 'class="tgme_widget_message text_not_supported_wrap service_message service_message_photo js-widget_message"');
  const emptyService = post(929, { text: '' }).replace('class="tgme_widget_message"', 'class="tgme_widget_message service_message js-widget_message"');
  const fixture = pages(feed(service, emptyService, post(928, { text: 'Channel photo updated' }), post(927, { text: '' })), feed());
  const history = [{ source: SOURCE, telegramMessageId: '930', sourceMessages: [{ message_id: 930, text: 'Previously imported service text' }] }];
  const archive = await collectTelegramArchive(SOURCE, { history, fetchImpl: fixture.fetchImpl });
  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['928']);
  assert.deepEqual(archive.serviceIds, ['929', '930']);
  assert.deepEqual(archive.skippedIds, ['927']);
  assert.equal(archive.complete, true);
  assert.equal(fixture.requests[1].url, 'https://t.me/s/losvprode?before=927');
});

test('does not resurrect saved-only posts absent from the public feed, but enriches observed album members', async () => {
  const history = [
    { source: SOURCE, telegramMessageId: '1', sourceMessages: [{ message_id: 1, text: 'Deleted original post retained in MAX history' }] },
    { source: SOURCE, telegramMessageId: '2', sourceMessages: [
      { message_id: 2, media_group_id: 'saved-album', caption: 'Observed album', photo: [{ file_id: 'photo2' }] },
      { message_id: 3, media_group_id: 'saved-album', photo: [{ file_id: 'photo3' }] },
    ] },
  ];
  const fixture = pages(feed(post(3, { text: '' }), post(4)), feed());
  const archive = await collectTelegramArchive(SOURCE, { history, fetchImpl: fixture.fetchImpl });
  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['2', '4']);
  assert.deepEqual(archive.storedOnlyIds, ['1']);
  assert.deepEqual(archive.skippedIds, []);
  assert.equal(archive.complete, true);

  const unavailable = await collectTelegramArchive(SOURCE, { history, fetchImpl: async () => response('') });
  assert.equal(unavailable.complete, false);
  assert.deepEqual(unavailable.posts, []);
  assert.deepEqual(unavailable.storedOnlyIds, ['1', '2']);
});

test('merges stored album snapshots and emits overlapping public wrappers only once', async () => {
  const older = { message_id: 100, media_group_id: 'album-a', caption: 'Старая подпись', photo: [{ file_id: 'photo100' }] };
  const newer = { ...older, caption: 'Исправленная подпись' };
  const second = { message_id: 101, media_group_id: 'album-a', photo: [{ file_id: 'photo101' }] };
  const history = [
    { source: SOURCE, sourceMessages: [newer], updatedAt: '2026-09-02T10:00:00Z' },
    { source: SOURCE, sourceMessages: [older], updatedAt: '2026-09-01T10:00:00Z' },
    { source: SOURCE, sourceMessages: [second], updatedAt: '2026-09-01T10:00:00Z' },
  ];
  const fixture = pages(feed(post(101, { text: '', mediaIds: [101] }), post(100, { text: 'Публичная подпись', mediaIds: [100, 101] })), feed());
  const archive = await collectTelegramArchive(SOURCE, { history, fetchImpl: fixture.fetchImpl });
  assert.equal(archive.posts.length, 1);
  assert.equal(archive.posts[0].messageId, '100');
  assert.deepEqual(archive.posts[0].sourceMessages.map((entry) => entry.message_id), [100, 101]);
  assert.equal(archive.posts[0].preview, 'Исправленная подпись');
  assert.deepEqual(archive.skippedIds, []);
});

test('deduplicates public album aliases, including the first photo ID hidden by its wrapper', async () => {
  const fixture = pages(feed(post(111, { mediaIds: [112, 113] }), post(112, { text: '', mediaIds: [112] })), feed(post(111, { mediaIds: [112, 113] }), post(110)), feed());
  const archive = await collectTelegramArchive(SOURCE, { fetchImpl: fixture.fetchImpl });
  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['110', '111']);
  assert.equal(archive.posts[1].sourceMessages.length, 2);
  assert.deepEqual(archive.skippedIds, []);
});

test('does not call an absent/private channel or an empty HTTP response a complete archive', async () => {
  for (const html of ['', '<div class="tgme_page">If you have Telegram, you can contact this user.</div>', feed().replaceAll(SOURCE, 'other_channel')]) {
    const archive = await collectTelegramArchive(SOURCE, { fetchImpl: async () => response(html) });
    assert.equal(archive.complete, false);
    assert.equal(archive.stopReason, 'source-unavailable');
    assert.equal(archive.posts.length, 0);
  }
});

test('retains partial results on transport failure without exposing transport details', async () => {
  const fixture = pages(feed(post(9)), new Error('proxy https://user:secret@example.test failed'));
  const archive = await collectTelegramArchive(SOURCE, { fetchImpl: fixture.fetchImpl });
  assert.equal(archive.complete, false);
  assert.equal(archive.stopReason, 'fetch-error');
  assert.equal(archive.pages, 1);
  assert.deepEqual(archive.posts.map((entry) => entry.messageId), ['9']);
  assert.doesNotMatch(JSON.stringify(archive), /secret|example\.test/);
});

test('stops repeated pagination and never treats a page cap as exhaustion', async () => {
  const repeated = pages(feed(post(9)), feed(post(9)));
  const stalled = await collectTelegramArchive(SOURCE, { fetchImpl: repeated.fetchImpl });
  assert.equal(stalled.stopReason, 'stalled-pagination');
  assert.equal(stalled.complete, false);
  assert.equal(stalled.posts.length, 1);

  const limited = await collectTelegramArchive(SOURCE, { maxPages: 1, fetchImpl: async () => response(feed(post(9))) });
  assert.equal(limited.stopReason, 'max-pages');
  assert.equal(limited.complete, false);
});

test('rejects large responses and unexpected content instead of returning a complete empty archive', async () => {
  for (const large of [
    new Response('', { headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    response('a'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const archive = await collectTelegramArchive(SOURCE, { fetchImpl: async () => large });
    assert.equal(archive.stopReason, 'page-too-large');
    assert.equal(archive.complete, false);
  }
  const invalid = await collectTelegramArchive(SOURCE, { fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(invalid.stopReason, 'invalid-response');
  assert.equal(invalid.complete, false);
});

test('validates the source and bounds before any request', async () => {
  const fetchImpl = async () => { assert.fail('Must not request invalid source/options'); };
  for (const source of ['', 'https://attacker.test/', 'losvprode/1', 'losvprode?before=1', 'bad']) {
    await assert.rejects(collectTelegramArchive(source, { fetchImpl }), /имя Telegram/);
  }
  for (const maxPages of [0, 1.5, 1001, Infinity]) {
    await assert.rejects(collectTelegramArchive(SOURCE, { fetchImpl, maxPages }), /Лимит страниц/);
  }
});
