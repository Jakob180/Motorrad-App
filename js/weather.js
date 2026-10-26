// weather.js – Wetter-Tab „Kann ich heute fahren?"
// Standort per GPS, Wohnort oder Ortssuche; Vorhersage von Open-Meteo für heute + 3 Tage;
// Fahr-Ampel pro Stunde und als Tagesfazit (Logik in ampel.js).
// Exportiert außerdem API-Helfer, die die Routenplanung (route.js) wiederverwendet.

import * as db from './db.js';
import { LEVELS, rateHours, summarizeDay } from './ampel.js';
import {
  esc, fmtNum, fmtTime, parseISODate, WEEKDAYS_SHORT, openSheet, toast, ICONS,
} from './ui.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const FORECAST_TTL = 30 * 60 * 1000;          // Vorhersage 30 Minuten cachen
const GPS_REUSE = 15 * 60 * 1000;             // letzte GPS-Position 15 Minuten wiederverwenden
const REFRESH_AFTER = 10 * 60 * 1000;         // beim Tab-Wechsel nach 10 Minuten neu laden
const PLACE_TTL = 30 * 24 * 3600 * 1000;      // Ortsnamen 30 Tage cachen

const HOURLY = 'temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,is_day';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,sunrise,sunset';
const CURRENT = 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day';

// WMO-Wettercodes → [Text, Symbol Tag, Symbol Nacht]
const WMO = {
  0: ['Klar', '☀️', '🌙'],
  1: ['Überwiegend klar', '🌤️', '🌙'],
  2: ['Teilweise bewölkt', '⛅', '☁️'],
  3: ['Bedeckt', '☁️'],
  45: ['Nebel', '🌫️'],
  48: ['Reifnebel', '🌫️'],
  51: ['Leichter Nieselregen', '🌦️'],
  53: ['Nieselregen', '🌦️'],
  55: ['Starker Nieselregen', '🌧️'],
  56: ['Gefrierender Niesel', '🌧️'],
  57: ['Gefrierender Niesel', '🌧️'],
  61: ['Leichter Regen', '🌦️'],
  63: ['Regen', '🌧️'],
  65: ['Starker Regen', '🌧️'],
  66: ['Gefrierender Regen', '🌧️'],
  67: ['Gefrierender Regen', '🌧️'],
  71: ['Leichter Schneefall', '🌨️'],
  73: ['Schneefall', '🌨️'],
  75: ['Starker Schneefall', '❄️'],
  77: ['Schneegriesel', '🌨️'],
  80: ['Regenschauer', '🌦️'],
  81: ['Regenschauer', '🌧️'],
  82: ['Heftige Schauer', '⛈️'],
  85: ['Schneeschauer', '🌨️'],
  86: ['Schneeschauer', '🌨️'],
  95: ['Gewitter', '⛈️'],
  96: ['Gewitter mit Hagel', '⛈️'],
  99: ['Gewitter mit Hagel', '⛈️'],
};

export function wmo(code, isDay = true) {
  const [text, day, night] = WMO[code] || ['Unbekannt', '❔'];
  return { text, icon: !isDay && night ? night : day };
}

// ======================================================================
// Netzwerk & APIs
// ======================================================================

