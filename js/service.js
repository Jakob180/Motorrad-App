// service.js – Service & Erinnerungen: Wartungsintervalle pro Motorrad (km bzw. Betriebsstunden
// und/oder Zeit), Pickerl (§57a-Begutachtung), Fälligkeits-Übersicht, Hinweis-Banner,
// Hinweise für geplante Fahrten und Kalender-Export (.ics).
//
// "Zuletzt erledigt" ergibt sich automatisch aus dem Logbuch (z. B. letzter Ölwechsel-Eintrag).
// Fehlt ein Eintrag, kann pro Intervall ein Startwert (Datum/Stand) hinterlegt werden.

import * as db from './db.js';
import {
  getBikes, getActiveBike, getEntries, currentOdometer, odometerReadings, meterOf, fmtMeter, parseMeter,
  openEntryForm, METERS,
} from './logbook.js';
import {
  esc, fmtNum, fmtDate, fmtMonthYear, fmtInDays, daysBetween, parseISODate, toISODate, todayISO,
  field, parseDecimal, setFieldError, clearFieldErrors, openSheet, confirmDialog, toast, downloadFile,
  canShareFiles, ICONS,
} from './ui.js';

const hasAny = (list, values) => (list || []).some((v) => values.includes(v));

/** Intervall-Länge ohne überflüssige Kommastelle: "15 Bh", "5.000 km", "2,5 Bh" */
const fmtEvery = (v, bike) => (Number.isInteger(v) ? `${fmtNum(v)} ${meterOf(bike).short}` : fmtMeter(v, bike));
const norm = (s) => String(s || '').trim().toLowerCase();

// Aufgaben: welcher Logbuch-Eintrag zählt als "erledigt"? (entry/preset → Formular bei „Erledigt")
export const TASKS = {
  oil: { label: 'Ölwechsel', icon: '🛢️', entry: 'oil', match: (e) => e.type === 'oil' },
  'chain-lube': {
    label: 'Kette schmieren', icon: '⛓️', entry: 'chain', preset: { actions: ['lube'] },
    match: (e) => e.type === 'chain' && hasAny(e.actions, ['lube', 'replace']),
  },
  'chain-clean': {
    label: 'Kette reinigen', icon: '⛓️', entry: 'chain', preset: { actions: ['clean', 'lube'] },
    match: (e) => e.type === 'chain' && hasAny(e.actions, ['clean', 'replace']),
  },
  'chain-replace': {
    label: 'Kettensatz wechseln', icon: '⛓️', entry: 'chain', preset: { actions: ['replace'] },
    match: (e) => e.type === 'chain' && hasAny(e.actions, ['replace']),
  },
  'tire-front': {
    label: 'Reifen vorne', icon: '🛞', entry: 'tire', preset: { position: 'front' },
    match: (e) => e.type === 'tire' && ['front', 'both'].includes(e.position),
  },
  'tire-rear': {
    label: 'Reifen hinten', icon: '🛞', entry: 'tire', preset: { position: 'rear' },
    match: (e) => e.type === 'tire' && ['rear', 'both'].includes(e.position),
  },
  brakes: { label: 'Bremsbeläge', icon: '🛑', entry: 'brakes', match: (e) => e.type === 'brakes' },
  service: { label: 'Service / Inspektion', icon: '🔧', entry: 'service', match: (e) => e.type === 'service' },
  // Eigene Aufgabe: zählt ein Eintrag "Sonstiges/Service/Reparatur" mit gleicher Bezeichnung
  custom: {
    label: 'Eigene Aufgabe', icon: '📝', entry: 'other',
    match: (e, iv) => ['other', 'service', 'repair'].includes(e.type) && norm(e.title) === norm(iv.name),
  },
};

// Vorschläge zum Start – bitte an die Herstellerangaben anpassen
const SUGGESTIONS = {
  km: [
    { task: 'oil', name: 'Ölwechsel', distance: 5000, months: 12 },
    { task: 'chain-lube', name: 'Kette schmieren', distance: 500, months: null },
    { task: 'service', name: 'Service / Inspektion', distance: 10000, months: 12 },
    { task: 'custom', name: 'Bremsflüssigkeit wechseln', distance: null, months: 24 },
  ],
  h: [
    { task: 'oil', name: 'Ölwechsel', distance: 15, months: 12 },
    { task: 'custom', name: 'Luftfilter reinigen', distance: 5, months: null },
    { task: 'chain-lube', name: 'Kette schmieren', distance: 3, months: null },
    { task: 'service', name: 'Service / Inspektion', distance: 30, months: 12 },
    { task: 'custom', name: 'Bremsflüssigkeit wechseln', distance: null, months: 24 },
  ],
};

const MONTH_OPTIONS = [1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48];
const MONTH_NAMES = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September',
  'Oktober', 'November', 'Dezember'];
const SOON_DAYS = 30;       // „bald fällig" ab 30 Tagen vorher …
const SOON_SHARE = 0.1;     // … bzw. bei den letzten 10 % der Strecke/Stunden

