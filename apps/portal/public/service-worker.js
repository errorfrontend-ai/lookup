// Look Up's service worker (ADR-006 decision 7): it shows a client's notices ("Summer service offer airs soon") and opens
// the advert a tap is for. It caches nothing: every page and every answer still comes from the network. It is registered
// only from the client area.

const FALLBACK_NOTICE = { title: 'Look Up', body: 'Open Look Up to see your adverts.', url: '/client', tag: 'look-up' };

/** Only a page of the client area opens from a notice: never another site, never a station's pages. */
function clientAreaPath(url) {
  return typeof url === 'string' && /^\/client(\/[A-Za-z0-9/_-]*)?$/.test(url) ? url : '/client';
}

/** A notice from Look Up's server: a title, a line, a page and a tag, each cut to a sensible length. */
function readNotice(data) {
  try {
    const notice = data ? data.json() : null;
    if (!notice || typeof notice.title !== 'string' || typeof notice.body !== 'string') return FALLBACK_NOTICE;
    return {
      title: notice.title.slice(0, 120),
      body: notice.body.slice(0, 300),
      url: clientAreaPath(notice.url),
      tag: typeof notice.tag === 'string' ? notice.tag.slice(0, 120) : FALLBACK_NOTICE.tag,
    };
  } catch {
    // A message that is not Look Up's JSON still shows something: a push must always show a notification.
    return FALLBACK_NOTICE;
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const notice = readNotice(event.data);
  event.waitUntil(
    self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      data: { url: notice.url },
      icon: '/icons/look-up-192.png',
      badge: '/icons/look-up-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = clientAreaPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const opened = await client.navigate(url);
          if (opened) return opened.focus();
        } catch {
          // A window this worker does not control cannot be sent elsewhere: a new one opens instead.
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
