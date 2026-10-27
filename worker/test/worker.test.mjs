// worker.test.mjs – Tests für den Push-Worker, laufen mit Node ohne Cloudflare-Konto:
//   npm test
// Simuliert KV-Speicher, Push-Dienst (entschlüsselt die Nachricht wie ein Handy) und Open-Meteo.

import assert from 'node:assert/strict';
import worker, { localNow, runCron, dueToday } from '../src/index.js';
import { encryptPayload, b64urlDecode, b64urlEncode } from '../src/webpush.js';

const enc = new TextEncoder();
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✔ ${name}`);
  } catch (err) {
    console.error(`✖ ${name}\n  ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ---------- Hilfen ----------

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** Entschlüsseln wie ein Browser (RFC 8291) – unabhängig vom Server-Code */
async function decrypt(body, ua) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(ua.auth, ecdh, new Uint8Array([...enc.encode('WebPush: info\0'), ...ua.publicRaw, ...asPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'Trennzeichen 0x02 fehlt');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

/** „Handy": Schlüssel wie bei pushManager.subscribe() */
async function fakeBrowser(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw,
    auth,
    subscription: { endpoint, keys: { p256dh: b64urlEncode(publicRaw), auth: b64urlEncode(auth) } },
  };
}

/** KV-Speicher im Arbeitsspeicher */
function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list({ prefix }) {
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// Open-Meteo-Antwort: heute schönes Wetter, ab 17 Uhr Regen
function fakeForecast() {
  const time = Array.from({ length: 24 }, (_, h) => `2026-10-27T${String(h).padStart(2, '0')}:00`);
  return {
    hourly: {
      time,
      temperature_2m: time.map((_, h) => (h < 9 ? 6 : 15)),
      precipitation_probability: time.map((_, h) => (h >= 17 ? 80 : 5)),
      precipitation: time.map((_, h) => (h >= 17 ? 1.5 : 0)),
      weather_code: time.map((_, h) => (h >= 17 ? 61 : 1)),
      wind_gusts_10m: time.map(() => 20),
    },
  };
}

// ---------- Umgebung ----------

const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const env = {
  PUSH_KV: fakeKV(),
  APP_TOKEN: 'geheimer-test-token-123',
  VAPID_PUBLIC_KEY: b64urlEncode(await crypto.subtle.exportKey('raw', vapidPair.publicKey)),
  VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vapidPair.privateKey)).d,
  VAPID_SUBJECT: 'https://jakob180.github.io/Motorrad-App/',
  ALLOWED_ORIGINS: 'https://jakob180.github.io,http://localhost:8080',
  TIMEZONE: 'Europe/Vienna',
};
const browser = await fakeBrowser('https://push.example.test/abo/123');
const pushes = [];          // beim Push-Dienst angekommene Nachrichten (entschlüsselt)
let pushStatus = 201;       // Antwort des Push-Dienstes
const claudeCalls = [];     // Anfragen an die Claude-API
const claudeReplies = [];   // vorbereitete Antworten der Claude-API (Warteschlange)
const groqCalls = [];       // Anfragen an die Groq-API
const groqReplies = [];     // vorbereitete Antworten der Groq-API
const orCalls = [];         // Anfragen an OpenRouter
const orReplies = [];       // vorbereitete Antworten von OpenRouter

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify(fakeForecast()));
  if (url.startsWith('https://openrouter.ai/')) {
    orCalls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const { status = 200, body, headers = {} } = orReplies.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }
  if (url.startsWith('https://api.groq.com/')) {
    groqCalls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const { status = 200, content = '', error } = groqReplies.shift();
    const body = error ? { error: { message: error } } : { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    claudeCalls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const { status = 200, body } = claudeReplies.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://push.example.test/')) {
    // VAPID-Header prüfen wie ein echter Push-Dienst
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
    assert.ok(m, 'Authorization-Header im VAPID-Format');
    const [h, c, s] = m[1].split('.');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vapidPair.publicKey, b64urlDecode(s), enc.encode(`${h}.${c}`));
    assert.ok(ok, 'JWT-Signatur gültig');
    assert.equal(JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))).aud, 'https://push.example.test');
    assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
    pushes.push(await decrypt(new Uint8Array(init.body), browser));
    return new Response('', { status: pushStatus });
  }
  throw new Error(`Unerwarteter Abruf: ${url}`);
};

