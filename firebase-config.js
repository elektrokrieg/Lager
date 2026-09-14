// firebase-config.js
// Diese Datei mit den Werten aus DEINEM Firebase-Projekt fuellen und als
// "firebase-config.js" (ohne ".example") neben index.html hochladen.
// Diese Werte sind NICHT geheim - sie duerfen oeffentlich im Quellcode
// stehen, die eigentliche Sicherheit kommt aus firestore.rules.
// Siehe docs/EINRICHTUNG.md Schritt 4.

// "self" statt "window" verwenden, damit dieselbe Datei sowohl in der
// normalen Seite als auch (per importScripts) im Service Worker
// funktioniert - beide kennen "self", nur die Seite kennt "window".
self.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCi1MetkbsTb16DxGjIyYb4mWknc6PkuKA",
  authDomain: "elektrokrieg-lager.firebaseapp.com",
  projectId: "elektrokrieg-lager",
  storageBucket: "elektrokrieg-lager.firebasestorage.app",
  messagingSenderId: "431502319427",
  appId: "1:431502319427:web:f0639c1b767327fc8199f6",
};

// Web-Push-Zertifikat (VAPID Key) aus Project Settings -> Cloud Messaging
self.FIREBASE_VAPID_KEY = "BOqpKInm0I2fbz_P6sAARiC8TeAFpjHs6dYa9EjEsaiCnJEfQWCr3_Btfqgwye_nJugNaKZP-rEpOA3RsyU2OEw";
