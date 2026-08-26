import test from 'node:test';
import assert from 'node:assert/strict';
import { richMessageFiles, splitHtml, telegramMessageHtml, telegramMessageText } from './telegram-rich.js';

test('converts Telegram rich messages, lists, and buttons to readable MAX text', () => {
  const message = {
    rich_message: {
      blocks: [
        { type: 'paragraph', text: ['Вступление ', { type: 'bold', text: 'жирным' }] },
        { type: 'list', items: [
          { label: '•', blocks: [{ type: 'paragraph', text: 'Первый пункт' }] },
          { label: '•', blocks: [{ type: 'paragraph', text: ['Второй ', { type: 'code', text: 'пункт' }] }] },
        ] },
        { type: 'buttons', buttons: [{ text: 'Отчёт', url: 'https://example.test/report' }] },
      ],
    },
  };

  assert.equal(telegramMessageText(message), 'Вступление жирным\n\n• Первый пункт\n• Второй пункт\n\nОтчёт: https://example.test/report');
  assert.equal(telegramMessageHtml(message), 'Вступление <b>жирным</b>\n\n• Первый пункт\n• Второй <code>пункт</code>\n\n<a href="https://example.test/report">Отчёт</a>');
});

test('maps supported Telegram rich formatting to safe MAX HTML', () => {
  const message = {
    rich_message: {
      blocks: [
        { type: 'heading', size: 2, text: ['Заголовок ', { type: 'italic', text: 'курсивом' }] },
        { type: 'paragraph', text: [
          '<начало> ',
          { type: 'underline', text: { type: 'bold', text: 'важно' } },
          ' ',
          { type: 'url', text: 'источник', url: 'https://example.test/?a=1&b=2' },
        ] },
        { type: 'blockquote', blocks: [{ type: 'paragraph', text: { type: 'strikethrough', text: 'цитата' } }] },
      ],
    },
  };

  assert.equal(
    telegramMessageHtml(message),
    '<h2>Заголовок <i>курсивом</i></h2>\n\n&lt;начало&gt; <u><b>важно</b></u> <a href="https://example.test/?a=1&amp;b=2">источник</a>\n\n<blockquote><s>цитата</s></blockquote>',
  );
});

test('splits long MAX HTML without breaking formatting tags or entities', () => {
  const content = `${'форматированный текст '.repeat(260)}&amp; финал`;
  const chunks = splitHtml(`<b>${content}</b>`);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.ok(chunks.every((chunk) => chunk.startsWith('<b>') && chunk.endsWith('</b>')));
  assert.equal(chunks.map((chunk) => chunk.slice(3, -4)).join(''), content);
});

test('extracts Telegram media nested inside rich message blocks', () => {
  const message = {
    rich_message: {
      blocks: [{
        type: 'collage',
        blocks: [
          { type: 'photo', photo: [{ file_id: 'small' }, { file_id: 'large' }] },
          { type: 'video', video: { file_id: 'video-1', file_name: 'clip.mp4', mime_type: 'video/mp4' } },
        ],
      }],
    },
  };

  assert.deepEqual(richMessageFiles(message), [
    { type: 'image', id: 'large', name: 'telegram-rich-photo.jpg', mime: 'image/jpeg' },
    { type: 'video', id: 'video-1', name: 'clip.mp4', mime: 'video/mp4' },
  ]);
});
