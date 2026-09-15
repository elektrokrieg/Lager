// logic.js
// Reine, framework- und Firebase-unabhaengige Geschaeftslogik.
// Bewusst getrennt von app.js/firebase-adapter.js, damit sich diese
// Funktionen ohne Browser und ohne Firebase-Verbindung automatisiert
// testen lassen (siehe test/logic.test.js).
//
// WICHTIG: Aenderungen an der "nur Menge verringern"-Regel fuer Monteure
// oder an der "Auftrag vollstaendig"-Logik muessen sowohl hier als auch
// in firestore.rules / functions/index.js nachgezogen werden. Die Tests
// in test/rulesMirror.test.js pruefen, dass beide Seiten uebereinstimmen.

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  BUERO: 'buero',
  MONTEUR: 'monteur',
  PENDING: 'pending',
});

export function isBuero(role) {
  return role === ROLES.BUERO || role === ROLES.ADMIN;
}

export function isMonteur(role) {
  return role === ROLES.MONTEUR;
}

export function isAdmin(role) {
  return role === ROLES.ADMIN;
}

export function canManageMaterials(role) {
  return isBuero(role);
}

export function canManageOrders(role) {
  return isBuero(role);
}

export function canOnlyWithdrawStock(role) {
  return isMonteur(role);
}

// Muss WORTGLEICH mit der Feldliste in isOnlyMonteurEntnahme() in
// firestore.rules uebereinstimmen. test/rules-consistency.test.js prueft
// das automatisch, damit beide Seiten nicht auseinanderlaufen.
export const ALLOWED_MONTEUR_FIELDS = ['quantity', 'updatedAt', 'updatedBy', 'updatedByName'];

/**
 * Prueft, ob eine von einem Monteur vorgenommene Aenderung an einem
 * Material-Dokument erlaubt waere. Spiegelt 1:1 die Firestore-Regel
 * isOnlyMonteurEntnahme() in firestore.rules.
 *
 * @param {object} oldData - aktueller Stand des Dokuments
 * @param {object} newData - vorgeschlagener neuer Stand
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateMonteurEntnahme(oldData, newData) {
  const allowedKeys = new Set(ALLOWED_MONTEUR_FIELDS);
  const changedKeys = Object.keys(newData).filter((k) => !deepEqual(newData[k], oldData[k]));

  for (const key of changedKeys) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `Feld "${key}" darf von Monteuren nicht geaendert werden.` };
    }
  }
  if (typeof newData.quantity !== 'number' || Number.isNaN(newData.quantity)) {
    return { ok: false, reason: 'Menge muss eine Zahl sein.' };
  }
  if (newData.quantity < 0) {
    return { ok: false, reason: 'Menge darf nicht negativ werden.' };
  }
  if (!(newData.quantity < oldData.quantity)) {
    return { ok: false, reason: 'Monteure duerfen die Menge nur verringern (Entnahme), nicht erhoehen.' };
  }
  return { ok: true };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Ermittelt, ob ein Material unter dem festgelegten Mindestbestand liegt.
 */
export function isLowStock(material) {
  if (typeof material.minQuantity !== 'number') return false;
  return material.quantity <= material.minQuantity;
}

/**
 * Filtert/sucht in der Materialliste. Reine Client-Filterfunktion,
 * damit die App auch offline (Service Worker Cache) durchsuchbar bleibt.
 *
 * @param {Array<object>} materials
 * @param {object} opts - { search, category, onlyLowStock }
 */
export function filterMaterials(materials, opts = {}) {
  const { search = '', category = '', onlyLowStock = false } = opts;
  const needle = normalize(search);

  return materials.filter((m) => {
    if (onlyLowStock && !isLowStock(m)) return false;
    if (category && m.category !== category) return false;
    if (!needle) return true;
    const haystack = normalize(
      [m.name, m.sku, m.category, m.location, m.supplier, m.notes].filter(Boolean).join(' ')
    );
    return haystack.includes(needle);
  });
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Umlaute/Akzente fuer Suche vereinheitlichen
    .trim();
}

