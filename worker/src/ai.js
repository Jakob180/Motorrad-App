// ai.js – KI-Recherche der Wartungsdaten eines Motorrads (Öl, Filter, Reifen, Kette …) mit Claude.
// Läuft im Worker, damit der API-Schlüssel geheim bleibt. Claude sucht im Web nach den
// Herstellerangaben und liefert das Ergebnis über ein strikt definiertes Werkzeug zurück.
// Ergebnisse werden 30 Tage in KV gecacht, ein Tageslimit schützt vor unerwarteten Kosten.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const CACHE_TTL = 30 * 86400;     // Sekunden
const DEFAULT_DAILY_LIMIT = 20;   // KI-Abfragen pro Tag (Variable AI_DAILY_LIMIT)

export const SPEC_KEYS = [
  'engineOil', 'oilAmount', 'oilFilter', 'gearOil', 'twoStrokeOil', 'airFilter', 'sparkPlug',
  'chain', 'sprockets', 'tireFront', 'tireRear', 'tirePressure', 'brakeFluid', 'brakePadsFront',
  'brakePadsRear', 'coolant', 'battery',
];

const FIELD_HINTS = {
  engineOil: 'Motoröl: Viskosität und Norm/Freigabe, z. B. "10W-40, JASO MA2, API SN". Leer bei Zweitaktern.',
  oilAmount: 'Ölmenge beim Wechsel, z. B. "2,4 l mit Filter, 2,2 l ohne Filter"',
  oilFilter: 'Ölfilter: Originalnummer und gängige Zubehörnummer, z. B. "Yamaha 5GH-13440-61 / HiFlo HF204"',
  gearOil: 'Getriebeöl, falls getrennt vom Motoröl (z. B. Zweitakter): Sorte und Menge',
  twoStrokeOil: 'Zweitaktöl: Sorte und Mischungsverhältnis bzw. Hinweis auf Öltank/Ölpumpe',
  airFilter: 'Luftfilter: Originalnummer oder gängiges Zubehör',
  sparkPlug: 'Zündkerze: Typ, z. B. "NGK LMAR9E-J"',
  chain: 'Kette: Teilung und Gliederzahl, z. B. "525, 118 Glieder"',
  sprockets: 'Ritzel/Kettenrad Zähnezahl serienmäßig, z. B. "16/45"',
  tireFront: 'Reifengröße vorne, z. B. "120/70 ZR17"',
  tireRear: 'Reifengröße hinten',
  tirePressure: 'Luftdruck vorne/hinten, z. B. "2,5 / 2,9 bar" (bei Enduros Straße und Gelände)',
  brakeFluid: 'Bremsflüssigkeit, z. B. "DOT 4"',
  brakePadsFront: 'Bremsbeläge vorne: Originalnummer oder gängiges Zubehör',
  brakePadsRear: 'Bremsbeläge hinten: Originalnummer oder gängiges Zubehör',
  coolant: 'Kühlmittel: Typ und Menge (leer bei luftgekühlten Motoren)',
  battery: 'Batterie: Typ, z. B. "YTZ10S"',
};

// Rückgabe-Werkzeug mit striktem Schema – garantiert gültige, vollständige Daten
const SUBMIT_TOOL = {
  name: 'submit_specs',
  description: 'Gibt die recherchierten Wartungsdaten an die App zurück. Genau einmal am Ende aufrufen.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      ...Object.fromEntries(SPEC_KEYS.map((k) => [k, { type: 'string', description: FIELD_HINTS[k] }])),
      confidence: {
        type: 'string',
        enum: ['hoch', 'mittel', 'niedrig'],
        description: 'Wie sicher die Angaben insgesamt sind (hoch = aus Herstellerquellen bestätigt)',
      },
      notes: { type: 'string', description: 'Kurze Hinweise auf Deutsch, z. B. Unsicherheiten oder Modellvarianten; sonst leer' },
      sources: {
        type: 'array',
        description: 'Die wichtigsten verwendeten Quellen (höchstens 5)',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, url: { type: 'string' } },
          required: ['title', 'url'],
          additionalProperties: false,
        },
      },
    },
    required: [...SPEC_KEYS, 'confidence', 'notes', 'sources'],
    additionalProperties: false,
  },
};

const SYSTEM = `Du recherchierst Wartungsdaten von Motorrädern für die Wartungs-App eines Hobby-Schraubers in Österreich.
Prüfe die Angaben mit der Websuche an Herstellerquellen (Fahrer- oder Werkstatthandbuch, Herstellerseite) oder verlässlichen Teile-Findern. Achte auf das genaue Modell und Baujahr – Füllmengen und Teilenummern ändern sich zwischen Modelljahren.
Gib das Ergebnis über das Werkzeug submit_specs zurück: kurz, auf Deutsch, metrische Einheiten, Dezimalkomma. Lass ein Feld leer (""), wenn es für dieses Motorrad nicht zutrifft oder du es nicht verlässlich findest – lieber leer als geraten. Zweitakter haben kein Motoröl im üblichen Sinn, sondern Getriebeöl und Zweitaktöl.`;

