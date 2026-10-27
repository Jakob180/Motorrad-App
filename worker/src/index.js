// Cloudflare Worker – Push-Server für den Motorrad-Begleiter.
//
// API (alle Aufrufe brauchen "Authorization: Bearer <APP_TOKEN>"):
//   GET    /api/vapid-public-key      öffentlicher VAPID-Schlüssel für das Abo in der App
//   PUT    /api/device/:id            Abo, Wohnort, Ampel-Grenzwerte, Fälligkeiten speichern (KV)
//   DELETE /api/device/:id            Gerät abmelden
//   POST   /api/device/:id/test       Test-Nachricht senden
//   POST   /api/device/:id/run        Morgen-Nachricht sofort erzeugen (zum Testen)
//   POST   /api/ai/specs              Wartungsdaten eines Motorrads per KI recherchieren (ai.js)
//
// Cron: läuft stündlich (UTC). Für jedes Gerät wird geprüft, ob in Europe/Vienna gerade die
// gewünschte Uhrzeit ist – so stimmt die Zeit auch bei Sommer-/Winterzeit.

import { LEVELS, rateHours, summarizeDay } from '../../js/ampel.js';
import { sendPush } from './webpush.js';
import { lookupSpecs, AiError } from './ai.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const DEVICE_PREFIX = 'dev:';
const REMIND_EVERY_DAYS = 7;       // dieselbe Erinnerung höchstens alle 7 Tage
const SOON_DAYS = 30;
const MAX_BODY = 64 * 1024;

// Falls die App (noch) keine Grenzwerte geschickt hat
const DEFAULT_THRESHOLDS = {
  rainProbYellow: 40, rainProbRed: 70, rainMmYellow: 0.5, rainMmRed: 2,
  tempYellow: 8, tempRed: 3, gustYellow: 50, gustRed: 70, rideFrom: 8, rideTo: 20,
};
const DEFAULT_PREFS = { weather: true, weatherMode: 'good', service: true, pickerl: true, hour: 7 };

// ======================================================================
// Hilfsfunktionen
// ======================================================================

/** Datum und Stunde in der Zeitzone des Nutzers (Standard: Europe/Vienna) */
export function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Tage zwischen zwei ISO-Daten (b − a) */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const n1 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
const n0 = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const fmtAmount = (v, unit) => `${unit === 'Bh' ? n1(v) : n0(v)} ${unit}`;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

/** CORS: nur die eigene App (GitHub Pages, lokal) darf zugreifen */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Token in konstanter Zeit vergleichen (verrät nichts über richtige Teile) */
function tokenOk(request, env) {
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = env.APP_TOKEN || '';
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (!expected || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function vapidOf(env) {
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

/** Eingehende Gerätedaten prüfen und nur bekannte Felder übernehmen */
function sanitizeDevice(id, body) {
  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')
    || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
    throw new Error('Ungültiges Push-Abo');
  }
  const home = body.home && Number.isFinite(body.home.lat) && Number.isFinite(body.home.lon)
    ? { name: String(body.home.name || 'Wohnort').slice(0, 80), lat: body.home.lat, lon: body.home.lon } : null;
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) if (Number.isFinite(body.thresholds?.[k])) thresholds[k] = body.thresholds[k];
  const prefs = { ...DEFAULT_PREFS };
  for (const k of ['weather', 'service', 'pickerl']) if (typeof body.prefs?.[k] === 'boolean') prefs[k] = body.prefs[k];
  if (['good', 'daily'].includes(body.prefs?.weatherMode)) prefs.weatherMode = body.prefs.weatherMode;
  if (Number.isInteger(body.prefs?.hour) && body.prefs.hour >= 0 && body.prefs.hour <= 23) prefs.hour = body.prefs.hour;
  const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : null);
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    home,
    thresholds,
    prefs,
    dues: (Array.isArray(body.dues) ? body.dues : []).slice(0, 100).map((d) => ({
      id: str(d.id, 80), name: str(d.name), dueDate: iso(d.dueDate), distLeft: num(d.distLeft),
      soonDist: num(d.soonDist), unit: d.unit === 'Bh' ? 'Bh' : 'km',
    })),
    pickerl: (Array.isArray(body.pickerl) ? body.pickerl : []).slice(0, 20).map((p) => ({
      id: str(p.id, 80), name: str(p.name), label: str(p.label, 40),
      windowStart: iso(p.windowStart), dueEnd: iso(p.dueEnd), graceEnd: iso(p.graceEnd),
    })),
    updatedAt: new Date().toISOString(),
  };
}

// ======================================================================
// Inhalt der Morgen-Nachricht
// ======================================================================