/** JSON laden mit Zeitlimit und verständlichen Fehlermeldungen */
export async function fetchJSON(url, { timeout = 12000, service = 'Der Dienst' } = {}) {
  if (!navigator.onLine) throw new Error('Keine Internetverbindung.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${service} meldet einen Fehler (${res.status}). Bitte später nochmal versuchen.`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${service} antwortet nicht (Zeitüberschreitung).`);
    if (err instanceof TypeError) throw new Error(`${service} ist nicht erreichbar – Internetverbindung prüfen.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vorhersage für einen Ort (heute + 3 Tage). Antworten werden 30 Minuten gecacht;
 * ohne Netz gibt es die letzten gespeicherten Daten (stale = true).
 * → { data, ts, stale?, error? }
 */
export async function getForecast(lat, lon, { force = false } = {}) {
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  const key = `wx:${la},${lo}`;
  const cached = await db.cacheGetStale(key);
  if (!force && cached && Date.now() - cached.ts < FORECAST_TTL) return { data: cached.data, ts: cached.ts };

  const url = `${FORECAST_URL}?latitude=${la}&longitude=${lo}&hourly=${HOURLY}&daily=${DAILY}&current=${CURRENT}`
    + '&timezone=auto&forecast_days=4&wind_speed_unit=kmh';
  try {
    const data = await fetchJSON(url, { service: 'Der Wetterdienst' });
    if (!data.hourly?.time?.length) throw new Error('Der Wetterdienst hat keine Daten geliefert.');
    await db.cacheSet(key, data);
    return { data, ts: Date.now() };
  } catch (err) {
    if (cached) return { data: cached.data, ts: cached.ts, stale: true, error: err.message };
    throw err;
  }
}

/** Stundenwerte als Objekte (Zeiten in Ortszeit des Standorts) */
export function toHours(data) {
  const h = data.hourly;
  return h.time.map((time, i) => ({
    time,
    day: time.slice(0, 10),
    hour: Number(time.slice(11, 13)),
    temp: h.temperature_2m[i],
    rainProb: h.precipitation_probability[i],
    rain: h.precipitation[i],
    code: h.weather_code[i],
    cloud: h.cloud_cover[i],
    wind: h.wind_speed_10m[i],
    gust: h.wind_gusts_10m[i],
    isDay: h.is_day[i] === 1,
  })).filter((x) => x.temp != null);
}

/** Aktuelles Datum und Stunde am Standort (unabhängig von der Zeitzone des Geräts) */
export function localNow(data) {
  const iso = new Date(Date.now() + (data.utc_offset_seconds || 0) * 1000).toISOString();
  return { day: iso.slice(0, 10), hour: Number(iso.slice(11, 13)) };
}

/** Ortssuche (Open-Meteo Geocoding) → [{ name, detail, lat, lon }] */
export async function geocode(query) {
  const q = query.trim();
  const key = `geo:${q.toLowerCase()}`;
  const cached = await db.cacheGet(key, PLACE_TTL);
  if (cached) return cached;
  const data = await fetchJSON(`${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=8&language=de&format=json`,
    { service: 'Die Ortssuche' });
  const results = (data.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
  await db.cacheSet(key, results);
  return results;
}

/** Ortsname zu Koordinaten (OpenStreetMap Nominatim, sparsam & gecacht) → Name oder null */
export async function reverseGeocode(lat, lon) {
  const key = `rev:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = await db.cacheGet(key, PLACE_TTL);
  if (cached) return cached;
  try {
    const data = await fetchJSON(`${REVERSE_URL}?format=jsonv2&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&zoom=10&accept-language=de`,
      { service: 'Die Ortsbestimmung', timeout: 8000 });
    const a = data.address || {};
    const name = a.city || a.town || a.village || a.municipality || a.county || null;
    if (name) await db.cacheSet(key, name);
    return name;
  } catch {
    return null;
  }
}

const GEO_ERRORS = {
  1: 'Standortzugriff nicht erlaubt. Am iPhone: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → '
    + 'Safari-Websites → „Beim Verwenden der App".',
  2: 'Standort nicht verfügbar – sind die Ortungsdienste eingeschaltet?',
  3: 'Die Standortbestimmung dauert zu lange.',
};

/** Aktuelle Position per GPS → { lat, lon } */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) {
      reject(new Error('Der Standort funktioniert nur über https (z. B. GitHub Pages) oder localhost.'));
      return;
    }
    if (!('geolocation' in navigator)) {
      reject(new Error('Dieses Gerät kann den Standort nicht bestimmen.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => reject(new Error(GEO_ERRORS[err.code] || 'Der Standort konnte nicht bestimmt werden.')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

/** GPS-Position samt Ortsnamen → { name, lat, lon } (für Wohnort & Co.) */
export async function currentPlace() {
  const pos = await getPosition();
  const name = await reverseGeocode(pos.lat, pos.lon);
  const place = { name: name || 'Mein Standort', lat: pos.lat, lon: pos.lon };
  await db.cacheSet('gps:last', place);
  return place;
}

// ======================================================================
// Ortsauswahl (auch von den Einstellungen genutzt)
// ======================================================================

/**
 * Bottom-Sheet zur Ortswahl: GPS, Wohnort, zuletzt verwendete Orte, Suche.
 * onPick(place | { gps: true })
 */
export async function openPlaceSearch({ title = 'Ort wählen', allowGps = true, showHome = true, onPick }) {
  const settings = await db.getSettings();
  const recent = settings.recentPlaces || [];
  const placeItem = (p, attrs, icon) => `<button type="button" class="item" ${attrs}>
      <span class="ico" aria-hidden="true">${icon}</span>
      <span class="main"><span class="t">${esc(p.name)}</span>${p.detail ? `<span class="s">${esc(p.detail)}</span>` : ''}</span>
      <span></span>
    </button>`;

  const body = `
    <div class="field">
      <input type="search" name="q" placeholder="Ort oder PLZ suchen" enterkeyhint="search" autocomplete="off" aria-label="Ort suchen">
    </div>
    <div class="list" id="place-results"></div>
    <div class="list" id="place-default">
      ${allowGps ? `<button type="button" class="item" data-gps>
          <span class="ico" aria-hidden="true">📍</span>
          <span class="main"><span class="t">Aktueller Standort</span><span class="s">per GPS</span></span><span></span>
        </button>` : ''}
      ${showHome && settings.home ? placeItem({ ...settings.home, detail: 'Wohnort' }, 'data-home', '🏠') : ''}
      ${recent.length ? '<div class="list-head">Zuletzt verwendet</div>' : ''}
      ${recent.map((p, i) => placeItem(p, `data-recent="${i}"`, '🕘')).join('')}
    </div>`;

  let results = [];
  let timer = null;

  openSheet({
    title,
    body,
    onOpen: (dlg, form, close) => {
      const input = form.elements.q;
      const box = form.querySelector('#place-results');
      const defaults = form.querySelector('#place-default');

      const search = async () => {
        const q = input.value.trim();
        defaults.hidden = q.length >= 2;
        if (q.length < 2) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="muted">Suche …</p>';
        try {
          results = await geocode(q);
          if (input.value.trim() !== q) return; // inzwischen weitergetippt
          box.innerHTML = results.length
            ? results.map((p, i) => placeItem(p, `data-result="${i}"`, '📍')).join('')
            : '<p class="muted">Nichts gefunden. Anders schreiben oder die Postleitzahl versuchen.</p>';
        } catch (err) {
          box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
        }
      };

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(search, 450);
      });
      // Enter auf der Tastatur → sofort suchen
      form.addEventListener('submit', () => { clearTimeout(timer); search(); });

      dlg.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-gps], [data-home], [data-recent], [data-result]');
        if (!btn) return;
        let place;
        if (btn.hasAttribute('data-gps')) place = { gps: true };
        else if (btn.hasAttribute('data-home')) place = settings.home;
        else if (btn.dataset.recent) place = recent[Number(btn.dataset.recent)];
        else place = results[Number(btn.dataset.result)];
        close();
        if (!place.gps) await rememberPlace(place);
        onPick(place);
      });
    },
  });
}