/** Fehler mit HTTP-Status für die App */
export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (s, max = 200) => String(s || '').trim().slice(0, max);

/** Ergebnis bereinigen: nur bekannte Felder, Längen begrenzen, nur echte Links */
function sanitize(input, found) {
  const specs = Object.fromEntries(SPEC_KEYS.map((k) => [k, clean(input[k])]));
  const fromModel = (Array.isArray(input.sources) ? input.sources : [])
    .filter((s) => /^https?:\/\//.test(s?.url || ''))
    .map((s) => ({ title: clean(s.title, 120) || s.url, url: clean(s.url, 500) }));
  const sources = (fromModel.length ? fromModel : found).slice(0, 5);
  return {
    specs,
    confidence: ['hoch', 'mittel', 'niedrig'].includes(input.confidence) ? input.confidence : 'niedrig',
    notes: clean(input.notes, 600),
    sources,
  };
}

/** Quellen aus den Websuche-Ergebnissen (falls das Modell selbst keine nennt) */
function collectSources(content) {
  const out = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r.url && !out.some((x) => x.url === r.url)) out.push({ title: r.title || r.url, url: r.url });
    }
  }
  return out;
}

/** Eine Recherche bei Claude (Websuche + submit_specs), inkl. pause_turn-Fortsetzung */
async function askClaude(env, bike) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  const desc = `${bike.brand} ${bike.model}${bike.year ? `, Baujahr ${bike.year}` : ''}`
    + (bike.meter === 'h' ? ' (wird nach Betriebsstunden gewartet, vermutlich Enduro/Offroad)' : '');
  const messages = [{ role: 'user', content: `Motorrad: ${desc}. Ermittle die Wartungsdaten.` }];
  const found = [];

  for (let round = 0; round < 4; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Lehnt das Modell ab, beantwortet ein anderes Modell die Anfrage im selben Aufruf
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'AT' } },
        SUBMIT_TOOL,
      ],
      tool_choice: { type: 'auto' },
      messages,
    });
    found.push(...collectSources(response.content));

    if (response.stop_reason === 'refusal') throw new AiError('Die KI hat die Anfrage abgelehnt.', 422);
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'submit_specs');
    if (call) return { ...sanitize(call.input, found), model: response.model };
    if (response.stop_reason === 'max_tokens') throw new AiError('Die Antwort der KI war unvollständig.', 502);

    // Websuche pausiert (pause_turn) → fortsetzen; sonst einmal um das Ergebnis bitten
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'pause_turn') {
      messages.push({ role: 'user', content: 'Bitte gib das Ergebnis jetzt mit submit_specs zurück.' });
    }
  }
  throw new AiError('Die KI hat keine Wartungsdaten geliefert.', 502);
}

/**
 * Wartungsdaten für ein Motorrad: aus dem Cache oder frisch recherchiert.
 * bike: { brand, model, year, meter }   force: Cache ignorieren (zählt zum Tageslimit)
 */
export async function lookupSpecs(env, bike, { force = false, today }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AiError('Die KI ist am Server noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt) – siehe README.', 503);
  }
  const key = `ai:specs:${norm(bike.brand)}|${norm(bike.model)}|${bike.year || ''}|${bike.meter === 'h' ? 'h' : 'km'}`;
  if (!force) {
    const cached = await env.PUSH_KV.get(key, 'json');
    if (cached) return { ...cached, cached: true };
  }

  // Tageslimit (schützt vor unerwarteten Kosten)
  const limit = Number(env.AI_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const countKey = `ai:count:${today}`;
  const count = Number(await env.PUSH_KV.get(countKey)) || 0;
  if (count >= limit) throw new AiError(`Tageslimit von ${limit} KI-Abfragen erreicht – morgen wieder.`, 429);
  await env.PUSH_KV.put(countKey, String(count + 1), { expirationTtl: 2 * 86400 });

  let result;
  try {
    result = await askClaude(env, bike);
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('Der Anthropic-API-Schlüssel im Worker ist ungültig.', 502);
    if (err instanceof Anthropic.RateLimitError) throw new AiError('Die KI ist gerade ausgelastet – bitte in einer Minute nochmal.', 429);
    if (err instanceof Anthropic.APIError) throw new AiError(`Die KI meldet einen Fehler (${err.status ?? 'Verbindung'}).`, 502);
    throw err;
  }
  const record = { ...result, fetchedAt: new Date().toISOString() };
  await env.PUSH_KV.put(key, JSON.stringify(record), { expirationTtl: CACHE_TTL });
  return { ...record, cached: false };
}
