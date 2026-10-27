// ai.js – KI-Recherche der Wartungsdaten eines Motorrads (Öl, Filter, Reifen, Kette …).
// Zwei Anbieter:
//   groq      – openai/gpt-oss-120b mit eingebauter Browser-Suche (Groq-Schlüssel kommt aus der App)
//   anthropic – Claude mit Websuche (Schlüssel aus der App oder als Worker-Secret ANTHROPIC_API_KEY)
// Schlüssel aus der App werden nur für die Anfrage verwendet, nie gespeichert oder geloggt.
// Ergebnisse werden 30 Tage in KV gecacht, ein Tageslimit schützt vor Kosten bzw. Gratis-Limits.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
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

/** Beschreibung des Motorrads für die Anfrage */
function describe(bike) {
  return `${bike.brand} ${bike.model}${bike.year ? `, Baujahr ${bike.year}` : ''}`
    + (bike.meter === 'h' ? ' (wird nach Betriebsstunden gewartet, vermutlich Enduro/Offroad)' : '');
}

/** Eine Recherche bei Claude (Websuche + submit_specs), inkl. pause_turn-Fortsetzung */
async function askClaude(apiKey, bike) {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const messages = [{ role: 'user', content: `Motorrad: ${describe(bike)}. Ermittle die Wartungsdaten.` }];
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

// ---------- Groq ----------

const GROQ_RESEARCH = `${SYSTEM.split('\n').slice(0, 2).join('\n')}
Schreib das Ergebnis als kurze Liste auf Deutsch (Feld: Wert), z. B. Motoröl, Ölmenge, Ölfilter, Getriebeöl,
Zweitaktöl, Luftfilter, Zündkerze, Kühlmittel, Batterie, Kette, Ritzel/Kettenrad, Reifen vorne/hinten,
Reifendruck, Bremsflüssigkeit, Bremsbeläge vorne/hinten. Schreib "unbekannt", wenn du etwas nicht verlässlich
findest – lieber unbekannt als geraten. Zweitakter haben kein Motoröl im üblichen Sinn, sondern Getriebeöl und
Zweitaktöl. Nenne am Ende unter "Quellen:" die vollständigen URLs, die du verwendet hast.`;

const GROQ_EXTRACT = `Übertrage die Recherche-Notizen zu einem Motorrad in das vorgegebene JSON-Schema.
Übernimm nur Angaben, die in den Notizen stehen – nichts ergänzen oder erfinden. "unbekannt" oder fehlende
Angaben → leerer String "". Werte kurz, auf Deutsch, metrische Einheiten, Dezimalkomma.
sources: die in den Notizen genannten URLs (höchstens 5). confidence: hoch nur bei Herstellerquellen.`;

/** Aufruf der Groq-API (OpenAI-kompatibel) mit verständlichen Fehlern */
async function groqCall(apiKey, body) {
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError('Groq ist nicht erreichbar.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AiError('Der Groq-Schlüssel ist ungültig – bitte in den Einstellungen prüfen.', 400);
  if (res.status === 429) throw new AiError('Groq-Limit erreicht (Gratis-Kontingent) – bitte später nochmal versuchen.', 429);
  if (!res.ok) throw new AiError(`Groq meldet einen Fehler (${res.status}): ${clean(data.error?.message, 150)}`, 502);
  return data.choices?.[0]?.message?.content || '';
}

/** Groq: 1) recherchieren mit Browser-Suche, 2) Notizen in striktes JSON überführen */
async function askGroq(apiKey, bike) {
  const notes = await groqCall(apiKey, {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: GROQ_RESEARCH },
      { role: 'user', content: `Motorrad: ${describe(bike)}. Ermittle die Wartungsdaten.` },
    ],
    tools: [{ type: 'browser_search' }],
    tool_choice: 'required',
    reasoning_effort: 'low', // empfohlen von Groq: kürzere Suche, weniger Token
    max_completion_tokens: 4000,
  });
  if (!notes.trim()) throw new AiError('Groq hat keine Recherche geliefert.', 502);

  // Browser-Suche und strukturierte Ausgabe gehen bei Groq nicht im selben Aufruf
  const json = await groqCall(apiKey, {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: GROQ_EXTRACT },
      { role: 'user', content: `Motorrad: ${describe(bike)}\n\nRecherche-Notizen:\n${notes.slice(0, 12000)}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'wartungsdaten', strict: true, schema: SUBMIT_TOOL.input_schema },
    },
    reasoning_effort: 'low',
    max_completion_tokens: 3000,
  });
  let input;
  try {
    input = JSON.parse(json);
  } catch {
    throw new AiError('Groq hat ungültige Daten geliefert – bitte nochmal versuchen.', 502);
  }
  const found = [...new Set(notes.match(/https?:\/\/[^\s)\]】>"'<,]+/g) || [])].map((url) => ({ title: url, url }));
  return { ...sanitize(input, found), model: GROQ_MODEL };
}

/**
 * Wartungsdaten für ein Motorrad: aus dem Cache oder frisch recherchiert.
 * bike: { brand, model, year, meter }   force: Cache ignorieren (zählt zum Tageslimit)
 * provider: 'groq' | 'anthropic'   apiKey: Schlüssel aus der App (optional bei anthropic)
 */
export async function lookupSpecs(env, bike, { force = false, today, provider = 'anthropic', apiKey = '' }) {
  const useGroq = provider === 'groq';
  const key = useGroq ? apiKey : (apiKey || env.ANTHROPIC_API_KEY);
  if (!key) {
    throw useGroq
      ? new AiError('Bitte zuerst deinen Groq-Schlüssel in den Einstellungen eintragen.', 400)
      : new AiError('Kein Claude-Schlüssel: in der App eintragen oder ANTHROPIC_API_KEY im Worker setzen – siehe README.', 503);
  }
  const cacheKey = `ai:specs:${useGroq ? 'groq' : 'claude'}|${norm(bike.brand)}|${norm(bike.model)}|${bike.year || ''}|${bike.meter === 'h' ? 'h' : 'km'}`;
  if (!force) {
    const cached = await env.PUSH_KV.get(cacheKey, 'json');
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
    result = useGroq ? await askGroq(key, bike) : await askClaude(key, bike);
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('Der Claude-API-Schlüssel ist ungültig.', 502);
    if (err instanceof Anthropic.RateLimitError) throw new AiError('Die KI ist gerade ausgelastet – bitte in einer Minute nochmal.', 429);
    if (err instanceof Anthropic.APIError) throw new AiError(`Die KI meldet einen Fehler (${err.status ?? 'Verbindung'}).`, 502);
    throw err;
  }
  const record = { ...result, fetchedAt: new Date().toISOString() };
  await env.PUSH_KV.put(cacheKey, JSON.stringify(record), { expirationTtl: CACHE_TTL });
  return { ...record, cached: false };
}
