// route.js – Wetter entlang einer Route (Unterseite „Route" im Wetter-Tab).
// Start/Ziel/Zwischenstopps per Suche, GPS oder Tipp auf die Karte; Route über den
// OSRM-Demo-Server; alle ~15 km das Wetter zur voraussichtlichen Ankunftszeit (Open-Meteo);
// Route nach Fahr-Ampel einfärben, Warnungen, beste Abfahrtszeit, Favoriten.

import * as db from './db.js';
import { rateHour } from './ampel.js';
import {
  fetchJSON, wmo, openPlaceSearch, currentPlace, reverseGeocode, FORECAST_URL, HOURLY,
} from './weather.js';
import {
  esc, fmtNum, fmtTime, WEEKDAYS_SHORT, field, openSheet, confirmDialog, toast, loadScript, loadCss, ICONS,
} from './ui.js';

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const STEP_KM = 15;                       // alle 15 km ein Wetterpunkt
const MAX_SAMPLES = 40;                   // bei sehr langen Routen den Abstand vergrößern
const ROUTE_TTL = 30 * 24 * 3600 * 1000;  // Routen 30 Tage cachen (OSRM sparsam nutzen!)
const FORECAST_TTL = 30 * 60 * 1000;      // Wetter 30 Minuten cachen
const MAX_SNAP_KM = 3;                    // weiter weg von einer Straße → Hinweis
const MAX_STOPS = 5;                      // Zwischenstopps
const LEVEL_COLORS = ['#2fbf71', '#f2c230', '#ef4b4b'];
const GRAY = '#7c8794';

// ======================================================================
// Berechnungen (ohne DOM – lassen sich auch in Node testen)
// ======================================================================

/** Entfernung zweier Punkte [lat, lon] in km */
export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Wetterpunkte entlang der Route: Start, alle stepKm ein Punkt, Ziel.
 * idx = Index der Routenkoordinate, VOR der der Punkt liegt (zum Zerschneiden der Linie).
 */
export function sampleRoute(coords, stepKm = STEP_KM) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineKm(coords[i - 1], coords[i]);
  const step = Math.max(stepKm, total / MAX_SAMPLES);

  const samples = [{ lat: coords[0][0], lon: coords[0][1], km: 0, idx: 0 }];
  let cum = 0;
  let next = step;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = haversineKm(a, b);
    while (d > 0 && cum + d >= next) {
      const f = (next - cum) / d;
      samples.push({ lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, km: next, idx: i });
      next += step;
    }
    cum += d;
  }
  // Ziel immer als letzter Punkt (einen Punkt knapp davor weglassen)
  if (samples.length > 1 && total - samples[samples.length - 1].km < step * 0.25) samples.pop();
  const end = coords[coords.length - 1];
  samples.push({ lat: end[0], lon: end[1], km: total, idx: coords.length - 1 });
  return { samples, totalKm: total };
}

/** Wetterwerte eines Punkts zur Stunde i (oder null) */
function hourAt(f, i) {
  if (i < 0 || i >= f.time.length || f.temp[i] == null) return null;
  return {
    temp: f.temp[i], rainProb: f.rainProb[i], rain: f.rain[i], code: f.code[i],
    gust: f.gust[i], wind: f.wind[i], cloud: f.cloud[i], isDay: f.isDay[i] === 1,
  };
}

const sameLocalDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * Route für eine Abfahrtszeit bewerten: Ankunftszeit an jedem Wetterpunkt
 * (Durchschnittsgeschwindigkeit) und Ampel für die Stunde, in der man dort ist.
 */
export function evaluateRoute(samples, forecasts, depMs, speed, t) {
  const points = samples.map((s, i) => {
    const eta = depMs + (s.km / speed) * 3600 * 1000;
    const f = forecasts[i];
    const idx = Math.round((eta / 1000 - f.time[0]) / 3600);
    const h = hourAt(f, idx);
    if (!h) return { ...s, i, eta, missing: true, level: null, reasons: [] };
    const prev = [hourAt(f, idx - 2), hourAt(f, idx - 1)].filter(Boolean);
    return { ...s, i, eta, h, ...rateHour(h, t, prev) };
  });
  const rated = points.filter((p) => !p.missing);
  const arrival = points[points.length - 1].eta;
  const sunset = (forecasts[forecasts.length - 1].sunset || [])
    .map((s) => s * 1000)
    .find((s) => sameLocalDay(s, arrival));
  return {
    points,
    level: rated.length ? Math.max(...rated.map((p) => p.level)) : null,
    missing: rated.length < points.length,
    arrival,
    sunset,
    afterSunset: sunset ? arrival > sunset : false,
  };
}

