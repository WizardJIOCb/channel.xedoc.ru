const token = process.env.MAX_BOT_TOKEN;
const link = (process.env.MAX_TARGET_CHANNEL_LINK || '').replace(/^@/, '');
const targetChatId = process.env.MAX_TARGET_CHAT_ID || '';

if (!token) throw new Error('MAX_BOT_TOKEN is required');
if (!targetChatId && !/^[a-zA-Z0-9_]+$/.test(link)) throw new Error('MAX_TARGET_CHANNEL_LINK must be a MAX channel nickname');

const identifier = targetChatId || link;
const response = await fetch(`https://platform-api2.max.ru/chats/${encodeURIComponent(identifier)}`, {
  headers: { Authorization: token },
});
const payload = await response.json();
if (!response.ok || !payload.chat_id) throw new Error(`MAX channel lookup failed: ${JSON.stringify(payload)}`);
if (payload.type && payload.type !== 'channel') throw new Error('The configured MAX link does not point to a channel');

console.log(payload.chat_id);
