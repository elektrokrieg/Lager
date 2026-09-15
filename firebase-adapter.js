// firebase-adapter.js
// Einzige Datei, die direkt mit Firebase spricht. app.js kennt nur diese
// Schnittstelle (initAuth, subscribeMaterials, createOrder, ...) und
// nichts von Firebase selbst - dadurch laesst sich app.js in Tests mit
// einer gefaelschten Version dieser Datei (firebase-adapter.mock.js)
// betreiben, ohne echte Firebase-Verbindung.
//
// Setzt voraus, dass firebase-config.js VOR dieser Datei geladen wurde
// und ein globales `self.FIREBASE_CONFIG` sowie `self.FIREBASE_VAPID_KEY`
// bereitstellt (siehe firebase-config.example.js).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  getDoc,
  serverTimestamp,
  query,
  orderBy,
  where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getMessaging,
  getToken,
  onMessage,
  isSupported as isMessagingSupported,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

import { validateEntnahme, validateMonteurEntnahme } from './logic.js';

const app = initializeApp(self.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'europe-west1');

let currentUserProfile = null;

export function initAuth({ onSignedIn, onSignedOut, onPending }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUserProfile = null;
      onSignedOut();
      return;
    }
    const profileRef = doc(db, 'users', user.uid);
    // Auf das vom Cloud Function "bootstrapUser" angelegte Profil warten
    // (kann beim allerersten Login/Registrieren einen Moment dauern).
    const profile = await waitForUserProfile(profileRef);
    currentUserProfile = { uid: user.uid, email: user.email, ...profile };

    if (!profile.active) {
      onPending(currentUserProfile);
      return;
    }
    onSignedIn(currentUserProfile);
  });
}

async function waitForUserProfile(ref, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const snap = await getDoc(ref);
    if (snap.exists()) return snap.data();
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Benutzerprofil konnte nicht geladen werden. Bitte Seite neu laden.');
}

export function getCurrentUserProfile() {
  return currentUserProfile;
}

export async function signIn(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }
  // Legt das zugehoerige Firestore-Profil an (Cloud Function "registerUser" -
  // siehe functions/index.js). Der Nutzer ist zu diesem Zeitpunkt bereits
  // angemeldet, sein ID-Token ist also gueltig. Ohne dies bliebe der
  // Account ohne users/{uid}-Dokument und damit ohne jede Berechtigung.
  await httpsCallable(functions, 'registerUser')();
}

export async function signOutUser() {
  await signOut(auth);
}

// -------------------- Material / Lager --------------------

export function subscribeMaterials(callback) {
  const q = query(collection(db, 'materials'), orderBy('name'));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function createMaterial(data) {
  await addDoc(collection(db, 'materials'), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: currentUserProfile.uid,
    updatedByName: currentUserProfile.displayName || currentUserProfile.email,
  });
}

export async function updateMaterial(id, data) {
  await updateDoc(doc(db, 'materials', id), {
    ...data,
    updatedAt: serverTimestamp(),
    updatedBy: currentUserProfile.uid,
    updatedByName: currentUserProfile.displayName || currentUserProfile.email,
  });
}

export async function deleteMaterial(id) {
  await deleteDoc(doc(db, 'materials', id));
}

// Entnahme durch Monteure (und Korrekturen durch Buero) - schreibt sowohl
// die neue Menge als auch einen Log-Eintrag in materialMovements.
export async function withdrawStock(material, amount, note) {
  const result = validateEntnahme(material, amount);
  if (!result.valid) throw new Error(result.error);

  const newData = {
    quantity: result.newQuantity,
    updatedAt: serverTimestamp(),
    updatedBy: currentUserProfile.uid,
    updatedByName: currentUserProfile.displayName || currentUserProfile.email,
  };

  // Clientseitige Vorabpruefung (freundliche Fehlermeldung). Die
  // verbindliche Pruefung erfolgt serverseitig durch firestore.rules.
  if (!currentUserProfile.role || currentUserProfile.role === 'monteur') {
    const check = validateMonteurEntnahme(material, { ...material, ...newData, updatedAt: material.updatedAt });
    if (!check.ok) throw new Error(check.reason);
  }

  await updateDoc(doc(db, 'materials', material.id), newData);
  await addDoc(collection(db, 'materialMovements'), {
    materialId: material.id,
    materialName: material.name,
    delta: -Math.abs(amount),
    type: 'entnahme',
    userId: currentUserProfile.uid,
    userName: currentUserProfile.displayName || currentUserProfile.email,
    note: note || '',
    timestamp: serverTimestamp(),
  });
}

// -------------------- Auftraege --------------------

// Buero/Admin sehen alle Auftraege (ohne Einschraenkung). Monteure sehen
// per firestore.rules NUR Auftraege, bei denen sie unter "Benachrichtigen
// wenn vollstaendig eingegangen" eingetragen sind - dafuer MUSS hier schon
// serverseitig gefiltert werden (options.forUid), da eine ungefilterte
// Abfrage fuer Monteure sonst komplett von den Regeln abgelehnt wuerde.
export function subscribeOrders(callback, options = {}) {
  const constraints = options.forUid ? [where('notifyUserIds', 'array-contains', options.forUid)] : [];
  const q = query(collection(db, 'orders'), ...constraints, orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function createOrder(data) {
  await addDoc(collection(db, 'orders'), {
    ...data,
    status: 'offen',
    notifiedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: currentUserProfile.uid,
    createdByName: currentUserProfile.displayName || currentUserProfile.email,
  });
}

export async function updateOrder(id, data) {
  await updateDoc(doc(db, 'orders', id), { ...data, updatedAt: serverTimestamp() });
}

export async function setPositionReceived(order, positionId, received) {
  const positions = order.positions.map((p) =>
    p.id === positionId
      ? {
          ...p,
          received,
          receivedAt: received ? new Date().toISOString() : null,
          receivedBy: received ? currentUserProfile.uid : null,
          receivedByName: received ? currentUserProfile.displayName || currentUserProfile.email : null,
        }
      : p
  );
  await updateOrder(order.id, { positions });
}

export async function deleteOrder(id) {
  await deleteDoc(doc(db, 'orders', id));
}

// -------------------- Benutzerverwaltung --------------------

export function subscribeUsers(callback) {
  return onSnapshot(collection(db, 'users'), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function setUserRole(uid, role, active) {
  const fn = httpsCallable(functions, 'setUserRole');
  await fn({ uid, role, active });
}

// -------------------- Push-Benachrichtigungen --------------------

export async function registerPushNotifications() {
  const supported = await isMessagingSupported().catch(() => false);
  if (!supported) return { ok: false, reason: 'Push wird auf diesem Geraet/Browser nicht unterstuetzt.' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'Berechtigung fuer Benachrichtigungen wurde nicht erteilt.' };

  const messaging = getMessaging(app);
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, {
    vapidKey: self.FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });

  await updateDoc(doc(db, 'users', currentUserProfile.uid), {
    [`fcmTokens.${token}`]: { device: navigator.userAgent.slice(0, 120), addedAt: new Date().toISOString() },
  });

  onMessage(messaging, (payload) => {
    // Vordergrund-Benachrichtigung (App gerade offen) - eigenes Popup,
    // da der Browser bei aktivem Tab keine System-Notification zeigt.
    window.dispatchEvent(new CustomEvent('lager:push', { detail: payload }));
  });

  return { ok: true };
}
