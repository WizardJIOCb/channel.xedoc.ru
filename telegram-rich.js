const htmlEscape = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function safeHref(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:', 'tg:', 'mailto:', 'tel:'].includes(url.protocol) ? String(value) : null;
  } catch {
    return null;
  }
}

function richText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(richText).join('');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'custom_emoji') return String(value.alternative_text || '');
  if (value.type === 'mathematical_expression') return String(value.expression || '');
  if (value.type === 'button') return buttonText(value.button);
  return richText(value.text);
}

function richTextHtml(value) {
  if (typeof value === 'string') return htmlEscape(value);
  if (Array.isArray(value)) return value.map(richTextHtml).join('');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'custom_emoji') return htmlEscape(value.alternative_text || '');
  if (value.type === 'mathematical_expression') return htmlEscape(value.expression || '');
  if (value.type === 'button') return buttonHtml(value.button);

  const content = richTextHtml(value.text);
  const wrappers = {
    bold: ['<b>', '</b>'],
    italic: ['<i>', '</i>'],
    underline: ['<u>', '</u>'],
    strikethrough: ['<s>', '</s>'],
    spoiler: ['<mark>', '</mark>'],
    marked: ['<mark>', '</mark>'],
    code: ['<code>', '</code>'],
  };
  if (wrappers[value.type] && content) return `${wrappers[value.type][0]}${content}${wrappers[value.type][1]}`;

  let href = null;
  if (value.type === 'url') href = safeHref(value.url);
  if (value.type === 'email_address') href = safeHref(`mailto:${value.email_address || ''}`);
  if (value.type === 'phone_number') href = safeHref(`tel:${value.phone_number || ''}`);
  return href && content ? `<a href="${htmlEscape(href)}">${content}</a>` : content;
}

function buttonText(button) {
  if (!button || typeof button !== 'object') return '';
  const label = richText(button.text).trim();
  const url = typeof button.url === 'string' && /^(?:https?:|tg:)/i.test(button.url) ? button.url : '';
  if (label && url) return `${label}: ${url}`;
  return label || url;
}

function buttonHtml(button) {
  if (!button || typeof button !== 'object') return '';
  const label = richTextHtml(button.text).trim();
  const url = safeHref(button.url);
  if (label && url) return `<a href="${htmlEscape(url)}">${label}</a>`;
  if (url) return `<a href="${htmlEscape(url)}">${htmlEscape(url)}</a>`;
  return label;
}

function captionText(caption) {
  if (!caption || typeof caption !== 'object') return '';
  return [richText(caption.text), richText(caption.credit)].filter(Boolean).join(' — ');
}

function captionHtml(caption) {
  if (!caption || typeof caption !== 'object') return '';
  return [richTextHtml(caption.text), richTextHtml(caption.credit)].filter(Boolean).join(' — ');
}

function richBlocksText(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > 16) return '';
  return blocks.map((block) => richBlockText(block, depth + 1)).filter(Boolean).join('\n\n');
}

function richBlocksHtml(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > 16) return '';
  return blocks.map((block) => richBlockHtml(block, depth + 1)).filter(Boolean).join('\n\n');
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

function richBlockHtml(block, depth) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'divider') return '—';
  if (block.type === 'mathematical_expression') return htmlEscape(block.expression || '');
  if (block.type === 'heading') {
    const size = Math.min(6, Math.max(1, Number(block.size) || 1));
    const text = richTextHtml(block.text);
    return text ? `<h${size}>${text}</h${size}>` : '';
  }
  if (block.type === 'pre') {
    const text = htmlEscape(richText(block.text));
    return text ? `<pre>${text}</pre>` : '';
  }
  if (block.type === 'footer') {
    const text = richTextHtml(block.text);
    return text ? `<i>${text}</i>` : '';
  }
  if (block.type === 'list') {
    return (block.items || []).map((item, index) => {
      const label = item?.label || (item?.has_checkbox ? (item.is_checked ? '☑' : '☐') : `${index + 1}.`);
      const content = richBlocksHtml(item?.blocks, depth).replace(/\n+/g, '\n  ').trim();
      return content ? `${htmlEscape(label)} ${content}` : '';
    }).filter(Boolean).join('\n');
  }
  if (block.type === 'table') {
    const rows = (block.cells || []).map((row) => (row || []).map((cell) => richTextHtml(cell?.text).trim()).join(' | ')).filter(Boolean);
    return [richTextHtml(block.caption), ...rows].filter(Boolean).join('\n');
  }
  if (block.type === 'buttons') return (block.buttons || []).map(buttonHtml).filter(Boolean).join('\n');
  if (block.type === 'details') {
    const summary = richTextHtml(block.summary);
    const content = richBlocksHtml(block.blocks, depth);
    return [summary ? `<b>${summary}</b>` : '', content].filter(Boolean).join('\n');
  }
  if (['expandable_blockquote', 'pullquote'].includes(block.type)) {
    const content = [richTextHtml(block.text), richTextHtml(block.credit)].filter(Boolean).join('\n— ');
    return content ? `<blockquote>${content}</blockquote>` : '';
  }
  if (block.type === 'blockquote') {
    const content = [richBlocksHtml(block.blocks, depth), richTextHtml(block.credit)].filter(Boolean).join('\n— ');
    return content ? `<blockquote>${content}</blockquote>` : '';
  }
  if (['collage', 'slideshow'].includes(block.type)) {
    return [richBlocksHtml(block.blocks, depth), captionHtml(block.caption), richTextHtml(block.credit)].filter(Boolean).join('\n');
  }
  if (block.type === 'map') {
    const location = block.location;
    const coordinates = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)
      ? `${location.latitude}, ${location.longitude}`
      : '';
    return [captionHtml(block.caption), coordinates].filter(Boolean).join('\n');
  }
  if (['animation', 'audio', 'document', 'photo', 'video', 'voice_note'].includes(block.type)) return captionHtml(block.caption);
  return richTextHtml(block.text);
}