/** Ort in "Zuletzt verwendet" aufnehmen (max. 5) */
async function rememberPlace(place) {
  const settings = await db.getSettings();
  const same = (p) => Math.abs(p.lat - place.lat) < 0.01 && Math.abs(p.lon - place.lon) < 0.01;
  const recent = [{ name: place.name, detail: place.detail || '', lat: place.lat, lon: place.lon },
    ...(settings.recentPlaces || []).filter((p) => !same(p))].slice(0, 5);
  await db.saveSettings({ recentPlaces: recent });
}

// ======================================================================
// Ansicht
// ======================================================================

let root = null;
const state = {
  settings: null,
  loc: null,        // { name, lat, lon, source: 'gps' | 'place' | 'home' | 'last' }
  forecast: null,   // { data, ts, stale, error }
  loadedAt: 0,
  dayIndex: 0,
  notice: null,     // Hinweis über der Vorhersage (z. B. GPS-Ersatz, Offline)
  error: null,      // Fehler, wenn gar keine Daten da sind
  loading: false,
};

export function init(el) {
  root = el;
  root.addEventListener('click', onClick);
}

export async function show() {
  state.settings = await db.getSettings();
  if (state.forecast && Date.now() - state.loadedAt < REFRESH_AFTER) render();
  else await load();
}

