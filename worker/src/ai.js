// ai.js – KI-Recherche der Wartungsdaten eines Motorrads (Öl, Filter, Reifen, Kette …).
// Drei Anbieter:
//   openrouter – Standard: openrouter/free (zufälliges Gratis-Modell) oder ein gewähltes Modell,
//                Websuche optional (kostet OpenRouter-Guthaben); Schlüssel kommt aus der App
//   groq      – openai/gpt-oss-120b (bei Limit gpt-oss-20b) mit eingebauter Browser-Suche
//               (Groq-Schlüssel kommt aus der App)
//   anthropic – Claude mit Websuche (Schlüssel aus der App oder als Worker-Secret ANTHROPIC_API_KEY)
// Schlüssel aus der App werden nur für die Anfrage verwendet, nie gespeichert oder geloggt.
// Ergebnisse werden 30 Tage in KV gecacht, ein Tageslimit schützt vor Kosten bzw. Gratis-Limits.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/free';
// Groq zählt die Gratis-Limits pro Modell: ist eines aufgebraucht, wird das andere versucht.
// Recherche zuerst mit dem großen Modell, das Übertragen ins JSON zuerst mit dem kleinen
// (spart das knappe Kontingent des großen Modells).
const GROQ_RESEARCH_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const GROQ_EXTRACT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
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

/** Groq-Limit erreicht (429) – Anlass, es mit dem anderen Modell zu versuchen */
class GroqLimitError extends AiError {}

/**
 * Groq-Limitmeldung verständlich machen, z. B.
 * "… tokens per day (TPD): Limit 200000 … Please try again in 23m55.9s"
 * → "Groq-Tageslimit des Gratis-Kontingents erreicht – wieder möglich in ca. 24 Minuten."
 */
export function groqLimitText(message = '') {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  let wait = '';
  if (m && (m[1] || m[2] || m[3])) {
    const minutes = Math.ceil((Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) / 60);
    if (minutes >= 120) wait = ` – wieder möglich in ca. ${Math.round(minutes / 60)} Stunden`;
    else if (minutes > 1) wait = ` – wieder möglich in ca. ${minutes} Minuten`;
    else wait = ' – in einer Minute wieder möglich';
  }
  const daily = /per day|\bTPD\b|\bRPD\b/i.test(message);
  return `Groq-${daily ? 'Tageslimit' : 'Minutenlimit'} des Gratis-Kontingents erreicht${wait}.`;
}

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
  if (res.status === 429) throw new GroqLimitError(groqLimitText(data.error?.message), 429);
  if (!res.ok) throw new AiError(`Groq meldet einen Fehler (${res.status}): ${clean(data.error?.message, 150)}`, 502);
  return data.choices?.[0]?.message?.content || '';
}

/** Mit dem ersten Modell versuchen, bei Limit mit dem nächsten → { content, model } */
async function groqWithFallback(apiKey, models, body) {
  let limit;
  for (const model of models) {
    try {
      return { content: await groqCall(apiKey, { ...body, model }), model };
    } catch (err) {
      if (!(err instanceof GroqLimitError)) throw err;
      limit = err;
    }
  }
  throw limit;
}

