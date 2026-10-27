// webpush.js – Web Push ohne externe Bibliothek, nur mit WebCrypto (läuft im Cloudflare Worker
// und in Node). Verschlüsselung nach RFC 8291 (aes128gcm), Absender-Kennung per VAPID (RFC 8292).

const enc = new TextEncoder();

/** base64url → Uint8Array */
export function b64urlDecode(str) {
  const b64 = str.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Uint8Array → base64url (ohne =) */
export function b64urlEncode(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** HKDF (Extract + Expand) mit SHA-256 */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** P-256-Schlüssel aus Rohdaten: öffentlicher Schlüssel (65 Byte) + privater Anteil d (32 Byte) */
function jwkFromRaw(publicRaw, privateD) {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
    d: b64urlEncode(privateD),
    ext: true,
  };
}

/**
 * Nachricht für ein Abo verschlüsseln (RFC 8291, Content-Encoding aes128gcm).
 * test: { asPublic, asPrivate, salt } – nur für Tests mit festen Werten
 * → Body (Header + Ciphertext) als Uint8Array
 */
export async function encryptPayload(plaintext, p256dh, auth, test = null) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);

  // Einmal-Schlüsselpaar des Servers (bei jeder Nachricht neu)
  let asPublic;
  let asPrivateKey;
  if (test) {
    asPublic = b64urlDecode(test.asPublic);
    asPrivateKey = await crypto.subtle.importKey('jwk', jwkFromRaw(asPublic, b64urlDecode(test.asPrivate)),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivateKey = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256));

  // Schlüssel ableiten (Abschnitt 3.4 des RFC)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = test ? b64urlDecode(test.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Ein einziger Datensatz: Klartext + Trennzeichen 0x02
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Header: salt (16) | Datensatzgröße (4) | Länge Schlüssel-ID (1) | Schlüssel-ID = as_public (65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** VAPID-JWT (ES256) für den Push-Dienst, 12 Stunden gültig */
export async function vapidJwt(audience, subject, publicKey, privateKey, now = Date.now()) {
  const key = await crypto.subtle.importKey('jwk', jwkFromRaw(b64urlDecode(publicKey), b64urlDecode(privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto liefert die Signatur bereits im JWT-Format (r || s, 64 Byte)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `${unsigned}.${b64urlEncode(sig)}`;
}

/**
 * Push-Nachricht senden.
 * subscription: { endpoint, keys: { p256dh, auth } }   vapid: { subject, publicKey, privateKey }
 * → { ok, status, gone } – gone = Abo existiert nicht mehr (404/410) und kann gelöscht werden
 */
export async function sendPush(subscription, payload, vapid, { ttl = 12 * 3600, urgency = 'normal' } = {}) {
  const endpoint = new URL(subscription.endpoint);
  const jwt = await vapidJwt(endpoint.origin, vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, text: res.ok ? '' : await res.text() };
}
