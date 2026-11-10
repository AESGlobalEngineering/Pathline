// Pathline Monitor's service worker: keeps the app's own files so it opens at once, and shows
// the notifications the Monitor service pushes.
'use strict';
const CACHE = 'pathline-monitor-1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'icon-192.png', 'badge-72.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

// the app's files: the network first (so an update shows straight away), the kept copy when
// the workshop network can't be reached. Live data (/api/) is never kept.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Pathline Monitor', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pathline Monitor', {
    body: d.body || '', icon: 'icon-192.png', badge: 'badge-72.png',
    // one notification per machine: a newer one replaces the last, and still sounds
    tag: d.machine || 'pathline', renotify: !d.silent, silent: !!d.silent,
    data: { machine: d.machine || null },
  }));
});

// tapping it opens the app on that machine
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const m = e.notification.data && e.notification.data.machine;
  const url = new URL(m ? '#m-' + encodeURIComponent(m) : '#alerts', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url.startsWith(self.registration.scope)) { c.postMessage({ open: m }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
