// settings.js – Einstellungen-Tab: Fahr-Ampel-Grenzwerte, Wohnort, Routen, Benachrichtigungen,
// Datensicherung (Backup), Speicher und App-Infos.

import * as db from './db.js';
import {
  esc, fmtDate, fmtTime, fmtNum, fmtInDays, daysBetween, todayISO, toast, confirmDialog,
  downloadFile, canShareFiles, isStandalone, ICONS, field, switchRow, parseDecimal, setFieldError, clearFieldErrors,
} from './ui.js';
import { openPlaceSearch, currentPlace } from './weather.js';
import {
  pushSupport, getPushConfig, requestPermission, enablePush, updatePush, disablePush, serverTest,
} from './push.js';

let root = null;
let backupFile = null; // vorbereitete Backup-Datei – iOS verlangt share() direkt beim Tippen

export function init(el) {
  root = el;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
}

/** Auswahlliste für ganze Zahlen von..bis (Temperaturen, Uhrzeiten – auch mit Minus bedienbar) */
function rangeOptions(from, to, unit, current) {
  const values = [];
  for (let v = from; v <= to; v++) values.push(v);
  if (Number.isFinite(current) && !values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).map((v) => [v, `${v}${unit}`]);
}

/** Formular für die Ampel-Grenzwerte */
function ampelCard(t) {
  const num = (label, name, decimals = 0) => field({
    label, name, inputmode: decimals ? 'decimal' : 'numeric', value: fmtNum(t[name], decimals),
  });
  const sel = (label, name, from, to, unit) => field({
    label, name, type: 'select', value: t[name], options: rangeOptions(from, to, unit, t[name]),
  });
  return `<div class="card">
    <h3>🚦 Fahr-Ampel</h3>
    <p class="muted small">Ab welchen Werten eine Stunde gelb oder rot wird. Regen ist auch rot, wenn
      Wahrscheinlichkeit <em>und</em> Menge über Gelb liegen. Gewitter und Schnee sind immer rot,
      Nebel und nasse Straße nach Regen gelb.</p>
    <form id="ampel-form" novalidate>
      <div class="form-sub">Regenwahrscheinlichkeit (%)</div>
      <div class="grid2">${num('Gelb über', 'rainProbYellow')}${num('Rot über', 'rainProbRed')}</div>
      <div class="form-sub">Regenmenge (mm pro Stunde)</div>
      <div class="grid2">${num('Gelb über', 'rainMmYellow', 1)}${num('Rot über', 'rainMmRed', 1)}</div>
      <div class="form-sub">Temperatur</div>
      <div class="grid2">${sel('Gelb unter', 'tempYellow', -5, 20, ' °C')}${sel('Rot unter (Glätte)', 'tempRed', -10, 15, ' °C')}</div>
      <div class="form-sub">Windböen (km/h)</div>
      <div class="grid2">${num('Gelb über', 'gustYellow')}${num('Rot über', 'gustRed')}</div>
      <div class="form-sub">Fahrzeit für das Tagesfazit</div>
      <div class="grid2">${sel('Von', 'rideFrom', 0, 23, ':00')}${sel('Bis', 'rideTo', 1, 24, ':00')}</div>
      <div class="row">
        <button type="submit" class="btn btn-primary">${ICONS.check} Speichern</button>
        <button type="button" class="btn" data-action="reset-ampel">Standardwerte</button>
      </div>
    </form>
  </div>`;
}

function homeCard(home) {
  return `<div class="card">
    <h3>🏠 Wohnort</h3>
    <p class="muted small">Wird im Wetter-Tab angezeigt, wenn GPS nicht verfügbar ist
      (später auch für die morgendliche Push-Nachricht).</p>
    <div class="kv"><span class="k">Wohnort</span><span class="v">${home ? esc(home.name) : 'nicht festgelegt'}</span></div>
    <div class="row mt">
      <button type="button" class="btn btn-sm" data-action="set-home">${home ? 'Ändern' : 'Festlegen'}</button>
      ${home ? '<button type="button" class="btn btn-sm btn-ghost" data-action="clear-home">Entfernen</button>' : ''}
    </div>
  </div>`;
}

