// app.js
// UI-Steuerung. Kennt nur die Schnittstelle aus backend.js (Firebase in
// Produktion, Mock in Tests - siehe test/README.md) und die reine Logik
// aus logic.js. Enthaelt selbst keine Firebase-Aufrufe.

import * as backend from './backend.js';
import {
  filterMaterials,
  isLowStock,
  orderProgress,
  parseImportText,
  extractOrderNumberFromFilename,
  validateMaterialForm,
  isBuero,
  isMonteur,
  isAdmin,
} from './logic.js';

const state = {
  user: null,
  materials: [],
  orders: [],
  users: [],
  materialFilter: { search: '', category: '', onlyLowStock: false },
  view: 'lager',
  unsubMaterials: null,
  unsubOrders: null,
  unsubUsers: null,
  importDraft: null,
  openOrderId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtNum(n) {
  return new Intl.NumberFormat('de-DE').format(n);
}

// ------------------------------------------------------------------
// Bootstrapping / Auth
// ------------------------------------------------------------------
export function initApp(root = document) {
  wireAuthForms(root);

  backend.initAuth({
    onSignedIn: (user) => {
      state.user = user;
      showScreen('app');
      startSubscriptions();
      renderShellForRole();
      switchView('lager');
      backend.registerPushNotifications?.().catch(() => {});
    },
    onPending: (user) => {
      state.user = user;
      showScreen('pending');
    },
    onSignedOut: () => {
      state.user = null;
      stopSubscriptions();
      showScreen('login');
    },
  });

  window.addEventListener('lager:push', (e) => showToast(pushToText(e.detail)));
}

function pushToText(payload) {
  const n = payload?.notification || {};
  return `${n.title || 'Benachrichtigung'}: ${n.body || ''}`;
}

function wireAuthForms(root) {
  const loginForm = $('#login-form', root);
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#login-email', root).value.trim();
    const password = $('#login-password', root).value;
    setFormError('#login-error', '');
    try {
      await backend.signIn(email, password);
    } catch (err) {
      setFormError('#login-error', translateAuthError(err));
    }
  });

  const registerForm = $('#register-form', root);
  registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#register-email', root).value.trim();
    const password = $('#register-password', root).value;
    const name = $('#register-name', root).value.trim();
    setFormError('#register-error', '');
    try {
      await backend.signUp(email, password, name);
    } catch (err) {
      setFormError('#register-error', translateAuthError(err));
    }
  });

  $('#show-register', root)?.addEventListener('click', () => showScreen('register'));
  $('#show-login', root)?.addEventListener('click', () => showScreen('login'));
  $$('.btn-logout', root).forEach((b) => b.addEventListener('click', () => backend.signOutUser()));
}

function translateAuthError(err) {
  const code = err?.code || '';
  const map = {
    'auth/invalid-credential': 'E-Mail oder Passwort ist falsch.',
    'auth/wrong-password': 'E-Mail oder Passwort ist falsch.',
    'auth/user-not-found': 'Kein Konto mit dieser E-Mail gefunden.',
    'auth/email-already-in-use': 'Fuer diese E-Mail existiert bereits ein Konto.',
    'auth/weak-password': 'Passwort muss mindestens 6 Zeichen haben.',
    'auth/invalid-email': 'Ungueltige E-Mail-Adresse.',
  };
  return map[code] || err?.message || 'Unbekannter Fehler.';
}

function setFormError(sel, msg) {
  const el = $(sel);
  if (el) el.textContent = msg;
}

function showScreen(name) {
  $$('.screen').forEach((s) => s.hidden = s.dataset.screen !== name);
}