const call = (method, path, body, token = env.APP_TOKEN, origin = 'https://jakob180.github.io') => worker.fetch(new Request(`https://motorrad-push.test${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}), env);

const deviceId = 'geraet-1234-abcd';
const deviceData = {
  subscription: browser.subscription,
  home: { name: 'Hallein', lat: 47.68, lon: 13.1 },
  thresholds: { rainProbYellow: 40, rainProbRed: 70, rainMmYellow: 0.5, rainMmRed: 2, tempYellow: 8, tempRed: 3, gustYellow: 50, gustRed: 70, rideFrom: 8, rideTo: 20 },
  prefs: { weather: true, weatherMode: 'good', service: true, pickerl: true, hour: 7 },
  dues: [
    { id: 'oel', name: 'Ölwechsel', dueDate: '2026-11-10', distLeft: 150, soonDist: 500, unit: 'km' },
    { id: 'kette', name: 'Kette schmieren', dueDate: null, distLeft: 400, soonDist: 50, unit: 'km' },
  ],
  pickerl: [{ id: 'pickerl-1', name: 'Pickerl', label: 'November 2026', windowStart: '2026-10-01', dueEnd: '2026-11-30', graceEnd: '2027-03-31' }],
};

// ---------- Tests ----------

await test('Verschlüsselung entspricht RFC 8291 (Anhang A)', async () => {
  const body = await encryptPayload('When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
  const expected = new Uint8Array([
    ...b64urlDecode('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    ...b64urlDecode('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'),
  ]);
  assert.deepEqual(body, expected);
});

await test('Ohne gültigen Token: 401', async () => {
  const res = await call('GET', '/api/vapid-public-key', null, 'falsch');
  assert.equal(res.status, 401);
});

await test('CORS nur für erlaubte Adressen', async () => {
  const ok = await call('GET', '/api/health', null, '', 'https://jakob180.github.io');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://jakob180.github.io');
  const bad = await call('GET', '/api/health', null, '', 'https://boese.example');
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

await test('Öffentlichen VAPID-Schlüssel abrufen', async () => {
  const res = await call('GET', '/api/vapid-public-key');
  assert.equal((await res.json()).key, env.VAPID_PUBLIC_KEY);
});

await test('Gerät speichern (ungültiges Abo wird abgelehnt)', async () => {
  const bad = await call('PUT', `/api/device/${deviceId}`, { ...deviceData, subscription: { endpoint: 'http://unsicher' } });
  assert.equal(bad.status, 400);
  const res = await call('PUT', `/api/device/${deviceId}`, deviceData);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.PUSH_KV.map.get(`dev:${deviceId}`));
  assert.equal(stored.home.name, 'Hallein');
  assert.equal(stored.prefs.hour, 7);
});

await test('Test-Nachricht kommt verschlüsselt beim Handy an', async () => {
  pushes.length = 0;
  const res = await (await call('POST', `/api/device/${deviceId}/test`)).json();
  assert.equal(res.sent, 1);
  assert.equal(pushes[0].title, '✅ Test vom Motorrad-Begleiter');
  assert.equal(pushes[0].tab, 'einstellungen');
});

await test('Fälligkeiten werden für heute neu bewertet', async () => {
  const device = JSON.parse(env.PUSH_KV.map.get(`dev:${deviceId}`));
  const items = dueToday(device, '2026-10-27');
  // km (150 von 5.000) ist dringender als die Zeit (14 Tage) → km wird genannt, wie in der App
  assert.deepEqual(items.map((i) => i.text), ['Ölwechsel: fällig in 150 km', 'Pickerl: jetzt fällig (November 2026)']);
  // in einer Woche ist die Zeit-Grenze nah (≤ 7 Tage) → Datum geht vor
  assert.equal(dueToday(device, '2026-11-05')[0].text, 'Ölwechsel: fällig in 5 Tagen');
  const later = dueToday(device, '2027-04-02');
  assert.equal(later[0].overdue, true);
  assert.match(later.map((i) => i.text).join(' | '), /Pickerl: abgelaufen/);
});

await test('Cron um 7 Uhr Wiener Zeit: Wetter + Wartung, kein Doppel-Versand', async () => {
  pushes.length = 0;
  // 27.10.2026 06:00 UTC = 07:00 in Wien (Winterzeit)
  const at7 = new Date(Date.UTC(2026, 9, 27, 6, 0));
  assert.equal(localNow('Europe/Vienna', at7).hour, 7);
  await runCron(env, at7);
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].title, /^🟢 Gutes Fahrwetter in Hallein/);
  assert.match(pushes[0].body, /ab 17 Uhr Regen/);
  assert.equal(pushes[0].tab, 'wetter');
  assert.equal(pushes[1].tab, 'service');
  assert.match(pushes[1].body, /Ölwechsel: fällig in 150 km/);
  // gleiche Stunde nochmal → nichts Neues
  await runCron(env, at7);
  assert.equal(pushes.length, 2);
  // andere Stunde → nichts
  await runCron(env, new Date(Date.UTC(2026, 9, 27, 9, 0)));
  assert.equal(pushes.length, 2);
});

await test('Erinnerungen höchstens alle 7 Tage, Wetter täglich', async () => {
  pushes.length = 0;
  await runCron(env, new Date(Date.UTC(2026, 9, 28, 6, 0))); // nächster Tag 7 Uhr
  assert.deepEqual(pushes.map((p) => p.tab), ['wetter']);
  pushes.length = 0;
  await runCron(env, new Date(Date.UTC(2026, 10, 3, 6, 0))); // eine Woche später
  assert.ok(pushes.some((p) => p.tab === 'service'));
});

await test('Sommerzeit: 7 Uhr in Wien = 05:00 UTC', async () => {
  assert.equal(localNow('Europe/Vienna', new Date(Date.UTC(2026, 6, 1, 5, 0))).hour, 7);
});

await test('Abo abgelaufen (410) → Gerät wird gelöscht', async () => {
  pushStatus = 410;
  const res = await (await call('POST', `/api/device/${deviceId}/test`)).json();
  assert.equal(res.gone, true);
  assert.equal(env.PUSH_KV.map.has(`dev:${deviceId}`), false);
  pushStatus = 201;
});

// ---------- KI: Wartungsdaten ----------

const specsInput = {
  engineOil: '', oilAmount: '', oilFilter: '', gearOil: 'SAE 10W-40, 0,8 l', twoStrokeOil: 'vollsynthetisch, Öltank (Ölpumpe)',
  airFilter: 'Twin Air 158112', sparkPlug: 'NGK BR7ES', chain: '520, 118 Glieder', sprockets: '14/50',
  tireFront: '90/90-21', tireRear: '140/80-18', tirePressure: 'Gelände 1,0 / 1,0 bar', brakeFluid: 'DOT 4',
  brakePadsFront: '', brakePadsRear: '', coolant: 'Motorex Coolant M3.0, 1,2 l', battery: 'YTZ7S',
  confidence: 'mittel', notes: 'Getriebeöl-Menge laut Handbuch prüfen.',
  sources: [{ title: 'Husqvarna Bedienungsanleitung TE 300', url: 'https://www.husqvarna-motorcycles.com/de/handbuch' }],
};
const msg = (content, stop_reason) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason,
  usage: { input_tokens: 100, output_tokens: 50 },
});
const searchResult = { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'Forum', url: 'https://forum.example/te300' }] };
const submit = { type: 'tool_use', id: 'tu_1', name: 'submit_specs', input: specsInput };
const askSpecs = (extra = {}) => call('POST', '/api/ai/specs', { brand: 'Husqvarna', model: 'TE 300', year: 2023, meter: 'h', ...extra });

await test('KI ohne API-Schlüssel: verständliche Meldung (503)', async () => {
  const res = await askSpecs();
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
});

await test('KI-Anfrage: richtiges Modell, Websuche, striktes Werkzeug, Fallback', async () => {
  env.ANTHROPIC_API_KEY = 'sk-test';
  claudeReplies.push({ body: msg([searchResult, submit], 'tool_use') });
  const res = await askSpecs();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cached, false);
  assert.equal(data.specs.gearOil, 'SAE 10W-40, 0,8 l');
  assert.equal(data.specs.engineOil, '');
  assert.equal(data.confidence, 'mittel');
  assert.equal(data.sources[0].url, 'https://www.husqvarna-motorcycles.com/de/handbuch');
  const req = claudeCalls.at(-1);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  // SDK 1.x sendet den Schlüssel als Bearer-Token (ältere Versionen als x-api-key)
  assert.ok(req.headers.get('authorization') === 'Bearer sk-test' || req.headers.get('x-api-key') === 'sk-test');
  assert.ok(req.body.tools.some((t) => t.type === 'web_search_20260209'));
  const tool = req.body.tools.find((t) => t.name === 'submit_specs');
  assert.equal(tool.strict, true);
  assert.match(req.body.messages[0].content, /Husqvarna TE 300, Baujahr 2023 \(wird nach Betriebsstunden gewartet/);
});

await test('KI: zweite Anfrage kommt aus dem Cache (keine Kosten)', async () => {
  const before = claudeCalls.length;
  const data = await (await askSpecs()).json();
  assert.equal(data.cached, true);
  assert.equal(claudeCalls.length, before);
});

await test('KI: pausierte Websuche (pause_turn) wird fortgesetzt', async () => {
  claudeReplies.push({ body: msg([searchResult], 'pause_turn') }, { body: msg([submit], 'tool_use') });
  const before = claudeCalls.length;
  const data = await (await askSpecs({ force: true })).json();
  assert.equal(claudeCalls.length - before, 2);
  assert.equal(data.specs.battery, 'YTZ7S');
  assert.equal(claudeCalls.at(-1).body.messages[1].role, 'assistant');
});

await test('KI: ungültiger API-Schlüssel → klare Fehlermeldung', async () => {
  claudeReplies.push({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  const res = await askSpecs({ force: true });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Claude-API-Schlüssel ist ungültig/);
});

await test('KI: Tageslimit schützt vor Kosten', async () => {
  env.AI_DAILY_LIMIT = '3'; // 3 Abfragen heute schon verbraucht (oben)
  const before = claudeCalls.length;
  const res = await askSpecs({ force: true });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /Tageslimit von 3/);
  assert.equal(claudeCalls.length, before);
});

// ---------- KI über Groq (Schlüssel aus der App) ----------

const askGroq = (extra = {}) => askSpecs({ provider: 'groq', apiKey: 'gsk_test', ...extra });
const groqNotes = 'Getriebeöl: SAE 10W-40, 0,8 l\nZweitaktöl: vollsynthetisch, Öltank\nZündkerze: NGK BR7ES\nMotoröl: unbekannt\n'
  + 'Quellen: https://www.husqvarna-motorcycles.com/de/te300 【1†L2】';
const groqJson = JSON.stringify({ ...specsInput, sources: [] }); // ohne Quellen → aus den Notizen

await test('Groq ohne Schlüssel: Hinweis auf die Einstellungen', async () => {
  env.AI_DAILY_LIMIT = '100';
  const res = await askSpecs({ provider: 'groq' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Groq-Schlüssel in den Einstellungen/);
});

await test('Groq: 1) Browser-Suche, 2) striktes JSON – Schlüssel aus der App', async () => {
  groqReplies.push({ content: groqNotes }, { content: groqJson });
  const res = await askGroq();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, 'openai/gpt-oss-120b');
  assert.equal(data.specs.sparkPlug, 'NGK BR7ES');
  assert.equal(data.sources[0].url, 'https://www.husqvarna-motorcycles.com/de/te300');
  const [research, extract] = groqCalls.slice(-2);
  assert.equal(research.headers.get('authorization'), 'Bearer gsk_test');
  assert.deepEqual(research.body.tools, [{ type: 'browser_search' }]);
  assert.equal(research.body.tool_choice, 'required');
  assert.equal(research.body.model, 'openai/gpt-oss-120b');
  assert.equal(extract.body.tools, undefined);
  assert.equal(extract.body.model, 'openai/gpt-oss-20b'); // Übertragen spart das große Kontingent
  assert.equal(extract.body.response_format.type, 'json_schema');
  assert.equal(extract.body.response_format.json_schema.strict, true);
  assert.match(extract.body.messages[1].content, /Zündkerze: NGK BR7ES/);
  // Schlüssel wird nirgends gespeichert
  assert.ok(![...env.PUSH_KV.map.values()].some((v) => v.includes('gsk_test')));
});

await test('Groq: zweite Anfrage aus dem Cache, getrennt vom Claude-Cache', async () => {
  const before = groqCalls.length;
  const data = await (await askGroq()).json();
  assert.equal(data.cached, true);
  assert.equal(data.model, 'openai/gpt-oss-120b');
  assert.equal(groqCalls.length, before);
});

// Echte Groq-Meldung (Tageslimit des Gratis-Kontingents)
const tpdError = (model) => `Rate limit reached for model \`${model}\` in organization \`org_x\` service tier \`on_demand\` `
  + 'on tokens per day (TPD): Limit 200000, Used 200000, Requested 3324. Please try again in 23m55.967999999s.';

await test('Groq: großes Modell am Tageslimit → kleines Modell recherchiert', async () => {
  const before = groqCalls.length;
  groqReplies.push({ status: 429, error: tpdError('openai/gpt-oss-120b') }, { content: groqNotes }, { content: groqJson });
  const res = await askGroq({ force: true });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, 'openai/gpt-oss-20b');
  assert.deepEqual(groqCalls.slice(before).map((c) => c.body.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
  assert.deepEqual(groqCalls[before + 1].body.tools, [{ type: 'browser_search' }]);
});

await test('Groq: ungültiger Schlüssel und Tageslimit (beide Modelle) verständlich', async () => {
  groqReplies.push({ status: 401, error: 'Invalid API Key' });
  let res = await askGroq({ force: true });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Groq-Schlüssel ist ungültig/);
  groqReplies.push({ status: 429, error: tpdError('openai/gpt-oss-120b') }, { status: 429, error: tpdError('openai/gpt-oss-20b') });
  res = await askGroq({ force: true });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Groq-Tageslimit des Gratis-Kontingents erreicht – wieder möglich in ca. 24 Minuten.');
});

await test('Groq-Limittexte: Minuten-, Stunden- und Minutenlimit', async () => {
  const { groqLimitText } = await import('../src/ai.js');
  assert.equal(groqLimitText('… tokens per minute (TPM) … Please try again in 7.5s.'), 'Groq-Minutenlimit des Gratis-Kontingents erreicht – in einer Minute wieder möglich.');
  assert.equal(groqLimitText('… requests per day (RPD) … Please try again in 3h12m.'), 'Groq-Tageslimit des Gratis-Kontingents erreicht – wieder möglich in ca. 3 Stunden.');
  assert.equal(groqLimitText(''), 'Groq-Minutenlimit des Gratis-Kontingents erreicht.');
});

await test('Groq: kaputtes JSON → Fehlermeldung statt Absturz', async () => {
  groqReplies.push({ content: groqNotes }, { content: '{"kaputt":' });
  const res = await askGroq({ force: true });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /ungültige Daten/);
});

// ---------- KI über OpenRouter (Standard) ----------

const askOR = (extra = {}) => askSpecs({ provider: 'openrouter', apiKey: 'sk-or-test', ...extra });
const orOk = (content, extra = {}) => ({
  body: { id: 'gen-1', model: 'google/gemma-4-31b-it:free', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] },
});

