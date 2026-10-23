/* Service worker di Giornata: rende l'app installabile e riceve le notifiche push */

// Tocco su una notifica mostrata dall'app (prova o notifica ad app aperta): apre/porta in primo piano Giornata.
// Le notifiche push arrivate ad app chiusa le gestisce Firebase (campo FCM_MSG), quindi qui le salto.
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  if (data.FCM_MSG) return;
  event.notification.close();
  const url = data.url || self.registration.scope;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
    }
    return clients.openWindow(url);
  })());
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDN8_KV1QQnNQK4hQ-7i9882Z_3hHx9rbg",
  authDomain: "calendar-4e472.firebaseapp.com",
  projectId: "calendar-4e472",
  storageBucket: "calendar-4e472.firebasestorage.app",
  messagingSenderId: "267721830851",
  appId: "1:267721830851:web:f213d24d00f6e50af90d76",
});

// Ad app chiusa Firebase mostra da solo la notifica (titolo, testo, icona) inviata dal controllo automatico.
firebase.messaging();