/** Standort bestimmen und Vorhersage laden */
async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  state.notice = null;
  render();
  try {
    state.settings = await db.getSettings();
    const loc = await resolveLocation(state.settings, force);
    if (!loc) return;
    const [forecast, name] = await Promise.all([
      getForecast(loc.lat, loc.lon, { force }),
      loc.name ? loc.name : reverseGeocode(loc.lat, loc.lon),
    ]);
    loc.name = name || 'Mein Standort';
    if (loc.source === 'gps') await db.cacheSet('gps:last', { name: loc.name, lat: loc.lat, lon: loc.lon });
    if (state.loc && (state.loc.lat !== loc.lat || state.loc.lon !== loc.lon)) state.dayIndex = 0;
    state.loc = loc;
    state.forecast = forecast;
    state.loadedAt = Date.now();
    if (forecast.stale) {
      state.notice = `${forecast.error} Angezeigt werden gespeicherte Daten von ${fmtTime(new Date(forecast.ts))} Uhr.`;
    }
  } catch (err) {
    if (state.forecast) state.notice = err.message;
    else state.error = { title: 'Wetter konnte nicht geladen werden', message: err.message };
  } finally {
    state.loading = false;
    render();
  }
}

/** Welcher Ort? GPS (mit Ersatz: Wohnort, letzter Standort) oder ein gewählter Ort */
async function resolveLocation(settings, force) {
  const pref = settings.weatherLocation || { mode: 'gps' };
  if (pref.mode === 'place') return { name: pref.name, lat: pref.lat, lon: pref.lon, source: 'place' };

  // Frische GPS-Position wiederverwenden – erspart am iPhone wiederholte Standort-Abfragen
  const last = await db.cacheGetStale('gps:last');
  if (!force && last && Date.now() - last.ts < GPS_REUSE) return { ...last.data, source: 'gps' };

  try {
    const pos = await getPosition();
    const near = last && Math.abs(last.data.lat - pos.lat) < 0.02 && Math.abs(last.data.lon - pos.lon) < 0.02;
    return { name: near ? last.data.name : null, lat: pos.lat, lon: pos.lon, source: 'gps' };
  } catch (err) {
    if (settings.home) {
      state.notice = `${err.message} Angezeigt wird dein Wohnort.`;
      return { ...settings.home, source: 'home' };
    }
    if (last) {
      state.notice = `${err.message} Angezeigt wird dein letzter Standort.`;
      return { ...last.data, source: 'last' };
    }
    state.error = { title: 'Standort nicht verfügbar', message: err.message, gps: true };
    return null;
  }
}

// ---------- Rendering ----------

const SOURCE_LABEL = { gps: 'Aktueller Standort', place: 'Gewählter Ort', home: 'Wohnort', last: 'Letzter Standort' };
const SOURCE_ICON = { gps: '📍', place: '📌', home: '🏠', last: '📍' };