// ======================================================================
// Berechnungen
// ======================================================================

/** ISO-Datum + n Monate (31. Jänner + 1 Monat → 28./29. Februar) */
export function addMonths(iso, n) {
  const d = parseISODate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Durchschnittliche Fahrleistung pro Tag (km bzw. Bh) aus den letzten ~4 Monaten */
export function usagePerDay(entries, bike) {
  const r = odometerReadings(entries, bike);
  if (r.length < 2) return null;
  const last = r[r.length - 1];
  const cutoff = addDays(last.date, -120);
  const first = r.filter((x) => x.date <= cutoff).pop() || r[0];
  const days = daysBetween(first.date, last.date);
  if (days < 14 || last.odo <= first.odo) return null;
  return (last.odo - first.odo) / days;
}

/**
 * Status eines Intervalls.
 * → { iv, task, lastOdo, lastDate, current, dueOdo, distLeft, dueDate, daysLeft, urgency, status }
 * status: 'ok' | 'soon' | 'overdue' | 'unknown'; urgency: verbleibender Anteil (kleiner = dringender)
 */
export function intervalStatus(iv, bike, entries, today = todayISO()) {
  const task = TASKS[iv.task] || TASKS.custom;
  const done = entries.filter((e) => task.match(e, iv));
  const odos = done.map((e) => e.odometer).filter(Number.isFinite);
  if (Number.isFinite(iv.baseOdo)) odos.push(iv.baseOdo);
  const dates = done.map((e) => e.date);
  if (iv.baseDate) dates.push(iv.baseDate);

  const s = {
    iv,
    task,
    lastOdo: odos.length ? Math.max(...odos) : null,
    lastDate: dates.length ? dates.sort()[dates.length - 1] : null,
    current: currentOdometer(entries, bike),
    dueOdo: null,
    distLeft: null,
    dueDate: null,
    daysLeft: null,
  };
  if (iv.distance && s.lastOdo != null && s.current != null) {
    s.dueOdo = s.lastOdo + iv.distance;
    s.distLeft = s.dueOdo - s.current;
  }
  if (iv.months && s.lastDate) {
    s.dueDate = addMonths(s.lastDate, iv.months);
    s.daysLeft = daysBetween(today, s.dueDate);
  }

  const shares = [];
  if (s.distLeft != null) shares.push(s.distLeft / iv.distance);
  if (s.daysLeft != null) shares.push(s.daysLeft / (iv.months * 30.44));
  s.urgency = shares.length ? Math.min(...shares) : null;

  const overdue = (s.distLeft != null && s.distLeft < 0) || (s.daysLeft != null && s.daysLeft < 0);
  const soon = (s.distLeft != null && s.distLeft <= iv.distance * SOON_SHARE)
    || (s.daysLeft != null && s.daysLeft <= SOON_DAYS);
  s.status = s.urgency == null ? 'unknown' : overdue ? 'overdue' : soon ? 'soon' : 'ok';
  return s;
}

/** "vor 2 Wochen" → "2 Wochen" für "überfällig seit …" */
function since(days) {
  if (days === -1) return 'gestern';
  return fmtInDays(days).replace(/^vor /, '');
}

/** Texte: { main: "Fällig in 320 km", other: "oder in 5 Monaten" } */
export function statusText(s, bike) {
  if (s.status === 'unknown') return { main: 'Noch nicht erfasst', other: 'Trag ein, wann es zuletzt gemacht wurde.' };
  const parts = [];
  if (s.distLeft != null) {
    parts.push({
      kind: meterOf(bike).short,
      share: s.distLeft / s.iv.distance,
      text: s.distLeft < 0 ? `überfällig seit ${fmtMeter(-s.distLeft, bike)}` : `fällig in ${fmtMeter(s.distLeft, bike)}`,
    });
  }
  if (s.daysLeft != null) {
    let text;
    if (s.daysLeft < 0) text = `überfällig seit ${since(s.daysLeft)}`;
    else if (s.daysLeft === 0) text = 'heute fällig';
    else text = `fällig ${fmtInDays(s.daysLeft)}`;
    parts.push({ kind: 'Zeit', share: s.daysLeft / (s.iv.months * 30.44), text });
  }
  parts.sort((a, b) => a.share - b.share);
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  let other = '';
  if (parts[1]) {
    // Ist das Dringendere schon überfällig, das andere nur als Zusatzinfo nennen
    other = parts[0].share < 0 ? `(${parts[1].kind}: ${parts[1].text})` : `oder ${parts[1].text.replace(/^fällig /, '')}`;
  }
  return { main: cap(parts[0].text), other };
}

/**
 * Pickerl (§57a): Begutachtung möglich ab dem Monat VOR der Lochung,
 * Toleranzfrist bis Ende des 4. Monats NACH der Lochung.
 */
export function pickerlStatus(bike, now = new Date()) {
  if (!bike?.pickerlMonth) return null;
  const [y, m] = bike.pickerlMonth.split('-').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(y, m - 1, 1);
  const windowStart = new Date(y, m - 2, 1);
  const dueEnd = new Date(y, m, 0);
  const graceEnd = new Date(y, m + 4, 0);
  const label = fmtMonthYear(due);

  if (today > graceEnd) {
    return { status: 'overdue', due, windowStart, graceEnd, text: 'Abgelaufen!',
      detail: `Die Toleranzfrist endete am ${fmtDate(graceEnd)}. Ohne gültiges Pickerl nicht fahren.` };
  }
  if (today > dueEnd) {
    return { status: 'overdue', due, windowStart, graceEnd, text: 'Toleranzfrist läuft',
      detail: `Gelocht war ${label}. Spätestens bis ${fmtDate(graceEnd)} (${fmtInDays(daysBetween(today, graceEnd))}) begutachten lassen.` };
  }
  if (today >= windowStart) {
    return { status: 'soon', due, windowStart, graceEnd, text: `Jetzt fällig (${label})`,
      detail: `Begutachtung möglich seit ${fmtDate(windowStart)}, Toleranz bis ${fmtDate(graceEnd)}.` };
  }
  const toWindow = daysBetween(today, windowStart);
  return {
    status: toWindow <= SOON_DAYS ? 'soon' : 'ok',
    due, windowStart, graceEnd,
    text: `Fällig im ${label}`,
    detail: `Begutachtung möglich ab ${fmtDate(windowStart)} (${fmtInDays(toWindow)}), Toleranz bis ${fmtDate(graceEnd)}.`,
  };
}

/** Alles Fällige (bald/überfällig) über alle Motorräder – für Banner & Push */
export async function dueOverview() {
  const items = [];
  for (const bike of await getBikes()) {
    const entries = await getEntries(bike.id);
    const ivs = await db.getAllByIndex('intervals', 'bikeId', bike.id);
    for (const iv of ivs) {
      const s = intervalStatus(iv, bike, entries);
      if (s.status === 'soon' || s.status === 'overdue') {
        items.push({ bike, name: iv.name, status: s.status, text: statusText(s, bike).main, urgency: s.urgency, s });
      }
    }
    const p = pickerlStatus(bike);
    if (p && p.status !== 'ok') items.push({ bike, name: 'Pickerl', status: p.status, text: p.text, urgency: p.status === 'overdue' ? -1 : 0, pickerl: p });
  }
  return items.sort((a, b) => (a.status === b.status ? a.urgency - b.urgency : a.status === 'overdue' ? -1 : 1));
}

/**
 * Hinweise vor einer Fahrt für das aktive Motorrad: alles Fällige plus Intervalle,
 * die während der Fahrt fällig werden (km bzw. bei Bh die geschätzte Fahrzeit).
 */
export async function rideHints({ km = 0, hours = 0 } = {}) {
  const bike = await getActiveBike();
  if (!bike) return [];
  const entries = await getEntries(bike.id);
  const ivs = await db.getAllByIndex('intervals', 'bikeId', bike.id);
  const isHours = meterOf(bike) === METERS.h;
  const usage = isHours ? hours : km;
  const hints = [];
  for (const iv of ivs) {
    const s = intervalStatus(iv, bike, entries);
    const duringRide = usage > 0 && s.distLeft != null && s.distLeft >= 0 && s.distLeft < usage;
    if (duringRide && s.status !== 'overdue') {
      const ride = isHours ? `die Fahrt dauert ca. ${fmtNum(hours, 1)} h` : `die Route ist ${fmtNum(km)} km lang`;
      hints.push({ status: 'soon', icon: s.task.icon, text: `${iv.name}: fällig in ${fmtMeter(s.distLeft, bike)} – ${ride}` });
    } else if (s.status === 'soon' || s.status === 'overdue') {
      hints.push({ status: s.status, icon: s.task.icon, text: `${iv.name}: ${statusText(s, bike).main.toLowerCase()}` });
    }
  }
  const p = pickerlStatus(bike);
  if (p && p.status === 'overdue') hints.push({ status: 'overdue', icon: '🔖', text: `Pickerl: ${p.text}` });
  return hints.sort((a, b) => (a.status === 'overdue' ? -1 : 0) - (b.status === 'overdue' ? -1 : 0));
}

// ======================================================================
// Kalender-Export (.ics)
// ======================================================================

function icsEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Zeilen auf max. 75 Byte umbrechen (iCalendar-Vorgabe, Folgezeilen beginnen mit Leerzeichen) */
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const max = out.length ? 74 : 75;
    if (bytes + b > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Ganztägiger Termin mit optionaler Erinnerung (alarm z. B. '-PT15H' = Vortag 9:00) */
export function buildIcs({ uid, title, date, description, alarm }) {
  const day = date.replace(/-/g, '');
  const next = addDays(date, 1).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Motorrad-Begleiter//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
    `SUMMARY:${icsEscape(title)}`, `DESCRIPTION:${icsEscape(description)}`, 'TRANSP:TRANSPARENT',
  ];
  if (alarm) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`, `TRIGGER:${alarm}`, 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

/** Sheet: Datum & Erinnerung wählen, dann .ics laden oder teilen */
function openIcsSheet({ uid, title, date, description, hint }) {
  const alarms = [['-PT15H', 'Am Vortag um 9 Uhr'], ['-P6DT15H', '1 Woche vorher um 9 Uhr'], ['PT9H', 'Am Tag selbst um 9 Uhr'], ['', 'Keine Erinnerung']];
  const share = canShareFiles();
  let makeFile = null;
  openSheet({
    title: '📅 In den Kalender',
    body: `<p class="muted small">${esc(hint || '')}</p>
      ${field({ label: 'Termin', name: 'date', type: 'date', value: date })}
      ${field({ label: 'Erinnerung', name: 'alarm', type: 'select', value: '-PT15H', options: alarms })}
      <p class="muted small">Am iPhone öffnet sich die Termin-Vorschau → „Hinzufügen". Die Erinnerung kommt dann vom Kalender.</p>`,
    footer: `${share ? '<button type="button" class="btn" data-share>Teilen …</button>' : '<button type="button" class="btn" data-close>Abbrechen</button>'}
      <button type="submit" class="btn btn-primary">${ICONS.download} Kalender-Datei</button>`,
    onOpen: (dlg, form, close) => {
      makeFile = () => {
        const ics = buildIcs({ uid, title, date: form.elements.date.value || date, description, alarm: form.elements.alarm.value });
        return new File([ics], `${title.replace(/[^\wäöüÄÖÜß -]/g, '').trim().replace(/\s+/g, '-') || 'termin'}.ics`, { type: 'text/calendar' });
      };
      form.querySelector('[data-share]')?.addEventListener('click', async () => {
        try {
          await navigator.share({ files: [makeFile()], title });
          close();
        } catch (err) {
          if (err.name !== 'AbortError') toast(err.message, 'error');
        }
      });
    },
    onSubmit: (form, close) => {
      const file = makeFile();
      downloadFile(file, file.name);
      close();
    },
  });
}

