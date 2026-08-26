import test from 'node:test';
import assert from 'node:assert/strict';
import { richMessageFiles, telegramMessageText } from './telegram-rich.js';

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