// ------------------------------------------------------------------
// Subscriptions
// ------------------------------------------------------------------
function startSubscriptions() {
  state.unsubMaterials = backend.subscribeMaterials((materials) => {
    state.materials = materials;
    if (state.view === 'lager') renderLager();
  });
  if (isBuero(state.user.role)) {
    state.unsubOrders = backend.subscribeOrders((orders) => {
      state.orders = orders;
      if (state.view === 'auftraege') renderAuftraege();
      // Ein offener Detail-Dialog liegt im globalen #dialog-slot (nicht
      // in #view-auftraege) und wird daher von renderAuftraege() nicht
      // beruehrt - hier gezielt mit den frischen Daten aktualisieren,
      // damit z.B. neu abgehakte Positionen sichtbar werden bzw. der
      // Dialog sich schliesst, wenn der Auftrag geloescht wurde.
      if (state.openOrderId) {
        const fresh = orders.find((o) => o.id === state.openOrderId);
        if (fresh) openOrderDetail(fresh);
        else closeDialog();
      }
    });
  }
  state.unsubUsers = backend.subscribeUsers((users) => {
    state.users = users;
    if (state.view === 'verwaltung') renderVerwaltung();
  });
}

function stopSubscriptions() {
  state.unsubMaterials?.();
  state.unsubOrders?.();
  state.unsubUsers?.();
}

// ------------------------------------------------------------------
// Navigation / Shell
// ------------------------------------------------------------------
function renderShellForRole() {
  const role = state.user.role;
  $$('[data-nav]').forEach((btn) => {
    const view = btn.dataset.nav;
    const allowed =
      view === 'lager' ||
      (view === 'auftraege' && isBuero(role)) ||
      (view === 'verwaltung' && isAdmin(role));
    btn.hidden = !allowed;
  });
  $('#current-user-name').textContent = state.user.displayName || state.user.email;
  $('#current-user-role').textContent = roleLabel(role);
  $$('[data-nav]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.nav)));
}

function roleLabel(role) {
  return { admin: 'Administrator', buero: 'Buero', monteur: 'Monteur', pending: 'Wartet auf Freischaltung' }[role] || role;
}

function switchView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.hidden = v.dataset.view !== view);
  $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  if (view === 'lager') renderLager();
  if (view === 'auftraege') renderAuftraege();
  if (view === 'verwaltung') renderVerwaltung();
}

