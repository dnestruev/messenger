// Service worker: показывает push-уведомления, когда приложение закрыто
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
