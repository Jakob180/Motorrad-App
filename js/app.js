// app.js – Einstiegspunkt: Tabs & Navigation (über den URL-Hash), Service Worker,
// Update-Hinweis und Hinweis-Banner.

import * as db from './db.js';
import { $, $$, esc, setBanner, toast, daysBetween, toISODate, ICONS } from './ui.js';
import { getActiveBike, getBikes, openBikePicker } from './logbook.js';
import { dueOverview } from './service.js';

// Start-Tab beim Öffnen der App
const DEFAULT_TAB = 'wetter';

// Tabs: Titel, Modul (wird erst beim ersten Öffnen geladen), Motorrad-Auswahl in der Kopfzeile?
const TABS = {
  wetter: { title: 'Kann ich fahren?', load: () => import('./weather.js') },
  logbuch: { title: 'Logbuch', load: () => import('./logbook.js'), bikeChip: true },
  service: { title: 'Service', load: () => import('./service.js'), bikeChip: true },
  einstellungen: { title: 'Einstellungen', load: () => import('./settings.js') },
};

const modules = new Map();
let currentTab = null;

async function getModule(name) {
  if (!modules.has(name)) {
    const mod = await TABS[name].load();
    mod.init($(`#tab-${name}`));
    modules.set(name, mod);
  }
  return modules.get(name);
}

/** '#logbuch/statistik' → { tab: 'logbuch', sub: 'statistik' } */
function parseHash() {
  const [tab, sub] = location.hash.replace(/^#\/?/, '').split('/');
  return { tab: TABS[tab] ? tab : DEFAULT_TAB, sub: sub || null };
}

async function route() {
  const { tab, sub } = parseHash();
  if (tab !== currentTab) window.scrollTo(0, 0);
  currentTab = tab;

  for (const name of Object.keys(TABS)) $(`#tab-${name}`).hidden = name !== tab;
  for (const a of $$('.tabbar a')) {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('#page-title').textContent = TABS[tab].title;
  document.title = `${TABS[tab].title} · Motorrad-Begleiter`;
  updateBikeChip();

  try {
    const mod = await getModule(tab);
    await mod.show(sub);
  } catch (err) {
    console.error(err);
    $(`#tab-${tab}`).innerHTML = `<div class="empty"><div class="e">😕</div>
      <h3>Da ist etwas schiefgelaufen</h3><p>${esc(err.message)}</p>
      <a class="btn" href="./">Neu laden</a></div>`;
  }
}

/** Aktives Motorrad in der Kopfzeile (nur bei Logbuch und Service) */
async function updateBikeChip() {
  const chip = $('#bike-chip');
  if (!TABS[currentTab]?.bikeChip) {
    chip.hidden = true;
    return;
  }
  const bike = await getActiveBike();
  chip.hidden = !bike;
  if (bike) chip.innerHTML = `<span>🏍️ ${esc(bike.name)}</span>${ICONS.chevronDown}`;
}

// ---------- Hinweis-Banner ----------

/** Erinnerung ans Backup, wenn es Daten gibt und das letzte Backup > 30 Tage her ist */
async function checkBackupReminder() {
  const [settings, counts] = await Promise.all([db.getSettings(), db.counts()]);
  const today = toISODate(new Date());
  const snoozed = settings.backupSnoozeUntil && settings.backupSnoozeUntil > today;
  const days = settings.lastBackup ? daysBetween(new Date(settings.lastBackup), new Date()) : null;
  if (counts.entries < 5 || snoozed || (days != null && days < 30)) {
    setBanner('backup', null);
    return;
  }
  setBanner('backup', {
    type: 'warn',
    icon: '💾',
    title: days == null ? 'Noch kein Backup' : `Letztes Backup vor ${days} Tagen`,
    text: 'iOS kann lokale Daten von Web-Apps löschen. Sichere deine Daten regelmäßig.',
    actions: [{ label: 'Jetzt sichern', onClick: () => { location.hash = '#einstellungen'; } }],
    onDismiss: () => {
      const until = new Date();
      until.setDate(until.getDate() + 7);
      db.saveSettings({ backupSnoozeUntil: toISODate(until) });
    },
  });
}

/** Hinweis bei fälligen Wartungen/Pickerl (alle Motorräder); „ausblenden" gilt bis morgen */
async function checkServiceBanner() {
  const settings = await db.getSettings();
  const today = toISODate(new Date());
  const items = settings.serviceSnoozeUntil && settings.serviceSnoozeUntil > today ? [] : await dueOverview();
  if (!items.length) {
    setBanner('service', null);
    return;
  }
  const multi = (await getBikes()).length > 1;
  const shown = items.slice(0, 3).map((i) => `<li>${multi ? `${esc(i.bike.name)}: ` : ''}<b>${esc(i.name)}</b> – ${esc(i.text)}</li>`);
  if (items.length > 3) shown.push(`<li>… und ${items.length - 3} weitere</li>`);
  setBanner('service', {
    type: items.some((i) => i.status === 'overdue') ? 'danger' : 'warn',
    icon: '🔧',
    title: items.length === 1 ? 'Wartung fällig' : `${items.length} Wartungen fällig`,
    html: `<ul class="b-list">${shown.join('')}</ul>`,
    actions: [{ label: 'Ansehen', onClick: () => { location.hash = '#service'; } }],
    onDismiss: () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      db.saveSettings({ serviceSnoozeUntil: toISODate(tomorrow) });
    },
  });
}

let bannerTimer = null;
/** Banner nach Datenänderungen gesammelt neu prüfen */
function refreshBanners() {
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    checkBackupReminder();
    checkServiceBanner();
  }, 300);
}