// ======================================================================
// Ansicht (Service-Tab)
// ======================================================================

let root = null;
let renderSeq = 0;

export function init(el) {
  root = el;
  root.addEventListener('click', onClick);
  // Änderungen (z. B. „Erledigt" → neuer Logbuch-Eintrag) sofort anzeigen, wenn der Tab offen ist
  window.addEventListener('data-changed', (e) => {
    if (!root.hidden && ['entries', 'intervals', 'bikes', 'all'].includes(e.detail.store)) render();
  });
}

export async function show() {
  await render();
}

const STATUS_LABEL = { ok: 'OK', soon: 'Bald fällig', overdue: 'Überfällig', unknown: 'Unbekannt' };

async function render() {
  const seq = ++renderSeq;
  const bike = await getActiveBike();
  if (!bike) {
    root.innerHTML = `<div class="empty"><div class="e">🔧</div><h3>Noch kein Motorrad</h3>
      <p>Lege zuerst im Logbuch ein Motorrad an – dann kannst du hier Wartungsintervalle und das Pickerl verwalten.</p>
      <a class="btn btn-primary" href="#logbuch/garage">${ICONS.plus} Motorrad anlegen</a></div>`;
    return;
  }
  const entries = await getEntries(bike.id);
  const ivs = await db.getAllByIndex('intervals', 'bikeId', bike.id);
  if (seq !== renderSeq) return;

  const statuses = ivs.map((iv) => intervalStatus(iv, bike, entries))
    .sort((a, b) => (a.urgency ?? 99) - (b.urgency ?? 99));
  const pick = pickerlStatus(bike);
  const current = currentOdometer(entries, bike);
  const rate = usagePerDay(entries, bike);
  const m = meterOf(bike);

  // Zusammenfassung
  const all = [...statuses.map((s) => s.status), pick?.status].filter(Boolean);
  const overdue = all.filter((s) => s === 'overdue').length;
  const soon = all.filter((s) => s === 'soon').length;
  const lvl = overdue ? 2 : soon ? 1 : 0;
  const verdict = overdue ? `${overdue} ${overdue === 1 ? 'Sache' : 'Sachen'} überfällig`
    : soon ? `${soon} ${soon === 1 ? 'Sache' : 'Sachen'} bald fällig` : 'Alles im grünen Bereich';

  let html = `<section class="hero l${lvl} svc-hero">
      <div class="hero-top">
        <div class="lamps" aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></div>
        <div><div class="hero-day">${esc(bike.name)}</div><div class="hero-verdict">${verdict}</div></div>
      </div>
    </section>`;

  // Aktueller Zählerstand
  const lastReading = odometerReadings(entries, bike).pop();
  html += `<div class="card">
      <div class="card-head"><h3>📏 ${m.reading}</h3>
        <button type="button" class="btn btn-sm" data-action="odometer">Aktualisieren</button></div>
      <div class="kv"><span class="k">Aktuell</span><span class="v">${current != null ? fmtMeter(current, bike) : 'noch unbekannt'}</span></div>
      ${lastReading ? `<div class="kv"><span class="k">Stand vom</span><span class="v">${fmtDate(lastReading.date)}</span></div>` : ''}
      ${rate ? `<div class="kv"><span class="k">Ø Fahrleistung</span><span class="v">${fmtMeter(rate * 7, bike)} / Woche</span></div>` : ''}
      <p class="muted small mt">Fälligkeiten nach ${m.label} stimmen nur, wenn der Stand aktuell ist –
        er kommt automatisch aus dem Logbuch oder du trägst ihn hier ein.</p>
    </div>`;

  // Pickerl
  html += `<div class="card svc s-${pick ? pick.status : 'unknown'}">
      <div class="svc-head"><span class="svc-ico" aria-hidden="true">🔖</span>
        <div class="svc-main"><div class="svc-name">Pickerl (§57a)</div>
          <div class="svc-status">${pick ? esc(pick.text) : 'Noch nicht eingetragen'}</div></div></div>
      <p class="muted small">${pick ? esc(pick.detail) : 'Trag den Monat ein, der auf deinem Pickerl gelocht ist.'}</p>
      <div class="row">
        ${pick ? `<button type="button" class="btn btn-sm btn-primary" data-action="pickerl-done">${ICONS.check} Erledigt</button>
          <button type="button" class="btn btn-sm" data-action="pickerl-ics">📅 Kalender</button>` : ''}
        <button type="button" class="btn btn-sm" data-action="pickerl-edit">${pick ? ICONS.edit : ICONS.plus} ${pick ? 'Ändern' : 'Monat eintragen'}</button>
      </div>
    </div>`;

  // Intervalle
  html += `<h2>Wartung</h2>`;
  if (!statuses.length) {
    html += `<div class="card"><p>Noch keine Intervalle. Leg eigene an oder übernimm Vorschläge
      für ${m === METERS.h ? 'Enduros (Betriebsstunden)' : 'Straßenmotorräder (Kilometer)'}.</p>
      <button type="button" class="btn btn-primary btn-block" data-action="suggest">✨ Vorschläge übernehmen</button></div>`;
  }
  for (const s of statuses) {
    const t = statusText(s, bike);
    const iv = s.iv;
    const every = [iv.distance ? `alle ${fmtEvery(iv.distance, bike)}` : '', iv.months ? `${iv.distance ? 'oder ' : 'alle '}${iv.months} Monate` : '']
      .filter(Boolean).join(' ');
    const last = s.lastDate || s.lastOdo != null
      ? `zuletzt ${s.lastDate ? fmtDate(s.lastDate) : ''}${s.lastOdo != null ? ` bei ${fmtMeter(s.lastOdo, bike)}` : ''}` : '';
    // Schätzung, wann ein km/Bh-Intervall erreicht ist
    const est = rate && s.distLeft != null && s.distLeft > 0 && s.daysLeft == null
      ? `≈ ${fmtInDays(Math.round(s.distLeft / rate))} bei deiner Fahrleistung` : '';
    const used = s.urgency == null ? 0 : Math.min(100, Math.max(0, (1 - s.urgency) * 100));
    html += `<div class="card svc s-${s.status}">
        <div class="svc-head"><span class="svc-ico" aria-hidden="true">${s.task.icon}</span>
          <div class="svc-main">
            <div class="svc-name">${esc(iv.name)} <span class="svc-badge">${STATUS_LABEL[s.status]}</span></div>
            <div class="svc-status">${esc(t.main)}</div>
            ${t.other ? `<div class="muted small">${esc(t.other)}</div>` : ''}
          </div></div>
        ${s.urgency != null ? `<div class="bar svc-bar"><i style="width:${used.toFixed(0)}%"></i></div>` : ''}
        <p class="muted small">${[every, last, est].filter(Boolean).map(esc).join(' · ')}</p>
        <div class="row">
          <button type="button" class="btn btn-sm btn-primary" data-action="done" data-id="${esc(iv.id)}">${ICONS.check} Erledigt</button>
          <button type="button" class="btn btn-sm" data-action="ics" data-id="${esc(iv.id)}">📅 Kalender</button>
          <button type="button" class="btn btn-sm" data-action="edit" data-id="${esc(iv.id)}" aria-label="Intervall bearbeiten">${ICONS.edit}</button>
        </div>
      </div>`;
  }
  html += `<button type="button" class="btn btn-block" data-action="add">${ICONS.plus} Intervall hinzufügen</button>
    ${statuses.length ? '<button type="button" class="btn btn-block btn-ghost mt" data-action="suggest">✨ Vorschläge ansehen</button>' : ''}
    <p class="muted small mt">„Erledigt" trägt die Arbeit ins Logbuch ein – das Intervall startet dann automatisch neu.
      Bald fällig heißt: weniger als ${SOON_DAYS} Tage bzw. die letzten ${SOON_SHARE * 100} % des Intervalls.</p>`;

  root.innerHTML = html;
  root.statuses = statuses;
}