// ------------------------------------------------------------------
// Lager (Materialbestand)
// ------------------------------------------------------------------
function renderLager() {
  const root = $('#view-lager');
  const canManage = isBuero(state.user.role);
  const canWithdraw = isMonteur(state.user.role) || canManage;

  const categories = Array.from(new Set(state.materials.map((m) => m.category).filter(Boolean))).sort();
  const filtered = filterMaterials(state.materials, state.materialFilter);
  const lowCount = state.materials.filter(isLowStock).length;

  root.innerHTML = `
    <div class="toolbar">
      <input type="search" id="mat-search" placeholder="Suchen (Name, Artikelnr., Lagerort ...)" value="${escapeHtml(state.materialFilter.search)}">
      <select id="mat-category">
        <option value="">Alle Kategorien</option>
        ${categories.map((c) => `<option value="${escapeHtml(c)}" ${c === state.materialFilter.category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <label class="checkbox">
        <input type="checkbox" id="mat-lowstock" ${state.materialFilter.onlyLowStock ? 'checked' : ''}>
        Nur unter Mindestbestand ${lowCount ? `<span class="badge badge-warn">${lowCount}</span>` : ''}
      </label>
      ${canManage ? `<button class="btn btn-primary" id="btn-new-material">+ Material anlegen</button>` : ''}
    </div>
    <table class="table" id="materials-table">
      <thead><tr>
        <th>Bezeichnung</th><th>Kategorie</th><th>Lagerort</th><th>Menge</th><th>Mindestbestand</th><th></th>
      </tr></thead>
      <tbody>
        ${filtered.map((m) => materialRow(m, canManage, canWithdraw)).join('') || `<tr><td colspan="6" class="empty">Keine Treffer.</td></tr>`}
      </tbody>
    </table>
  `;

  $('#mat-search').addEventListener('input', (e) => { state.materialFilter.search = e.target.value; renderLager(); });
  $('#mat-category').addEventListener('change', (e) => { state.materialFilter.category = e.target.value; renderLager(); });
  $('#mat-lowstock').addEventListener('change', (e) => { state.materialFilter.onlyLowStock = e.target.checked; renderLager(); });
  $('#btn-new-material')?.addEventListener('click', () => openMaterialDialog(null));

  $$('.btn-edit-material').forEach((b) => b.addEventListener('click', () => openMaterialDialog(findMaterial(b.dataset.id))));
  $$('.btn-delete-material').forEach((b) => b.addEventListener('click', () => confirmDeleteMaterial(b.dataset.id)));
  $$('.btn-withdraw').forEach((b) => b.addEventListener('click', () => openWithdrawDialog(findMaterial(b.dataset.id))));
}

function findMaterial(id) {
  return state.materials.find((m) => m.id === id);
}

function materialRow(m, canManage, canWithdraw) {
  const low = isLowStock(m);
  return `
    <tr class="${low ? 'row-warn' : ''}">
      <td>${escapeHtml(m.name)}${m.sku ? `<div class="muted">${escapeHtml(m.sku)}</div>` : ''}</td>
      <td>${escapeHtml(m.category || '')}</td>
      <td>${escapeHtml(m.location || '')}</td>
      <td>${fmtNum(m.quantity)} ${escapeHtml(m.unit || '')} ${low ? '<span class="badge badge-warn">niedrig</span>' : ''}</td>
      <td>${fmtNum(m.minQuantity)}</td>
      <td class="row-actions">
        ${canWithdraw ? `<button class="btn btn-small btn-withdraw" data-id="${m.id}">Entnehmen</button>` : ''}
        ${canManage ? `<button class="btn btn-small btn-edit-material" data-id="${m.id}">Bearbeiten</button>` : ''}
        ${canManage ? `<button class="btn btn-small btn-danger btn-delete-material" data-id="${m.id}">Loeschen</button>` : ''}
      </td>
    </tr>
  `;
}

function openMaterialDialog(material) {
  const slot = $('#dialog-slot');
  const isEdit = !!material;
  slot.innerHTML = dialogShell('material-dialog', isEdit ? 'Material bearbeiten' : 'Material anlegen', `
    <form id="material-form">
      <label>Bezeichnung *<input name="name" value="${escapeHtml(material?.name || '')}" required></label>
      <label>Artikelnummer<input name="sku" value="${escapeHtml(material?.sku || '')}"></label>
      <label>Kategorie<input name="category" value="${escapeHtml(material?.category || '')}"></label>
      <label>Lagerort<input name="location" value="${escapeHtml(material?.location || '')}"></label>
      <label>Einheit<input name="unit" value="${escapeHtml(material?.unit || 'Stk')}"></label>
      <label>Menge *<input name="quantity" type="number" step="any" value="${material?.quantity ?? 0}" required></label>
      <label>Mindestbestand *<input name="minQuantity" type="number" step="any" value="${material?.minQuantity ?? 0}" required></label>
      <label>Lieferant<input name="supplier" value="${escapeHtml(material?.supplier || '')}"></label>
      <label>Notizen<textarea name="notes">${escapeHtml(material?.notes || '')}</textarea></label>
      <div class="form-error" id="material-form-error"></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Abbrechen</button>
        <button type="submit" class="btn btn-primary">Speichern</button>
      </div>
    </form>
  `);
  wireDialogClose(slot);

  $('#material-form', slot).addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = formToObject(e.target);
    data.quantity = data.quantity === '' ? '' : Number(data.quantity);
    data.minQuantity = data.minQuantity === '' ? '' : Number(data.minQuantity);
    const { valid, errors } = validateMaterialForm(data);
    if (!valid) {
      $('#material-form-error', slot).textContent = Object.values(errors).join(' ');
      return;
    }
    try {
      if (isEdit) await backend.updateMaterial(material.id, data);
      else await backend.createMaterial(data);
      closeDialog();
    } catch (err) {
      $('#material-form-error', slot).textContent = err.message || 'Fehler beim Speichern.';
    }
  });
}

function confirmDeleteMaterial(id) {
  const m = findMaterial(id);
  if (!m) return;
  if (confirm(`"${m.name}" wirklich loeschen?`)) {
    backend.deleteMaterial(id).catch((err) => showToast(err.message));
  }
}

function openWithdrawDialog(material) {
  const slot = $('#dialog-slot');
  slot.innerHTML = dialogShell('withdraw-dialog', `Entnahme: ${escapeHtml(material.name)}`, `
    <form id="withdraw-form">
      <p class="muted">Aktueller Bestand: ${fmtNum(material.quantity)} ${escapeHtml(material.unit || '')}</p>
      <label>Entnommene Menge *<input name="amount" type="number" step="any" min="0" required autofocus></label>
      <label>Notiz (optional, z.B. Auftragsnummer)<input name="note"></label>
      <div class="form-error" id="withdraw-form-error"></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Abbrechen</button>
        <button type="submit" class="btn btn-primary">Entnehmen</button>
      </div>
    </form>
  `);
  wireDialogClose(slot);
  $('#withdraw-form', slot).addEventListener('submit', async (e) => {
    e.preventDefault();
    const { amount, note } = formToObject(e.target);
    try {
      await backend.withdrawStock(material, Number(amount), note);
      closeDialog();
    } catch (err) {
      $('#withdraw-form-error', slot).textContent = err.message;
    }
  });
}

// ------------------------------------------------------------------
// Auftraege
// ------------------------------------------------------------------
function renderAuftraege() {
  const root = $('#view-auftraege');
  root.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-primary" id="btn-new-order">+ Auftrag anlegen</button>
      <button class="btn" id="btn-import-order">Aus PDF/Text importieren</button>
    </div>
    <div class="order-list">
      ${state.orders.map(orderCard).join('') || '<p class="empty">Noch keine Auftraege.</p>'}
    </div>
  `;
  $('#btn-new-order').addEventListener('click', () => openOrderDialog(null));
  $('#btn-import-order').addEventListener('click', () => openImportDialog());
  $$('.order-card').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.closest('.btn-delete-order')) return;
    openOrderDetail(state.orders.find((o) => o.id === c.dataset.id));
  }));
  $$('.btn-delete-order').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('Auftrag wirklich loeschen?')) backend.deleteOrder(b.dataset.id).catch((err) => showToast(err.message));
  }));
}