await test('OpenRouter ohne Schlüssel: Hinweis auf die Einstellungen', async () => {
  const res = await askSpecs({ provider: 'openrouter' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /OpenRouter-Schlüssel in den Einstellungen/);
});

await test('OpenRouter Standard: openrouter/free, striktes JSON, ohne Websuche', async () => {
  orReplies.push(orOk('```json\n' + JSON.stringify(specsInput) + '\n```'));
  const res = await askOR();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, 'google/gemma-4-31b-it:free'); // vom Router gewähltes Gratis-Modell
  assert.equal(data.specs.gearOil, 'SAE 10W-40, 0,8 l');
  const req = orCalls.at(-1);
  assert.equal(req.headers.get('authorization'), 'Bearer sk-or-test');
  assert.equal(req.body.model, 'openrouter/free');
  assert.equal(req.body.response_format.json_schema.strict, true);
  assert.deepEqual(req.body.provider, { require_parameters: true });
  assert.equal(req.body.plugins, undefined);
  assert.match(req.body.messages[0].content, /keine Websuche/);
});

await test('OpenRouter mit Websuche: Plugin "web", Quellen aus den Annotationen, eigener Cache', async () => {
  orReplies.push(orOk(JSON.stringify({ ...specsInput, sources: [] }), {
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://www.husqvarna-motorcycles.com/de/te300', title: 'Husqvarna TE 300' } }],
  }));
  const before = orCalls.length;
  const data = await (await askOR({ web: true, model: 'google/gemma-4-31b-it:free' })).json();
  assert.equal(orCalls.length - before, 1); // nicht aus dem Cache der Variante ohne Websuche
  assert.equal(data.sources[0].title, 'Husqvarna TE 300');
  const req = orCalls.at(-1);
  assert.equal(req.body.model, 'google/gemma-4-31b-it:free');
  assert.deepEqual(req.body.plugins, [{ id: 'web', engine: 'exa', max_results: 5 }]);
  // zweites Mal: aus dem Cache
  assert.equal((await (await askOR({ web: true, model: 'google/gemma-4-31b-it:free' })).json()).cached, true);
});