function render() {
  if (!root) return;
  const loc = state.loc;
  const bar = `<div class="loc-bar">
      <button type="button" class="loc-btn" data-action="pick-location" aria-label="Ort wählen">
        <span aria-hidden="true">${loc ? SOURCE_ICON[loc.source] : '📍'}</span>
        <span class="nm">${loc ? esc(loc.name) : 'Standort …'}</span>${ICONS.chevronDown}
      </button>
      <button type="button" class="icon-btn ${state.loading ? 'spin' : ''}" data-action="refresh" aria-label="Aktualisieren">${ICONS.refresh}</button>
    </div>
    <div class="loc-meta">${state.loading ? 'Wird geladen …'
      : loc && state.forecast ? `${SOURCE_LABEL[loc.source]} · Stand ${fmtTime(new Date(state.forecast.ts))} Uhr` : '&nbsp;'}</div>
    ${state.notice ? `<div class="notice" role="status"><span aria-hidden="true">ℹ️</span><span>${esc(state.notice)}</span></div>` : ''}`;

  if (!state.forecast) {
    if (state.error) {
      root.innerHTML = `${bar}<div class="empty">
        <div class="e">${state.error.gps ? '📍' : '📡'}</div>
        <h3>${esc(state.error.title)}</h3>
        <p>${esc(state.error.message)}</p>
        <div class="stack mt">
          <button type="button" class="btn btn-primary" data-action="pick-location">Ort suchen</button>
          <button type="button" class="btn" data-action="refresh">${ICONS.refresh} Erneut versuchen</button>
        </div>
        ${state.error.gps ? '<p class="muted small mt">Tipp: In den Einstellungen einen Wohnort festlegen – der wird angezeigt, wenn GPS nicht klappt.</p>' : ''}
      </div>`;
    } else {
      root.innerHTML = `${bar}<div class="empty"><div class="e">🌤️</div><p>Wetter wird geladen …</p></div>`;
    }
    return;
  }

  const t = state.settings.thresholds;
  const data = state.forecast.data;
  const now = localNow(data);
  const hours = rateHours(toHours(data), t);
  const days = data.daily.time
    .map((day, i) => ({
      day,
      code: data.daily.weather_code[i],
      tMax: data.daily.temperature_2m_max[i],
      tMin: data.daily.temperature_2m_min[i],
      rainSum: data.daily.precipitation_sum[i],
      gustMax: data.daily.wind_gusts_10m_max[i],
      sunrise: data.daily.sunrise[i],
      sunset: data.daily.sunset[i],
    }))
    .filter((d) => d.day >= now.day)
    .map((d) => ({
      ...d,
      isToday: d.day === now.day,
      hours: hours.filter((h) => h.day === d.day),
    }))
    .map((d) => ({ ...d, summary: summarizeDay(d.hours, t, { fromHour: d.isToday ? now.hour : 0 }) }));

  if (!days.length) {
    root.innerHTML = `${bar}<div class="empty"><div class="e">📡</div><h3>Keine aktuellen Daten</h3>
      <p>Die gespeicherte Vorhersage ist veraltet. Bitte mit Internet aktualisieren.</p>
      <button type="button" class="btn btn-primary" data-action="refresh">${ICONS.refresh} Aktualisieren</button></div>`;
    return;
  }
  state.dayIndex = Math.min(state.dayIndex, days.length - 1);
  const sel = days[state.dayIndex];

  root.innerHTML = bar
    + renderHero(sel, data, now)
    + renderDayCards(days)
    + renderHours(sel, now, t)
    + renderLegend(t)
    + renderFooter();
}

function dayLabel(d, long = false) {
  const date = parseISODate(d.day);
  const dm = `${date.getDate()}.${date.getMonth() + 1}.`;
  if (d.isToday) return long ? `Heute, ${dm}` : 'Heute';
  return `${WEEKDAYS_SHORT[date.getDay()]} ${dm}`;
}