/** Lokale Uhrzeit an einem Tag (Sommerzeit-sicher) */
function atMinutes(dayStartMs, minutes) {
  const d = new Date(dayStartMs);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

/**
 * Beste Abfahrtszeit an einem Tag: alle 30 Minuten innerhalb der Fahrzeit durchrechnen
 * (ohne neue API-Abfragen). Rot zählt 10, Gelb 3 Punkte pro Wetterpunkt,
 * Ankunft nach Sonnenuntergang 4 Punkte. Weniger ist besser.
 */
export function bestDeparture(samples, forecasts, dayStartMs, speed, t, nowMs = Date.now()) {
  const durationMin = (samples[samples.length - 1].km / speed) * 60;
  const from = t.rideFrom * 60;
  const last = Math.max(from, t.rideTo * 60 - durationMin);
  const options = [];
  for (let m = from; m <= last; m += 30) {
    const dep = atMinutes(dayStartMs, m);
    if (dep < nowMs - 15 * 60 * 1000) continue; // schon vorbei
    const ev = evaluateRoute(samples, forecasts, dep, speed, t);
    if (ev.missing) continue;
    const score = ev.points.reduce((s, p) => s + [0, 3, 10][p.level], 0) + (ev.afterSunset ? 4 : 0);
    options.push({ dep, minutes: m, level: ev.level, score, arrival: ev.arrival, afterSunset: ev.afterSunset });
  }
  if (!options.length) return null;
  const best = options.reduce((b, o) => (o.score < b.score ? o : b));
  return { best, options };
}

/** Warnungen entlang der Strecke – aufeinanderfolgende Punkte mit gleichem Grund zusammengefasst */
export function routeWarnings(ev) {
  const groups = [];
  for (const p of ev.points) {
    if (!p.level) continue;
    const r = p.reasons[0];
    const g = groups[groups.length - 1];
    if (g && g.kind === r.kind && g.last.i === p.i - 1) {
      g.last = p;
      if (p.level > g.level) { g.level = p.level; g.text = r.text; }
    } else {
      groups.push({ kind: r.kind, level: p.level, text: r.text, first: p, last: p });
    }
  }
  const km = (p) => fmtNum(Math.round(p.km));
  const list = groups.map((g) => ({
    level: g.level,
    text: g.first === g.last
      ? `Bei km ${km(g.first)} um ${fmtTime(new Date(g.first.eta))} Uhr: ${g.text}`
      : `Von km ${km(g.first)} bis ${km(g.last)} (${fmtTime(new Date(g.first.eta))}–${fmtTime(new Date(g.last.eta))} Uhr): ${g.text}`,
  }));
  if (ev.afterSunset) {
    list.push({ level: 1, text: `Ankunft nach Sonnenuntergang (${fmtTime(new Date(ev.sunset))} Uhr) – es wird dunkel.` });
  }
  if (ev.missing) list.push({ level: 1, text: 'Für einen Teil der Strecke gibt es zu dieser Zeit noch keine Vorhersage.' });
  return list;
}

// ======================================================================
// APIs: Route (OSRM) und Wetter für alle Punkte (Open-Meteo)
// ======================================================================

/** Route über OSRM → { coords: [[lat, lon]], distance (m), snapWarnings } – 30 Tage gecacht */
async function fetchRoute(waypoints) {
  const path = waypoints.map((w) => `${w.lon.toFixed(5)},${w.lat.toFixed(5)}`).join(';');
  const key = `osrm:${path}`;
  const cached = await db.cacheGet(key, ROUTE_TTL);
  if (cached) return cached;

  const data = await fetchJSON(`${OSRM_URL}/${path}?overview=full&geometries=geojson&alternatives=false&steps=false`,
    { service: 'Der Routenplaner', timeout: 20000, acceptErrors: true });
  if (data.code !== 'Ok' || !data.routes?.length) {
    if (data.code === 'NoRoute') throw new Error('Zwischen diesen Punkten wurde keine Straßenverbindung gefunden.');
    if (data.code === 'NoSegment') throw new Error('Ein Punkt liegt zu weit von einer Straße entfernt.');
    throw new Error(`Der Routenplaner konnte keine Route berechnen (${data.code || 'unbekannter Fehler'}).`);
  }
  // OSRM schiebt Punkte auf die nächste Straße – weit weg? Dann Hinweis
  const snapWarnings = (data.waypoints || [])
    .map((w, i) => ({ i, km: (w.distance || 0) / 1000 }))
    .filter((w) => w.km > MAX_SNAP_KM);
  const r = data.routes[0];
  const result = {
    coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: r.distance,
    snapWarnings,
  };
  await db.cacheSet(key, result);
  return result;
}

/** Stündliches Wetter für alle Wetterpunkte in EINER Anfrage → { list, ts, stale?, error? } */
async function fetchRouteForecast(samples) {
  const lats = samples.map((s) => s.lat.toFixed(2)).join(',');
  const lons = samples.map((s) => s.lon.toFixed(2)).join(',');
  const key = `wxr:${lats}|${lons}`;
  const cached = await db.cacheGetStale(key);
  if (cached && Date.now() - cached.ts < FORECAST_TTL) return { list: cached.data, ts: cached.ts };

  const url = `${FORECAST_URL}?latitude=${lats}&longitude=${lons}&hourly=${HOURLY}&daily=sunset`
    + '&timezone=GMT&timeformat=unixtime&forecast_days=4&wind_speed_unit=kmh';
  try {
    const data = await fetchJSON(url, { service: 'Der Wetterdienst', timeout: 20000 });
    const list = (Array.isArray(data) ? data : [data]).map((d) => ({
      time: d.hourly.time,
      temp: d.hourly.temperature_2m,
      rainProb: d.hourly.precipitation_probability,
      rain: d.hourly.precipitation,
      code: d.hourly.weather_code,
      cloud: d.hourly.cloud_cover,
      wind: d.hourly.wind_speed_10m,
      gust: d.hourly.wind_gusts_10m,
      isDay: d.hourly.is_day,
      sunset: d.daily?.sunset || [],
    }));
    if (list.length !== samples.length) throw new Error('Der Wetterdienst hat unvollständige Daten geliefert.');
    await db.cacheSet(key, list);
    return { list, ts: Date.now() };
  } catch (err) {
    if (cached) return { list: cached.data, ts: cached.ts, stale: true, error: err.message };
    throw err;
  }
}

// ======================================================================
// Ansicht
// ======================================================================

let root = null;
let map = null;
let L = null;
const layers = {};

const state = {
  waypoints: [null, null],  // Start, …Zwischenstopps…, Ziel – je { name, lat, lon } oder null
  dayOffset: 0,             // 0 = heute … 3
  depMinutes: 600,          // Abfahrt in Minuten nach Mitternacht
  speed: 60,                // Ø km/h
  route: null,              // { coords, distance, snapWarnings, samples, totalKm }
  forecast: null,           // { list, ts, stale, error }
  loading: false,
  error: null,
  fitPending: false,        // Karte nach neuer Route auf die Strecke zoomen
  settings: null,
};

export async function init(el) {
  root = el;
  root.innerHTML = `
    <div class="card wp-card"></div>
    <div class="card dep-card"></div>
    <div class="map-wrap"><div id="route-map" aria-label="Karte"></div></div>
    <p class="muted small map-hint">Tippe auf die Karte, um Start, Ziel oder einen Zwischenstopp zu setzen.
      Punkte lassen sich verschieben.</p>
    <div id="route-result"></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);

  state.settings = await db.getSettings();
  state.speed = state.settings.avgSpeed || 60;
  const draft = state.settings.routeDraft;
  if (Array.isArray(draft) && draft.length >= 2) state.waypoints = draft;
  else if (state.settings.home) state.waypoints = [{ ...state.settings.home }, null];
  setDefaultDeparture();

  renderWaypoints();
  renderDeparture();
  renderResult();
  await initMap();
}

export async function show() {
  state.settings = await db.getSettings();
  state.speed = state.settings.avgSpeed || state.speed;
  renderDeparture();
  renderResult();
  if (map) {
    map.invalidateSize();
    drawRoute();
  }
}

/** Nächste halbe Stunde – oder morgen früh, wenn die Fahrzeit heute vorbei ist */
function setDefaultDeparture() {
  const t = state.settings.thresholds;
  const now = new Date();
  const next = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
  if (next <= (t.rideTo - 1) * 60) {
    state.dayOffset = 0;
    state.depMinutes = Math.max(next, t.rideFrom * 60);
  } else {
    state.dayOffset = 1;
    state.depMinutes = (t.rideFrom + 1) * 60;
  }
}

function dayStart(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

const depMs = () => atMinutes(dayStart(state.dayOffset), state.depMinutes);
const start = () => state.waypoints[0];
const end = () => state.waypoints[state.waypoints.length - 1];
const fmtHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function dayName(offset) {
  if (offset === 0) return 'Heute';
  if (offset === 1) return 'Morgen';
  const d = new Date(dayStart(offset));
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

function fmtDuration(hours) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

// ---------- Formular: Wegpunkte & Abfahrt ----------

function renderWaypoints() {
  const n = state.waypoints.length;
  const rows = state.waypoints.map((w, i) => {
    const kind = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
    const label = kind === 'start' ? 'S' : kind === 'end' ? 'Z' : String(i);
    const placeholder = kind === 'start' ? 'Start wählen …' : kind === 'end' ? 'Ziel wählen …' : 'Zwischenstopp wählen …';
    return `<div class="wp-row">
      <span class="wp-pin ${kind}" aria-hidden="true">${label}</span>
      <button type="button" class="wp-btn ${w ? '' : 'empty'}" data-action="wp-pick" data-i="${i}">
        ${w ? esc(w.name) : placeholder}</button>
      ${w || kind === 'via' ? `<button type="button" class="icon-btn" data-action="wp-remove" data-i="${i}"
        aria-label="${kind === 'via' ? 'Zwischenstopp entfernen' : 'Punkt leeren'}">${ICONS.x}</button>` : '<span class="wp-gap"></span>'}
    </div>`;
  }).join('');
  root.querySelector('.wp-card').innerHTML = `${rows}
    <div class="row mt">
      ${n - 2 < MAX_STOPS ? `<button type="button" class="btn btn-sm" data-action="wp-add">${ICONS.plus} Zwischenstopp</button>` : ''}
      <button type="button" class="btn btn-sm" data-action="wp-reverse">⇅ Umdrehen</button>
      <button type="button" class="btn btn-sm" data-action="favorites">⭐ Favoriten</button>
    </div>`;
}

function renderDeparture() {
  const days = [0, 1, 2, 3].map((d) => [d, dayName(d)]);
  const times = [];
  for (let m = 5 * 60; m <= 22 * 60; m += 30) times.push([m, fmtHM(m)]);
  if (!times.some(([m]) => m === state.depMinutes)) times.push([state.depMinutes, fmtHM(state.depMinutes)]);
  times.sort((a, b) => a[0] - b[0]);
  const speeds = [];
  for (let v = 30; v <= 110; v += 5) speeds.push([v, `${v} km/h`]);
  const ready = start() && end();

  root.querySelector('.dep-card').innerHTML = `
    <div class="grid3">
      ${field({ label: 'Tag', name: 'dayOffset', type: 'select', value: state.dayOffset, options: days })}
      ${field({ label: 'Abfahrt', name: 'depMinutes', type: 'select', value: state.depMinutes, options: times })}
      ${field({ label: 'Ø Tempo', name: 'speed', type: 'select', value: state.speed, options: speeds })}
    </div>
    <button type="button" class="btn btn-primary btn-block" data-action="compute" ${ready && !state.loading ? '' : 'disabled'}>
      ${state.loading ? 'Wird berechnet …' : '🗺️ Route &amp; Wetter berechnen'}</button>
    ${ready ? '' : '<p class="muted small mt">Wähle zuerst Start und Ziel.</p>'}`;
}

// ---------- Ergebnis ----------

let lastEval = null;

function renderResult() {
  const box = root.querySelector('#route-result');
  lastEval = null;
  if (state.loading) {
    box.innerHTML = '<div class="empty"><div class="e">🛣️</div><p>Route und Wetter werden geladen …</p></div>';
    return;
  }
  if (state.error) {
    box.innerHTML = `<div class="empty"><div class="e">😕</div><h3>Das hat nicht geklappt</h3><p>${esc(state.error)}</p>
      <button type="button" class="btn" data-action="compute">${ICONS.refresh} Nochmal versuchen</button></div>`;
    return;
  }
  if (!state.route || !state.forecast) {
    box.innerHTML = `<div class="card"><h3>So funktioniert's</h3>
      <ol class="steps">
        <li>Start und Ziel wählen – per Suche, GPS oder Tipp auf die Karte. Zwischenstopps sind optional.</li>
        <li>Tag, Abfahrtszeit und Durchschnittstempo einstellen.</li>
        <li><b>Route &amp; Wetter berechnen</b>: Alle ca. ${STEP_KM} km wird das Wetter zu der Uhrzeit geprüft,
          zu der du dort ankommst. Die Route wird nach der Ampel eingefärbt.</li>
      </ol></div>`;
    return;
  }

  const t = state.settings.thresholds;
  const { samples, totalKm } = state.route;
  const list = state.forecast.list;
  const dep = depMs();
  const ev = evaluateRoute(samples, list, dep, state.speed, t);
  lastEval = ev;
  const warnings = routeWarnings(ev);

  // Zusammenfassung
  const rated = ev.points.filter((p) => !p.missing);
  const temps = rated.map((p) => p.h.temp);
  const verdict = ev.level == null ? 'Keine Vorhersage' : ['Gute Fahrt!', 'Geht so', 'Lieber nicht fahren'][ev.level];
  const facts = rated.length ? [
    `🌡️ ${fmtNum(Math.min(...temps))}–${fmtNum(Math.max(...temps))} °C`,
    `💧 bis ${fmtNum(Math.max(...rated.map((p) => p.h.rainProb ?? 0)))} %`,
    `💨 Böen bis ${fmtNum(Math.max(...rated.map((p) => p.h.gust ?? 0)))} km/h`,
  ] : [];
  let html = `<section class="hero ${ev.level == null ? '' : `l${ev.level}`}" aria-label="Ergebnis">
      <div class="hero-top">
        <div class="lamps" aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></div>
        <div>
          <div class="hero-day">${esc(start().name)} → ${esc(end().name)}</div>
          <div class="hero-verdict">${verdict}</div>
        </div>
      </div>
      <p class="hero-text">${fmtNum(totalKm)} km · ca. ${fmtDuration(totalKm / state.speed)}<br>
        ${dayName(state.dayOffset)} ${fmtTime(new Date(dep))} → Ankunft ${fmtTime(new Date(ev.arrival))} Uhr</p>
      <div class="hero-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
    </section>`;

  if (state.forecast.stale) {
    html += `<div class="notice"><span aria-hidden="true">ℹ️</span><span>${esc(state.forecast.error)}
      Wetter von ${fmtTime(new Date(state.forecast.ts))} Uhr.</span></div>`;
  }
  for (const w of state.route.snapWarnings || []) {
    const name = state.waypoints[w.i]?.name || `Punkt ${w.i + 1}`;
    html += `<div class="notice"><span aria-hidden="true">📍</span><span>„${esc(name)}" liegt ${fmtNum(w.km, 1)} km von der
      nächsten Straße entfernt – die Route beginnt/endet dort. Bitte den Punkt prüfen.</span></div>`;
  }

  // Beste Abfahrt
  html += renderBestDeparture(samples, list, t);

  // Warnungen
  html += `<div class="card"><h3>${warnings.length ? '⚠️ Hinweise unterwegs' : '✅ Keine Warnungen'}</h3>
    ${warnings.length
      ? `<ul class="warn-list">${warnings.map((w) => `<li><span class="dot l${w.level}"></span>${esc(w.text)}</li>`).join('')}</ul>`
      : '<p class="muted">Auf der ganzen Strecke grün – viel Spaß!</p>'}
    </div>`;

  // Wetterpunkte
  const rows = ev.points.map((p, idx) => {
    if (p.missing) {
      return `<div class="hour"><span class="h">${fmtNum(Math.round(p.km))}</span><span>${fmtTime(new Date(p.eta))}</span>
        <span class="why muted">keine Vorhersage</span></div>`;
    }
    const w = wmo(p.h.code, p.h.isDay);
    const label = idx === 0 ? 'Start' : idx === ev.points.length - 1 ? 'Ziel' : `${fmtNum(Math.round(p.km))}`;
    return `<div class="hour l${p.level}">
      <span class="h">${label}</span>
      <span><b>${fmtTime(new Date(p.eta))}</b></span>
      <span class="w"><span class="ic" title="${esc(w.text)}">${w.icon}</span>${fmtNum(p.h.temp)}°</span>
      <span><b>${fmtNum(p.h.rainProb ?? 0)} %</b><small>${fmtNum(p.h.rain ?? 0, 1)} mm</small></span>
      <span><b>${fmtNum(p.h.gust)}</b><small>km/h</small></span>
      ${p.level > 0 ? `<span class="why">${p.reasons.map((r) => esc(r.text)).join(' · ')}</span>` : ''}
    </div>`;
  }).join('');
  html += `<div class="card hours route-points" aria-label="Wetter entlang der Strecke">
      <div class="hour-head"><span>km</span><span>Ankunft</span><span>Temp.</span><span>Regen</span><span>Böen</span></div>
      ${rows}
    </div>
    <button type="button" class="btn btn-block" data-action="save-favorite">☆ Als Favorit speichern</button>
    <p class="muted small mt">Ankunftszeiten mit Ø ${state.speed} km/h ohne Pausen.
      Route: <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> ·
      Wetter: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>
      (Stand ${fmtTime(new Date(state.forecast.ts))} Uhr)</p>`;

  box.innerHTML = html;
}

function renderBestDeparture(samples, list, t) {
  const res = bestDeparture(samples, list, dayStart(state.dayOffset), state.speed, t);
  if (!res) {
    return `<div class="card"><h3>⏰ Beste Abfahrt</h3><p class="muted">Für ${dayName(state.dayOffset).toLowerCase()}
      gibt es innerhalb der Fahrzeit (${t.rideFrom}–${t.rideTo} Uhr) keine passende Abfahrt mehr.</p></div>`;
  }
  const { best, options } = res;
  const isCurrent = best.minutes === state.depMinutes;
  const lvlText = ['durchgehend grün', 'teilweise gelb', 'mit roten Abschnitten'][best.level];

  // Gibt es an einem anderen Tag eine bessere Abfahrt?
  let other = '';
  for (const d of [0, 1, 2, 3]) {
    if (d === state.dayOffset) continue;
    const r = bestDeparture(samples, list, dayStart(d), state.speed, t);
    if (r && r.best.level < best.level) {
      other = `<p class="small mt">💡 Besser: <b>${dayName(d)} ${fmtHM(r.best.minutes)} Uhr</b> (${['grün', 'gelb'][r.best.level]})
        <button type="button" class="btn btn-sm btn-ghost" data-action="use-departure" data-day="${d}" data-min="${r.best.minutes}">Übernehmen</button></p>`;
      break;
    }
  }

  const bars = options.map((o) => `<i class="l${o.level} ${o.minutes === state.depMinutes ? 'sel' : ''}"
      title="${fmtHM(o.minutes)}"></i>`).join('');
  return `<div class="card">
      <h3>⏰ Beste Abfahrt ${dayName(state.dayOffset).toLowerCase()}</h3>
      <p><b class="big">${fmtHM(best.minutes)} Uhr</b> – ${lvlText}, Ankunft ${fmtTime(new Date(best.arrival))} Uhr
        ${best.afterSunset ? ' (nach Sonnenuntergang)' : ''}</p>
      <div class="strip dep-strip" aria-hidden="true">
        <div class="strip-bar" style="grid-template-columns:repeat(${options.length},1fr)">${bars}</div>
        <div class="dep-labels"><span>${fmtHM(options[0].minutes)}</span><span>${fmtHM(options[options.length - 1].minutes)}</span></div>
      </div>
      ${isCurrent ? '<p class="muted small mt">✔ Ist bereits eingestellt.</p>'
        : `<button type="button" class="btn btn-sm mt" data-action="use-departure" data-day="${state.dayOffset}" data-min="${best.minutes}">
            ${fmtHM(best.minutes)} Uhr übernehmen</button>`}
      ${other}
    </div>`;
}

// ---------- Karte ----------

async function initMap() {
  const el = root.querySelector('#route-map');
  try {
    await Promise.all([loadCss(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
  } catch (err) {
    el.innerHTML = `<div class="empty"><p>Karte nicht verfügbar: ${esc(err.message)}</p></div>`;
    return;
  }
  L = window.L;
  const home = state.settings.home;
  map = L.map(el, { zoomControl: true }).setView(home ? [home.lat, home.lon] : [47.6, 13.6], home ? 9 : 7);
  L.tileLayer(TILE_URL, {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  layers.route = L.layerGroup().addTo(map);
  layers.points = L.layerGroup().addTo(map);
  layers.wps = L.layerGroup().addTo(map);

  // Tipp auf die Karte → Auswahl Start / Zwischenstopp / Ziel.
  // Leaflet stoppt Klicks in Popups – daher eigener Listener direkt am Popup-Inhalt.
  map.on('click', (e) => {
    const n = state.waypoints.length;
    const btn = (kind, text) => `<button type="button" class="btn btn-sm" data-map-pick="${kind}">${text}</button>`;
    const content = document.createElement('div');
    content.className = 'map-pick';
    content.innerHTML = btn('start', '🟢 Als Start')
      + (n - 2 < MAX_STOPS ? btn('via', '⚪ Als Zwischenstopp') : '')
      + btn('end', '🔴 Als Ziel');
    content.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-map-pick]');
      if (b) pickFromMap(b.dataset.mapPick, e.latlng);
    });
    L.popup({ className: 'pick-popup', minWidth: 200 }).setLatLng(e.latlng).setContent(content).openOn(map);
  });

  drawWaypoints(true);
  drawRoute();
}

/** Kartenpunkt als Start, Zwischenstopp oder Ziel übernehmen */
function pickFromMap(kind, latlng) {
  map.closePopup();
  const place = { name: `${fmtNum(latlng.lat, 3)} / ${fmtNum(latlng.lng, 3)}`, lat: latlng.lat, lon: latlng.lng };
  if (kind === 'start') {
    setWaypoint(0, place);
  } else if (kind === 'end') {
    setWaypoint(state.waypoints.length - 1, place);
  } else {
    // in einen leeren Zwischenstopp setzen, sonst neuen vor dem Ziel anlegen
    const empty = state.waypoints.findIndex((w, i) => !w && i > 0 && i < state.waypoints.length - 1);
    if (empty > 0) state.waypoints[empty] = place;
    else state.waypoints.splice(state.waypoints.length - 1, 0, place);
    invalidateRoute();
  }
  nameFromMap(place);
}

/** Ortsnamen für einen Kartenpunkt nachladen (OpenStreetMap, gecacht) */
async function nameFromMap(place) {
  const name = await reverseGeocode(place.lat, place.lon);
  if (!name) return;
  place.name = name;
  renderWaypoints();
  saveDraft();
  if (lastEval) renderResult();
}

function pinIcon(kind, label) {
  return L.divIcon({ className: '', html: `<div class="wp-pin ${kind}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}

function drawWaypoints(fit = false) {
  if (!map) return;
  layers.wps.clearLayers();
  const n = state.waypoints.length;
  const pts = [];
  state.waypoints.forEach((w, i) => {
    if (!w) return;
    const kind = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
    const marker = L.marker([w.lat, w.lon], {
      icon: pinIcon(kind, kind === 'start' ? 'S' : kind === 'end' ? 'Z' : String(i)),
      draggable: true,
      keyboard: false,
    }).addTo(layers.wps);
    // Punkt verschieben → neue Position übernehmen
    marker.on('dragend', () => {
      const { lat, lng } = marker.getLatLng();
      const place = { name: `${fmtNum(lat, 3)} / ${fmtNum(lng, 3)}`, lat, lon: lng };
      setWaypoint(i, place);
      nameFromMap(place);
    });
    pts.push([w.lat, w.lon]);
  });
  if (fit && pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
  else if (fit && pts.length === 1) map.setView(pts[0], 10);
}

/** Route einfärben: jedes Teilstück nach dem schlechteren der beiden Wetterpunkte */
function drawRoute() {
  if (!map) return;
  layers.route.clearLayers();
  layers.points.clearLayers();
  const r = state.route;
  if (!r) return;

  // dunkler Rand für Kontrast
  L.polyline(r.coords, { color: '#0d0f12', weight: 10, opacity: 0.6 }).addTo(layers.route);
  const ev = lastEval;
  if (!ev) {
    L.polyline(r.coords, { color: GRAY, weight: 6 }).addTo(layers.route);
  } else {
    const pts = ev.points;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const levels = [a.level, b.level].filter((x) => x != null);
      const color = levels.length ? LEVEL_COLORS[Math.max(...levels)] : GRAY;
      const seg = [[a.lat, a.lon], ...r.coords.slice(a.idx, b.idx), [b.lat, b.lon]];
      L.polyline(seg, { color, weight: 6, opacity: 0.95 }).addTo(layers.route);
    }
    for (const p of pts) {
      const color = p.level == null ? GRAY : LEVEL_COLORS[p.level];
      const w = p.h ? wmo(p.h.code, p.h.isDay) : null;
      const popup = p.h
        ? `<b>km ${fmtNum(Math.round(p.km))} · ${fmtTime(new Date(p.eta))} Uhr</b><br>
           ${w.icon} ${fmtNum(p.h.temp)} °C · 💧 ${fmtNum(p.h.rainProb ?? 0)} % · 💨 ${fmtNum(p.h.gust)} km/h
           ${p.level ? `<br><span class="lvl-text l${p.level}">${p.reasons.map((x) => esc(x.text)).join(' · ')}</span>` : ''}`
        : `km ${fmtNum(Math.round(p.km))}: keine Vorhersage`;
      L.circleMarker([p.lat, p.lon], { radius: 7, color: '#0d0f12', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(popup)
        .addTo(layers.points);
    }
  }
  if (state.fitPending) {
    map.fitBounds(L.polyline(r.coords).getBounds(), { padding: [30, 30] });
    state.fitPending = false;
  }
}

// ---------- Aktionen ----------

function saveDraft() {
  db.saveSettings({ routeDraft: state.waypoints });
}

/** Wegpunkt setzen – eine vorhandene Route passt dann nicht mehr */
function setWaypoint(i, place) {
  state.waypoints[i] = place;
  invalidateRoute();
}

function invalidateRoute() {
  state.route = null;
  state.forecast = null;
  state.error = null;
  lastEval = null;
  saveDraft();
  renderWaypoints();
  renderDeparture();
  renderResult();
  drawWaypoints();
  drawRoute();
}

async function compute() {
  const wps = state.waypoints.filter(Boolean);
  if (!start() || !end()) {
    toast('Bitte Start und Ziel wählen.', 'error');
    return;
  }
  state.loading = true;
  state.error = null;
  state.forecast = null;  // gehört zu den Wetterpunkten der alten Route
  renderDeparture();
  renderResult();
  try {
    const route = await fetchRoute(wps);
    const { samples, totalKm } = sampleRoute(route.coords);
    state.route = { ...route, samples, totalKm };
    state.fitPending = true;
    state.forecast = await fetchRouteForecast(samples);
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    renderDeparture();
    renderResult();
    drawRoute();
  }
}

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const i = Number(el.dataset.i);
  switch (el.dataset.action) {
    case 'wp-pick': {
      const n = state.waypoints.length;
      openPlaceSearch({
        title: i === 0 ? 'Start' : i === n - 1 ? 'Ziel' : 'Zwischenstopp',
        onPick: async (place) => {
          try {
            const p = place.gps ? await currentPlace() : place;
            setWaypoint(i, { name: p.name, lat: p.lat, lon: p.lon });
            drawWaypoints(true);
          } catch (err) {
            toast(err.message, 'error', 6000);
          }
        },
      });
      break;
    }
    case 'wp-remove':
      if (i === 0 || i === state.waypoints.length - 1) state.waypoints[i] = null;
      else state.waypoints.splice(i, 1);
      invalidateRoute();
      break;
    case 'wp-add':
      state.waypoints.splice(state.waypoints.length - 1, 0, null);
      renderWaypoints();
      break;
    case 'wp-reverse':
      state.waypoints.reverse();
      invalidateRoute();
      break;
    case 'favorites':
      openFavorites();
      break;
    case 'compute':
      await compute();
      break;
    case 'use-departure':
      state.dayOffset = Number(el.dataset.day);
      state.depMinutes = Number(el.dataset.min);
      renderDeparture();
      renderResult();
      drawRoute();
      break;
    case 'save-favorite':
      saveFavorite();
      break;
    default:
  }
}

/** Tag, Abfahrt oder Tempo geändert → sofort neu bewerten (ohne neue Abfragen) */
async function onChange(e) {
  const { name, value } = e.target;
  if (!['dayOffset', 'depMinutes', 'speed'].includes(name)) return;
  state[name] = Number(value);
  if (name === 'speed') await db.saveSettings({ avgSpeed: state.speed });
  renderResult();
  drawRoute();
}

// ---------- Favoriten ----------

async function openFavorites() {
  const routes = (await db.getAll('routes')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const items = routes.map((r) => `<div class="fav-row">
      <button type="button" class="item" data-load="${esc(r.id)}">
        <span class="ico" aria-hidden="true">⭐</span>
        <span class="main"><span class="t">${esc(r.name)}</span>
          <span class="s">${esc(r.waypoints[0]?.name || '')} → ${esc(r.waypoints[r.waypoints.length - 1]?.name || '')}${r.km ? ` · ${fmtNum(r.km)} km` : ''}</span></span>
        <span></span>
      </button>
      <button type="button" class="icon-btn" data-del="${esc(r.id)}" aria-label="Favorit löschen">${ICONS.trash}</button>
    </div>`).join('');
  openSheet({
    title: 'Favoriten',
    body: routes.length ? `<div class="list">${items}</div>`
      : '<div class="empty"><div class="e">⭐</div><p>Noch keine Favoriten. Berechne eine Route und tippe auf „Als Favorit speichern".</p></div>',
    onOpen: (dlg, form, close) => {
      dlg.addEventListener('click', async (e) => {
        const load = e.target.closest('[data-load]');
        const del = e.target.closest('[data-del]');
        if (load) {
          const fav = routes.find((r) => r.id === load.dataset.load);
          close();
          state.waypoints = fav.waypoints.map((w) => ({ ...w }));
          invalidateRoute();
          drawWaypoints(true);
          await compute();
        } else if (del) {
          const fav = routes.find((r) => r.id === del.dataset.del);
          if (!await confirmDialog(`Favorit „${fav.name}" löschen?`, { ok: 'Löschen', danger: true })) return;
          await db.remove('routes', fav.id);
          close();
          toast('Favorit gelöscht', 'ok');
          openFavorites();
        }
      });
    },
  });
}

function saveFavorite() {
  if (!state.route) return;
  const wps = state.waypoints.filter(Boolean);
  openSheet({
    title: 'Als Favorit speichern',
    body: field({ label: 'Name', name: 'name', value: `${start().name} → ${end().name}`, required: true }),
    footer: `<button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>`,
    onSubmit: async (form, close) => {
      const name = form.elements.name.value.trim();
      if (!name) return;
      await db.put('routes', {
        id: db.uid(),
        name,
        waypoints: wps.map(({ name: n, lat, lon }) => ({ name: n, lat, lon })),
        km: Math.round(state.route.totalKm),
        createdAt: new Date().toISOString(),
      });
      close();
      toast('Favorit gespeichert ⭐', 'ok');
    },
  });
}

