// Service worker: показывает push-уведомления, когда приложение закрыто
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Свои файлы всегда сверяем с сервером: иначе браузер до 10 минут показывает старую версию сайта.
// Если файл не менялся, сервер отвечает коротким «304», так что лишнего трафика нет.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => fetch(req)));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused)) return;           // приложение открыто — там свой звук
    await self.registration.showNotification(d.title || 'Мессенджер', {
      body: d.body || 'Новое сообщение 🔒',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.conv || 'message',
      renotify: true,
      data: { conv: d.conv || null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conv = e.notification.data && e.notification.data.conv;
  const url = new URL(conv ? './#c=' + conv : './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (conv) w.postMessage({ open: conv });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
