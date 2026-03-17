// Service Worker — cache disabled, clear all old caches
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network only — no caching
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