await test('OpenRouter-Fehler verständlich: Guthaben, Limit, Modell, Schlüssel', async () => {
  orReplies.push({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } });
  let res = await askOR({ web: true, force: true });
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /Websuche braucht OpenRouter Guthaben/);
  orReplies.push({ status: 429, body: { error: { code: 429, message: 'Rate limit exceeded' } }, headers: { 'retry-after': '1440' } });
  res = await askOR({ force: true });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /50 Anfragen pro Tag.*ca\. 24 Minuten/);
  orReplies.push({ status: 404, body: { error: { code: 404, message: 'No endpoints found that support the requested parameters' } } });
  res = await askOR({ force: true, model: 'irgendein/modell:free' });
  assert.match((await res.json()).error, /keine strukturierte Ausgabe/);
  orReplies.push({ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } });
  res = await askOR({ force: true });
  assert.match((await res.json()).error, /OpenRouter-Schlüssel ist ungültig/);
});

await test('OpenRouter: Fehler im Antwort-Body (Status 200) und kaputtes JSON', async () => {
  orReplies.push({ body: { error: { code: 502, message: 'Provider returned error' } } });
  let res = await askOR({ force: true });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Provider returned error/);
  orReplies.push(orOk('Hier sind die Daten: Öl 10W-40'));
  res = await askOR({ force: true });
  assert.match((await res.json()).error, /ungültige Daten/);
});

console.log(`\n${passed} Tests bestanden${process.exitCode ? ' – es gab Fehler!' : '.'}`);