function routeCard(settings) {
  return `<div class="card">
    <h3>🗺️ Routen</h3>
    <p class="muted small">Mit diesem Durchschnittstempo (ohne Pausen) berechnet die App, wann du an welchem
      Punkt der Route bist. Lässt sich auch direkt bei der Route ändern.</p>
    ${field({ label: 'Durchschnittsgeschwindigkeit', name: 'avgSpeed', type: 'select', value: settings.avgSpeed,
      options: rangeOptions(30, 110, ' km/h', settings.avgSpeed).filter(([v]) => v % 5 === 0 || v === settings.avgSpeed) })}
  </div>`;
}

/** Benachrichtigungen: Server, Wünsche, Aktivieren/Testen */
function pushCard(cfg, home) {
  const sup = pushSupport();
  const p = cfg.prefs;
  const hours = [];
  for (let h = 5; h <= 21; h++) hours.push([h, `${h}:00 Uhr`]);
  let notice = '';
  if (sup.ios && !sup.standalone) {
    notice = 'Auf dem iPhone gibt es Benachrichtigungen nur in der installierten App (ab iOS 16.4): '
      + 'In Safari auf Teilen → „Zum Home-Bildschirm" tippen und die App dann von dort öffnen.';
  } else if (!sup.supported) {
    notice = 'Dieser Browser unterstützt keine Push-Benachrichtigungen.';
  }
  const canEnable = sup.supported && !(sup.ios && !sup.standalone);
  const permText = { granted: 'erteilt ✅', denied: 'blockiert ⛔', default: 'noch nicht gefragt', unsupported: '–' }[sup.permission];

  return `<div class="card">
    <h3>🔔 Benachrichtigungen</h3>
    <p class="muted small">Jeden Morgen eine kurze Nachricht: Fahrwetter am Wohnort und fällige Wartungen bzw. Pickerl.
      Dafür braucht es einen kleinen, kostenlosen Server (Cloudflare Worker) – Anleitung in der README.</p>
    ${notice ? `<div class="notice"><span aria-hidden="true">📱</span><span>${esc(notice)}</span></div>` : ''}
    <div class="kv"><span class="k">Status</span><span class="v">${cfg.enabled ? `aktiv ✅ (${p.hour}:00 Uhr)` : 'aus'}</span></div>
    <div class="kv"><span class="k">Erlaubnis</span><span class="v">${permText}</span></div>
    ${cfg.enabled && cfg.lastSync ? `<div class="kv"><span class="k">Letzter Abgleich</span>
      <span class="v">${fmtDate(cfg.lastSync)} ${fmtTime(cfg.lastSync)}</span></div>` : ''}
    <form id="push-form" class="mt" novalidate data-enabled="${cfg.enabled}">
      ${field({ label: 'Server-Adresse (Worker-URL)', name: 'workerUrl', type: 'url', value: cfg.workerUrl,
        placeholder: 'https://motorrad-push.….workers.dev', attrs: 'inputmode="url" autocapitalize="off" spellcheck="false"' })}
      ${field({ label: 'Zugangs-Token', name: 'token', type: 'password', value: cfg.token,
        placeholder: 'aus „npm run setup"', attrs: 'autocapitalize="off" spellcheck="false"' })}
      <div class="form-sub">Was möchtest du bekommen?</div>
      ${switchRow({ label: '🏍️ Fahrwetter am Wohnort', name: 'weather', checked: p.weather,
        hint: home ? esc(home.name) : '⚠️ Erst oben einen Wohnort festlegen' })}
      ${field({ label: 'Fahrwetter-Nachricht', name: 'weatherMode', type: 'select', value: p.weatherMode,
        options: [['good', 'nur bei gutem Wetter (Grün)'], ['daily', 'jeden Morgen']] })}
      ${switchRow({ label: '🔧 Service-Erinnerungen', name: 'service', checked: p.service })}
      ${switchRow({ label: '🔖 Pickerl', name: 'pickerl', checked: p.pickerl })}
      ${field({ label: 'Uhrzeit', name: 'hour', type: 'select', value: p.hour, options: hours })}
      <button type="submit" class="btn btn-primary btn-block" ${canEnable ? '' : 'disabled'}>
        ${cfg.enabled ? `${ICONS.check} Speichern` : '🔔 Benachrichtigungen aktivieren'}</button>
    </form>
    ${cfg.enabled ? `<div class="stack mt">
      <button type="button" class="btn btn-block" data-action="push-test">Test-Nachricht senden</button>
      <button type="button" class="btn btn-block" data-action="push-run">Morgen-Nachricht jetzt testen</button>
      <button type="button" class="btn btn-block btn-ghost" data-action="push-disable">Benachrichtigungen deaktivieren</button>
    </div>` : ''}
  </div>`;
}