function orderCard(o) {
  const { total, received } = orderProgress(o.positions);
  const complete = o.status === 'vollstaendig';
  return `
    <div class="order-card ${complete ? 'order-complete' : ''}" data-id="${o.id}">
      <div class="order-card-head">
        <strong>${escapeHtml(o.orderNumber || '(ohne Nummer)')}</strong>
        <span class="badge ${complete ? 'badge-ok' : 'badge-info'}">${received}/${total} eingegangen</span>
        <button class="btn btn-small btn-danger btn-delete-order" data-id="${o.id}">Loeschen</button>
      </div>
      <div class="muted">${escapeHtml(o.customer || '')}</div>
    </div>
  `;
}

function openOrderDialog(prefill) {
  const slot = $('#dialog-slot');
  const positions = prefill?.positions || [];
  slot.innerHTML = dialogShell('order-dialog', 'Auftrag anlegen', `
    <form id="order-form">
      <label>Auftragsnummer *<input name="orderNumber" value="${escapeHtml(prefill?.orderNumber || '')}" required></label>
      <label>Kunde<input name="customer" value="${escapeHtml(prefill?.customer || '')}"></label>
      <fieldset>
        <legend>Materialpositionen</legend>
        <div id="positions-list">${positions.map((p, i) => positionRow(p, i)).join('')}</div>
        <button type="button" class="btn btn-small" id="btn-add-position">+ Position</button>
      </fieldset>
      <fieldset>
        <legend>Benachrichtigen wenn vollstaendig eingegangen</legend>
        <div id="notify-list">
          ${state.users.filter((u) => u.active).map((u) => `
            <label class="checkbox">
              <input type="checkbox" name="notify" value="${u.id}" ${prefill?.notifyUserIds?.includes(u.id) ? 'checked' : ''}>
              ${escapeHtml(u.displayName || u.email)} (${roleLabel(u.role)})
            </label>`).join('')}
        </div>
      </fieldset>
      <div class="form-error" id="order-form-error"></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Abbrechen</button>
        <button type="submit" class="btn btn-primary">Speichern</button>
      </div>
    </form>
  `);
  wireDialogClose(slot);
  wirePositionsList(slot);

  $('#order-form', slot).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const orderNumber = form.orderNumber.value.trim();
    const customer = form.customer.value.trim();
    const notifyUserIds = $$('input[name="notify"]:checked', form).map((i) => i.value);
    const positionsData = readPositionsFromForm(slot);
    if (!orderNumber) {
      $('#order-form-error', slot).textContent = 'Auftragsnummer ist erforderlich.';
      return;
    }
    if (positionsData.length === 0) {
      $('#order-form-error', slot).textContent = 'Mindestens eine Materialposition erforderlich.';
      return;
    }
    try {
      await backend.createOrder({ orderNumber, customer, notifyUserIds, positions: positionsData, sourceType: prefill?.sourceType || 'manual' });
      closeDialog();
    } catch (err) {
      $('#order-form-error', slot).textContent = err.message;
    }
  });
}

