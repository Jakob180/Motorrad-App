// push.js – Push-Benachrichtigungen: Erlaubnis, Web-Push-Abo und Abgleich mit dem
// Cloudflare-Worker (Wohnort, Ampel-Grenzwerte, Fälligkeiten). Der Worker schickt dann
// zur eingestellten Uhrzeit Fahrwetter- und Wartungs-Hinweise.
//
// iOS: Push gibt es nur ab iOS 16.4 und nur in der installierten App (Home-Bildschirm).
// Server-Adresse und Token sind Geräte-Einstellungen und landen NICHT im Backup.

import * as db from './db.js';
import { getBikes, getEntries, meterOf } from './logbook.js';
import { intervalStatus, pickerlStatus, SOON_SHARE } from './service.js';
import { toISODate, fmtMonthYear, isStandalone } from './ui.js';

export const DEFAULT_PREFS = { weather: true, weatherMode: 'good', service: true, pickerl: true, hour: 7 };

/** Was kann dieses Gerät? */
export function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    standalone: isStandalone(),
    ios,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

/** Push-Einstellungen dieses Geräts (inkl. dauerhafter Geräte-ID) */
export async function getPushConfig() {
  const dev = await db.getDeviceSettings();
  let { deviceId } = dev;
  if (!deviceId) {
    deviceId = db.uid();
    await db.saveDeviceSettings({ deviceId });
  }
  const push = dev.push || {};
  return {
    deviceId,
    enabled: !!push.enabled,
    workerUrl: push.workerUrl || '',
    token: push.token || '',
    prefs: { ...DEFAULT_PREFS, ...(push.prefs || {}) },
    lastSync: push.lastSync || null,
    lastSyncJson: push.lastSyncJson || null,
  };
}

async function savePushConfig(patch) {
  const { deviceId, ...current } = await getPushConfig();
  await db.saveDeviceSettings({ push: { ...current, ...patch } });
}

// ---------- Server-Aufrufe ----------

async function api(cfg, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(cfg.workerUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Der Zugangs-Token stimmt nicht.');
    if (!res.ok) throw new Error(data.error || `Push-Server meldet Fehler ${res.status}.`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Der Push-Server antwortet nicht.');
    if (err instanceof TypeError) {
      throw new Error('Push-Server nicht erreichbar – Adresse, Internet und ALLOWED_ORIGINS im Worker prüfen.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(buffer, key) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = b64urlToBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------- Aktivieren / Deaktivieren ----------

/**
 * Erlaubnis anfragen. MUSS direkt (ohne vorheriges await) im Tipp-Ereignis aufgerufen werden,
 * sonst zeigt iOS die Abfrage nicht an.
 */
export function requestPermission() {
  return Notification.requestPermission();
}

/** Push aktivieren: Erlaubnis abwarten, Abo anlegen, alles an den Worker schicken */
export async function enablePush({ workerUrl, token, prefs }, permissionPromise) {
  const permission = await permissionPromise;
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Benachrichtigungen sind blockiert. iPhone: Einstellungen → Mitteilungen → Motorrad → „Mitteilungen erlauben".'
      : 'Ohne Erlaubnis kann die App keine Benachrichtigungen schicken.');
  }
  const cfg = { ...(await getPushConfig()), workerUrl, token, prefs };
  const { key } = await api(cfg, 'GET', '/api/vapid-public-key');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Abo für einen anderen Server-Schlüssel (z. B. nach neuem Setup)? → neu abonnieren
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });

  await savePushConfig({ workerUrl, token, prefs, enabled: true, lastSyncJson: null });
  await syncNow({ force: true });
}

/** Einstellungen ändern (Push bleibt aktiv) */
export async function updatePush({ workerUrl, token, prefs }) {
  await savePushConfig({ workerUrl, token, prefs });
  await syncNow({ force: true });
}

/** Push abschalten: beim Server abmelden und Abo beenden */
export async function disablePush() {
  const cfg = await getPushConfig();
  try {
    await api(cfg, 'DELETE', `/api/device/${cfg.deviceId}`);
  } catch { /* Server nicht erreichbar – lokal trotzdem abschalten */ }
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await savePushConfig({ enabled: false, lastSyncJson: null });
}

/** Test-Nachricht ('test') oder Morgen-Nachricht sofort ('run') vom Server anfordern */
export async function serverTest(kind) {
  await syncNow();
  const cfg = await getPushConfig();
  return api(cfg, 'POST', `/api/device/${cfg.deviceId}/${kind}`);
}

// ---------- Abgleich mit dem Server ----------

/** Daten für den Server: Abo, Wohnort, Grenzwerte, Wünsche und alle Fälligkeiten */
async function buildPayload(cfg, sub) {
  const settings = await db.getSettings();
  const bikes = await getBikes();
  const multi = bikes.length > 1;
  const dues = [];
  const pickerl = [];
  for (const bike of bikes) {
    const entries = await getEntries(bike.id);
    for (const iv of await db.getAllByIndex('intervals', 'bikeId', bike.id)) {
      const s = intervalStatus(iv, bike, entries);
      if (s.status === 'unknown') continue;
      dues.push({
        id: iv.id,
        name: multi ? `${bike.name}: ${iv.name}` : iv.name,
        dueDate: s.dueDate,
        distLeft: s.distLeft == null ? null : Math.round(s.distLeft * 10) / 10,
        soonDist: iv.distance ? iv.distance * SOON_SHARE : null,
        unit: meterOf(bike).short,
      });
    }
    const p = pickerlStatus(bike);
    if (p) {
      pickerl.push({
        id: `pickerl-${bike.id}`,
        name: multi ? `${bike.name}: Pickerl` : 'Pickerl',
        label: fmtMonthYear(p.due),
        windowStart: toISODate(p.windowStart),
        dueEnd: toISODate(p.dueEnd),
        graceEnd: toISODate(p.graceEnd),
      });
    }
  }
  return { subscription: sub.toJSON(), home: settings.home, thresholds: settings.thresholds, prefs: cfg.prefs, dues, pickerl };
}

/** Mit dem Server abgleichen – nur wenn sich etwas geändert hat (schont das KV-Schreiblimit) */
export async function syncNow({ force = false } = {}) {
  const cfg = await getPushConfig();
  if (!cfg.enabled || !cfg.workerUrl || !cfg.token) return { skipped: true };
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) {
    await savePushConfig({ enabled: false, lastSyncJson: null });
    throw new Error('Das Push-Abo ist nicht mehr gültig – bitte Benachrichtigungen neu aktivieren.');
  }
  const payload = await buildPayload(cfg, sub);
  const json = JSON.stringify(payload);
  if (!force && json === cfg.lastSyncJson) return { unchanged: true };
  await api(cfg, 'PUT', `/api/device/${cfg.deviceId}`, payload);
  await savePushConfig({ lastSyncJson: json, lastSync: new Date().toISOString() });
  return { ok: true };
}

/** Beim App-Start: Klicks auf Benachrichtigungen verarbeiten, Änderungen automatisch abgleichen */
export function initPush() {
  // Benachrichtigung angetippt, App war schon offen → passenden Tab zeigen
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'OPEN_TAB' && e.data.tab) location.hash = `#${e.data.tab}`;
  });

  let timer = null;
  const later = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => syncNow().catch((err) => console.warn('Push-Abgleich:', err.message)), ms);
  };
  window.addEventListener('data-changed', (e) => {
    if (e.detail.store !== 'cache') later(3000);
  });
  later(4000); // einmal nach dem Start (z. B. erneuertes Abo)
}
