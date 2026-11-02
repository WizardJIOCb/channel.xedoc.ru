export function createSharedMax({ getStore, save, api, token, unseal, rid, queue, now = Date.now }) {
  const isShared = (connection) => Boolean(token && connection?.maxToken && unseal(connection.maxToken) === token);
  const pending = (connection) => (getStore().maxBindings || []).find((row) => row.connectionId === connection.id && row.expiresAt > now());
  const run = (work) => queue.run('shared-max', work);

  async function begin(connection) {
    return run(async () => {
      if (!isShared(connection) || connection.targetChatId) throw new Error('Это подключение MAX уже настроено или использует собственного бота.');
      const store = getStore();
      store.maxBindings = (store.maxBindings || []).filter((row) => row.connectionId !== connection.id && row.expiresAt > now());
      const row = { connectionId: connection.id, userId: connection.userId, code: rid(16), expiresAt: now() + 30 * 60 * 1000 };
      store.maxBindings.push(row); await save(); return row;
    });
  }

  async function command(update, text) {
    const match = text.match(/^\/connect\s+([A-Za-z0-9_-]{20,64})\s*$/);
    if (!match) return null;
    const sender = update.message?.sender;
    if (update.update_type !== 'message_created' || update.is_channel || update.message?.recipient?.chat_type !== 'dialog' || !sender?.user_id || sender.is_bot) return null;
    return run(async () => {
      const store = getStore();
      const row = (store.maxBindings || []).find((item) => item.code === match[1] && item.expiresAt > now());
      const connection = row && store.connections.find((c) => c.id === row.connectionId && c.userId === row.userId);
      if (!row || !isShared(connection) || connection.targetChatId) return 'Код недействителен. Откройте подключение MAX в кабинете и получите новый код.';
      if (row.maxUserId && row.maxUserId !== String(sender.user_id)) return 'Этот код уже подтверждён другим аккаунтом MAX. Получите новый код в кабинете.';
      row.maxUserId = String(sender.user_id);
      store.maxBindings = store.maxBindings.filter((item) => item === row || item.maxUserId !== row.maxUserId);
      await save();
      return `Подключение «${connection.name}» подтверждено. Теперь добавьте этого бота в нужный канал MAX и назначьте администратором с правом публикации. Затем вернитесь в кабинет и подтвердите выбранный канал.`;
    });
  }

  async function event(update) {
    if (!['bot_added', 'bot_removed', 'bot_admin_permissions_changed'].includes(update.update_type) || !update.is_channel || !update.chat_id) return;
    return run(async () => {
      const store = getStore(), chatId = String(update.chat_id);
      if (update.update_type === 'bot_removed') {
        let changed = false;
        for (const connection of store.connections) if (isShared(connection) && String(connection.targetChatId || '') === chatId) {
          connection.targetChatId = null; connection.error = 'Общий бот MAX удалён из канала. Подключите канал заново.';
          connection.updatedAt = new Date(now()).toISOString(); changed = true;
        }
        for (const row of store.maxBindings || []) if (row.chatId === chatId) { delete row.chatId; changed = true; }
        if (changed) await save();
        return;
      }
      const actorId = update.update_type === 'bot_admin_permissions_changed' ? update.user_id : update.user?.user_id;
      if (!actorId || update.user?.is_bot) return;
      const matches = (store.maxBindings || []).filter((row) => row.expiresAt > now() && row.maxUserId === String(actorId));
      if (matches.length !== 1 || matches[0].chatId) return;
      const row = matches[0], connection = store.connections.find((c) => c.id === row.connectionId && c.userId === row.userId);
      if (!isShared(connection) || connection.targetChatId) return;
      row.chatId = chatId; await save();
    });
  }

  async function forward(update) {
    const message = update.message;
    if (update.update_type !== 'message_created' || update.is_channel || message?.recipient?.chat_type !== 'dialog' || !message.sender?.user_id || message.sender.is_bot || message.link?.type !== 'forward' || !message.link.chat_id) return null;
    return run(async () => {
      const store = getStore();
      const matches = (store.maxBindings || []).filter((row) => row.expiresAt > now() && row.maxUserId === String(message.sender.user_id));
      if (matches.length !== 1) return 'Сначала откройте подключение MAX в кабинете и подтвердите команду /connect с кодом.';
      const row = matches[0], connection = store.connections.find((c) => c.id === row.connectionId && c.userId === row.userId);
      if (!isShared(connection) || connection.targetChatId) return null;
      const chatId = String(message.link.chat_id);
      if (!/^-?\d+$/.test(chatId)) return null;
      if (row.chatId && row.chatId !== chatId) return 'Для подключения другого канала получите новый код в кабинете.';
      row.chatId = chatId; await save();
      return `Канал для «${connection.name}» найден по пересланному посту. Вернитесь на страницу подключения MAX в кабинете и подтвердите канал. Перед подключением проверим ваши права и права бота.`;
    });
  }

  async function confirm(connection, code) {
    return run(async () => {
      const store = getStore(), row = pending(connection);
      if (!isShared(connection) || connection.targetChatId || !row || row.code !== code || !row.maxUserId || !row.chatId) throw new Error('Подтвердите код у бота MAX и добавьте его в нужный канал. Если код устарел, получите новый.');
      if (store.connections.some((c) => c.id !== connection.id && String(c.targetChatId || '') === row.chatId)) throw new Error('Этот канал MAX уже используется другим подключением.');
      let chat, member, admins;
      try {
        [chat, member, admins] = await Promise.all([api(`/chats/${row.chatId}`), api(`/chats/${row.chatId}/members/me`), api(`/chats/${row.chatId}/members/admins`)]);
      } catch { throw new Error('Не удалось проверить права MAX. Назначьте общего бота администратором канала с правом публикации и повторите проверку.'); }
      const owner = admins.members?.find((m) => String(m.user_id) === row.maxUserId && !m.is_bot);
      if (String(chat.chat_id) !== row.chatId || chat.type !== 'channel' || !(owner?.is_admin || owner?.is_owner)) throw new Error('Аккаунт MAX, подтвердивший код, должен быть администратором выбранного канала.');
      if (!(member.is_admin || member.is_owner) || !(member.permissions || []).some((p) => ['write', 'post_edit_delete_message'].includes(p))) throw new Error('Назначьте общего бота администратором MAX с правом публикации.');
      connection.targetChatId = row.chatId; connection.maxTargetTitle = String(chat.title || '').slice(0, 180);
      if (connection.maxSetupPending) { connection.enabled = true; delete connection.maxSetupPending; }
      connection.error = null; connection.updatedAt = new Date(now()).toISOString();
      store.maxBindings = store.maxBindings.filter((item) => item !== row);
      await save(); return connection;
    });
  }
  return { isShared, pending, begin, command, event, forward, confirm };
}