function positionRow(p, i) {
  const id = p.id || `pos-${i}-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div class="position-row" data-pos-id="${id}">
      <input type="text" class="pos-desc" placeholder="Bezeichnung" value="${escapeHtml(p.description || '')}">
      <input type="number" step="any" class="pos-qty" placeholder="Menge" value="${p.quantityOrdered ?? ''}">
      <input type="text" class="pos-unit" placeholder="Einheit" value="${escapeHtml(p.unit || 'Stk')}" style="width:5em">
      <button type="button" class="btn btn-small btn-danger btn-remove-position">x</button>
    </div>
  `;
}

function wirePositionsList(root) {
  const list = $('#positions-list', root);
  $('#btn-add-position', root)?.addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', positionRow({}, list.children.length));
    wireRemoveButtons(list);
  });
  wireRemoveButtons(list);
}

function wireRemoveButtons(list) {
  $$('.btn-remove-position', list).forEach((b) => {
    b.onclick = () => b.closest('.position-row').remove();
  });
}

function readPositionsFromForm(root) {
  return $$('.position-row', root)
    .map((row) => ({
      id: row.dataset.posId,
      description: $('.pos-desc', row).value.trim(),
      quantityOrdered: Number($('.pos-qty', row).value) || 0,
      unit: $('.pos-unit', row).value.trim() || 'Stk',
      received: false,
    }))
    .filter((p) => p.description);
}