/** Fahrwetter am Wohnort für heute (ab der aktuellen Stunde) */
export async function weatherSummary(device, now, env) {
  const { lat, lon } = device.home;
  const url = `${FORECAST_URL}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`
    + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_gusts_10m'
    + `&timezone=${encodeURIComponent(env.TIMEZONE || 'Europe/Vienna')}&forecast_days=1&wind_speed_unit=kmh`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  const h = data.hourly;
  const hours = h.time.map((time, i) => ({
    hour: Number(time.slice(11, 13)),
    temp: h.temperature_2m[i],
    rainProb: h.precipitation_probability[i],
    rain: h.precipitation[i],
    code: h.weather_code[i],
    gust: h.wind_gusts_10m[i],
  })).filter((x) => x.temp != null);
  const t = device.thresholds;
  return summarizeDay(rateHours(hours, t), t, { fromHour: now.hour });
}

/** Fällige Wartungen/Pickerl für heute – mit dem Stand der letzten Synchronisierung */
export function dueToday(device, today) {
  const items = [];
  if (device.prefs.service) {
    for (const d of device.dues) {
      const days = d.dueDate ? daysBetween(today, d.dueDate) : null;
      const distOver = d.distLeft != null && d.distLeft < 0;
      const timeOver = days != null && days < 0;
      const distSoon = d.distLeft != null && d.soonDist != null && d.distLeft <= d.soonDist;
      const timeSoon = days != null && days <= SOON_DAYS;
      let text = null;
      if (timeOver) text = `überfällig seit ${-days} ${-days === 1 ? 'Tag' : 'Tagen'}`;
      else if (distOver) text = `überfällig seit ${fmtAmount(-d.distLeft, d.unit)}`;
      else if (timeSoon && (!distSoon || days <= 7)) text = days === 0 ? 'heute fällig' : `fällig in ${days} ${days === 1 ? 'Tag' : 'Tagen'}`;
      else if (distSoon) text = `fällig in ${fmtAmount(d.distLeft, d.unit)}`;
      if (text) items.push({ key: d.id, kind: 'service', overdue: timeOver || distOver, text: `${d.name}: ${text}` });
    }
  }
  if (device.prefs.pickerl) {
    for (const p of device.pickerl) {
      if (!p.windowStart || !p.dueEnd || !p.graceEnd) continue;
      let text = null;
      let overdue = false;
      if (today > p.graceEnd) { text = 'abgelaufen – ohne gültiges Pickerl nicht fahren!'; overdue = true; }
      else if (today > p.dueEnd) { text = `Toleranzfrist läuft noch bis ${fmtDate(p.graceEnd)}`; overdue = true; }
      else if (today >= p.windowStart) text = `jetzt fällig (${p.label})`;
      else if (daysBetween(today, p.windowStart) <= SOON_DAYS) text = `ab ${fmtDate(p.windowStart)} möglich`;
      if (text) items.push({ key: p.id, kind: 'pickerl', overdue, text: `${p.name}: ${text}` });
    }
  }
  return items.sort((a, b) => Number(b.overdue) - Number(a.overdue));
}

/**
 * Morgen-Nachrichten für ein Gerät zusammenstellen und senden.
 * force = Test aus der App: Wetter immer senden, Erinnerungs-Pause ignorieren.
 */
export async function runDaily(env, device, now, { force = false } = {}) {
  const messages = [];

  if (device.prefs.weather && device.home) {
    try {
      const s = await weatherSummary(device, now, env);
      if (s.level != null && (force || device.prefs.weatherMode === 'daily' || s.level === 0)) {
        const icon = ['🟢', '🟡', '🔴'][s.level];
        const temps = s.stats ? ` · ${n0(s.stats.tempMin)}–${n0(s.stats.tempMax)} °C` : '';
        messages.push({
          title: `${icon} ${LEVELS[s.level].verdict} in ${device.home.name}`,
          body: `${s.text}${temps}`,
          tab: 'wetter',
          tag: 'wetter',
        });
      }
    } catch (err) {
      console.log('Wetter fehlgeschlagen:', err.message);
    }
  }

  // Erinnerungen: jede höchstens alle 7 Tage
  const notedKey = `note:${device.id}`;
  const noted = (await env.PUSH_KV.get(notedKey, 'json')) || {};
  const due = dueToday(device, now.date)
    .filter((i) => force || !noted[i.key] || daysBetween(noted[i.key], now.date) >= REMIND_EVERY_DAYS);
  if (due.length) {
    const onlyPickerl = due.every((i) => i.kind === 'pickerl');
    messages.push({
      title: onlyPickerl ? '🔖 Pickerl' : `🔧 ${due.length === 1 ? 'Wartung fällig' : `${due.length} Wartungen fällig`}`,
      body: due.slice(0, 4).map((i) => i.text).join('\n') + (due.length > 4 ? `\n… und ${due.length - 4} weitere` : ''),
      tab: 'service',
      tag: 'service',
    });
  }

  const results = [];
  for (const msg of messages) {
    const r = await sendPush(device.subscription, msg, vapidOf(env));
    results.push({ title: msg.title, status: r.status });
    if (r.gone) {
      // Abo existiert nicht mehr (App gelöscht / Benachrichtigungen aus) → Gerät entfernen
      await env.PUSH_KV.delete(`${DEVICE_PREFIX}${device.id}`);
      return { sent: 0, gone: true, results };
    }
  }
  if (due.length && results.some((r) => r.status < 300) && !force) {
    for (const i of due) noted[i.key] = now.date;
    await env.PUSH_KV.put(notedKey, JSON.stringify(noted), { expirationTtl: 120 * 86400 });
  }
  return { sent: results.filter((r) => r.status < 300).length, results, messages };
}

