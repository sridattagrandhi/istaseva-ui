// Firebase Cloud Messaging service worker
// Handles background push notifications when the app tab is closed or not focused.
// This file must be at the root URL (/firebase-messaging-sw.js) — Vite serves
// everything in /public at the root, so no extra config needed.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// NOTE: These values are public (they're in the JS bundle anyway).
// The real security comes from Firebase Security Rules, not these keys.
// They are injected at build time — the service worker can't access
// import.meta.env so we read them from a config object posted by the main thread.

let messaging = null;

// The main thread will call postMessage({ type: 'FIREBASE_CONFIG', config: {...} })
// once the app loads. We cache it here so messaging can be initialised.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'FIREBASE_CONFIG') {
    const { config } = event.data;
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    messaging = firebase.messaging();

    // Handle background messages (tab closed / not focused)
    messaging.onBackgroundMessage((payload) => {
      const { title, body } = payload.notification ?? {};
      const link = payload.data?.link || '/';

      self.registration.showNotification(title || 'IstaSeva', {
        body: body || '',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        data: { link },
        vibrate: [200, 100, 200],
      });
    });
  }
});

// When a notification is clicked, open / focus the app at the correct URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it and navigate
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.navigate?.(link);
          return;
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) {
        return clients.openWindow(link);
      }
    })
  );
});
