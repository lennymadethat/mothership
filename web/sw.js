/* Mothership service worker — app-shell cache + payload-free push */
const VERSION = 'ms-v11';
const SHELL = [
  '/', '/manifest.webmanifest',
  '/css/app.css',
  '/js/app.js', '/js/views/sessions.js', '/js/views/terminal.js', '/js/views/files.js', '/js/views/fleet.js',
  '/js/views/machine.js', '/js/views/history.js', '/js/views/settings.js',
  '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/xterm-addon-fit.js', '/vendor/marked.min.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network-first: always try to show the freshest deploy, fall back to cache offline
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Payload-free push (the wire carries nothing): on arrival, fetch the latest
// recorded notification and show its real content, tagged per-session so
// multiple events stack instead of silently replacing each other.
// Bridge tags look like claude-<key> / roll-<key> / beam-<key> → deep-link to that chat.
const sessionUrlFromTag = (tag) => {
  const m = /^(?:claude|roll|beam)-(.+)$/.exec(tag || '');
  return m ? `/#/sessions/${m[1]}` : '/';
};

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let n = null;
    try {
      const res = await fetch('/api/notifications');
      n = (await res.json()).notifications?.[0] || null;
    } catch { /* offline or token-gated hub: fall back to the generic card */ }
    return self.registration.showNotification(n?.title || 'Mothership', {
      body: n?.body || 'Activity on your fleet — open to see what happened.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: n?.tag || `mothership-${Date.now()}`,
      data: { url: sessionUrlFromTag(n?.tag) },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ navigate: url }); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