/** Stündlicher Cron: Geräte mit passender Uhrzeit benachrichtigen (einmal pro Tag) */
export async function runCron(env, date = new Date()) {
  const now = localNow(env.TIMEZONE || 'Europe/Vienna', date);
  let cursor;
  let checked = 0;
  do {
    const list = await env.PUSH_KV.list({ prefix: DEVICE_PREFIX, cursor });
    for (const { name } of list.keys) {
      const device = await env.PUSH_KV.get(name, 'json');
      if (!device || device.prefs.hour !== now.hour) continue;
      const sentKey = `sent:${device.id}`;
      if ((await env.PUSH_KV.get(sentKey)) === now.date) continue;
      checked++;
      try {
        await runDaily(env, device, now);
      } catch (err) {
        console.log(`Gerät ${device.id}:`, err.message);
      }
      await env.PUSH_KV.put(sentKey, now.date, { expirationTtl: 3 * 86400 });
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return { hour: now.hour, checked };
}

// ======================================================================
// HTTP
// ======================================================================

async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (url.pathname === '/' || url.pathname === '/api/health') {
    const ready = Boolean(env.APP_TOKEN && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.PUSH_KV);
    return json({ ok: true, service: 'Motorrad-Begleiter Push-Server', ready, ai: Boolean(env.ANTHROPIC_API_KEY) }, 200, cors);
  }
  if (!env.APP_TOKEN || !env.VAPID_PRIVATE_KEY) {
    return json({ error: 'Server ist noch nicht eingerichtet (Secrets fehlen) – siehe README.' }, 500, cors);
  }
  if (!tokenOk(request, env)) return json({ error: 'Token ungültig' }, 401, cors);

  if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY }, 200, cors);
  }

  if (url.pathname === '/api/ai/specs' && request.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json({ error: 'Ungültige Anfrage' }, 400, cors);
    }
    const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');
    const bike = {
      brand: str(body.brand),
      model: str(body.model),
      year: Number.isInteger(body.year) ? body.year : null,
      meter: body.meter === 'h' ? 'h' : 'km',
    };
    if (!bike.brand || !bike.model) return json({ error: 'Bitte Marke und Modell angeben.' }, 400, cors);
    try {
      const result = await lookupSpecs(env, bike, {
        force: body.force === true,
        today: localNow(env.TIMEZONE || 'Europe/Vienna').date,
      });
      return json(result, 200, cors);
    } catch (err) {
      if (err instanceof AiError) return json({ error: err.message }, err.status, cors);
      throw err;
    }
  }

  const m = url.pathname.match(/^\/api\/device\/([A-Za-z0-9-]{8,64})(\/(test|run))?$/);
  if (!m) return json({ error: 'Nicht gefunden' }, 404, cors);
  const [, id, , action] = m;
  const key = `${DEVICE_PREFIX}${id}`;

  if (!action && request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Zu groß' }, 413, cors);
    let device;
    try {
      device = sanitizeDevice(id, JSON.parse(text));
    } catch (err) {
      return json({ error: err.message }, 400, cors);
    }
    await env.PUSH_KV.put(key, JSON.stringify(device));
    return json({ ok: true, hour: device.prefs.hour }, 200, cors);
  }

  if (!action && request.method === 'DELETE') {
    await env.PUSH_KV.delete(key);
    await env.PUSH_KV.delete(`note:${id}`);
    await env.PUSH_KV.delete(`sent:${id}`);
    return json({ ok: true }, 200, cors);
  }

  if (action && request.method === 'POST') {
    const device = await env.PUSH_KV.get(key, 'json');
    if (!device) return json({ error: 'Gerät unbekannt – bitte Benachrichtigungen neu aktivieren.' }, 404, cors);
    if (action === 'test') {
      const r = await sendPush(device.subscription, {
        title: '✅ Test vom Motorrad-Begleiter',
        body: 'Push-Benachrichtigungen funktionieren. Gute Fahrt!',
        tab: 'einstellungen',
        tag: 'test',
      }, vapidOf(env));
      if (r.gone) await env.PUSH_KV.delete(key);
      return json({ sent: r.ok ? 1 : 0, status: r.status, gone: r.gone, detail: r.text?.slice(0, 200) }, 200, cors);
    }
    const now = localNow(env.TIMEZONE || 'Europe/Vienna');
    const r = await runDaily(env, device, now, { force: true });
    return json(r, 200, cors);
  }

  return json({ error: 'Methode nicht erlaubt' }, 405, cors);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.log('Fehler:', err.stack || err.message);
      return json({ error: 'Interner Fehler' }, 500, corsHeaders(request, env));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },
};
