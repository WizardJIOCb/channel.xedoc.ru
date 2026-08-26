const TELEGRAM_PAGE_LIMIT = 2 * 1024 * 1024;
const TELEGRAM_MEDIA_HOST = /(^|\.)telesco\.pe$/i;

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return decodeEntities(match?.[1] ?? match?.[2] ?? '');
}

function extractMessageHtml(segment) {
  const opening = /<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>/i.exec(segment);
  if (!opening) return '';
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let match = tags.exec(segment); match; match = tags.exec(segment)) {
    depth += /^<\/div/i.test(match[0]) ? -1 : 1;
    if (depth === 0) return segment.slice(start, match.index);
  }
  return '';
}

function htmlToText(value) {
  let html = String(value || '');
  html = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const label = htmlToText(inner);
    const href = attribute(`<a ${attrs}>`, 'href');
    if (!href || !/^https?:\/\//i.test(href) || label.includes(href)) return label;
    return label ? `${label} (${href})` : href;
  });
  html = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n');
  html = html.replace(/<[^>]+>/g, '');
  return decodeEntities(html)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function safeTelegramMediaUrl(value) {
  try {
    const url = new URL(String(value || '').startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && TELEGRAM_MEDIA_HOST.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mediaFromSegment(segment, source, postId) {
  const result = [];
  const seen = new Set();
  const tags = /<a\b[^>]*class="[^"]*\bjs-message_photo\b[^"]*"[^>]*>|<video\b[^>]*class="[^"]*\bjs-message_video\b[^"]*"[^>]*>/gi;
  for (let match = tags.exec(segment); match; match = tags.exec(segment)) {
    const tag = match[0];
    const video = /^<video/i.test(tag);
    const rawUrl = video ? attribute(tag, 'src') : tag.match(/background-image\s*:\s*url\(['"]?([^'"\)]+)['"]?\)/i)?.[1];
    const url = safeTelegramMediaUrl(decodeEntities(rawUrl || ''));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const href = attribute(tag, 'href');
    const mediaId = href.match(new RegExp(`t\\.me/${source}/(\\d+)`, 'i'))?.[1] || (result.length ? `${postId}-${result.length + 1}` : postId);
    result.push({
      type: video ? 'video' : 'image',
      url,
      messageId: mediaId,
      name: video ? `telegram-${postId}-${result.length + 1}.mp4` : `telegram-${postId}-${result.length + 1}.jpg`,
      mime: video ? 'video/mp4' : 'image/jpeg',
    });
  }
  return result;
}

export function publicPostMessages(post) {
  const media = Array.isArray(post?.media) ? post.media.slice(0, 12) : [];
  const date = post?.publishedAt ? Math.floor(new Date(post.publishedAt).getTime() / 1000) : undefined;
  if (!media.length) return [{ message_id: Number(post.messageId), text: post.text || '', date, public_import: true }];
  const group = media.length > 1 ? `public:${post.source}:${post.messageId}` : undefined;
  return media.map((item, index) => ({
    message_id: index === 0
      ? Number(post.messageId)
      : /^\d+$/.test(String(item.messageId)) ? Number(item.messageId) : String(item.messageId),
    media_group_id: group,
    caption: index === 0 ? post.text || '' : undefined,
    date,
    public_import: true,
    imported_media: item,
  }));
}

export function parseTelegramPublicPosts(html, expectedSource) {
  const source = String(expectedSource || '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9_]{5,64}$/i.test(source)) return [];
  const marker = '<div class="tgme_widget_message_wrap js-widget_message_wrap">';
  return String(html || '').split(marker).slice(1).map((segment) => {
    const post = segment.match(/\bdata-post="([^"/]+)\/(\d+)"/i);
    if (!post || post[1].toLowerCase() !== source) return null;
    const messageId = post[2];
    const text = htmlToText(extractMessageHtml(segment));
    const media = mediaFromSegment(segment, source, messageId);
    if ((!text && !media.length) || media.length > 12) return null;
    const publishedAt = decodeEntities(segment.match(/<time\b[^>]*datetime="([^"]+)"/i)?.[1] || '') || null;
    const value = {
      source,
      messageId,
      text,
      media,
      publishedAt,
      link: `https://t.me/${source}/${messageId}`,
    };
    value.sourceMessages = publicPostMessages(value);
    return value;
  }).filter(Boolean);
}

export async function fetchTelegramPublicPosts(source, messageId = null, fetchImpl = fetch) {
  const channel = String(source || '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9_]{5,64}$/i.test(channel)) throw new Error('Некорректное имя Telegram-канала');
  const postId = messageId == null ? null : String(messageId);
  if (postId !== null && !/^\d+$/.test(postId)) throw new Error('Некорректный ID Telegram-поста');
  const url = postId ? `https://t.me/${channel}/${postId}?embed=1&mode=tme` : `https://t.me/s/${channel}`;
  const response = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MultiPost/1.0)' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Telegram не открыл публичную ленту (${response.status})`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > TELEGRAM_PAGE_LIMIT) throw new Error('Страница Telegram слишком большая');
  const html = await response.text();
  if (Buffer.byteLength(html) > TELEGRAM_PAGE_LIMIT) throw new Error('Страница Telegram слишком большая');
  return parseTelegramPublicPosts(html, channel);
}