function inlineKeyboardEntries(markup) {
  return (markup?.inline_keyboard || []).flat().map((button) => {
    if (!button || typeof button !== 'object') return '';
    const label = String(button.text || '').trim();
    const url = safeHref(button.url);
    const text = label && url ? `${label}: ${url}` : url || '';
    const html = label && url
      ? `<a href="${htmlEscape(url)}">${htmlEscape(label)}</a>`
      : url ? `<a href="${htmlEscape(url)}">${htmlEscape(url)}</a>` : '';
    return text ? { text, html } : null;
  }).filter(Boolean);
}

function inlineKeyboardText(markup) {
  return inlineKeyboardEntries(markup).map((entry) => entry.text).join('\n');
}

export function telegramMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const body = message.caption || message.text || richBlocksText(message.rich_message?.blocks);
  const buttons = inlineKeyboardText(message.reply_markup);
  const missingButtons = buttons.split('\n').filter((line) => line && !String(body || '').includes(line)).join('\n');
  return [body, missingButtons].filter(Boolean).join('\n\n');
}

export function telegramMessageHtml(message) {
  if (!message?.rich_message) return null;
  const bodyText = richBlocksText(message.rich_message.blocks);
  const body = richBlocksHtml(message.rich_message.blocks);
  const missingButtons = inlineKeyboardEntries(message.reply_markup)
    .filter((entry) => entry.text && !bodyText.includes(entry.text))
    .map((entry) => entry.html)
    .join('\n');
  return [body, missingButtons].filter(Boolean).join('\n\n') || null;
}

export function splitHtml(value, limit = 4000) {
  const html = String(value || '');
  if (!html || html.length <= limit) return html ? [html] : [''];
  const tokens = html.match(/<[^>]+>|&(?:amp|lt|gt|quot|#39);|[^<&]+|[<&]/g) || [];
  const chunks = [];
  const stack = [];
  let current = '';
  let hasContent = false;
  const closers = () => [...stack].reverse().map((item) => `</${item.name}>`).join('');
  const openers = () => stack.map((item) => item.token).join('');
  const flush = () => {
    if (!hasContent) return false;
    chunks.push(`${current}${closers()}`);
    current = openers();
    hasContent = false;
    return true;
  };
  const appendText = (text) => {
    const atoms = text.match(/&(?:amp|lt|gt|quot|#39);|[\s\S]/g) || [];
    while (atoms.length) {
      const capacity = limit - current.length - closers().length;
      if (capacity <= 0) {
        if (!flush()) throw new Error('MAX HTML formatting exceeds the message limit');
        continue;
      }
      let count = 0;
      let used = 0;
      let lastBreak = 0;
      while (count < atoms.length && used + atoms[count].length <= capacity) {
        used += atoms[count].length;
        count += 1;
        if (/\s/u.test(atoms[count - 1])) lastBreak = count;
      }
      if (count < atoms.length && lastBreak) count = lastBreak;
      if (!count) {
        if (!flush()) throw new Error('MAX HTML entity exceeds the message limit');
        continue;
      }
      const part = atoms.splice(0, count).join('');
      current += part;
      hasContent ||= /\S/u.test(part);
      if (atoms.length) flush();
    }
  };

  for (const token of tokens) {
    const closing = token.match(/^<\/([a-z][a-z0-9]*)>$/i);
    const opening = token.match(/^<([a-z][a-z0-9]*)\b[^>]*>$/i);
    if (closing) {
      current += token;
      if (stack.at(-1)?.name === closing[1].toLowerCase()) stack.pop();
      continue;
    }
    if (opening && !token.endsWith('/>')) {
      const item = { name: opening[1].toLowerCase(), token };
      if (current.length + token.length + `</${item.name}>`.length + closers().length > limit) flush();
      current += token;
      stack.push(item);
      continue;
    }
    if (token.startsWith('<')) {
      if (current.length + token.length + closers().length > limit) flush();
      current += token;
      hasContent = true;
      continue;
    }
    appendText(token);
  }
  flush();
  return chunks.length ? chunks : [html];
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

export { richBlocksHtml, richBlocksText, richText, richTextHtml };