// ---------- Aktionen ----------

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const bike = await getActiveBike();
  if (!bike) return;
  const s = (root.statuses || []).find((x) => x.iv.id === el.dataset.id);
  switch (el.dataset.action) {
    case 'add':
      openIntervalForm(bike);
      break;
    case 'edit':
      if (s) openIntervalForm(bike, s.iv);
      break;
    case 'done':
      if (s) markDone(bike, s);
      break;
    case 'ics':
      if (s) intervalToCalendar(bike, s);
      break;
    case 'suggest':
      openSuggestions(bike);
      break;
    case 'odometer':
      openOdometerForm(bike);
      break;
    case 'pickerl-edit':
      openPickerlForm(bike);
      break;
    case 'pickerl-done':
      openPickerlForm(bike, { done: true });
      break;
    case 'pickerl-ics': {
      const p = pickerlStatus(bike);
      openIcsSheet({
        uid: `pickerl-${bike.id}-${bike.pickerlMonth}@motorrad-begleiter`,
        title: `${bike.name}: Pickerl (§57a)`,
        date: toISODate(p.windowStart),
        description: `Pickerl ${fmtMonthYear(p.due)}. Begutachtung möglich ab ${fmtDate(p.windowStart)}, Toleranz bis ${fmtDate(p.graceEnd)}.`,
        hint: 'Vorgeschlagen ist der erste Tag, an dem die Begutachtung möglich ist.',
      });
      break;
    }
    default:
  }
}

