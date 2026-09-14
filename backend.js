// backend.js
// Duenne Weiche zwischen echtem Firebase-Adapter (Produktion) und dem
// Test-Mock (siehe test/backend.mock.js). app.js importiert IMMER von
// hier, nie direkt von firebase-adapter.js - so kann der Testaufbau
// diese eine Datei austauschen, ohne app.js anzufassen.
export * from './firebase-adapter.js';
