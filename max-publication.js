const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function plainMaxText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[entity]);
}

// Recover only an exact, consecutive match beside the saved first message.
// A missing or changed legacy part must never turn into a new publication.
export function recoverMaxPartIds(messages, firstId, expectedTexts) {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const start = ordered.findIndex((message) => message.body?.mid === firstId);
  const parts = start < 0 ? [] : ordered.slice(start, start + expectedTexts.length);
  if (parts.length !== expectedTexts.length || parts.some((message, index) => (message.body?.text || '').trim() !== expectedTexts[index].trim())) {
    throw new Error('Не удалось безопасно определить части старого поста MAX; требуется сверка публикации.');
  }
  return parts.map((message) => message.body.mid);
}

export async function publishMaxParts({ parts, formatted, attachments = [], state, send, token, chatId, persist, canAppend, request = fetch, sleep = pause }) {
  if (state.maxPendingPart !== undefined && state.maxPendingPart !== null) {
    throw new Error('Результат предыдущей отправки MAX не подтверждён; перед повтором требуется сверка канала.');
  }
  state.maxMessageIds ||= [];
  const ids = state.maxMessageIds;
  if (ids.length && parts.length > ids.length && !await canAppend(ids.at(-1))) {
    throw new Error('Пост стал длиннее, но после него уже есть другие публикации MAX; новые части не отправлены.');
  }

  async function call(method, id, payload) {
    const endpoint = id ? `message_id=${encodeURIComponent(id)}` : `chat_id=${encodeURIComponent(chatId)}`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await send(() => request(`https://platform-api2.max.ru/messages?${endpoint}`, {
        method, headers: { Authorization: token, 'content-type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }));
      const detail = await response.text();
      let body;
      try { body = JSON.parse(detail); } catch { body = {}; }
      if (response.ok && body.success !== false) return body;
      // A rejected attachment is safe to retry. A POST with a server error may
      // already exist: keep the pending marker and stop instead of duplicating it.
      const attachmentNotReady = detail.includes('attachment.not.ready');
      if (attempt < 3 && (attachmentNotReady || (method === 'PUT' && response.status >= 500))) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (method === 'POST' && (response.status < 500 || attachmentNotReady)) {
        state.maxPendingPart = null;
        await persist();
      }
      throw new Error(`MAX rejected the post (${response.status}): ${detail.slice(0, 180)}`);
    }
  }

  state.maxPartsComplete = false;
  await persist();
  for (const [index, text] of parts.entries()) {
    const id = ids[index];
    const payload = { text, notify: !id };
    if (formatted) payload.format = 'html';
    if (!index && attachments.length) payload.attachments = attachments;
    if (!id) {
      state.maxPendingPart = index;
      await persist();
    }
    const body = await call(id ? 'PUT' : 'POST', id, payload);
    const confirmedId = id || body.message?.body?.mid || body.body?.mid || body.message_id;
    if (!confirmedId) throw new Error('MAX не вернул ID отправленной части; требуется сверка канала.');
    ids[index] = confirmedId;
    state.maxMessageId = ids[0];
    state.maxPendingPart = null;
    await persist();
  }
  // Shortening a post removes its own obsolete tails, in reverse order.
  while (ids.length > parts.length) {
    await call('DELETE', ids.at(-1));
    ids.pop();
    await persist();
  }
  state.maxPartsComplete = true;
  await persist();
  return [...ids];
}