/** „Erledigt": passenden Logbuch-Eintrag vorausgefüllt öffnen */
function markDone(bike, s) {
  const task = s.task;
  const preset = { ...(task.preset || {}) };
  if (s.iv.task === 'custom') preset.title = s.iv.name;
  openEntryForm(task.entry, null, preset);
}

/** Kalender-Termin für ein Intervall: Fälligkeitsdatum oder Schätzung aus der Fahrleistung */
async function intervalToCalendar(bike, s) {
  const entries = await getEntries(bike.id);
  const rate = usagePerDay(entries, bike);
  let date = s.dueDate;
  let hint = s.dueDate ? 'Vorgeschlagen ist das Fälligkeitsdatum.' : '';
  if (s.distLeft != null) {
    const estDate = rate ? addDays(todayISO(), Math.max(0, Math.round(s.distLeft / rate))) : null;
    if (estDate && (!date || estDate < date)) {
      date = estDate;
      hint = `Geschätzt aus deiner Fahrleistung (${fmtMeter(rate * 7, bike)}/Woche) – bei ${fmtMeter(s.dueOdo, bike)}.`;
    }
  }
  if (!date) {
    date = addDays(todayISO(), 7);
    hint = 'Für dieses Intervall lässt sich kein Datum berechnen – wähle selbst eines.';
  }
  const desc = [
    `${s.iv.name} für ${bike.name}.`,
    s.dueOdo != null ? `Fällig bei ${fmtMeter(s.dueOdo, bike)}.` : '',
    s.dueDate ? `Spätestens am ${fmtDate(s.dueDate)}.` : '',
    'Erstellt mit dem Motorrad-Begleiter.',
  ].filter(Boolean).join(' ');
  openIcsSheet({ uid: `${s.iv.id}-${date}@motorrad-begleiter`, title: `${bike.name}: ${s.iv.name}`, date, description: desc, hint });
}