function openImportDialog() {
  const slot = $('#dialog-slot');
  slot.innerHTML = dialogShell('import-dialog', 'Auftrag importieren', `
    <div class="import-step" id="import-step-1">
      <label>PDF-Datei waehlen<input type="file" id="import-file" accept="application/pdf"></label>
      <p class="muted">oder Text aus dem Angebot/der Bestellung hier einfuegen:</p>
      <textarea id="import-text" rows="10" placeholder="Text einfuegen (Strg+V) ..."></textarea>
      <div class="form-error" id="import-error"></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Abbrechen</button>
        <button type="button" class="btn btn-primary" id="btn-parse-import">Weiter</button>
      </div>
    </div>
  `);
  wireDialogClose(slot);

  let selectedFileName = '';
  $('#import-file', slot).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedFileName = file.name;
    try {
      const text = await extractPdfText(file);
      $('#import-text', slot).value = text;
    } catch (err) {
      $('#import-error', slot).textContent = 'PDF konnte nicht gelesen werden: ' + err.message;
    }
  });

  $('#btn-parse-import', slot).addEventListener('click', () => {
    const text = $('#import-text', slot).value;
    if (!text.trim()) {
      $('#import-error', slot).textContent = 'Bitte PDF waehlen oder Text einfuegen.';
      return;
    }
    const draft = parseImportText(text);
    // Eigene Auftragsnummer aus dem Dateinamen (z.B. "767 - EK Bibra.pdf")
    // hat Vorrang vor der im PDF-Text gefundenen Belegnummer, da Christian
    // im Alltag mit dieser eigenen Nummer arbeitet.
    const fileNumber = extractOrderNumberFromFilename(selectedFileName);
    if (fileNumber) {
      draft.orderNumber = fileNumber;
      draft.warnings = draft.warnings.filter(
        (w) => w !== 'Auftragsnummer konnte nicht automatisch erkannt werden.'
      );
    }
    renderImportReview(slot, draft);
  });
}

async function extractPdfText(file) {
  const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += reconstructPdfLines(content.items) + '\n';
  }
  return text;
}

// pdf.js liefert nur einzelne Textfragmente mit Position, aber standardmaessig
// keine Zeilenumbrueche zwischen ihnen. parseImportText() braucht aber die
// Zeilenstruktur (z.B. um "Objekt:"-Zeilen und die Positionstabelle zu
// erkennen), deshalb hier ueber "hasEOL" (von pdf.js pro Fragment gesetzt,
// sobald visuell eine neue Zeile beginnt) selbst nachgebaut.
function reconstructPdfLines(items) {
  let text = '';
  for (const item of items) {
    text += item.str;
    text += item.hasEOL ? '\n' : ' ';
  }
  return text;
}

