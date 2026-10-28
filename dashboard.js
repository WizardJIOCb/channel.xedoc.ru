import { dashboardStyles } from './dashboard-style.js';

const ZONE = 'Asia/Yekaterinburg';
const esc = (v = '') => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const plural = (n, one, few, many) => n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
const postWord = (n) => plural(n, 'пост', 'поста', 'постов');
const messageWord = (n) => plural(n, 'сообщение', 'сообщения', 'сообщений');
const eventWord = (n, mode) => mode === 'posts' ? plural(n, 'публикация', 'публикации', 'публикаций') : plural(n, 'доставка', 'доставки', 'доставок');
const number = (v) => new Intl.NumberFormat('ru-RU').format(v);
const validDate = (v) => { const d = new Date(typeof v === 'number' ? v * 1000 : v); return v && !Number.isNaN(+d) ? d.toISOString() : null; };
export const dashboardDay = (v) => validDate(v) ? new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(validDate(v))) : null;
const time = (v) => v ? new Intl.DateTimeFormat('ru-RU', { timeZone: ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : 'Ещё нет доставок';

// Only this allowlisted view model reaches the renderer. Never serialize the store or tokens.
export function dashboardData(store, userId, now = new Date()) {
  const connections = (store.connections || []).filter((c) => c.userId === userId);
  const owned = new Map(connections.map((c) => [c.id, c]));
  const posts = [];
  const aliases = new Map();
  const metrics = new Map(connections.map((c) => [c.id, { max: 0, waPosts: 0, messages: 0, maxLast: null, waLast: null, issues: 0 }]));
  const successful = new Set();
  const confirmedMessages = new Set();
  const deliveries = [];
  const latest = (a, b) => !a || (b && b > a) ? b : a;
  function postFor(row, messageId, dates, preview, ids = []) {
    const c = owned.get(row.connectionId);
    if (!c || messageId == null) return null;
    const keys = [...new Set([messageId, ...ids].map(String))].map((id) => `${c.id}:${id}`);
    if (row.telegramMediaGroupId) keys.push(`${c.id}:album:${row.telegramMediaGroupId}`);
    const matches = [...new Set(keys.map((key) => aliases.get(key)).filter(Boolean))];
    const post = matches[0] || { key: keys[0], connectionId: c.id, source: c.source, name: c.name, messageId: String(messageId), preview: '', date: null, estimated: true, max: false, whatsapp: false };
    if (!matches.length) posts.push(post);
    // A later album record may bridge previously separate source messages.
    for (const extra of matches.slice(1)) {
      post.max ||= extra.max; post.whatsapp ||= extra.whatsapp;
      if (!extra.estimated && post.estimated) { post.date = extra.date; post.estimated = false; }
      for (const [key, value] of aliases) if (value === extra) aliases.set(key, post);
      posts.splice(posts.indexOf(extra), 1);
      for (const delivery of deliveries) if (delivery.post === extra) delivery.post = post;
    }
    for (const key of keys) aliases.set(key, post);
    const original = dates.map(validDate).find(Boolean);
    if (original && post.estimated) { post.date = original; post.estimated = false; }
    if (!post.date) post.date = validDate(row.createdAt || row.loadedAt);
    if (preview && (!post.preview || preview.length > post.preview.length)) post.preview = String(preview).slice(0, 240);
    return post;
  }
  for (const row of store.history || []) {
    if (!owned.has(row.connectionId)) continue;
    const messages = row.sourceMessages || [];
    const post = postFor(row, row.telegramMessageId, [row.sourceMessage?.date, ...messages.map((m) => m.date)], row.preview, row.telegramMessageIds || messages.map((m) => m.message_id));
    if (!post) continue;
    const ok = row.status === 'published' || Boolean(row.maxMessageId || row.lastReplayMaxMessageId);
    if (ok) {
      post.max = true;
      const key = `${post.key}:max`;
      if (!successful.has(key)) {
        successful.add(key); metrics.get(row.connectionId).max++;
        const date = validDate(row.deliveredAt || row.lastReplayAt || row.updatedAt || row.createdAt);
        deliveries.push({ post, platform: 'max', date });
        metrics.get(row.connectionId).maxLast = latest(metrics.get(row.connectionId).maxLast, date);
      }
    }
    if (['failed', 'blocked'].includes(row.status) && !row.lastReplayMaxMessageId) metrics.get(row.connectionId).issues++;
  }
  for (const row of store.whatsappDeliveries || []) {
    if (!owned.has(row.connectionId) || (row.userId && row.userId !== userId)) continue;
    const post = postFor(row, row.telegramMessageId, [row.sourceDate], row.preview, row.telegramMessageIds || []);
    if (!post) continue;
    // An uncertain network attempt is never counted as a confirmed message.
    const sentIds = new Set([...(row.sentMessageIds || []), ...(row.parts || []).filter((p) => p.status === 'sent').map((p) => p.messageId)].filter(Boolean));
    const stats = metrics.get(row.connectionId);
    for (const id of sentIds) {
      const key = `${row.connectionId}:${row.groupId || ''}:${id}`;
      if (!confirmedMessages.has(key)) { confirmedMessages.add(key); stats.messages++; }
    }
    if (row.status === 'published') {
      post.whatsapp = true;
      const key = `${post.key}:whatsapp`;
      if (!successful.has(key)) {
        successful.add(key); stats.waPosts++;
        const date = validDate(row.deliveredAt || row.updatedAt || row.createdAt);
        deliveries.push({ post, platform: 'whatsapp', date });
        stats.waLast = latest(stats.waLast, date);
      }
    }
    if (['failed', 'partial', 'uncertain'].includes(row.status)) stats.issues++;
  }
  for (const row of store.telegramImports || []) {
    postFor(row, row.messageId, [row.publishedAt, ...(row.sourceMessages || []).map((m) => m.date)], row.preview, (row.sourceMessages || []).map((m) => m.message_id));
  }
  // Album aliases discovered in imports can merge records from either destination.
  for (const c of connections) {
    const stats = metrics.get(c.id);
    stats.max = posts.filter((p) => p.connectionId === c.id && p.max).length;
    stats.waPosts = posts.filter((p) => p.connectionId === c.id && p.whatsapp).length;
  }
  const uniqueDeliveries = deliveries.filter((delivery, index) => deliveries.findIndex((d) => d.post === delivery.post && d.platform === delivery.platform) === index);
  const channels = connections.map((c) => ({
    id: c.id, name: c.name, source: c.source, enabled: Boolean(c.enabled), telegramConfigured: Boolean(c.telegramToken), maxConfigured: Boolean(c.maxToken),
    target: c.targetChatId || '', error: c.error || '', whatsapp: { groupName: c.whatsapp?.groupName || '', hasGroup: Boolean(c.whatsapp?.groupId), enabled: Boolean(c.whatsapp?.enabled) },
    ...metrics.get(c.id),
  }));
  return { channels, posts, deliveries: uniqueDeliveries, today: dashboardDay(now.toISOString()), totals: channels.reduce((a, c) => ({ max: a.max + c.max, whatsapp: a.whatsapp + c.waPosts, messages: a.messages + c.messages, issues: a.issues + c.issues }), { max: 0, whatsapp: 0, messages: 0, issues: 0 }) };
}

function icon(platform) {
  const paths = {
    telegram: '<path d="m5 11 14-6-4 14-5-5-3 2 1-5 7-3-5 6"/>',
    max: '<path d="M5 17V7l7 8 7-8v10"/>',
    whatsapp: '<path d="M7 18 3 21l1-5a9 9 0 1 1 3 2Z"/><path d="M8 7c0 5 4 9 9 9l1-3-3-1-1 1-3-3 1-1-1-3Z"/>',
  };
  return `<span class="ov-icon ${platform}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[platform]}</svg></span>`;
}
const badge = (label, state = 'muted') => `<span class="ov-status ${state}"><i></i>${esc(label)}</span>`;
const postForm = (action, csrf, label, style = '') => `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ov-button ${style}">${label}</button></form>`;

function channelCard(c, csrf, waState, imports, openImports) {
  const base = `/connections/${encodeURIComponent(c.id)}`;
  const maxReady = c.maxConfigured && c.target;
  const waReady = c.whatsapp.hasGroup && waState === 'connected';
  return `<article class="ov-channel" id="connection-${esc(c.id)}">
    <div class="ov-channel-head"><div><h3>${esc(c.name)}</h3><p>@${esc(c.source)} <span>· Telegram → ваши площадки</span></p></div>${badge(c.issues ? `${c.issues} ${plural(c.issues, 'сбой', 'сбоя', 'сбоев')} в истории` : 'Без сбоев в истории', c.issues ? 'warning' : 'muted')}</div>
    <div class="ov-platforms">
      <section class="ov-platform"><div class="ov-platform-head">${icon('telegram')}<div><h4>Telegram</h4><span class="ov-caption">Источник публикаций</span></div></div>
        ${badge(c.telegramConfigured ? 'Источник настроен' : 'Нужна настройка', c.telegramConfigured ? 'good' : 'warning')}
        <strong class="ov-destination">@${esc(c.source)}</strong><p class="ov-caption">Новые посты из этого канала поступают в сервис.</p>
        <div class="ov-platform-bottom"><a class="ov-button" href="https://t.me/${encodeURIComponent(c.source)}" target="_blank" rel="noreferrer">Открыть канал ↗</a>${postForm(`${base}/import`, csrf, 'Подгрузить посты с канала', 'quiet')}</div>
      </section>
      <section class="ov-platform"><div class="ov-platform-head">${icon('max')}<div><h4>MAX</h4><span class="ov-caption">Получатель постов</span></div></div>
        ${badge(c.error ? 'Требует внимания' : !maxReady ? 'Не подключено' : c.enabled ? 'Подключено' : 'Репост на паузе', c.error || !maxReady ? 'warning' : c.enabled ? 'good' : 'muted')}
        <strong class="ov-destination">${c.target ? `Канал ${esc(c.target)}` : 'Выберите канал MAX'}</strong>
        <p class="ov-caption">${number(c.max)} ${postWord(c.max)} ${plural(c.max, 'доставлен', 'доставлено', 'доставлено')}<br>Последний: ${esc(time(c.maxLast))}</p>
        <div class="ov-platform-bottom">${maxReady ? postForm(`${base}/toggle`, csrf, c.enabled ? 'Приостановить репост' : 'Возобновить репост', 'quiet') : postForm(`${base}/configure`, csrf, 'Подключить MAX')}
        <details class="ov-settings"><summary>Настройки MAX</summary>${c.error ? `<p class="ov-error">${esc(c.error)}</p>` : ''}${postForm(`${base}/configure`, csrf, 'Обновить подключение', 'quiet')}
        <form method="post" action="${base}/max-token"><input type="hidden" name="csrf" value="${esc(csrf)}"><label>Новый токен MAX<input name="maxToken" type="password" autocomplete="new-password" required placeholder="Токен бота"></label><button class="ov-button">Заменить токен MAX</button></form></details></div>
      </section>
      <section class="ov-platform"><div class="ov-platform-head">${icon('whatsapp')}<div><h4>WhatsApp</h4><span class="ov-caption">Получатель постов</span></div></div>
        ${badge(!c.whatsapp.hasGroup ? 'Не подключено' : !waReady ? (['connecting', 'reconnecting'].includes(waState) ? 'Подключается…' : 'Аккаунт отключён') : c.whatsapp.enabled ? 'Подключено' : 'Репост на паузе', waReady && c.whatsapp.enabled ? 'good' : 'warning')}
        <strong class="ov-destination">${esc(c.whatsapp.groupName || 'Добавьте группу WhatsApp')}</strong><p class="ov-caption">${number(c.waPosts)} ${postWord(c.waPosts)} · ${number(c.messages)} ${messageWord(c.messages)}<br>Последний: ${esc(time(c.waLast))}</p>
        <div class="ov-platform-bottom"><a class="ov-button ${waReady ? '' : 'primary'}" href="${base}/whatsapp">${!c.whatsapp.hasGroup ? 'Подключить WhatsApp' : !waReady ? 'Восстановить подключение' : 'Настроить WhatsApp'} <span aria-hidden="true">↗</span></a></div>
      </section>
    </div>
    ${imports ? `<details class="ov-imports" ${openImports ? 'open' : ''}><summary>Посты из Telegram · выбрать для переноса</summary>${imports}</details>` : ''}
  </article>`;
}

function calendar(model, options) {
  const requested = options.month || '';
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) && Number(requested.slice(0, 4)) >= 2000 && Number(requested.slice(0, 4)) <= 2100 ? requested : model.today.slice(0, 7);
  const mode = options.view === 'deliveries' ? 'deliveries' : 'posts';
  const [year, mon] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const start = (new Date(Date.UTC(year, mon - 1, 1)).getUTCDay() + 6) % 7;
  const monthDate = new Date(Date.UTC(year, mon - 1, 15));
  const label = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate);
  const adjacent = (delta) => new Date(Date.UTC(year, mon - 1 + delta, 1)).toISOString().slice(0, 7);
  const url = (m = month, day = '', view = mode) => `/dashboard?month=${m}&view=${view}${day ? `&day=${day}` : ''}#activity`;
  const events = mode === 'posts' ? model.posts.filter((p) => p.date).map((post) => ({ post, date: post.date })) : model.deliveries.filter((d) => d.date);
  const buckets = new Map();
  for (const event of events) { const day = dashboardDay(event.date); if (!buckets.has(day)) buckets.set(day, []); buckets.get(day).push(event); }
  const monthEvents = events.filter((e) => dashboardDay(e.date).startsWith(month));
  const activeDays = [...buckets.keys()].filter((d) => d.startsWith(month));
  const selected = options.day?.startsWith(`${month}-`) && Number(options.day.slice(8)) >= 1 && Number(options.day.slice(8)) <= days && /^\d{4}-\d{2}-\d{2}$/.test(options.day) ? options.day : (month === model.today.slice(0, 7) ? model.today : activeDays.sort().at(-1) || `${month}-01`);
  const rows = (buckets.get(selected) || []).sort((a, b) => b.date.localeCompare(a.date));
  const max = Math.max(1, ...activeDays.map((d) => buckets.get(d).length));
  const cells = Array.from({ length: start }, () => '<span class="ov-day-blank" aria-hidden="true"></span>');
  for (let n = 1; n <= days; n++) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    const count = buckets.get(day)?.length || 0;
    const heat = count ? Math.min(4, Math.ceil(count / max * 4)) : 0;
    cells.push(`<a class="ov-day heat-${heat}${day === selected ? ' selected' : ''}${day === model.today ? ' today' : ''}" href="${esc(url(month, day))}" aria-label="${day}: ${count} ${eventWord(count, mode)}" ${day === selected ? 'aria-current="date"' : ''}><span>${n}</span><b>${count || '<span aria-hidden="true">·</span>'}</b></a>`);
  }
  const dateLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${selected}T12:00:00Z`));
  return `<section class="ov-activity" id="activity"><div class="ov-section-head"><div><p class="ov-kicker">Ритм канала</p><h2>Календарь публикаций</h2><p class="ov-caption">${mode === 'posts' ? 'Когда выходили исходные посты в Telegram.' : 'Когда сервис доставлял посты на площадки.'} Время Екатеринбурга, UTC+5.</p></div><div class="ov-tabs" aria-label="Режим календаря"><a ${mode === 'posts' ? 'aria-current="page"' : ''} href="${esc(url(month, '', 'posts'))}">Публикации</a><a ${mode === 'deliveries' ? 'aria-current="page"' : ''} href="${esc(url(month, '', 'deliveries'))}">Доставки</a></div></div>
    <div class="ov-calendar-layout"><div class="ov-month"><div class="ov-month-head"><h3>${esc(label)}</h3><div><a class="ov-arrow" href="${esc(url(adjacent(-1)))}" aria-label="Предыдущий месяц">‹</a><a class="ov-today" href="${esc(url(model.today.slice(0, 7), model.today))}">Сегодня</a><a class="ov-arrow" href="${esc(url(adjacent(1)))}" aria-label="Следующий месяц">›</a></div></div>
    <div class="ov-week" aria-hidden="true">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<span>${d}</span>`).join('')}</div><div class="ov-days">${cells.join('')}</div><div class="ov-calendar-footer"><span>${monthEvents.length} ${eventWord(monthEvents.length, mode)} · ${activeDays.length} ${plural(activeDays.length, 'активный день', 'активных дня', 'активных дней')}</span><span class="ov-legend">Реже ${[0, 1, 2, 3, 4].map((n) => `<i class="heat-${n}"></i>`).join('')} Чаще</span></div></div>
    <aside class="ov-day-feed"><div class="ov-feed-heading"><h3>${esc(dateLabel)}</h3><span>${rows.length} ${eventWord(rows.length, mode)}</span></div>${rows.length ? rows.map(({ post, platform, date }) => `<article class="ov-feed-post"><div class="ov-feed-meta"><span>${esc(post.name)}</span><time datetime="${esc(date)}">${esc(time(date).split(', ').at(-1))}${mode === 'posts' && post.estimated ? ' ≈' : ''}</time></div><a href="https://t.me/${encodeURIComponent(post.source)}/${encodeURIComponent(post.messageId)}" target="_blank" rel="noreferrer">${esc(post.preview || `Пост №${post.messageId}`)} <span aria-hidden="true">↗</span></a><div class="ov-feed-badges">${platform ? badge(platform === 'max' ? 'MAX · доставлен' : 'WhatsApp · доставлен', 'good') : `${post.max ? badge('MAX', 'good') : ''}${post.whatsapp ? badge('WhatsApp', 'good') : ''}${!post.max && !post.whatsapp ? badge('Только в источнике') : ''}`}</div></article>`).join('') : '<div class="ov-day-empty"><span aria-hidden="true">☷</span><h4>Спокойный день</h4><p>В сохранённой истории за этот день записей нет. Выберите выделенную дату в календаре.</p></div>'}</aside></div>
    <p class="ov-data-note">${mode === 'posts' ? 'Один исходный пост считается один раз, даже если отправлен на две площадки. ≈ — дата первой обработки, когда исходная дата не сохранилась.' : 'Одна доставка — один пост на одной площадке. Пост может состоять из нескольких сообщений.'} Календарь показывает сохранённую историю, запланированные посты здесь не учитываются.</p>
  </section>`;
}

