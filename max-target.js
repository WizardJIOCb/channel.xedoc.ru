export function applyMaxTargetUpdate(connection, update) {
  if (!connection || !update?.is_channel || !update.chat_id) return false;
  const chatId = String(update.chat_id);
  if (update.update_type === 'bot_added') {
    if (connection.targetChatId) return false;
    connection.targetChatId = chatId;
    connection.error = null;
    return true;
  }
  if (update.update_type === 'bot_removed' && String(connection.targetChatId || '') === chatId) {
    connection.targetChatId = null;
    connection.error = 'MAX-бот удалён из целевого канала';
    return true;
  }
  return false;
}