/** Formular: Intervall anlegen/bearbeiten */
async function openIntervalForm(bike, iv = null) {
  const m = meterOf(bike);
  const entries = await getEntries(bike.id);
  const v = iv || { task: 'oil', name: TASKS.oil.label, distance: null, months: 12 };
  const taskOptions = Object.entries(TASKS).map(([k, t]) => [k, `${t.icon} ${t.label}`]);
  const monthOptions = [['', '–'], ...MONTH_OPTIONS.map((n) => [n, `${n} Monate`])];

  const logInfo = () => {
    const tmp = intervalStatus({ ...v, baseOdo: null, baseDate: null }, bike, entries);
    return tmp.lastDate
      ? `Zuletzt laut Logbuch: ${fmtDate(tmp.lastDate)}${tmp.lastOdo != null ? ` bei ${fmtMeter(tmp.lastOdo, bike)}` : ''}.`
      : 'Noch kein passender Logbuch-Eintrag.';
  };

  const body = `
    ${field({ label: 'Art', name: 'task', type: 'select', value: v.task, options: taskOptions })}
    ${field({ label: 'Bezeichnung', name: 'name', value: v.name, required: true })}
    <div class="grid2">
      ${field({ label: `Alle … ${m.short}`, name: 'distance', inputmode: m.decimals ? 'decimal' : 'numeric',
        value: v.distance ? fmtNum(v.distance, Number.isInteger(v.distance) ? 0 : m.decimals) : '',
        placeholder: m === METERS.h ? 'z. B. 15' : 'z. B. 5.000' })}
      ${field({ label: 'und/oder alle', name: 'months', type: 'select', value: v.months || '', options: monthOptions })}
    </div>
    <p class="muted small" id="log-info">${esc(logInfo())}</p>
    <div class="form-sub">Zuletzt erledigt (nur nötig, wenn es nicht im Logbuch steht)</div>
    <div class="grid2">
      ${field({ label: 'Datum', name: 'baseDate', type: 'date', value: v.baseDate || '' })}
      ${field({ label: m.reading, name: 'baseOdo', inputmode: m.decimals ? 'decimal' : 'numeric',
        value: Number.isFinite(v.baseOdo) ? fmtNum(v.baseOdo, m.decimals) : '', placeholder: m.short })}
    </div>`;

  const footer = `${iv ? `<button type="button" class="btn btn-danger-ghost" data-delete aria-label="Intervall löschen">${ICONS.trash}</button>` : ''}
    <button type="button" class="btn" data-close>Abbrechen</button>
    <button type="submit" class="btn btn-primary">Speichern</button>`;

  openSheet({
    title: iv ? 'Intervall bearbeiten' : 'Neues Intervall',
    body,
    footer,
    onOpen: (dlg, form, close) => {
      // Art geändert → Bezeichnung mitziehen, solange sie nicht selbst geändert wurde
      let lastLabel = TASKS[v.task]?.label;
      form.elements.task.addEventListener('change', () => {
        const t = TASKS[form.elements.task.value];
        if (!form.elements.name.value.trim() || form.elements.name.value === lastLabel) {
          form.elements.name.value = form.elements.task.value === 'custom' ? '' : t.label;
        }
        lastLabel = t.label;
        v.task = form.elements.task.value;
        v.name = form.elements.name.value;
        form.querySelector('#log-info').textContent = logInfo();
      });
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await confirmDialog(`Intervall „${iv.name}" löschen? Die Logbuch-Einträge bleiben erhalten.`, { ok: 'Löschen', danger: true })) return;
        await db.remove('intervals', iv.id);
        close();
        toast('Intervall gelöscht', 'ok');
      });
    },
    onSubmit: async (form, close) => {
      clearFieldErrors(form);
      const f = form.elements;
      const name = f.name.value.trim();
      const distance = parseMeter(f.distance.value, bike);
      const months = f.months.value ? Number(f.months.value) : null;
      const baseOdo = parseMeter(f.baseOdo.value, bike);
      let ok = true;
      if (!name) { setFieldError(form, 'name', 'Bitte eine Bezeichnung eingeben.'); ok = false; }
      if (Number.isNaN(distance) || distance < 0) { setFieldError(form, 'distance', 'Bitte eine Zahl eingeben.'); ok = false; }
      if (!distance && !months) { setFieldError(form, 'distance', `Bitte ${m.short} und/oder Monate angeben.`); ok = false; }
      if (Number.isNaN(baseOdo)) { setFieldError(form, 'baseOdo', 'Bitte eine Zahl eingeben.'); ok = false; }
      if (!ok) return;
      await db.put('intervals', {
        ...(iv || {}),
        id: iv?.id || db.uid(),
        bikeId: bike.id,
        task: f.task.value,
        name,
        distance: distance || null,
        months,
        baseDate: f.baseDate.value || null,
        baseOdo: baseOdo ?? null,
        createdAt: iv?.createdAt || new Date().toISOString(),
      });
      close();
      toast(iv ? 'Intervall gespeichert' : 'Intervall angelegt', 'ok');
    },
  });
}