/**
 * Bestimmt, ob alle Positionen eines Auftrags als eingegangen markiert sind.
 * Ein Auftrag ohne Positionen gilt NICHT automatisch als vollstaendig.
 */
export function allPositionsReceived(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return false;
  return positions.every((p) => p.received === true);
}

/**
 * Leitet den Auftragsstatus aus den Positionen ab.
 */
export function computeOrderStatus(positions) {
  return allPositionsReceived(positions) ? 'vollstaendig' : 'offen';
}

/**
 * Zaehlt offene/eingegangene Positionen fuer die Fortschrittsanzeige.
 */
export function orderProgress(positions) {
  const total = Array.isArray(positions) ? positions.length : 0;
  const received = Array.isArray(positions) ? positions.filter((p) => p.received).length : 0;
  return { total, received, open: total - received };
}

// ---------------------------------------------------------------------
// "Material eingegangen" - Herkunft "aus Lager"
// ---------------------------------------------------------------------
// Positionstexte aus Angeboten enthalten oft eine Montage-Floskel
// ("Sperrelement liefern und montieren"), die beim Suchen im Lager
// stoert (dort heisst das Material einfach "Sperrelement"). Diese
// Floskeln werden fuer die Lager-Suche entfernt - der Auftragstext
// selbst bleibt unveraendert, nur die SUCHE nutzt den bereinigten Namen.
const INSTALL_SUFFIX_RE = new RegExp(
  '\\s*(?:' +
    [
      'liefern\\s+(?:und|u\\.?)\\s+montieren',
      'liefern\\s+(?:und|u\\.?)\\s+mont\\.?',
      'liefern\\s+(?:und|u\\.?)\\s+einbauen',
      'liefern\\s+(?:und|u\\.?)\\s+anschlie(?:ß|ss)en',
      'liefern',
      'montieren',
      'mont\\.?',
      'einbauen',
    ].join('|') +
    ')\\.?\\s*$',
  'i'
);

export function cleanMaterialSearchName(description) {
  const original = String(description || '').trim();
  let name = original;
  let previous;
  do {
    previous = name;
    name = name.replace(INSTALL_SUFFIX_RE, '').trim();
  } while (name !== previous && name.length > 0);
  return name || original;
}

// Sucht im Lagerbestand nach Material, dessen Name zum (bereinigten)
// Positionstext passt. Bewusst tolerant (Teilstring in beide Richtungen),
// da Bezeichnungen im Angebot und im Lager selten wortgleich sind - das
// Ergebnis wird dem Nutzer immer zur Auswahl/Bestaetigung vorgelegt.
export function findMatchingMaterials(materials, searchName) {
  const needle = String(searchName || '').trim().toLowerCase();
  if (!needle || !Array.isArray(materials)) return [];
  return materials.filter((m) => {
    const name = String(m?.name || '').trim().toLowerCase();
    if (!name) return false;
    return name === needle || name.includes(needle) || needle.includes(name);
  });
}

/**
 * Parser fuer den Auftragsimport (aus PDF-Text oder eingefuegtem Text).
 * Da Angebots-/Bestell-PDFs unterschiedlich aufgebaut sein koennen, wird
 * bewusst kein "Alles-oder-Nichts"-Parser gebaut: Es werden so viele
 * Felder wie moeglich zuverlaessig erkannt, alles andere bleibt fuer die
 * manuelle Kontrolle/Korrektur im Formular leer bzw. wird als Warnung
 * zurueckgegeben. Der Nutzer sieht das Ergebnis IMMER vor dem Speichern
 * in einer editierbaren Vorschau.
 *
 * @param {string} rawText
 * @returns {{orderNumber: string, customer: string, positions: Array, warnings: string[]}}
 */
