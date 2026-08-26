import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramPublicPosts, publicPostMessages, safeTelegramMediaUrl } from './telegram-public.js';

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