/** Vorschläge für km- bzw. Bh-Motorräder auswählen und anlegen */
async function openSuggestions(bike) {
  const m = meterOf(bike);
  const list = SUGGESTIONS[m === METERS.h ? 'h' : 'km'];
  const existing = (await db.getAllByIndex('intervals', 'bikeId', bike.id)).map((iv) => norm(iv.name));
  const rows = list.map((sg, i) => {
    const every = [sg.distance ? `alle ${fmtEvery(sg.distance, bike)}` : '', sg.months ? `${sg.distance ? 'oder ' : 'alle '}${sg.months} Monate` : '']
      .filter(Boolean).join(' ');
    const has = existing.includes(norm(sg.name));
    return `<label class="switch-row">
      <span>${TASKS[sg.task].icon} ${esc(sg.name)}<br><span class="muted small">${esc(every)}${has ? ' · schon vorhanden' : ''}</span></span>
      <input type="checkbox" name="s${i}" ${has ? '' : 'checked'}><span class="switch" aria-hidden="true"></span>
    </label>`;
  }).join('');
  openSheet({
    title: 'Vorschläge',
    body: `<p class="muted small">Übliche Werte als Startpunkt – bitte mit den Angaben im Handbuch deines Motorrads
      abgleichen und bei Bedarf anpassen.</p>${rows}`,
    footer: `<button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Übernehmen</button>`,
    onSubmit: async (form, close) => {
      let count = 0;
      for (const [i, sg] of list.entries()) {
        if (!form.elements[`s${i}`].checked) continue;
        await db.put('intervals', { id: db.uid(), bikeId: bike.id, ...sg, baseDate: null, baseOdo: null, createdAt: new Date().toISOString() });
        count++;
      }
      close();
      if (count) toast(`${count} Intervall${count === 1 ? '' : 'e'} angelegt – trag bei Bedarf ein, wann zuletzt erledigt.`, 'ok', 5000);
    },
  });
}