export function renderDashboard(model, { csrf, waState = 'disconnected', notice = '', noticeError = false, imports = new Map(), createForm = '', ...options } = {}) {
  const { totals: t } = model;
  const active = model.channels.reduce((sum, c) => sum + Number(Boolean(c.enabled && c.target && !c.error)) + Number(Boolean(c.whatsapp.hasGroup && c.whatsapp.enabled && waState === 'connected')), 0);
  return `<style>${dashboardStyles}</style><main class="ov-dashboard"><header class="ov-heading"><div><p class="ov-kicker">Обзор · Multi Post</p><h1>Ваши каналы под контролем</h1><p>Подключения, доставки и ритм публикаций — в одном месте.</p></div><a class="ov-button primary" href="/dashboard?new=1#new"><span aria-hidden="true">+</span> Добавить канал</a></header>
    ${notice ? `<p class="notice${noticeError ? ' error' : ''}" role="status">${esc(notice)}</p>` : ''}
    <section class="ov-metrics" aria-label="Общая статистика"><article><span>Работают сейчас</span><strong>${active}<small> / ${model.channels.length * 2}</small></strong><p>направлений репоста</p></article><article><span>MAX · доставлено</span><strong>${number(t.max)}<small> ${postWord(t.max)}</small></strong><p>успешные публикации</p></article><article><span>WhatsApp · доставлено</span><strong>${number(t.whatsapp)}<small> ${postWord(t.whatsapp)}</small></strong><p>${number(t.messages)} ${plural(t.messages, 'подтверждённое', 'подтверждённых', 'подтверждённых')} ${messageWord(t.messages)}</p></article><article class="${t.issues ? 'ov-metric-warning' : ''}"><span>Сбои в истории</span><strong>${number(t.issues)}</strong><p><a href="/history">Открыть историю доставки ↗</a></p></article></section>
    <section class="ov-connections"><div class="ov-section-head"><div><p class="ov-kicker">Откуда и куда</p><h2>Подключения</h2></div><span class="ov-caption">Telegram → MAX / WhatsApp</span></div>
    ${model.channels.length ? model.channels.map((c) => channelCard(c, csrf, waState, imports.get(c.id), options.openImports)).join('') : `<article class="ov-empty"><h3>Подключите первый канал</h3><p>Добавьте источник в Telegram и канал MAX. WhatsApp можно подключить к этой же связке.</p><div class="ov-empty-platforms">${['telegram', 'max', 'whatsapp'].map((p) => `${icon(p)}<strong>${p === 'telegram' ? 'Telegram' : p === 'max' ? 'MAX' : 'WhatsApp'}</strong>${badge('Не подключено')}`).join('')}</div><a class="ov-button primary" href="/dashboard?new=1#new">Настроить подключения</a></article>`}</section>
    ${calendar(model, options)}
    <details class="ov-create" id="new" ${options.openNew || !model.channels.length ? 'open' : ''}><summary><span><strong>Добавить ещё один канал</strong><small>Источник Telegram → канал MAX, затем WhatsApp по желанию</small></span><span aria-hidden="true">+</span></summary><div class="ov-create-body">${createForm}</div></details>
    <p class="ov-data-note">Статистика по сохранённым данным сервиса. Для MAX учитываются посты: старые записи не хранят точное число частей сообщения. Статус WhatsApp проверяется при открытии страницы.</p>
  </main>`;
}
