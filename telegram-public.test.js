import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTelegramPublicPage, fetchTelegramPublicPosts, parseTelegramPublicPosts, publicPostMessages, safeTelegramMediaUrl } from './telegram-public.js';

const fixture = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="anytin_sadik/551">
    <div class="tgme_widget_message_text js-message_text" dir="auto">
      Первый <b>день</b><br>Смотреть <a href="https://example.test/post">фото</a> &amp; видео
    </div>
    <a class="tgme_widget_message_photo_wrap js-message_photo" href="https://t.me/anytin_sadik/552" style="background-image:url('https://cdn4.telesco.pe/file/photo-one.jpg')"></a>
    <video class="tgme_widget_message_video js-message_video" src="https://cdn4.telesco.pe/file/video-one.mp4"></video>
    <time datetime="2026-08-25T08:15:00+00:00"></time>
  </div>
</div>`;

test('parses a public Telegram post into one MAX-ready album payload', () => {
  const posts = parseTelegramPublicPosts(fixture, '@anytin_sadik');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].messageId, '551');
  assert.equal(posts[0].text, 'Первый день\nСмотреть фото (https://example.test/post) & видео');
  assert.equal(posts[0].publishedAt, '2026-08-25T08:15:00+00:00');
  assert.deepEqual(posts[0].media.map((item) => item.type), ['image', 'video']);
  assert.equal(posts[0].sourceMessages.length, 2);
  assert.equal(posts[0].sourceMessages[0].message_id, 551);
  assert.equal(posts[0].sourceMessages[0].caption, posts[0].text);
  assert.equal(posts[0].sourceMessages[1].message_id, '551-2');
  assert.equal(posts[0].sourceMessages[0].media_group_id, 'public:anytin_sadik:551');
});

test('keeps the wrapper post id as the primary history id', () => {
  const messages = publicPostMessages({
    source: 'anytin_sadik',
    messageId: '539',
    text: 'Подпись',
    media: [{ type: 'image', messageId: '540', url: 'https://cdn4.telesco.pe/file/photo.jpg', name: 'photo.jpg', mime: 'image/jpeg' }],
  });
  assert.equal(messages[0].message_id, 539);
});

test('accepts only Telegram public-preview media hosts', () => {
  assert.equal(safeTelegramMediaUrl('https://cdn4.telesco.pe/file/photo.jpg'), 'https://cdn4.telesco.pe/file/photo.jpg');
  assert.equal(safeTelegramMediaUrl('http://cdn4.telesco.pe/file/photo.jpg'), null);
  assert.equal(safeTelegramMediaUrl('https://telesco.pe.attacker.test/file/photo.jpg'), null);
  assert.equal(safeTelegramMediaUrl('https://example.test/file/photo.jpg'), null);
});

test('refreshes an individual source post through the parseable public channel page', async () => {
  const posts = await fetchTelegramPublicPosts('anytin_sadik', '551', async (url) => {
    assert.equal(url, 'https://t.me/s/anytin_sadik/551');
    return new Response(fixture);
  });
  const post = posts.find((item) => item.messageId === '551');
  assert.equal(post.sourceMessages.length, 2);
  assert.equal(post.text, 'Первый день\nСмотреть фото (https://example.test/post) & видео');
});

test('paginates only the same public source and rejects looping or external next pages', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return new Response(fixture + '<a class="js-messages_more" href="/s/anytin_sadik?before=551"></a><a class="js-messages_more" href="https://evil.test/s/anytin_sadik?before=1"></a>'); };
  const page = await fetchTelegramPublicPage('anytin_sadik', { fetchImpl });
  assert.equal(page.nextBefore, '551'); assert.equal(page.posts.length, 1);
  const older = await fetchTelegramPublicPage('anytin_sadik', { before: '551', fetchImpl });
  assert.equal(urls[1], 'https://t.me/s/anytin_sadik?before=551');
  assert.equal(older.nextBefore, null);
  await assert.rejects(fetchTelegramPublicPage('anytin_sadik', { before: 'bad', fetchImpl }));
});