function renderImportReview(slot, draft) {
  slot.innerHTML = dialogShell('import-dialog', 'Import pruefen', `
    <form id="import-review-form">
      <p class="muted">Bitte pruefen und bei Bedarf korrigieren - es wird nichts automatisch uebernommen.</p>
      ${draft.warnings.length ? `<div class="warning-box">${draft.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
      <label>Auftragsnummer *<input name="orderNumber" value="${escapeHtml(draft.orderNumber)}" required></label>
      <label>Kunde<input name="customer" value="${escapeHtml(draft.customer)}"></label>
      <fieldset>
        <legend>Erkannte Materialpositionen</legend>
        <div id="positions-list">${draft.positions.map((p, i) => positionRow(p, i)).join('') || ''}</div>
        <button type="button" class="btn btn-small" id="btn-add-position">+ Position</button>
      </fieldset>
      <fieldset>
        <legend>Benachrichtigen wenn vollstaendig eingegangen</legend>
        <div id="notify-list">
          ${state.users.filter((u) => u.active).map((u) => `
            <label class="checkbox">
              <input type="checkbox" name="notify" value="${u.id}">
              ${escapeHtml(u.displayName || u.email)} (${roleLabel(u.role)})
            </label>`).join('')}
        </div>
      </fieldset>
      <div class="form-error" id="order-form-error"></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Abbrechen</button>
        <button type="submit" class="btn btn-primary">Auftrag speichern</button>
      </div>
    </form>
  `);
  wireDialogClose(slot);
  wirePositionsList(slot);

  $('#import-review-form', slot).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const orderNumber = form.orderNumber.value.trim();
    const customer = form.customer.value.trim();
    const notifyUserIds = $$('input[name="notify"]:checked', form).map((i) => i.value);
    const positionsData = readPositionsFromForm(slot);
    if (!orderNumber || positionsData.length === 0) {
      $('#order-form-error', slot).textContent = 'Auftragsnummer und mindestens eine Position sind erforderlich.';
      return;
    }
    try {
      await backend.createOrder({ orderNumber, customer, notifyUserIds, positions: positionsData, sourceType: 'import' });
      closeDialog();
    } catch (err) {
      $('#order-form-error', slot).textContent = err.message;
    }
  });
}

function openOrderDetail(order) {
  const slot = $('#dialog-slot');
  state.openOrderId = order.id;
  const { total, received } = orderProgress(order.positions);
  slot.innerHTML = dialogShell('order-detail-dialog', `Auftrag ${escapeHtml(order.orderNumber)}`, `
    <p class="muted">${escapeHtml(order.customer || '')} - ${received}/${total} eingegangen</p>
    <div class="position-checklist">
      ${order.positions.map((p) => `
        <label class="checkbox position-check">
          <input type="checkbox" data-pos="${p.id}" ${p.received ? 'checked' : ''}>
          ${escapeHtml(p.description)} - ${fmtNum(p.quantityOrdered)} ${escapeHtml(p.unit)}
          ${p.received ? `<span class="muted"> (${escapeHtml(p.receivedByName || '')})</span>` : ''}
        </label>
      `).join('')}
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" data-close>Schliessen</button>
    </div>
  `);
  wireDialogClose(slot);
  $$('.position-check input', slot).forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await backend.setPositionReceived(order, cb.dataset.pos, cb.checked);
      } catch (err) {
        showToast(err.message);
        cb.checked = !cb.checked;
      }
    });
  });
}

// ------------------------------------------------------------------
// Verwaltung (Admin: Benutzer/Rollen)
// ------------------------------------------------------------------
function renderVerwaltung() {
  const root = $('#view-verwaltung');
  root.innerHTML = `
    <table class="table">
      <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.users.map(userRow).join('')}
      </tbody>
    </table>
  `;
  $$('.btn-save-role', root).forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const role = $('.role-select', row).value;
    const active = $('.active-select', row).value === 'true';
    b.disabled = true;
    try {
      await backend.setUserRole(row.dataset.uid, role, active);
      showToast('Gespeichert.');
    } catch (err) {
      showToast(err.message);
    } finally {
      b.disabled = false;
    }
  }));
}

function userRow(u) {
  return `
    <tr data-uid="${u.id}">
      <td>${escapeHtml(u.displayName || '')}</td>
      <td>${escapeHtml(u.email || '')}</td>
      <td>
        <select class="role-select">
          ${['pending', 'monteur', 'buero', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="active-select">
          <option value="true" ${u.active ? 'selected' : ''}>Aktiv</option>
          <option value="false" ${!u.active ? 'selected' : ''}>Gesperrt</option>
        </select>
      </td>
      <td><button class="btn btn-small btn-save-role">Speichern</button></td>
    </tr>
  `;
}

// ------------------------------------------------------------------
// Kleine UI-Helfer
// ------------------------------------------------------------------
function dialogShell(id, title, bodyHtml) {
  return `
    <div class="dialog-backdrop" id="${id}">
      <div class="dialog">
        <div class="dialog-head"><h2>${escapeHtml(title)}</h2><button class="btn-icon" data-close>x</button></div>
        <div class="dialog-body">${bodyHtml}</div>
      </div>
    </div>
  `;
}

function closeDialog() {
  const slot = $('#dialog-slot');
  if (slot) slot.innerHTML = '';
  state.openOrderId = null;
}

function wireDialogClose(slot) {
  $$('[data-close]', slot).forEach((b) => b.addEventListener('click', closeDialog));
  $('.dialog-backdrop', slot)?.addEventListener('click', (e) => {
    if (e.target.classList.contains('dialog-backdrop')) closeDialog();
  });
}

function formToObject(form) {
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = v; });
  return data;
}

let toastTimer = null;
function showToast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// Fuer Tests zugaenglich machen
export const __internal = { state, filterMaterials };
