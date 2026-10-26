// settings.js – Einstellungen-Tab: Datensicherung (Backup), Speicher und App-Infos.
// Spätere Ausbaustufen ergänzen hier Ampel-Grenzwerte, Routen und Benachrichtigungen.

import * as db from './db.js';
import {
  esc, fmtDate, fmtNum, fmtInDays, daysBetween, todayISO, toast, confirmDialog,
  downloadFile, canShareFiles, isStandalone, ICONS,
} from './ui.js';

let root = null;
let backupFile = null; // vorbereitete Backup-Datei – iOS verlangt share() direkt beim Tippen

export function init(el) {
  root = el;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
}

export async function show() {
  await render();
}

async function render() {
  const [settings, counts, storage, version] = await Promise.all([
    db.getSettings(), db.counts(), storageInfo(), swVersion(),
  ]);
  backupFile = await prepareBackup();

  const last = settings.lastBackup;
  const lastText = last ? `${fmtDate(last)} (${fmtInDays(daysBetween(new Date(), new Date(last)))})` : 'noch nie';
  const share = canShareFiles();

  root.innerHTML = `
    <div class="card">
      <h3>💾 Datensicherung</h3>
      <p class="muted">iOS kann die Daten von Web-Apps löschen, z. B. wenn die App länger nicht geöffnet wurde
        oder der Speicher knapp ist. Mach regelmäßig ein Backup und speichere es in iCloud Drive oder „Dateien".</p>
      <div class="kv"><span class="k">Letztes Backup</span><span class="v">${lastText}</span></div>
      <div class="kv"><span class="k">Gespeichert</span><span class="v">${counts.bikes} Motorr${counts.bikes === 1 ? 'ad' : 'äder'}, ${counts.entries} Einträge</span></div>
      <div class="stack mt">
        ${share ? `<button type="button" class="btn btn-primary btn-block" data-action="share">${ICONS.share} Backup sichern (Teilen / In Dateien)</button>` : ''}
        <button type="button" class="btn btn-block ${share ? '' : 'btn-primary'}" data-action="download">${ICONS.download} Backup als Datei herunterladen</button>
        <label class="btn btn-block">${ICONS.upload} Backup importieren
          <input type="file" accept=".json,application/json" data-action="import" hidden>
        </label>
      </div>
      <p class="muted small mt">Beim Import werden alle aktuellen Daten durch das Backup ersetzt.</p>
    </div>

    <div class="card">
      <h3>📦 Speicher</h3>
      <div class="kv"><span class="k">Dauerhafter Speicher</span><span class="v">${storage.persisted == null ? 'unbekannt' : storage.persisted ? 'ja ✅' : 'nein'}</span></div>
      ${storage.usage != null ? `<div class="kv"><span class="k">Belegt</span><span class="v">${fmtNum(storage.usage / 1048576, 1)} MB</span></div>` : ''}
      ${storage.persisted === false ? `<button type="button" class="btn btn-block mt" data-action="persist">Dauerhaften Speicher anfragen</button>` : ''}
    </div>

    <div class="card">
      <h3>📱 App</h3>
      <div class="kv"><span class="k">Version</span><span class="v">${esc(version || '–')}</span></div>
      <div class="kv"><span class="k">Als App installiert</span><span class="v">${isStandalone() ? 'ja ✅' : 'nein'}</span></div>
      ${isStandalone() ? '' : `<p class="muted small mt">Tipp: In Safari auf <strong>Teilen</strong> → <strong>Zum Home-Bildschirm</strong> tippen.
        Dann startet die App im Vollbild und funktioniert offline.</p>`}
      <div class="stack mt">
        <button type="button" class="btn btn-block" data-action="update">${ICONS.refresh} Nach Updates suchen</button>
        <button type="button" class="btn btn-block btn-ghost" data-action="wipe" style="color:var(--red)">${ICONS.trash} Alle Daten löschen</button>
      </div>
    </div>`;
}

/** Backup-Datei vorbereiten (JSON mit allen Daten) */
async function prepareBackup() {
  const data = await db.exportAll();
  return new File([JSON.stringify(data, null, 2)], `motorrad-backup-${todayISO()}.json`, { type: 'application/json' });
}

async function markBackupDone() {
  await db.saveSettings({ lastBackup: new Date().toISOString() });
  await render();
}

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'share':
      try {
        // Kein await davor! Sonst verweigert iOS das Teilen-Menü.
        await navigator.share({ files: [backupFile], title: 'Motorrad-Backup' });
        toast('Backup gesichert', 'ok');
        await markBackupDone();
      } catch (err) {
        if (err.name !== 'AbortError') toast(`Teilen nicht möglich: ${err.message}`, 'error');
      }
      break;
    case 'download':
      downloadFile(backupFile, backupFile.name);
      toast('Backup-Datei wird heruntergeladen', 'ok');
      await markBackupDone();
      break;
    case 'persist':
      try {
        const ok = await navigator.storage.persist();
        toast(ok ? 'Speicher ist jetzt dauerhaft' : 'Der Browser hat abgelehnt – Backups sind umso wichtiger.', ok ? 'ok' : 'info');
      } catch { /* nicht unterstützt */ }
      await render();
      break;
    case 'update':
      await checkForUpdate();
      break;
    case 'wipe':
      if (!await confirmDialog('Alle Motorräder, Einträge und Einstellungen auf diesem Gerät löschen?', { ok: 'Weiter', danger: true })) return;
      if (!await confirmDialog('Wirklich? Das kann nicht rückgängig gemacht werden – außer du hast ein Backup.', { title: 'Letzte Warnung', ok: 'Alles löschen', danger: true })) return;
      await db.clearAll();
      toast('Alle Daten gelöscht', 'ok');
      window.dispatchEvent(new CustomEvent('bike-changed'));
      await render();
      break;
    default:
  }
}

async function onChange(e) {
  if (e.target.dataset.action !== 'import') return;
  const file = e.target.files?.[0];
  e.target.value = ''; // gleiche Datei erneut wählbar
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const info = db.inspectBackup(data);
    const ok = await confirmDialog(
      `Backup vom ${fmtDate(info.exportedAt)} mit ${info.bikes} Motorr${info.bikes === 1 ? 'ad' : 'ädern'} und ${info.entries} Einträgen importieren?\n\nAlle aktuellen Daten auf diesem Gerät werden dabei ersetzt.`,
      { title: 'Backup importieren', ok: 'Importieren', danger: true },
    );
    if (!ok) return;
    await db.importAll(data);
    toast('Backup importiert', 'ok');
    window.dispatchEvent(new CustomEvent('bike-changed'));
    await render();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Die Datei ist kein gültiges JSON.' : err.message, 'error');
  }
}

async function storageInfo() {
  const info = { persisted: null, usage: null };
  try { info.persisted = await navigator.storage?.persisted?.() ?? null; } catch { /* egal */ }
  try { info.usage = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* egal */ }
  return info;
}

/** Version beim aktiven Service Worker erfragen */
function swVersion() {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) { resolve(null); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data?.version || null);
    ctrl.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    setTimeout(() => resolve(null), 1000);
  });
}

async function checkForUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) {
    toast('Updates gibt es nur, wenn die App über https oder localhost läuft.', 'info');
    return;
  }
  try {
    await reg.update();
  } catch {
    toast('Keine Verbindung – später nochmal versuchen.', 'error');
    return;
  }
  if (reg.installing || reg.waiting) toast('Neue Version gefunden – oben auf „Aktualisieren" tippen.', 'ok');
  else toast('Du hast bereits die neueste Version.', 'ok');
}