/** Aktuellen Zählerstand eintragen (ohne Logbuch-Eintrag) */
async function openOdometerForm(bike) {
  const m = meterOf(bike);
  const entries = await getEntries(bike.id);
  const current = currentOdometer(entries, bike);
  openSheet({
    title: `${m.reading} eintragen`,
    body: `${field({ label: `Aktueller Stand (${m.short})`, name: 'odo', inputmode: m.decimals ? 'decimal' : 'numeric',
        placeholder: current != null ? fmtNum(current, m.decimals) : m.short, required: true,
        hint: current != null ? `bisher: ${fmtMeter(current, bike)}` : '' })}
      ${field({ label: 'Datum', name: 'date', type: 'date', value: todayISO() })}`,
    footer: `<button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>`,
    onSubmit: async (form, close) => {
      clearFieldErrors(form);
      const odo = parseMeter(form.elements.odo.value, bike);
      if (odo == null || Number.isNaN(odo)) { setFieldError(form, 'odo', 'Bitte eine Zahl eingeben.'); return; }
      if (current != null && odo < current && !await confirmDialog(
        `${fmtMeter(odo, bike)} ist weniger als der bisher bekannte Stand (${fmtMeter(current, bike)}). Trotzdem speichern?`,
        { ok: 'Speichern' },
      )) return;
      await db.put('bikes', { ...bike, odometer: odo, odometerDate: form.elements.date.value || todayISO() });
      close();
      toast('Stand gespeichert', 'ok');
    },
  });
}

/** Pickerl-Monat eintragen bzw. nach der Begutachtung den nächsten Monat setzen */
function openPickerlForm(bike, { done = false } = {}) {
  const now = new Date();
  let [y, m] = bike.pickerlMonth ? bike.pickerlMonth.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  if (done) y += 1; // Motorräder ab dem 5. Jahr: jährlich (gleicher Monat)
  const years = [];
  for (let i = now.getFullYear() - 1; i <= now.getFullYear() + 5; i++) years.push([i, String(i)]);
  openSheet({
    title: done ? 'Pickerl erledigt 🎉' : 'Pickerl (§57a)',
    body: `<p class="muted small">${done
      ? 'Trag den Monat ein, der auf dem NEUEN Pickerl gelocht ist (bei Motorrädern meist ein Jahr später).'
      : 'Welcher Monat ist auf dem Pickerl gelocht?'}</p>
      <div class="grid2">
        ${field({ label: 'Monat', name: 'month', type: 'select', value: m, options: MONTH_NAMES.map((n, i) => [i + 1, n]) })}
        ${field({ label: 'Jahr', name: 'year', type: 'select', value: y, options: years })}
      </div>
      ${done ? field({ label: 'Kosten (€, optional – landet im Logbuch)', name: 'cost', inputmode: 'decimal', placeholder: '0,00' }) : ''}`,
    footer: `${bike.pickerlMonth && !done ? `<button type="button" class="btn btn-danger-ghost" data-delete aria-label="Pickerl entfernen">${ICONS.trash}</button>` : ''}
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>`,
    onOpen: (dlg, form, close) => {
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        const { pickerlMonth, ...rest } = bike;
        await db.put('bikes', rest);
        close();
      });
    },
    onSubmit: async (form, close) => {
      const month = `${form.elements.year.value}-${String(form.elements.month.value).padStart(2, '0')}`;
      if (done) {
        const cost = parseDecimal(form.elements.cost.value);
        if (Number.isNaN(cost)) { setFieldError(form, 'cost', 'Bitte einen gültigen Betrag eingeben.'); return; }
        await db.put('entries', {
          id: db.uid(), bikeId: bike.id, type: 'other', title: 'Pickerl (§57a)', date: todayISO(),
          odometer: null, cost: cost ?? null, note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
      await db.put('bikes', { ...bike, pickerlMonth: month });
      close();
      toast(done ? `Nächstes Pickerl: ${fmtMonthYear(`${month}-01`)}` : 'Pickerl gespeichert', 'ok');
    },
  });
}
