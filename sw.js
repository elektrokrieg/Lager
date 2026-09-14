// sw.js - Offline-Cache + Hintergrund-Push in einer Datei.
// WICHTIG: CACHE_NAME bei jedem Update hochzaehlen (siehe version.json),
// sonst laden Nutzer eine alte, zwischengespeicherte Version.
const CACHE_NAME = 'lager-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './backend.js',
  './firebase-adapter.js',
  './logic.js',
  './manifest.json',
  './firebase-config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Firebase/Firestore-Anfragen NIE aus dem Cache bedienen (Live-Daten!).
// Nur die statischen App-Dateien bekommen Cache-first mit Netzwerk-Fallback.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (event.request.method !== 'GET') return;
  if (url.includes('googleapis.com') || url.includes('firestore') || url.includes('gstatic.com/firebasejs')) {
    return; // Browser normal ans Netzwerk gehen lassen
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------------------------------------------------------------------
// Push-Benachrichtigungen im Hintergrund (App/Tab nicht offen).
// Nutzt den compat-Build, da klassische Service-Worker-Skripte kein
// "import" unterstuetzen. Die Firebase-Konfigurationswerte kommen aus
// firebase-config.js (per importScripts, self.FIREBASE_CONFIG).
// ---------------------------------------------------------------------
try {
  importScripts('firebase-config.js');
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

  if (self.FIREBASE_CONFIG) {
    firebase.initializeApp(self.FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || 'Lager Elektro Krieg';
      const body = payload.notification?.body || '';
      self.registration.showNotification(title, {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: payload.data || {},
      });
    });
  }
} catch (err) {
  // Falls FCM (noch) nicht konfiguriert ist, soll der reine Offline-Cache
  // trotzdem funktionieren.
  console.warn('Push-Setup im Service Worker uebersprungen:', err);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
