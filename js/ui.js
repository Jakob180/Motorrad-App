// ui.js – Gemeinsame UI-Helfer: DOM, Formatierung (Österreich), Formularbausteine,
// Dialoge (Bottom-Sheets), Banner, Toasts und Nachladen externer Bibliotheken.

export const LOCALE = 'de-AT';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** HTML-Sonderzeichen maskieren – für ALLE Nutzereingaben, die per innerHTML landen */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- Zahlen ----------

// Hinweis: Für Zahlen wird bewusst 'de-DE' verwendet. 'de-AT' gruppiert Tausender laut
// Unicode-Standard mit Leerzeichen ("12 345"), im Alltag ist "12.345" üblicher.
const numberFormats = new Map();
function numberFormat(digits) {
  if (!numberFormats.has(digits)) {
    numberFormats.set(digits, new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  }
  return numberFormats.get(digits);
}

export function fmtNum(n, digits = 0) {
  return Number.isFinite(n) ? numberFormat(digits).format(n) : '–';
}

export function fmtKm(n) {
  return Number.isFinite(n) ? `${fmtNum(n)} km` : '–';
}

const euroFormat = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR' });
export function fmtEuro(n) {
  return Number.isFinite(n) ? euroFormat.format(n) : '–';
}

/** "12,5" / "12.5" / "1.234,50" → Zahl; leer → null; ungültig → NaN */
export function parseDecimal(input) {
  if (typeof input === 'number') return input;
  let s = String(input ?? '').trim().replace(/[\s€]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** "12.345" / "12 345" → 12345 (Kilometerstände); leer → null */
export function parseInteger(input) {
  const s = String(input ?? '').replace(/[^\d]/g, '');
  return s ? parseInt(s, 10) : null;
}

// ---------- Datum & Zeit ----------

export const MONTHS_SHORT = ['Jän', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** 'YYYY-MM-DD' → Date (lokale Mitternacht, nicht UTC!) */
export function parseISODate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Date → 'YYYY-MM-DD' in lokaler Zeit */
export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const todayISO = () => toISODate(new Date());

const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthYearFormat = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseISODate(value);
  return new Date(value);
}

/** → "26.10.2026" */
export function fmtDate(value) {
  const d = toDate(value);
  return d && !isNaN(d) ? dateFormat.format(d) : '–';
}

/** → "26.10." */
export function fmtDateShort(value) {
  const d = toDate(value);
  return d && !isNaN(d) ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.` : '–';
}

/** → "Oktober 2026" (in Österreich: "Jänner") */
export function fmtMonthYear(value) {
  const d = toDate(value);
  return d && !isNaN(d) ? monthYearFormat.format(d) : '–';
}

/** → "14:30" */
export function fmtTime(value) {
  const d = toDate(value);
  return d && !isNaN(d) ? timeFormat.format(d) : '–';
}

/** Ganze Tage zwischen zwei Daten (b − a), unabhängig von Sommerzeit */
export function daysBetween(a, b) {
  const da = toDate(a);
  const dbb = toDate(b);
  const utcA = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const utcB = Date.UTC(dbb.getFullYear(), dbb.getMonth(), dbb.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

/** Tage → "heute", "morgen", "in 5 Tagen", "in 3 Wochen", "in 4 Monaten" */
export function fmtInDays(days) {
  if (days === 0) return 'heute';
  if (days === 1) return 'morgen';
  if (days === -1) return 'gestern';
  const abs = Math.abs(days);
  let text;
  if (abs < 14) text = `${abs} Tagen`;
  else if (abs < 60) text = `${Math.round(abs / 7)} Wochen`;
  else if (abs < 730) text = `${Math.round(abs / 30.44)} Monaten`;
  else text = `${fmtNum(abs / 365.25, 1)} Jahren`;
  return days > 0 ? `in ${text}` : `vor ${text}`;
}

// ---------- Icons (Strich-Icons, 24×24) ----------

export const ICONS = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4M12 2v13"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 10 12h5l3.5 5M15 12l-2-5h-2M15 7h3"/></svg>',
};

// ---------- Formular-Bausteine ----------

/**
 * Eingabefeld mit Beschriftung.
 * type: text | number | date | month | textarea | select; options für select: [[wert, text], …]
 */
export function field({
  label, name, value = '', type = 'text', inputmode, placeholder = '', required = false,
  hint = '', options = [], attrs = '',
}) {
  const common = `name="${esc(name)}" id="f-${esc(name)}" ${required ? 'required' : ''} ${attrs}`;
  let control;
  if (type === 'textarea') {
    control = `<textarea ${common} placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  } else if (type === 'select') {
    control = `<select ${common}>${options.map(([v, t]) =>
      `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  } else {
    control = `<input type="${type}" ${common} value="${esc(value)}" placeholder="${esc(placeholder)}"
      ${inputmode ? `inputmode="${inputmode}"` : ''} autocomplete="off" enterkeyhint="next">`;
  }
  return `<label class="field" data-field="${esc(name)}">
    <span class="lbl">${esc(label)}${required ? ' *' : ''}</span>
    ${control}
    ${hint ? `<span class="hint">${hint}</span>` : ''}
    <span class="error" hidden></span>
  </label>`;
}

/** Ein-/Aus-Schalter */
export function switchRow({ label, name, checked = false, hint = '' }) {
  return `<label class="switch-row">
    <span>${esc(label)}${hint ? `<br><span class="muted small">${hint}</span>` : ''}</span>
    <input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}>
    <span class="switch" aria-hidden="true"></span>
  </label>`;
}

/** Segment-Auswahl. options: { wert: 'Text' }; multi=true → Mehrfachauswahl (Checkboxen) */
export function segInput({ label, name, options, value, multi = false }) {
  const selected = multi ? new Set(value || []) : new Set([value]);
  const kind = multi ? 'checkbox' : 'radio';
  return `<div class="field" data-field="${esc(name)}">
    ${label ? `<span class="lbl">${esc(label)}</span>` : ''}
    <div class="seg-input" role="${multi ? 'group' : 'radiogroup'}">
      ${Object.entries(options).map(([v, t]) => `<label>
        <input type="${kind}" name="${esc(name)}" value="${esc(v)}" ${selected.has(v) ? 'checked' : ''}>
        <span>${esc(t)}</span></label>`).join('')}
    </div>
    <span class="error" hidden></span>
  </div>`;
}

/** Fehlermeldung an einem Feld anzeigen (msg leer → entfernen) */
export function setFieldError(form, name, msg) {
  const wrap = form.querySelector(`[data-field="${name}"]`);
  if (!wrap) return;
  const err = wrap.querySelector('.error');
  const input = wrap.querySelector('input, select, textarea');
  err.textContent = msg || '';
  err.hidden = !msg;
  if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

export function clearFieldErrors(form) {
  form.querySelectorAll('.error').forEach((e) => { e.hidden = true; e.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
}

// ---------- Dialoge (Bottom-Sheets) ----------

/**
 * Öffnet ein Bottom-Sheet. Inhalt und Fußzeile liegen in einem <form>,
 * damit "Speichern"-Buttons (type=submit) direkt onSubmit auslösen.
 * @returns {{ el: HTMLDialogElement, form: HTMLFormElement, close: () => void }}
 */
export function openSheet({ title, body, footer = '', onSubmit, onOpen, onClose }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form class="sheet-form" novalidate>
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close autofocus aria-label="Schließen">${ICONS.x}</button>
      </div>
      <div class="sheet-body">${body}</div>
      ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
    </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const close = () => { if (dlg.open) dlg.close(); };

  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  // Tipp auf den abgedunkelten Hintergrund oder auf [data-close] schließt
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = form.querySelector('[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await onSubmit(form, close, e.submitter);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Fehler beim Speichern', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  dlg.showModal();
  onOpen?.(dlg, form, close);
  return { el: dlg, form, close };
}

/** Bestätigungsdialog → Promise<boolean> */
export function confirmDialog(message, { title = 'Bist du sicher?', ok = 'OK', cancel = 'Abbrechen', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openSheet({
      title,
      body: `<p>${esc(message)}</p>`,
      footer: `<button type="button" class="btn" data-close>${esc(cancel)}</button>
               <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(ok)}</button>`,
      onSubmit: (form, close) => { result = true; close(); },
      onClose: () => resolve(result),
    });
  });
}

// ---------- Toasts & Banner ----------

/** Kurze Meldung unten einblenden. type: info | ok | error */
export function toast(message, type = 'info', ms = 3200) {
  // Bei offenem Dialog muss die Meldung IM Dialog liegen (sonst verdeckt)
  const openDialogs = $$('dialog[open]');
  const host = openDialogs.length ? openDialogs[openDialogs.length - 1] : document.body;
  let box = host === document.body ? $('#toasts') : host.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    host.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms);
}

/**
 * Hinweis-Banner oben im Inhalt setzen/ersetzen.
 * opt: { type: 'warn'|'danger'|'info', icon, title, text, actions: [{label, onClick}], dismissible }
 */
export function setBanner(id, opt) {
  const host = $('#banners');
  let el = host.querySelector(`[data-banner="${id}"]`);
  if (!opt) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.dataset.banner = id;
    host.append(el);
  }
  el.className = `banner ${opt.type || 'warn'}`;
  el.innerHTML = `<div class="b-ico" aria-hidden="true">${opt.icon || '⚠️'}</div>
    <div class="b-text">
      ${opt.title ? `<strong>${esc(opt.title)}</strong>` : ''}
      ${opt.html ?? esc(opt.text || '')}
      ${opt.actions?.length ? `<div class="b-actions">${opt.actions.map((a, i) =>
        `<button type="button" class="btn btn-sm ${i === 0 ? 'btn-primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>
    ${opt.dismissible !== false ? `<button type="button" class="icon-btn" data-dismiss aria-label="Hinweis ausblenden">${ICONS.x}</button>` : ''}`;
  el.onclick = (e) => {
    if (e.target.closest('[data-dismiss]')) { el.remove(); opt.onDismiss?.(); return; }
    const btn = e.target.closest('[data-i]');
    if (btn) opt.actions[Number(btn.dataset.i)].onClick?.();
  };
}

// ---------- Externe Bibliotheken nachladen ----------

const scriptPromises = new Map();

/** Lädt ein <script> genau einmal (Chart.js, Leaflet) – vom Service Worker offline gecacht */
export function loadScript(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromises.delete(src);
        s.remove();
        reject(new Error('Bibliothek konnte nicht geladen werden – bist du offline?'));
      };
      document.head.append(s);
    }));
  }
  return scriptPromises.get(src);
}

const cssPromises = new Map();

/** Lädt ein Stylesheet genau einmal (Leaflet) → Promise, sobald es geladen ist */
export function loadCss(href) {
  if (!cssPromises.has(href)) {
    cssPromises.set(href, new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.crossOrigin = 'anonymous';
      l.onload = () => resolve();
      l.onerror = () => {
        cssPromises.delete(href);
        l.remove();
        reject(new Error('Stylesheet konnte nicht geladen werden – bist du offline?'));
      };
      document.head.append(l);
    }));
  }
  return cssPromises.get(href);
}

// ---------- Dateien ----------

/** Bild verkleinern und als JPEG-DataURL liefern (spart Speicher, passt ins JSON-Backup) */
export async function imageToDataURL(file, maxSize = 800, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Datei als Download anbieten */
export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Kann dieses Gerät Dateien über das Teilen-Menü weitergeben (iOS: "In Dateien sichern")? */
export function canShareFiles() {
  try {
    const probe = new File(['x'], 'probe.json', { type: 'application/json' });
    return !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

/** Läuft die App als installierte PWA (Home-Bildschirm)? */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