export function parseImportText(rawText) {
  const warnings = [];
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const orderNumber = extractFirstMatch(text, [
    /Auftrags?-?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9\-\/\.]+)/i,
    /Bestell(?:ung)?-?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9\-\/\.]+)/i,
    /Angebots?-?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9\-\/\.]+)/i,
    /\bAuftrag\s*[:#]\s*([A-Za-z0-9\-\/\.]+)/i,
    // Format der Elektro-Krieg-eigenen Angebots-/Leistungsverzeichnisse:
    // Spaltenwert unter der Ueberschrift "Belegnummer" (z.B. ANG26-0200)
    // bzw. generisch jeder Beleg-Code dieser Form irgendwo im Text.
    /\b([A-Z]{2,6}\d{2}-\d{3,6})\b/,
  ]);
  if (!orderNumber) warnings.push('Auftragsnummer konnte nicht automatisch erkannt werden.');

  const customer =
    extractFirstMatch(text, [
      /Kunde\s*[:#]?\s*(.+)/i,
      /Kundenname\s*[:#]?\s*(.+)/i,
      /Auftraggeber\s*[:#]?\s*(.+)/i,
    ]) || extractObjekt(lines);
  if (!customer) warnings.push('Kunde konnte nicht automatisch erkannt werden.');

  const positions = extractPositions(lines);
  if (positions.length === 0) {
    warnings.push('Es wurden keine Materialpositionen automatisch erkannt - bitte manuell hinzufuegen.');
  }

  return {
    orderNumber: orderNumber ? orderNumber.trim() : '',
    customer: customer ? customer.trim() : '',
    positions,
    warnings,
  };
}

// Christian benennt seine Angebots-/Auftrags-PDFs nach dem Muster
// "<eigene Nummer> - <Kunde/Objekt>.pdf" (z.B. "767 - EK Bibra.pdf"). Diese
// Nummer taucht im PDF-Inhalt selbst nicht auf (dort steht nur die
// Belegnummer der Angebots-Software), ist aber die Nummer, die er im
// Alltag als Auftragsnummer verwendet. Wird beim Datei-Import daher der
// Belegnummer aus dem PDF-Text vorgezogen, siehe app.js -> openImportDialog().
export function extractOrderNumberFromFilename(filename) {
  const m = String(filename || '').match(/^\s*(\d{1,10})[\s_]*[-–][\s_]*/);
  return m ? m[1] : '';
}

// In den Elektro-Krieg-Angeboten steht statt "Kunde:" eine Zeile
// "Objekt: <Baustelle/Schule/Gebaeude>", die sich haeufig auf einer
// zweiten Zeile fortsetzt (z.B. "Objekt: Jean Paul Schule" / "Meiningen").
// Diese Fortsetzungszeile wird angehaengt, sofern sie nicht schon zum
// naechsten Abschnitt (Tabellenkopf o.ae.) gehoert.
function extractObjekt(lines) {
  const idx = lines.findIndex((l) => /^Objekt\s*[:#]?\s*.+/i.test(l));
  if (idx === -1) return '';
  let value = lines[idx].replace(/^Objekt\s*[:#]?\s*/i, '').trim();
  const next = lines[idx + 1];
  if (
    next &&
    next.length < 60 &&
    !/^(Position|Datum|Angebot|Auftrag|Bestell|Kunde|Auftraggeber|LEISTUNGSVERZEICHNIS)/i.test(next)
  ) {
    value += ', ' + next.replace(/"/g, '').trim();
  }
  return value;
}

function extractFirstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].split('\n')[0].trim();
  }
  return '';
}

// Erkennt Zeilen der Form "<Menge> <Einheit> <Beschreibung>" bzw.
// "<Beschreibung> ... <Menge> Stk" - typisch fuer Positionslisten in
// Angeboten/Bestellungen. Bewusst tolerant, da Format je nach Lieferant
// variiert; Ergebnis ist immer im Formular nachbearbeitbar.
const UNIT_ALTERNATION = 'stk|stck|st\\.?|std|m|meter|kg|l|liter|pack|pkg|rolle|rl|dose|karton|kt';
const POSITION_LINE_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALTERNATION})\\b\\.?\\s+(.+)$`, 'i');
const POSITION_LINE_RE_TRAILING = new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALTERNATION})\\.?$`, 'i');
// Tabellenzeile aus den Elektro-Krieg-Leistungsverzeichnissen:
// "<Positionsnummer>  <Beschreibung>  <Menge> <Einheit>  ....(Preise)"
// z.B. "1   Sperrelement liefern und montieren   1 Stck   ......"
const POSITION_TABLE_RE = new RegExp(
  `^(\\d{1,3})\\s+(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`,
  'i'
);

function extractPositions(lines) {
  const positions = [];
  for (const line of lines) {
    if (/^(Auftrag|Bestell|Angebot|Kunde|Auftraggeber|Datum|Seite|Position\s+Text)/i.test(line)) continue;

    let m = line.match(POSITION_TABLE_RE);
    if (m) {
      const unit = normalizeUnit(m[4]);
      // Arbeitszeit-Positionen (Einheit "Std") sind Montage-/Programmierzeit,
      // kein zu lieferndes Material - werden fuer den Wareneingangs-Abgleich
      // nicht gebraucht und deshalb hier nicht mit importiert.
      if (unit !== 'Std') {
        positions.push({
          description: m[2].trim(),
          quantityOrdered: parseGermanNumber(m[3]),
          unit,
        });
      }
      continue;
    }

    m = line.match(POSITION_LINE_RE);
    if (m) {
      positions.push({
        description: m[3].trim(),
        quantityOrdered: parseGermanNumber(m[1]),
        unit: normalizeUnit(m[2]),
      });
      continue;
    }
    m = line.match(POSITION_LINE_RE_TRAILING);
    if (m) {
      positions.push({
        description: m[1].trim(),
        quantityOrdered: parseGermanNumber(m[2]),
        unit: normalizeUnit(m[3]),
      });
    }
  }
  return positions;
}

function parseGermanNumber(str) {
  return parseFloat(String(str).replace(',', '.'));
}

function normalizeUnit(unit) {
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (['stk', 'stck', 'st'].includes(u)) return 'Stk';
  if (['std'].includes(u)) return 'Std';
  if (['m', 'meter'].includes(u)) return 'm';
  if (['kg'].includes(u)) return 'kg';
  if (['l', 'liter'].includes(u)) return 'l';
  if (['pack', 'pkg'].includes(u)) return 'Pack';
  if (['rolle', 'rl'].includes(u)) return 'Rolle';
  if (['dose'].includes(u)) return 'Dose';
  if (['karton', 'kt'].includes(u)) return 'Karton';
  return unit;
}

export function validateMaterialForm(input) {
  const errors = {};
  if (!input.name || !input.name.trim()) errors.name = 'Bezeichnung ist erforderlich.';
  if (input.quantity === '' || input.quantity === null || Number.isNaN(Number(input.quantity))) {
    errors.quantity = 'Menge muss eine Zahl sein.';
  } else if (Number(input.quantity) < 0) {
    errors.quantity = 'Menge darf nicht negativ sein.';
  }
  if (input.minQuantity === '' || input.minQuantity === null || Number.isNaN(Number(input.minQuantity))) {
    errors.minQuantity = 'Mindestbestand muss eine Zahl sein.';
  } else if (Number(input.minQuantity) < 0) {
    errors.minQuantity = 'Mindestbestand darf nicht negativ sein.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateEntnahme(material, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    return { valid: false, error: 'Bitte eine Menge groesser 0 eingeben.' };
  }
  if (n > material.quantity) {
    return { valid: false, error: `Nur noch ${material.quantity} ${material.unit || ''} auf Lager.` };
  }
  return { valid: true, newQuantity: material.quantity - n };
}
