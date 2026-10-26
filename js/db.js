// db.js – Lokale Datenhaltung mit IndexedDB (bewusst ohne externe Bibliothek,
// damit das Logbuch auch beim allerersten Offline-Start funktioniert).
//
// Alle Daten bleiben im Browser des Geräts. iOS kann Daten von Web-Apps löschen,
// deshalb gibt es exportAll()/importAll() für Backups (siehe Einstellungen).

const DB_NAME = 'motorrad-begleiter';
const DB_VERSION = 1;

// Objekt-Stores samt Indizes. Alle Stores werden schon in Version 1 angelegt,
// damit spätere Ausbaustufen keine Datenbank-Migration brauchen.
const SCHEMA = {
  bikes: { keyPath: 'id' },                                   // Motorräder
  entries: { keyPath: 'id', indexes: { bikeId: 'bikeId' } },  // Logbuch-Einträge
  intervals: { keyPath: 'id', indexes: { bikeId: 'bikeId' } },// Service-Intervalle
  routes: { keyPath: 'id' },                                  // Favoriten-Routen
  settings: { keyPath: 'key' },                               // Einstellungen (Schlüssel/Wert)
  cache: { keyPath: 'key' },                                  // Kurzzeit-Cache für API-Antworten
};

// Diese Stores landen im Backup (der API-Cache nicht)
export const BACKUP_STORES = ['bikes', 'entries', 'intervals', 'routes', 'settings'];

// Geräte-spezifische Einstellungen (z. B. Push-Abo) – werden NICHT exportiert
const DEVICE_KEY = 'device';
const APP_KEY = 'app';

// Standardwerte für alle Einstellungen
export const DEFAULT_SETTINGS = {
  activeBikeId: null,
  // Grenzwerte für die Fahr-Ampel
  thresholds: {
    rainProbYellow: 40,   // Regenwahrscheinlichkeit in %
    rainProbRed: 70,
    rainMmYellow: 0.5,    // Niederschlag in mm pro Stunde
    rainMmRed: 2,
    tempYellow: 8,        // unter diesem Wert (°C) → Gelb
    tempRed: 3,           // unter diesem Wert (°C) → Rot (Glättegefahr)
    gustYellow: 50,       // Böen in km/h
    gustRed: 70,
  },
  avgSpeed: 60,           // Durchschnittsgeschwindigkeit für Routen (km/h)
  lastBackup: null,       // ISO-Zeitstempel des letzten Exports
};

let dbPromise = null;

/** Datenbank öffnen (einmalig) und bei Bedarf Stores anlegen */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Dieser Browser unterstützt keine lokale Datenbank (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [index, path] of Object.entries(def.indexes || {})) store.createIndex(index, path);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Eine neuere App-Version in einem anderen Fenster will upgraden → Verbindung freigeben
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** IDBRequest → Promise */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Wartet, bis eine Transaktion vollständig geschrieben ist */
function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(friendlyError(tx.error));
    tx.onabort = () => reject(friendlyError(tx.error));
  });
}

function friendlyError(err) {
  if (err && err.name === 'QuotaExceededError') {
    return new Error('Der Speicher ist voll. Bitte ein Backup machen und alte Fotos entfernen.');
  }
  return err || new Error('Unbekannter Datenbankfehler');
}

/** Andere Module über Datenänderungen informieren (z. B. Banner, Push-Sync) */
function notify(store) {
  if (store === 'cache') return;
  window.dispatchEvent(new CustomEvent('data-changed', { detail: { store } }));
}

/** Eindeutige ID erzeugen */
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- Allgemeine CRUD-Funktionen ----------

export async function getAll(store) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).get(key));
}

export async function getAllByIndex(store, index, value) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await complete(tx);
  notify(store);
  return value;
}

export async function remove(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await complete(tx);
  notify(store);
}

/** Alle Datensätze eines Stores löschen, deren Index-Feld = value ist */
export async function removeByIndex(store, index, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const keys = await request(tx.objectStore(store).index(index).getAllKeys(value));
  for (const key of keys) tx.objectStore(store).delete(key);
  await complete(tx);
  notify(store);
  return keys.length;
}

// ---------- Einstellungen ----------

let settingsCache = null;

/** Objekte zusammenführen – verschachtelte Objekte (z. B. thresholds) eine Ebene tief */
function mergeOneLevel(base, patch) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    result[key] = isObject && result[key] && typeof result[key] === 'object'
      ? { ...result[key], ...value }
      : value;
  }
  return result;
}

const mergeSettings = (stored) => mergeOneLevel(DEFAULT_SETTINGS, stored);