function renderHero(d, data, now) {
  const s = d.summary;
  const lvl = s.level == null ? '' : `l${s.level}`;
  const verdict = s.level == null ? (d.isToday ? 'Fahrzeit vorbei' : '–') : LEVELS[s.level].verdict;
  const cur = d.isToday && data.current ? wmo(data.current.weather_code, data.current.is_day === 1) : null;
  const [tLo, tHi] = s.stats ? [s.stats.tempMin, s.stats.tempMax] : [d.tMin, d.tMax];
  const facts = [
    `🌡️ ${fmtNum(tLo) === fmtNum(tHi) ? fmtNum(tHi) : `${fmtNum(tLo)}–${fmtNum(tHi)}`} °C`,
    `💧 ${fmtNum(d.rainSum, 1)} mm`,
    `💨 Böen bis ${fmtNum(d.gustMax)} km/h`,
    d.sunrise && d.sunset ? `🌅 ${d.sunrise.slice(11, 16)} · 🌇 ${d.sunset.slice(11, 16)}` : '',
  ].filter(Boolean);

  // Zeitleiste: 24 Stunden als Farbbalken
  const t = state.settings.thresholds;
  const byHour = new Map(d.hours.map((h) => [h.hour, h]));
  const strip = Array.from({ length: 24 }, (_, hr) => {
    const h = byHour.get(hr);
    const cls = [h ? `l${h.level}` : '', d.isToday && hr < now.hour ? 'past' : '', hr < t.rideFrom || hr >= t.rideTo ? 'out' : ''];
    return `<i class="${cls.join(' ')}" title="${hr} Uhr"></i>`;
  }).join('');

  return `<section class="hero ${lvl}" aria-label="Tagesfazit">
      <div class="hero-top">
        <div class="lamps" aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></div>
        <div>
          <div class="hero-day">${dayLabel(d, true)}${cur ? ` · jetzt ${cur.icon} ${fmtNum(data.current.temperature_2m)} °C` : ''}</div>
          <div class="hero-verdict">${verdict}</div>
        </div>
      </div>
      <p class="hero-text">${esc(s.text)}</p>
      <div class="hero-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
      <div class="strip" aria-hidden="true">
        <div class="strip-bar">${strip}</div>
        <div class="strip-labels"><span>0</span><span>6</span><span>12</span><span>18</span></div>
      </div>
    </section>`;
}

function renderDayCards(days) {
  return `<div class="days" role="tablist" aria-label="Tag wählen">${days.map((d, i) => {
    const w = wmo(d.code);
    const lvl = d.summary.level == null ? '' : `l${d.summary.level}`;
    const label = d.summary.level == null ? 'keine Bewertung' : LEVELS[d.summary.level].label;
    return `<button type="button" class="day-card ${i === state.dayIndex ? 'active' : ''}" role="tab"
        aria-selected="${i === state.dayIndex}" data-action="day" data-i="${i}" aria-label="${dayLabel(d)}: ${label}">
        <span class="d">${dayLabel(d)}</span>
        <span class="e" aria-hidden="true">${w.icon}</span>
        <span class="tt"><b>${fmtNum(d.tMax)}°</b> ${fmtNum(d.tMin)}°</span>
        <span class="dot ${lvl}"></span>
      </button>`;
  }).join('')}</div>`;
}