/** Groq: 1) recherchieren mit Browser-Suche, 2) Notizen in striktes JSON überführen */
async function askGroq(apiKey, bike) {
  const { content: notes, model } = await groqWithFallback(apiKey, GROQ_RESEARCH_MODELS, {
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
  const { content: json } = await groqWithFallback(apiKey, GROQ_EXTRACT_MODELS, {
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
  return { ...sanitize(input, found), model };
}

// ---------- OpenRouter ----------

const OPENROUTER_SYSTEM = (web) => `${SYSTEM.split('\n')[0]}
${web
    ? 'Nutze die mitgelieferten Suchergebnisse und prüfe Modell und Baujahr genau – Füllmengen und Teilenummern ändern sich zwischen Modelljahren.'
    : 'Du hast keine Websuche – antworte aus deinem Wissen und sei bei Teilenummern und Füllmengen besonders vorsichtig.'}
Antworte ausschließlich mit JSON im vorgegebenen Schema: kurz, auf Deutsch, metrische Einheiten, Dezimalkomma.
Lass ein Feld leer (""), wenn es nicht zutrifft oder du es nicht verlässlich weißt – lieber leer als geraten.
Zweitakter haben kein Motoröl im üblichen Sinn, sondern Getriebeöl und Zweitaktöl.
confidence: hoch nur bei Herstellerangaben${web ? '' : ' (ohne Websuche höchstens "mittel")'}. sources: verwendete URLs (sonst leer).`;

/** OpenRouter-Fehler in verständliche Meldungen übersetzen */
function openRouterError(status, message, retryAfter, web) {
  if (status === 401) return new AiError('Der OpenRouter-Schlüssel ist ungültig – bitte in den Einstellungen prüfen.', 400);
  if (status === 402) {
    return new AiError(web
      ? 'Für die Websuche braucht OpenRouter Guthaben – Websuche in den Einstellungen ausschalten oder Guthaben aufladen.'
      : 'Kein OpenRouter-Guthaben für dieses Modell – „openrouter/free" wählen oder Guthaben aufladen.', 402);
  }
  if (status === 429) {
    const minutes = Math.ceil(Number(retryAfter) / 60);
    const wait = Number.isFinite(minutes) && minutes > 0 ? ` – wieder möglich in ca. ${minutes} Minuten` : ' – bitte später nochmal';
    return new AiError(`OpenRouter-Limit erreicht (Gratis: 50 Anfragen pro Tag, mit Guthaben mehr)${wait}.`, 429);
  }
  if (status === 404 || /no endpoints/i.test(message)) {
    return new AiError('Dieses Modell kann keine strukturierte Ausgabe – bitte „openrouter/free" oder ein anderes Modell wählen.', 400);
  }
  return new AiError(`OpenRouter meldet einen Fehler (${status}): ${clean(message, 150)}`, 502);
}

/** JSON aus der Antwort lesen (manche Modelle setzen es in ```json … ```) */
function parseJsonContent(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(raw);
}

/** OpenRouter: ein Aufruf mit strikter JSON-Ausgabe, Websuche optional (Plugin "web") */
async function askOpenRouter(apiKey, bike, { model = OPENROUTER_DEFAULT_MODEL, web = false }) {
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Motorrad-Begleiter', // Anzeige im OpenRouter-Dashboard
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: OPENROUTER_SYSTEM(web) },
          { role: 'user', content: `Motorrad: ${describe(bike)}. Ermittle die Wartungsdaten.` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'wartungsdaten', strict: true, schema: SUBMIT_TOOL.input_schema },
        },
        // nur Anbieter verwenden, die die strukturierte Ausgabe auch wirklich können
        provider: { require_parameters: true },
        ...(web ? { plugins: [{ id: 'web', engine: 'exa', max_results: 5 }] } : {}),
        max_tokens: 4000,
      }),
    });
  } catch {
    throw new AiError('OpenRouter ist nicht erreichbar.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw openRouterError(res.ok ? Number(data.error?.code) || 502 : res.status, data.error?.message || '', res.headers.get('retry-after'), web);
  }
  const message = data.choices?.[0]?.message || {};
  let input;
  try {
    input = parseJsonContent(message.content);
  } catch {
    throw new AiError('Das Modell hat ungültige Daten geliefert – bitte nochmal versuchen.', 502);
  }
  // Quellen der Websuche (Annotationen) als Ersatz, falls das Modell selbst keine nennt
  const found = (message.annotations || [])
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url }));
  return { ...sanitize(input, found), model: data.model || model };
}

/**
 * Wartungsdaten für ein Motorrad: aus dem Cache oder frisch recherchiert.
 * bike: { brand, model, year, meter }   force: Cache ignorieren (zählt zum Tageslimit)
 * provider: 'openrouter' | 'groq' | 'anthropic'   apiKey: Schlüssel aus der App (optional bei anthropic)
 * options: { model, web } – nur OpenRouter
 */
export async function lookupSpecs(env, bike, { force = false, today, provider = 'anthropic', apiKey = '', options = {} }) {
  const names = { openrouter: 'OpenRouter', groq: 'Groq' };
  const key = provider === 'anthropic' ? (apiKey || env.ANTHROPIC_API_KEY) : apiKey;
  if (!key) {
    throw provider === 'anthropic'
      ? new AiError('Kein Claude-Schlüssel: in der App eintragen oder ANTHROPIC_API_KEY im Worker setzen – siehe README.', 503)
      : new AiError(`Bitte zuerst deinen ${names[provider]}-Schlüssel in den Einstellungen eintragen.`, 400);
  }
  const variant = provider === 'openrouter'
    ? `openrouter:${options.model || OPENROUTER_DEFAULT_MODEL}:${options.web ? 'web' : 'ohne'}`
    : provider === 'groq' ? 'groq' : 'claude';
  const cacheKey = `ai:specs:${variant}|${norm(bike.brand)}|${norm(bike.model)}|${bike.year || ''}|${bike.meter === 'h' ? 'h' : 'km'}`;
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
    if (provider === 'openrouter') result = await askOpenRouter(key, bike, options);
    else if (provider === 'groq') result = await askGroq(key, bike);
    else result = await askClaude(key, bike);
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
