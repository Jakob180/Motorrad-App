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

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify(fakeForecast()));
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

console.log(`\n${passed} Tests bestanden${process.exitCode ? ' – es gab Fehler!' : '.'}`);