const AI_PROVIDERS = {
  groq: { label: 'Groq (kostenloses Kontingent)', keyUrl: 'https://console.groq.com/keys', keyName: 'Groq-Schlüssel' },
  anthropic: { label: 'Claude (kostenpflichtig)', keyUrl: 'https://console.anthropic.com/settings/keys', keyName: 'Claude-Schlüssel' },
};

/** KI für die Wartungsdaten: Anbieter und eigener Schlüssel (nur auf diesem Gerät) */
function aiCard(ai) {
  const p = AI_PROVIDERS[ai.provider] || AI_PROVIDERS.groq;
  return `<div class="card">
    <h3>🤖 KI für Wartungsdaten</h3>
    <p class="muted small">Recherchiert Öl, Filter, Reifen &amp; Co. für dein Motorrad (Garage → Wartungsdaten → „Mit KI ausfüllen").
      Läuft über deinen Server (Benachrichtigungen). Der Schlüssel bleibt nur auf diesem Gerät und ist nicht im Backup.</p>
    <div class="kv"><span class="k">Schlüssel</span><span class="v">${ai.apiKey ? 'gespeichert ✅' : 'fehlt'}</span></div>
    <form id="ai-form" class="mt" novalidate>
      ${field({ label: 'Anbieter', name: 'provider', type: 'select', value: ai.provider,
        options: Object.entries(AI_PROVIDERS).map(([k, v]) => [k, v.label]) })}
      ${field({ label: p.keyName, name: 'apiKey', type: 'password', value: ai.apiKey,
        placeholder: ai.provider === 'groq' ? 'gsk_…' : 'sk-ant-…', attrs: 'autocapitalize="off" spellcheck="false" autocomplete="off"',
        hint: `Erstellen: <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl.replace('https://', '')}</a>`
          + (ai.provider === 'anthropic' ? ' · leer lassen, wenn der Schlüssel im Worker gesetzt ist' : '') })}
      <button type="submit" class="btn btn-primary btn-block">${ICONS.check} Speichern</button>
    </form>
  </div>`;
}

/** KI-Einstellungen speichern (mit Plausibilitätsprüfung des Schlüssels) */
async function onAiSubmit(e) {
  e.preventDefault();
  const form = e.target;
  clearFieldErrors(form);
  const provider = form.elements.provider.value;
  const apiKey = form.elements.apiKey.value.trim();
  if (provider === 'groq' && !apiKey) { setFieldError(form, 'apiKey', 'Bitte deinen Groq-Schlüssel eintragen.'); return; }
  if (provider === 'groq' && apiKey.startsWith('sk-ant-')) { setFieldError(form, 'apiKey', 'Das ist ein Claude-Schlüssel – Anbieter auf Claude stellen.'); return; }
  if (provider === 'anthropic' && apiKey.startsWith('gsk_')) { setFieldError(form, 'apiKey', 'Das ist ein Groq-Schlüssel – Anbieter auf Groq stellen.'); return; }
  await db.saveDeviceSettings({ ai: { provider, apiKey } });
  toast('KI-Einstellungen gespeichert', 'ok');
  await render();
}