function updateOnlineBanner() {
  setBanner('offline', navigator.onLine ? null : {
    type: 'info',
    icon: '📴',
    title: 'Offline',
    text: 'Das Logbuch funktioniert weiter. Wetter und Routen brauchen Internet.',
    dismissible: true,
  });
}

// ---------- Service Worker (Offline-Cache & Updates) ----------

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    let controlled = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register('./sw.js');

    const offerUpdate = (worker) => setBanner('update', {
      type: 'info',
      icon: '✨',
      title: 'Neue Version verfügbar',
      text: 'Tippe auf „Aktualisieren", um die neueste Version zu laden.',
      actions: [{ label: 'Aktualisieren', onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }],
    });

    if (reg.waiting && controlled) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });

    // Neuer Service Worker hat übernommen → Seite neu laden (nicht beim allerersten Start)
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) { controlled = true; return; }
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    // iOS hält installierte Web-Apps lange im Speicher → beim Zurückkehren nach Updates schauen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  } catch (err) {
    console.warn('Service Worker konnte nicht registriert werden:', err);
  }
}

/** Browser bitten, die Daten nicht automatisch zu löschen */
async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* nicht überall unterstützt */ }
}

// ---------- Start ----------

function start() {
  window.addEventListener('hashchange', route);
  $('#bike-chip').addEventListener('click', openBikePicker);

  // Motorrad gewechselt / Daten importiert → aktuellen Tab neu aufbauen
  window.addEventListener('bike-changed', () => route());
  window.addEventListener('data-changed', (e) => {
    if (['bikes', 'all'].includes(e.detail.store)) updateBikeChip();
    if (['entries', 'intervals', 'bikes', 'settings', 'all'].includes(e.detail.store)) refreshBanners();
  });

  window.addEventListener('online', updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    toast(e.reason?.message || 'Unerwarteter Fehler', 'error');
  });

  route();
  updateOnlineBanner();
  checkBackupReminder();
  checkServiceBanner();
  registerServiceWorker();
  requestPersistentStorage();
  db.cachePrune();
}

start();

// Für die Fehlersuche in der Browser-Konsole
window.motoApp = { db, getBikes };
