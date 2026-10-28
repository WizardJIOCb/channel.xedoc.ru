import { createWhatsAppClient } from './whatsapp-client.js';
import { createWhatsAppDelivery } from './whatsapp-delivery.js';
import { collectTelegramArchive } from './whatsapp-archive.js';

const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const labels = { error: 'Ошибка подключения', reconnecting: 'Восстанавливается соединение…', connected: 'Аккаунт подключён', connecting: 'Подключение…', qr: 'Отсканируйте QR-код', disconnected: 'Аккаунт отключён', stopped: 'Аккаунт отключён', logged_out: 'Нужно подключить аккаунт заново', published: 'Отправлено', processing: 'Отправляется', prepared: 'Подготовлено', failed: 'Ошибка подготовки', uncertain: 'Результат требует проверки', partial: 'Отправлена часть поста' };

export function createWhatsAppFeature(deps) {
  const { getStore, save, page, html, go, needUser, forbidden, form, csrf, loadMedia, textOf, filesOf, normalizeMessages, primaryMessage, refreshedPublicMessages } = deps;
  const client = deps.client || createWhatsAppClient({ directory: deps.directory, seal: deps.seal, unseal: deps.unseal });
  const delivery = deps.delivery || createWhatsAppDelivery({ getStore, save, client, loadMedia, textOf, filesOf, normalizeMessages, primaryMessage });
  const tasks = new Map();
  const preparing = new Set();
  const configuring = new Set();
  const sending = new Set();
  const stamp = () => new Date().toISOString();
  const store = () => getStore();
  const pathFor = (connection) => `/connections/${encodeURIComponent(connection.id)}/whatsapp`;
  const stateFor = (connection) => client.status(connection.userId, { includeQr: true });
  const entryFor = (connection, id) => (store().whatsappDeliveries || []).find((entry) => entry.connectionId === connection.id && entry.groupId === connection.whatsapp?.groupId && (String(entry.telegramMessageId) === String(id) || entry.telegramMessageIds?.map(String).includes(String(id))));
  function initialize() {
    store().whatsappAccounts ||= {};
    store().whatsappArchives ||= {};
    store().whatsappBatches ||= {};
    store().whatsappDeliveries ||= [];
  }
  function candidates(connection) {
    const archive = store().whatsappArchives[connection.id];
    if (archive) return archive.posts;
    const found = new Map();
    for (const entry of store().telegramImports || []) {
      if (entry.connectionId === connection.id) found.set(String(entry.messageId), entry);
    }
    for (const entry of store().history) {
      if (entry.connectionId !== connection.id) continue;
      const sourceMessages = normalizeMessages(entry.sourceMessages?.length ? entry.sourceMessages : entry.sourceMessage ? [entry.sourceMessage] : []);
      if (!sourceMessages.length) continue;
      found.set(String(entry.telegramMessageId), { messageId: entry.telegramMessageId, preview: entry.preview, sourceMessages });
    }
    return [...found.values()].sort((a, b) => Number(a.messageId) - Number(b.messageId));
  }
  async function sourceMessages(connection, post) {
    const messages = normalizeMessages(post.sourceMessages || []);
    if (!messages.length) throw new Error('Исходник поста не сохранён');
    return messages.some((message) => message.public_import) ? refreshedPublicMessages(connection, post.messageId, messages) : messages;
  }
  async function sendOne(connection, post, retry = false) {
    if (!connection.whatsapp?.groupId) throw new Error('Сначала сохраните группу WhatsApp');
    return delivery.send(connection, await sourceMessages(connection, post), { historical: true, retry });
  }
  async function runBatch(connection, batch) {
    try {
      for (; batch.cursor < batch.messageIds.length; batch.cursor += 1) {
        if (batch.pauseRequested || client.status(connection.userId).state !== 'connected') { batch.status = 'paused'; break; }
        const post = candidates(connection).find((entry) => String(entry.messageId) === batch.messageIds[batch.cursor]);
        if (!post) { batch.status = 'paused'; batch.error = 'Исходник больше не найден. Подготовьте архив заново.'; break; }
        const result = await sendOne(connection, post, true);
        if (result.status !== 'published') {
          batch.status = 'paused'; batch.error = result.error || 'Проверьте результат доставки текущего поста'; break;
        }
        batch.lastMessageId = post.messageId;
        batch.updatedAt = stamp();
        await save();
      }
      if (batch.cursor >= batch.messageIds.length) batch.status = 'completed';
    } catch { batch.status = 'paused'; batch.error = 'Перенос остановлен. Проверьте аккаунт и историю доставки.'; }
    finally { batch.updatedAt = stamp(); await save(); tasks.delete(connection.id); }
  }
  async function prepareArchive(connection) {
    try {
      const archive = await collectTelegramArchive(connection.source, {
        history: store().history.filter((item) => item.connectionId === connection.id),
        onProgress: async (progress) => { connection.whatsappArchiveProgress = { pages: progress.pages, posts: progress.posts?.length || 0 }; },
      });
      store().whatsappArchives[connection.id] = { ...archive, preparedAt: stamp() };
      connection.whatsappArchiveError = null;
    } catch { connection.whatsappArchiveError = 'Не удалось подготовить архив. Повторите загрузку позже.'; }
    finally { preparing.delete(connection.id); delete connection.whatsappArchiveProgress; await save(); }
  }
  function postForm(connection, value, action, label, fields = '', disabled = false) {
    return `<form method="post" action="${pathFor(connection)}/${action}"><input type="hidden" name="csrf" value="${esc(value.session.csrf)}">${fields}<button class="button small outline"${disabled ? ' disabled' : ''}>${label}</button></form>`;
  }
  function render(connection, value, notice = '') {
    initialize();
    const status = stateFor(connection);
    const target = connection.whatsapp;
    const archive = store().whatsappArchives[connection.id];
    const batch = store().whatsappBatches[connection.id];
    const posts = candidates(connection);
    const active = tasks.has(connection.id);
    const hidden = `<input type="hidden" name="csrf" value="${esc(value.session.csrf)}">`;
    const rows = posts.slice(-100).reverse().map((post) => {
      const sent = entryFor(connection, post.messageId);
      const action = !sent || sent.status === 'failed' || sent.status === 'prepared'
        ? postForm(connection, value, 'send', sent ? 'Повторить подготовку' : 'Отправить в WhatsApp', `<input type="hidden" name="messageId" value="${esc(post.messageId)}">${sent ? '<input type="hidden" name="retry" value="yes">' : ''}`, active || status.state !== 'connected' || !target?.groupId)
        : `<span class="tag ${sent.status === 'published' ? 'live' : 'wait'}">${esc(labels[sent.status] || sent.status)}</span>`;
      return `<article class="wa-post"><div><strong>${esc(post.preview || textOf(primaryMessage(post.sourceMessages || [])).slice(0, 200) || 'Вложение')}</strong><p class="small"><a href="https://t.me/${encodeURIComponent(connection.source)}/${encodeURIComponent(post.messageId)}" target="_blank" rel="noreferrer">Telegram · ${esc(post.messageId)}</a>${sent?.parts?.length ? ` · частей: ${sent.parts.length}` : ''}</p>${sent?.error ? `<p class="history-error small">${esc(sent.error)}</p>` : ''}</div>${action}</article>`;
    }).join('');
    const historyRows = store().whatsappDeliveries.filter((entry) => entry.connectionId === connection.id).slice(-50).reverse().map((entry) => `<article class="wa-post"><div><strong>${esc(entry.preview || `Пост ${entry.telegramMessageId || ''}`)}</strong><p class="small">${esc(entry.groupName || entry.groupId)} · ${esc(entry.updatedAt || entry.createdAt || '')}</p>${entry.error ? `<p class="history-error small">${esc(entry.error)}</p>` : ''}</div><span class="tag">${esc(labels[entry.status] || entry.status)}</span></article>`).join('');
    return page('WhatsApp', `<main class="dashboard"><a href="/dashboard">← Подключения</a><section class="head"><div><p class="eyebrow"><i></i>Telegram → WhatsApp</p><h1>${esc(connection.name)}</h1><p class="muted">Публикации @${esc(connection.source)} в выбранную группу WhatsApp.</p></div></section>${notice ? `<p class="notice">${esc(notice)}</p>` : ''}<section class="panel"><h2>Аккаунт WhatsApp</h2><p id="wa-state" class="muted">${esc(labels[status.state] || status.state)}</p><p class="small">Подключение работает через WhatsApp Web с неофициальной библиотекой. Возможны выход из сессии и ограничения аккаунта. Аккаунт должен уже состоять в нужной группе и иметь право отправки.</p><div class="actions">${postForm(connection, value, 'connect', 'Подключить по QR', '', status.state === 'connected')}${postForm(connection, value, 'disconnect', 'Отключить аккаунт', '', active)}</div><div id="wa-qr-wrap"${status.qr ? '' : ' hidden'}><p>На телефоне: WhatsApp → Связанные устройства → Привязать устройство.</p><img id="wa-qr" alt="QR-код для привязки WhatsApp" width="280" height="280"${status.qr ? ` src="${esc(status.qr)}"` : ''}></div><p id="wa-error" class="history-error small">${esc(status.error || '')}</p></section><section class="panel wa-section"><h2>Группа назначения</h2><p class="muted">${target?.groupName ? esc(target.groupName) : 'Группа ещё не выбрана'}</p><form method="post" action="${pathFor(connection)}/group" class="stack">${hidden}<label class="field"><span>Ссылка приглашения в группу</span><input name="invite" type="url" placeholder="https://chat.whatsapp.com/…" autocomplete="off" required></label><button class="button"${active || status.state !== 'connected' ? ' disabled' : ''}>Проверить и сохранить группу</button></form>${target?.groupId ? `<div class="actions">${postForm(connection, value, 'group', 'Уточнить чат назначения', '<input type="hidden" name="useSaved" value="yes">', active || status.state !== 'connected')}${postForm(connection, value, 'toggle', target.enabled ? 'Остановить новые репосты' : 'Включить новые репосты', '', active || status.state !== 'connected')}<span class="tag ${target.enabled ? 'live' : 'pause'}">${target.enabled ? 'Новые посты отправляются автоматически' : 'Автопостинг выключен'}</span></div>` : ''}<p class="small" style="margin-top:14px">Во время пробного подключения отправки в WhatsApp не списывают баланс. Тариф MAX остаётся прежним. Правки уже отправленных постов автоматически не переносятся.</p></section><section class="panel wa-section"><h2>Перенос истории</h2><p id="wa-progress" class="muted"></p><p class="small">Подготовка собирает доступную публичную историю и сохранённые исходники. Опросы, закрытые и неподдерживаемые публикации могут требовать отдельного экспорта Telegram. Исходные даты добавляются в текст; сообщения в WhatsApp получают время новой отправки.</p><div class="actions">${postForm(connection, value, 'prepare', preparing.has(connection.id) ? 'Архив загружается…' : 'Подготовить архив Telegram', '', active || preparing.has(connection.id))}</div>${connection.whatsappArchiveError ? `<p class="history-error">${esc(connection.whatsappArchiveError)}</p>` : ''}${archive ? `<p>Подготовлено постов: <strong>${archive.posts.length}</strong>. Страниц просмотрено: ${archive.pages}. ${archive.complete ? 'Публичная лента просмотрена до конца.' : `Загрузка неполная: ${esc(archive.stopReason || 'требуется проверка')}.`}</p>${archive.storedOnlyIds?.length ? `<p class="small">Ещё ${archive.storedOnlyIds.length} записей из старой истории не найдены в текущей публичной ленте и не включены в перенос.</p>` : ''}${archive.skippedIds?.length ? `<p class="notice error">Не удалось извлечь ${archive.skippedIds.length} публикаций: ${archive.skippedIds.slice(0, 40).map(esc).join(', ')}${archive.skippedIds.length > 40 ? '…' : ''}. Они не войдут в перенос.</p>` : ''}<div class="actions">${postForm(connection, value, 'batch', `Перенести подготовленные посты (${archive.posts.length})`, '', active || status.state !== 'connected' || !target?.groupId || !archive.posts.length)}${postForm(connection, value, 'pause', 'Приостановить перенос', '', !active)}</div>` : `<p class="muted">В сохранённой истории доступно постов: ${posts.length}. Для просмотра всей доступной ленты подготовьте архив.</p>`}${batch ? `<p class="notice">Перенос: ${batch.status === 'completed' ? 'завершён' : batch.status === 'running' ? 'идёт' : 'приостановлен'} · ${batch.cursor}/${batch.messageIds.length}${batch.error ? ` · ${esc(batch.error)}` : ''}</p>` : ''}<p class="small">При неясном результате отправка останавливается. Уже отправленные посты повторно не отправляются. Ниже показано до 100 последних исходников.</p>${rows || '<p class="muted">Исходники ещё не загружены.</p>'}</section><section class="panel wa-section"><h2>История WhatsApp</h2>${historyRows || '<p class="muted">Отправок пока нет.</p>'}</section></main><style>.wa-section{margin-top:18px}.wa-post{display:flex;align-items:start;justify-content:space-between;gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}.wa-post>div{min-width:0;overflow-wrap:anywhere}.wa-post form{flex-shrink:0}.wa-post strong{font-size:14px}.wa-post p{margin:6px 0}button:disabled{opacity:.5;cursor:default}@media(max-width:620px){.wa-post{flex-direction:column}#wa-qr{max-width:100%;height:auto}}</style><script>(()=>{const state=document.getElementById('wa-state'),image=document.getElementById('wa-qr'),wrap=document.getElementById('wa-qr-wrap'),error=document.getElementById('wa-error');let previous=${JSON.stringify(status.state)},wasPreparing=${preparing.has(connection.id)},previousBatch=${JSON.stringify(batch?.status || null)};const labels=${JSON.stringify(labels)};let timer=setInterval(async()=>{try{const r=await fetch(location.pathname+'/status',{cache:'no-store'});if(!r.ok){clearInterval(timer);return}const data=await r.json();state.textContent=labels[data.state]||data.state;error.textContent=data.error||'';wrap.hidden=!data.qr;if(data.qr)image.src=data.qr;else image.removeAttribute('src');if(data.state==='connected'&&previous!=='connected'){location.reload();return}previous=data.state;const progress=document.getElementById('wa-progress');if(data.preparing)progress.textContent='Архив загружается: страниц '+(data.progress?.pages||0)+', постов '+(data.progress?.posts||0);else if(data.batch)progress.textContent='Перенос: '+data.batch.cursor+'/'+data.batch.total;if((wasPreparing&&!data.preparing)||(previousBatch==='running'&&data.batch?.status!=='running')){location.reload();return}wasPreparing=data.preparing;previousBatch=data.batch?.status;}catch{}},3000);window.addEventListener('pagehide',()=>clearInterval(timer));})();</script>`, value);
  }
  async function handle(req, res, url) {
    const match = url.pathname.match(/^\/connections\/([^/]+)\/whatsapp(?:\/(status|connect|disconnect|group|toggle|prepare|send|batch|pause))?$/);
    if (!match) return false;
    initialize();
    const value = needUser(req, res);
    if (!value) return true;
    const connection = store().connections.find((item) => item.id === match[1] && item.userId === value.user.id);
    if (!connection) { forbidden(res); return true; }
    const action = match[2];
    if (req.method === 'GET' && action === 'status') {
      const extra = {};
      if (url.searchParams.get('inspectGroup') === 'yes' && connection.whatsapp?.groupId) {
        try { extra.group = await client.inspectGroup(value.user.id, connection.whatsapp.groupId); }
        catch { extra.groupError = 'Не удалось проверить выбранную группу WhatsApp.'; }
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const batch = store().whatsappBatches[connection.id];
      res.end(JSON.stringify({ ...stateFor(connection), ...extra, preparing: preparing.has(connection.id), progress: connection.whatsappArchiveProgress || null, batch: batch ? { status: batch.status, cursor: batch.cursor, total: batch.messageIds.length } : null })); return true;
    }
    if (req.method === 'GET' && !action) {
      let notice = '';
      if (url.searchParams.get('inspectGroup') === 'yes' && connection.whatsapp?.groupId) {
        try { notice = `Проверка группы: ${JSON.stringify(await client.inspectGroup(value.user.id, connection.whatsapp.groupId))}`; }
        catch { notice = 'Не удалось проверить выбранную группу WhatsApp.'; }
      }
      html(res, 200, render(connection, value, notice)); return true;
    }
    if (req.method !== 'POST' || !action || action === 'status') { html(res, 405, render(connection, value, 'Действие недоступно')); return true; }
    const data = await form(req);
    if (!csrf(value, data)) { forbidden(res); return true; }
    try {
      if (action === 'connect') {
        store().whatsappAccounts[value.user.id] = { active: true }; await save();
        await client.start(value.user.id);
      } else if (action === 'disconnect') {
        for (const other of store().connections.filter((item) => item.userId === value.user.id)) {
          const batch = store().whatsappBatches[other.id]; if (batch) batch.pauseRequested = true;
          if (other.whatsapp) other.whatsapp.enabled = false;
        }
        store().whatsappAccounts[value.user.id] = { active: false }; await save(); await client.stop(value.user.id);
      } else if (action === 'group') {
        if (tasks.has(connection.id) || configuring.has(connection.id) || sending.has(connection.id)) throw new Error('Сначала дождитесь завершения текущей операции');
        configuring.add(connection.id);
        try {
          const group = data.useSaved === 'yes' && connection.whatsapp?.groupId
            ? await client.resolveDestination(value.user.id, connection.whatsapp.groupId)
            : await client.resolveGroup(value.user.id, String(data.invite || '').trim());
          connection.whatsapp = { groupId: group.id, groupName: group.name, enabled: false, updatedAt: stamp() };
          delete store().whatsappBatches[connection.id]; await save();
        } finally { configuring.delete(connection.id); }
      } else if (action === 'toggle') {
        if (!connection.whatsapp?.groupId) throw new Error('Сначала выберите группу');
        if (!connection.whatsapp.enabled && client.status(value.user.id).state !== 'connected') throw new Error('Сначала подключите аккаунт');
        connection.whatsapp.enabled = !connection.whatsapp.enabled; await save();
      } else if (action === 'prepare') {
        if (tasks.has(connection.id) || preparing.has(connection.id)) throw new Error('Дождитесь завершения текущей операции');
        preparing.add(connection.id); void prepareArchive(connection);
      } else if (action === 'send') {
        if (tasks.has(connection.id) || configuring.has(connection.id) || sending.has(connection.id)) throw new Error('Дождитесь завершения текущей операции');
        const post = candidates(connection).find((entry) => String(entry.messageId) === String(data.messageId));
        if (!post) throw new Error('Пост не найден среди подготовленных исходников');
        sending.add(connection.id);
        let result;
        try { result = await sendOne(connection, post, data.retry === 'yes'); }
        finally { sending.delete(connection.id); }
        html(res, 200, render(connection, value, labels[result.status] || result.status)); return true;
      } else if (action === 'batch') {
        if (tasks.has(connection.id) || preparing.has(connection.id) || configuring.has(connection.id) || sending.has(connection.id)) throw new Error('Дождитесь завершения текущей операции');
        if (client.status(value.user.id).state !== 'connected' || !connection.whatsapp?.groupId) throw new Error('Подключите аккаунт и сохраните группу');
        const archive = store().whatsappArchives[connection.id];
        if (!archive?.posts.length) throw new Error('Сначала подготовьте архив');
        const batch = { status: 'running', groupId: connection.whatsapp.groupId, messageIds: archive.posts.map((item) => String(item.messageId)), cursor: 0, startedAt: stamp(), updatedAt: stamp(), pauseRequested: false };
        store().whatsappBatches[connection.id] = batch;
        tasks.set(connection.id, true); await save();
        void runBatch(connection, batch);
      } else if (action === 'pause') {
        const batch = store().whatsappBatches[connection.id]; if (batch) { batch.pauseRequested = true; await save(); }
      }
      go(res, pathFor(connection));
    } catch (error) { html(res, 400, render(connection, value, String(error.message || 'Не удалось выполнить действие').slice(0, 240))); }
    return true;
  }
  async function init() {
    initialize();
    for (const batch of Object.values(store().whatsappBatches)) if (batch.status === 'running') { batch.status = 'paused'; batch.pauseRequested = true; }
    await delivery.recover();
    await client.resume(Object.entries(store().whatsappAccounts).filter(([, account]) => account.active).map(([id]) => id));
  }
  async function auto(connection, messages, edited = false) {
    if (!connection.whatsapp?.enabled || !connection.whatsapp.groupId || edited) return;
    try { await delivery.send(connection, messages); } catch { /* Delivery state carries the error; MAX remains independent. */ }
  }
  function card(connection) {
    return `<div class="actions" style="border-top:1px solid var(--line);padding-top:12px"><a class="button small outline" href="${pathFor(connection)}">${connection.whatsapp?.groupId ? 'Настроить WhatsApp' : '+ Подключить WhatsApp'}</a>${connection.whatsapp?.groupId ? `<span class="tag ${connection.whatsapp.enabled ? 'live' : 'pause'}">WhatsApp · ${esc(connection.whatsapp.groupName)}</span>` : ''}</div>`;
  }
  return { handle, init, auto, card, close: () => client.closeAll(), client };
}