function renderHours(d, now, t) {
  // Nachtstunden ausblenden: ab 5 Uhr, heute erst ab der aktuellen Stunde
  const list = d.hours.filter((h) => h.hour >= 5 && (!d.isToday || h.hour >= now.hour));
  if (!list.length) return '';
  const rows = list.map((h) => {
    const w = wmo(h.code, h.isDay);
    const out = h.hour < t.rideFrom || h.hour >= t.rideTo;
    const isNow = d.isToday && h.hour === now.hour;
    return `<div class="hour l${h.level} ${out ? 'out' : ''} ${isNow ? 'now' : ''}">
        <span class="h">${isNow ? 'Jetzt' : `${String(h.hour).padStart(2, '0')}:00`}</span>
        <span class="w"><span class="ic" title="${esc(w.text)}">${w.icon}</span>${fmtNum(h.temp)}°</span>
        <span><b>${fmtNum(h.rainProb ?? 0)} %</b><small>${fmtNum(h.rain ?? 0, 1)} mm</small></span>
        <span><b>${fmtNum(h.gust)}</b><small>Wind ${fmtNum(h.wind)}</small></span>
        <span><b>${fmtNum(h.cloud)} %</b></span>
        ${h.level > 0 ? `<span class="why">${h.reasons.map((r) => esc(r.text)).join(' · ')}</span>` : ''}
      </div>`;
  }).join('');
  return `<div class="card hours" aria-label="Stündliche Vorhersage">
      <div class="hour-head"><span>Zeit</span><span>Temp.</span><span>Regen</span><span>Böen km/h</span><span>Wolken</span></div>
      ${rows}
    </div>`;
}

function renderLegend(t) {
  const n = (v, d = 0) => fmtNum(v, d);
  return `<details class="card legend">
      <summary>🚦 So bewertet die Ampel</summary>
      <ul>
        <li><span class="dot l1"></span> <b>Gelb</b>: Regen über ${n(t.rainProbYellow)} % oder über ${n(t.rainMmYellow, 1)} mm/h,
          unter ${n(t.tempYellow)} °C, Böen über ${n(t.gustYellow)} km/h, Nebel, nasse Straße nach Regen</li>
        <li><span class="dot l2"></span> <b>Rot</b>: Regen über ${n(t.rainProbRed)} % oder über ${n(t.rainMmRed, 1)} mm/h
          (oder Wahrscheinlichkeit und Menge über Gelb), unter ${n(t.tempRed)} °C (Glättegefahr),
          Böen über ${n(t.gustRed)} km/h, Gewitter, Schnee</li>
        <li><span class="dot l0"></span> <b>Tagesfazit</b>: Grün, wenn zwischen ${t.rideFrom} und ${t.rideTo} Uhr
          mindestens 3 Stunden am Stück grün sind</li>
      </ul>
      <a href="#einstellungen" class="btn btn-sm">Grenzwerte ändern</a>
    </details>`;
}

function renderFooter() {
  const loc = state.loc;
  const home = state.settings.home;
  const isHome = home && loc && Math.abs(home.lat - loc.lat) < 0.01 && Math.abs(home.lon - loc.lon) < 0.01;
  return `${loc && !isHome ? `<button type="button" class="btn btn-sm btn-ghost" data-action="set-home">🏠 „${esc(loc.name)}" als Wohnort speichern</button>` : ''}
    <p class="muted small mt">Wetterdaten: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>
      · Ortsnamen: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende</p>`;
}

// ---------- Interaktion ----------

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'refresh':
      await load({ force: true });
      break;
    case 'day':
      state.dayIndex = Number(el.dataset.i);
      render();
      break;
    case 'pick-location':
      openPlaceSearch({
        title: 'Wetter für …',
        onPick: async (place) => {
          if (place.gps) {
            await db.saveSettings({ weatherLocation: { mode: 'gps' } });
            await load({ force: true });
          } else {
            await db.saveSettings({ weatherLocation: { mode: 'place', name: place.name, lat: place.lat, lon: place.lon } });
            await load();
          }
        },
      });
      break;
    case 'set-home': {
      const { name, lat, lon } = state.loc;
      await db.saveSettings({ home: { name, lat, lon } });
      state.settings = await db.getSettings();
      toast(`${name} ist jetzt dein Wohnort`, 'ok');
      render();
      break;
    }
    default:
  }
}
