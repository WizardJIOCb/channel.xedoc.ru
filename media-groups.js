function orderOf(message) {
  const value = Number(message?.message_id);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function normalizeMessages(value) {
  const messages = Array.isArray(value) ? value : [value];
  const unique = new Map();
  let anonymous = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const key = message.message_id === undefined ? `anonymous-${anonymous++}` : String(message.message_id);
    unique.set(key, message);
  }
  return [...unique.values()].sort((left, right) => orderOf(left) - orderOf(right));
}

export function mergeMessages(existing, incoming) {
  return normalizeMessages([...normalizeMessages(existing), ...normalizeMessages(incoming)]);
}

export function primaryMessage(value) {
  const messages = normalizeMessages(value);
  return messages.find((message) => String(message.caption || message.text || '').trim()) || messages[0] || {};
}

export function mediaGroupKey(connectionId, mediaGroupId) {
  return JSON.stringify([String(connectionId), String(mediaGroupId)]);
}