/** Push-Formular lesen (synchron – wichtig für die iOS-Erlaubnisabfrage) */
function readPushForm(form) {
  const f = form.elements;
  return {
    workerUrl: f.workerUrl.value.trim(),
    token: f.token.value.trim(),
    prefs: {
      weather: f.weather.checked,
      weatherMode: f.weatherMode.value,
      service: f.service.checked,
      pickerl: f.pickerl.checked,
      hour: Number(f.hour.value),
    },
  };
}

export async function show() {
  await render();
}

async function render() {
  const [settings, counts, storage, version, pushCfg, device] = await Promise.all([
    db.getSettings(), db.counts(), storageInfo(), swVersion(), getPushConfig(), db.getDeviceSettings(),
  ]);
  const ai = { provider: 'groq', apiKey: '', ...(device.ai || {}) };
  backupFile = await prepareBackup();

  const last = settings.lastBackup;
  const lastText = last ? `${fmtDate(last)} (${fmtInDays(daysBetween(new Date(), new Date(last)))})` : 'noch nie';
  const share = canShareFiles();

  root.innerHTML = `
    ${ampelCard(settings.thresholds)}
    ${homeCard(settings.home)}
    ${pushCard(pushCfg, settings.home)}
    ${aiCard(ai)}
    ${routeCard(settings)}
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
    case 'reset-ampel':
      await db.saveSettings({ thresholds: structuredClone(db.DEFAULT_SETTINGS.thresholds) });
      toast('Standardwerte wiederhergestellt', 'ok');
      await render();
      break;
    case 'set-home':
      openPlaceSearch({
        title: 'Wohnort wählen',
        showHome: false,
        onPick: async (place) => {
          try {
            const p = place.gps ? await currentPlace() : place;
            await db.saveSettings({ home: { name: p.name, lat: p.lat, lon: p.lon } });
            toast(`Wohnort: ${p.name}`, 'ok');
            await render();
          } catch (err) {
            toast(err.message, 'error', 6000);
          }
        },
      });
      break;
    case 'clear-home':
      await db.saveSettings({ home: null });
      await render();
      break;
    case 'push-test':
    case 'push-run':
      el.disabled = true;
      try {
        const r = await serverTest(el.dataset.action === 'push-test' ? 'test' : 'run');
        if (r.gone) toast('Das Push-Abo ist nicht mehr gültig – bitte deaktivieren und neu aktivieren.', 'error', 7000);
        else if (r.sent) toast(`${r.sent === 1 ? 'Nachricht' : `${r.sent} Nachrichten`} gesendet – sollte gleich ankommen.`, 'ok', 5000);
        else if (el.dataset.action === 'push-run') toast('Heute gäbe es nichts zu melden (kein Wohnort/Fahrwetter, nichts fällig).', 'info', 6000);
        else toast(`Nicht zugestellt (Status ${r.status}).`, 'error', 6000);
      } catch (err) {
        toast(err.message, 'error', 7000);
      }
      el.disabled = false;
      break;
    case 'push-disable':
      if (!await confirmDialog('Keine Benachrichtigungen mehr auf diesem Gerät?', { ok: 'Deaktivieren' })) return;
      await disablePush();
      toast('Benachrichtigungen deaktiviert', 'ok');
      await render();
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

/** Benachrichtigungen aktivieren bzw. Einstellungen speichern */
async function onPushSubmit(e) {
  e.preventDefault();
  const form = e.target;
  clearFieldErrors(form);
  const values = readPushForm(form);
  let ok = true;
  if (!/^https:\/\/\S+$/.test(values.workerUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(values.workerUrl)) {
    setFieldError(form, 'workerUrl', 'Bitte die https-Adresse des Workers eingeben (z. B. https://motorrad-push.name.workers.dev).');
    ok = false;
  }
  if (values.token.length < 8) {
    setFieldError(form, 'token', 'Bitte den Token aus „npm run setup" eintragen.');
    ok = false;
  }
  if (!ok) return;

  const enabled = form.dataset.enabled === 'true';
  // Erlaubnis SOFORT anfragen – iOS zeigt die Abfrage nur direkt nach dem Tippen
  const permission = enabled ? null : requestPermission();
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = enabled ? 'Wird gespeichert …' : 'Wird eingerichtet …';
  try {
    if (enabled) await updatePush(values);
    else await enablePush(values, permission);
    toast(enabled ? 'Gespeichert' : 'Benachrichtigungen aktiviert 🔔 – probier die Test-Nachricht!', 'ok', 5000);
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
  await render();
}

/** Ampel-Grenzwerte prüfen und speichern */
async function onSubmit(e) {
  if (e.target.id === 'push-form') {
    await onPushSubmit(e);
    return;
  }
  if (e.target.id === 'ai-form') {
    await onAiSubmit(e);
    return;
  }
  if (e.target.id !== 'ampel-form') return;
  e.preventDefault();
  const form = e.target;
  clearFieldErrors(form);
  const names = ['rainProbYellow', 'rainProbRed', 'rainMmYellow', 'rainMmRed', 'tempYellow', 'tempRed',
    'gustYellow', 'gustRed', 'rideFrom', 'rideTo'];
  const v = {};
  let ok = true;
  const fail = (name, msg) => { setFieldError(form, name, msg); ok = false; };
  for (const name of names) {
    v[name] = parseDecimal(form.elements[name].value);
    if (!Number.isFinite(v[name])) fail(name, 'Bitte eine Zahl eingeben.');
  }
  if (!ok) return;
  if (v.rainProbYellow < 0 || v.rainProbYellow > 100) fail('rainProbYellow', 'Zwischen 0 und 100 %.');
  if (v.rainProbRed < 0 || v.rainProbRed > 100) fail('rainProbRed', 'Zwischen 0 und 100 %.');
  if (v.rainProbRed <= v.rainProbYellow) fail('rainProbRed', 'Muss größer als Gelb sein.');
  if (v.rainMmRed <= v.rainMmYellow) fail('rainMmRed', 'Muss größer als Gelb sein.');
  if (v.gustRed <= v.gustYellow) fail('gustRed', 'Muss größer als Gelb sein.');
  if (v.tempRed >= v.tempYellow) fail('tempRed', 'Muss kälter als Gelb sein.');
  if (v.rideTo <= v.rideFrom) fail('rideTo', 'Muss nach „Von" liegen.');
  if (!ok) return;
  await db.saveSettings({ thresholds: v });
  toast('Grenzwerte gespeichert', 'ok');
}

async function onChange(e) {
  if (e.target.name === 'provider' && e.target.form?.id === 'ai-form') {
    // Beschriftung und Link zum Schlüssel an den gewählten Anbieter anpassen
    const p = AI_PROVIDERS[e.target.value];
    const wrap = e.target.form.querySelector('[data-field="apiKey"]');
    wrap.querySelector('.lbl').textContent = p.keyName;
    wrap.querySelector('input').placeholder = e.target.value === 'groq' ? 'gsk_…' : 'sk-ant-…';
    wrap.querySelector('.hint').innerHTML = `Erstellen: <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl.replace('https://', '')}</a>`
      + (e.target.value === 'anthropic' ? ' · leer lassen, wenn der Schlüssel im Worker gesetzt ist' : '');
    return;
  }
  if (e.target.name === 'avgSpeed') {
    await db.saveSettings({ avgSpeed: Number(e.target.value) });
    toast(`Durchschnitt: ${e.target.value} km/h`, 'ok');
    return;
  }
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
