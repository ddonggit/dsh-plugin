/**
 * dsh-mobile: deep links into one session.
 *
 * `?token=<token>#session=<id>` survives the auth redirect; `#session=<id>` and
 * `?session=<id>` work once a login cookie exists. The parameter is removed
 * from the address bar after it is consumed, and a later hash change switches
 * session without a reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.deeplink.js',

  factory() {
function readDeepLink() {
  const url = new URL(window.location.href);
  const fromSearch = url.searchParams.get('session');
  if (fromSearch) return { sessionId: fromSearch, source: 'search' };
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromHash = hash.get('session');
  return fromHash ? { sessionId: fromHash, source: 'hash' } : null;
}

function dropDeepLink(source) {
  const url = new URL(window.location.href);
  if (source === 'search') url.searchParams.delete('session');
  else {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    hash.delete('session');
    const rest = hash.toString();
    url.hash = rest ? `#${rest}` : '';
  }
  if (url.href !== window.location.href) {
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

function installDeepLink(ctx, openSession) {
  const link = readDeepLink();
  if (!link) return () => {};
  const { sessionId, source } = link;

  // The shell restores the last selected Session asynchronously after boot and
  // that restore wins over an earlier openSession(). Retry while the restored
  // title does not match the deep-linked Session; a user interaction cancels.
  const RETRY_MS = [0, 1000, 2200, 3800, 6000];
  let settled = false;
  let cancelled = false;
  let index = 0;
  let timer;
  let retryTimer;
  let off = () => {};

  const cleanup = () => {
    settled = true;
    window.clearTimeout(timer);
    window.clearTimeout(retryTimer);
    off();
    off = () => {};
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
    dropDeepLink(source);
  };

  const cancel = () => {
    if (settled) return;
    cancelled = true;
  };

  const targetTitle = () => {
    const row = ctx.sessions.list.getSnapshot()?.byId?.[sessionId];
    return (row?.displayTitle ?? '').trim();
  };

  const matches = () => {
    const title = targetTitle();
    if (!title) return false;
    return document.title.startsWith(title);
  };

  const attempt = () => {
    if (settled || cancelled) {
      if (cancelled) cleanup();
      return;
    }
    openSession(ctx, sessionId);
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (settled) return;
      if (matches()) {
        cleanup();
        return;
      }
      index += 1;
      if (index < RETRY_MS.length) timer = window.setTimeout(attempt, RETRY_MS[index] - RETRY_MS[index - 1]);
      else cleanup();
    }, 300);
  };

  const onSnapshot = () => {
    if (settled || cancelled) return;
    const snapshot = ctx.sessions.list.getSnapshot();
    if (snapshot?.phase !== 'ready') return;
    off();
    off = () => {};
    attempt();
  };

  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  off = ctx.sessions.list.subscribe(onSnapshot);
  window.setTimeout(onSnapshot, 0);
  return () => {
    settled = true;
    window.clearTimeout(timer);
    window.clearTimeout(retryTimer);
    off();
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
  };
}

function watchHashDeepLink(ctx, openSession) {
  const onHashChange = () => {
    const link = readDeepLink();
    if (!link || link.source !== 'hash') return;
    openSession(ctx, link.sessionId);
    dropDeepLink('hash');
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}

return { installDeepLink, watchHashDeepLink };
  },
});
