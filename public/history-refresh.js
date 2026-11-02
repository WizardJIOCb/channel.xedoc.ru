(() => {
  let pending = false, submitting = false;
  let lastRefresh = Date.now();
  document.addEventListener('submit', (event) => {
    if (event.target.closest('#history-root') && !event.defaultPrevented) submitting = true;
  });
  async function refresh() {
    if (pending || submitting || document.hidden || Date.now() - lastRefresh < 55000) return;
    const root = document.getElementById('history-root');
    if (!root || root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
    pending = true;
    try {
      const url = new URL(location.href); url.pathname = '/history/fragment'; url.searchParams.delete('result');
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok || response.redirected) throw new Error('History refresh failed');
      const documentCopy = new DOMParser().parseFromString(await response.text(), 'text/html');
      const replacement = documentCopy.getElementById('history-root');
      if (!replacement) throw new Error('History response missing');
      const expanded = new Set([...root.querySelectorAll('details[open][data-expand]')].map((el) => el.dataset.expand));
      for (const el of replacement.querySelectorAll('details[data-expand]')) if (expanded.has(el.dataset.expand)) el.open = true;
      root.replaceWith(replacement); lastRefresh = Date.now();
    } catch {
      const state = root.querySelector('[data-sync-state]');
      if (state) state.textContent = 'Автообновление не удалось. Повторим через минуту.';
      lastRefresh = Date.now();
    } finally { pending = false; }
  }
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
})();