export async function getSettings() {
  if (!settingsCache) {
    const rec = await get('settings', APP_KEY);
    settingsCache = mergeSettings(rec?.value);
  }
  return structuredClone(settingsCache);
}

/** Einzelne Einstellungen ändern, z. B. saveSettings({ avgSpeed: 70 }) */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeOneLevel(current, patch);
  await put('settings', { key: APP_KEY, value: next });
  settingsCache = next;
  return structuredClone(next);
}

/** Geräte-spezifische Werte (nicht im Backup), z. B. Push-Abo */
export async function getDeviceSettings() {
  return (await get('settings', DEVICE_KEY))?.value || {};
}

export async function saveDeviceSettings(patch) {
  const next = { ...(await getDeviceSettings()), ...patch };
  await put('settings', { key: DEVICE_KEY, value: next });
  return next;
}

// ---------- Kurzzeit-Cache für API-Antworten ----------

/** Liefert gecachte Daten, wenn sie jünger als maxAgeMs sind – sonst null */
export async function cacheGet(key, maxAgeMs) {
  try {
    const rec = await get('cache', key);
    if (rec && Date.now() - rec.ts < maxAgeMs) return rec.data;
  } catch { /* Cache ist optional */ }
  return null;
}

/** Ältesten Cache-Eintrag holen, egal wie alt (Fallback bei Offline) */
export async function cacheGetStale(key) {
  try {
    const rec = await get('cache', key);
    return rec ? { data: rec.data, ts: rec.ts } : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, data) {
  try {
    await put('cache', { key, data, ts: Date.now() });
  } catch { /* Cache-Fehler ignorieren */ }
}

/** Cache-Einträge älter als maxAgeMs entfernen */
export async function cachePrune(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const db = await openDB();
    const tx = db.transaction('cache', 'readwrite');
    const all = await request(tx.objectStore('cache').getAll());
    for (const rec of all) if (Date.now() - rec.ts > maxAgeMs) tx.objectStore('cache').delete(rec.key);
    await complete(tx);
  } catch { /* egal */ }
}

// ---------- Backup ----------

/** Alle Nutzerdaten als Objekt (für JSON-Export) */
export async function exportAll() {
  const data = {
    app: 'motorrad-begleiter',
    format: 1,
    exportedAt: new Date().toISOString(),
    stores: {},
  };
  for (const store of BACKUP_STORES) {
    let rows = await getAll(store);
    if (store === 'settings') rows = rows.filter((r) => r.key !== DEVICE_KEY);
    data.stores[store] = rows;
  }
  return data;
}

/** Prüft eine Backup-Datei und liefert eine kurze Zusammenfassung */
export function inspectBackup(data) {
  if (!data || data.app !== 'motorrad-begleiter' || typeof data.stores !== 'object') {
    throw new Error('Das ist keine gültige Backup-Datei dieser App.');
  }
  const count = (s) => (Array.isArray(data.stores[s]) ? data.stores[s].length : 0);
  return {
    exportedAt: data.exportedAt,
    bikes: count('bikes'),
    entries: count('entries'),
    intervals: count('intervals'),
    routes: count('routes'),
  };
}

/** Ersetzt ALLE Nutzerdaten durch den Inhalt des Backups (in einer Transaktion) */
export async function importAll(data) {
  inspectBackup(data);
  const db = await openDB();
  const tx = db.transaction(BACKUP_STORES, 'readwrite');
  for (const store of BACKUP_STORES) {
    const os = tx.objectStore(store);
    if (store === 'settings') {
      // Geräte-Einstellungen behalten, alles andere ersetzen
      const keys = await request(os.getAllKeys());
      for (const key of keys) if (key !== DEVICE_KEY) os.delete(key);
    } else {
      os.clear();
    }
    for (const row of data.stores[store] || []) {
      if (store === 'settings' && row.key === DEVICE_KEY) continue;
      os.put(row);
    }
  }
  await complete(tx);
  settingsCache = null;
  notify('all');
}

/** Löscht alle Nutzerdaten auf diesem Gerät */
export async function clearAll() {
  const db = await openDB();
  const stores = [...BACKUP_STORES, 'cache'];
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) tx.objectStore(store).clear();
  await complete(tx);
  settingsCache = null;
  notify('all');
}

/** Anzahl der Datensätze pro Store (für die Einstellungsseite) */
export async function counts() {
  const db = await openDB();
  const result = {};
  for (const store of BACKUP_STORES) {
    result[store] = await request(db.transaction(store).objectStore(store).count());
  }
  return result;
}
