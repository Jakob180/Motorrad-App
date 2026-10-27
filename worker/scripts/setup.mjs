// setup.mjs – erzeugt die VAPID-Schlüssel und einen Zugangs-Token und speichert sie direkt
// als Cloudflare-Secrets (npx wrangler secret put …). Der private Schlüssel landet so nie in
// einer Datei oder im Git-Repository.
//
// Aufruf im Ordner "worker":   npm run setup
// Nur den Token neu erzeugen:  npm run setup -- --token-only
//
// Achtung: Neue VAPID-Schlüssel machen bestehende Push-Abos ungültig → danach in der App
// Benachrichtigungen einmal deaktivieren und wieder aktivieren.

import { spawnSync } from 'node:child_process';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** Wert per stdin an "wrangler secret put" übergeben (erscheint nicht in der Konsole) */
function putSecret(name, value) {
  console.log(`\n→ Speichere Secret ${name} …`);
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32', // unter Windows heißt es npx.cmd
  });
  if (result.status !== 0) {
    console.error(`\n✖ Konnte ${name} nicht speichern. Bist du mit "npx wrangler login" angemeldet `
      + 'und wurde der Worker schon einmal mit "npx wrangler deploy" hochgeladen?');
    process.exit(1);
  }
}

const tokenOnly = process.argv.includes('--token-only');

if (!tokenOnly) {
  // VAPID: P-256-Schlüsselpaar (öffentlicher Schlüssel roh, 65 Byte; privat = d, 32 Byte)
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  putSecret('VAPID_PUBLIC_KEY', publicKey);
  putSecret('VAPID_PRIVATE_KEY', privateKey);
}

const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
putSecret('APP_TOKEN', token);

console.log(`
✔ Fertig! Trag diesen Zugangs-Token in der App ein
  (Einstellungen → Benachrichtigungen → Zugangs-Token):

    ${token}

  Tipp: Am besten per AirDrop/Notizen aufs iPhone kopieren. Der Token wird nirgends gespeichert –
  geht er verloren, einfach "npm run setup -- --token-only" ausführen.
`);
