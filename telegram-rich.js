function richText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(richText).join('');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'custom_emoji') return String(value.alternative_text || '');
  if (value.type === 'mathematical_expression') return String(value.expression || '');
  if (value.type === 'button') return buttonText(value.button);
  return richText(value.text);
}

function buttonText(button) {
  if (!button || typeof button !== 'object') return '';
  const label = richText(button.text).trim();
  const url = typeof button.url === 'string' && /^(?:https?:|tg:)/i.test(button.url) ? button.url : '';
  if (label && url) return `${label}: ${url}`;
  return label || url;
}

function captionText(caption) {
  if (!caption || typeof caption !== 'object') return '';
  return [richText(caption.text), richText(caption.credit)].filter(Boolean).join(' — ');
}

function richBlocksText(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > 16) return '';
  return blocks.map((block) => richBlockText(block, depth + 1)).filter(Boolean).join('\n\n');
}

function richBlockText(block, depth) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'divider') return '—';
  if (block.type === 'mathematical_expression') return String(block.expression || '');
  if (block.type === 'list') {
    return (block.items || []).map((item, index) => {
      const label = item?.label || (item?.has_checkbox ? (item.is_checked ? '☑' : '☐') : `${index + 1}.`);
      const content = richBlocksText(item?.blocks, depth).replace(/\n+/g, '\n  ').trim();
      return content ? `${label} ${content}` : '';
    }).filter(Boolean).join('\n');
  }
  if (block.type === 'table') {
    const rows = (block.cells || []).map((row) => (row || []).map((cell) => richText(cell?.text).trim()).join(' | ')).filter(Boolean);
    return [richText(block.caption), ...rows].filter(Boolean).join('\n');
  }
  if (block.type === 'buttons') return (block.buttons || []).map(buttonText).filter(Boolean).join('\n');
  if (block.type === 'details') return [richText(block.summary), richBlocksText(block.blocks, depth)].filter(Boolean).join('\n');
  if (['expandable_blockquote', 'pullquote'].includes(block.type)) return [richText(block.text), richText(block.credit)].filter(Boolean).join('\n');
  if (['blockquote', 'collage', 'slideshow'].includes(block.type)) {
    return [richBlocksText(block.blocks, depth), captionText(block.caption), richText(block.credit)].filter(Boolean).join('\n');
  }
  if (block.type === 'map') {
    const location = block.location;
    const coordinates = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)
      ? `${location.latitude}, ${location.longitude}`
      : '';
    return [captionText(block.caption), coordinates].filter(Boolean).join('\n');
  }
  if (['animation', 'audio', 'document', 'photo', 'video', 'voice_note'].includes(block.type)) return captionText(block.caption);
  return richText(block.text);
}

function inlineKeyboardText(markup) {
  return (markup?.inline_keyboard || []).flat().map((button) => {
    if (!button || typeof button !== 'object') return '';
    const label = String(button.text || '').trim();
    const url = typeof button.url === 'string' && /^(?:https?:|tg:)/i.test(button.url) ? button.url : '';
    return label && url ? `${label}: ${url}` : url;
  }).filter(Boolean).join('\n');
}

export function telegramMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const body = message.caption || message.text || richBlocksText(message.rich_message?.blocks);
  const buttons = inlineKeyboardText(message.reply_markup);
  const missingButtons = buttons.split('\n').filter((line) => line && !String(body || '').includes(line)).join('\n');
  return [body, missingButtons].filter(Boolean).join('\n\n');
}

function richBlockFiles(block, depth = 0) {
  if (!block || typeof block !== 'object' || depth > 16) return [];
  if (['collage', 'slideshow', 'blockquote', 'details'].includes(block.type)) return (block.blocks || []).flatMap((item) => richBlockFiles(item, depth + 1));
  if (block.type === 'list') return (block.items || []).flatMap((item) => (item?.blocks || []).flatMap((nested) => richBlockFiles(nested, depth + 1)));
  if (block.type === 'photo' && block.photo?.length) return [{ type: 'image', id: block.photo.at(-1).file_id, name: 'telegram-rich-photo.jpg', mime: 'image/jpeg' }];
  if (block.type === 'video' && block.video?.file_id) return [{ type: 'video', id: block.video.file_id, name: block.video.file_name || 'telegram-rich-video.mp4', mime: block.video.mime_type || 'video/mp4' }];
  if (block.type === 'animation' && block.animation?.file_id) return [{ type: 'video', id: block.animation.file_id, name: block.animation.file_name || 'telegram-rich-animation.mp4', mime: block.animation.mime_type || 'video/mp4' }];
  if (block.type === 'audio' && block.audio?.file_id) return [{ type: 'audio', id: block.audio.file_id, name: block.audio.file_name || 'telegram-rich-audio.mp3', mime: block.audio.mime_type || 'audio/mpeg' }];
  if (block.type === 'voice_note' && block.voice_note?.file_id) return [{ type: 'audio', id: block.voice_note.file_id, name: 'telegram-rich-voice.ogg', mime: block.voice_note.mime_type || 'audio/ogg' }];
  if (block.type === 'document' && block.document?.file_id) return [{ type: 'file', id: block.document.file_id, name: block.document.file_name || 'telegram-rich-file', mime: block.document.mime_type || 'application/octet-stream' }];
  return [];
}

export function richMessageFiles(message) {
  return (message?.rich_message?.blocks || []).flatMap((block) => richBlockFiles(block));
}

export { richBlocksText, richText };
