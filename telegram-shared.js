// One Telegram bot has one webhook. Keep the original endpoint and route only
// between connections authenticated with the same bot token.
export function createSharedTelegram({ getStore, token, username = 'MultiPoostBot', unseal, api }) {
  const botToken = (connection) => unseal(connection.telegramToken);
  const sameBot = (left, right) => botToken(left) === botToken(right);
  const anchorFor = (connection) => getStore().connections.find((item) => sameBot(item, connection)) || connection;
  const sharedAnchor = () => token ? getStore().connections.find((item) => botToken(item) === token) : null;
  const linked = (user, anchor = sharedAnchor()) => {
    const connection = getStore().connections.find((item) => item.id === user.telegramConnectionId);
    return Boolean(anchor && connection && user.telegramChatId && sameBot(anchor, connection));
  };

  async function verifySource(user, source) {
    const anchor = sharedAnchor();
    if (!anchor) throw new Error('Общий бот пока недоступен. Используйте токен собственного бота.');
    if (!linked(user, anchor)) throw new Error(`Откройте @${username}, отправьте /link и подтвердите привязку этого кабинета. Затем вернитесь к подключению канала.`);
    let chat, bot, botMember, userMember;
    try {
      [chat, bot] = await Promise.all([api(anchor, 'getChat', { chat_id: `@${source}` }), api(anchor, 'getMe', {})]);
      [botMember, userMember] = await Promise.all([
        api(anchor, 'getChatMember', { chat_id: chat.id, user_id: bot.id }),
        api(anchor, 'getChatMember', { chat_id: chat.id, user_id: Number(user.telegramChatId) }),
      ]);
    } catch {
      throw new Error(`Не удалось проверить канал. Добавьте @${username} в его администраторы и проверьте имя канала.`);
    }
    if (chat.type !== 'channel' || chat.username?.toLowerCase() !== source) throw new Error('Укажите публичный Telegram канал.');
    if (!['creator', 'administrator'].includes(botMember.status)) throw new Error(`Добавьте @${username} в администраторы канала.`);
    if (!['creator', 'administrator'].includes(userMember.status)) throw new Error('Привязанный аккаунт Telegram должен быть владельцем или администратором этого канала.');
    return { anchor, chatId: String(chat.id) };
  }

  function postConnection(endpoint, post) {
    const source = post?.chat?.username?.toLowerCase();
    if (!source) return null;
    const matches = getStore().connections.filter((item) => item.enabled && item.source === source && sameBot(item, endpoint)
      && (!item.telegramSourceChatId || String(post.chat.id) === item.telegramSourceChatId));
    return matches.length === 1 ? matches[0] : null;
  }

  return { anchorFor, sharedAnchor, linked, verifySource, postConnection, sameBot, username };
}
