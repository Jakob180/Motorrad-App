// specs.js – Wartungsdaten pro Motorrad (Öl, Filter, Reifen, Kette …), Ausfüllen per KI über den
// eigenen Cloudflare Worker und Einkaufs-Links zu Shops. Gespeichert im Motorrad (bike.specs).
// Die KI-Werte sind Vorschläge: leere Felder werden ausgefüllt, abweichende nur angeboten.

import * as db from './db.js';
import { getEntries, POSITIONS } from './logbook.js';
import { esc, fmtDate, field, openSheet, toast } from './ui.js';

// Felder mit Beschriftung, Beispiel und Suchbegriff-Präfix für die Shops (null = nichts zu kaufen).
// segments: wie viele kommagetrennte Teile in die Suche kommen; withBike: Marke/Modell mitsuchen
export const SPEC_FIELDS = [
  { key: 'engineOil', label: 'Motoröl', icon: '🛢️', example: 'z. B. 10W-40, JASO MA2', prefix: 'Motoröl' },
  { key: 'oilAmount', label: 'Ölmenge', icon: '🛢️', example: 'z. B. 2,4 l mit Filter', prefix: null },
  { key: 'oilFilter', label: 'Ölfilter', icon: '🛢️', example: 'z. B. HiFlo HF204', prefix: 'Ölfilter' },
  { key: 'gearOil', label: 'Getriebeöl', icon: '⚙️', example: 'z. B. 10W-40, 0,8 l', prefix: 'Getriebeöl' },
  { key: 'twoStrokeOil', label: 'Zweitaktöl', icon: '⚙️', example: 'z. B. vollsynthetisch, Öltank', prefix: 'Zweitaktöl', segments: 1 },
  { key: 'airFilter', label: 'Luftfilter', icon: '🌬️', example: 'Teilenummer', prefix: 'Luftfilter' },
  { key: 'sparkPlug', label: 'Zündkerze', icon: '⚡', example: 'z. B. NGK LMAR9E-J', prefix: 'Zündkerze' },
  { key: 'coolant', label: 'Kühlmittel', icon: '❄️', example: 'Typ und Menge', prefix: 'Kühlmittel Motorrad', segments: 1 },
  { key: 'battery', label: 'Batterie', icon: '🔋', example: 'z. B. YTZ10S', prefix: 'Motorradbatterie' },
  { key: 'chain', label: 'Kette', icon: '⛓️', example: 'z. B. 525, 118 Glieder', prefix: 'Kettensatz', segments: 1, withBike: true },
  { key: 'sprockets', label: 'Ritzel / Kettenrad', icon: '⛓️', example: 'z. B. 16/45', prefix: null },
  { key: 'tireFront', label: 'Reifen vorne', icon: '🛞', example: 'z. B. 120/70 ZR17', prefix: 'Motorradreifen' },
  { key: 'tireRear', label: 'Reifen hinten', icon: '🛞', example: 'z. B. 180/55 ZR17', prefix: 'Motorradreifen' },
  { key: 'tirePressure', label: 'Reifendruck', icon: '🛞', example: 'z. B. 2,5 / 2,9 bar', prefix: null },
  { key: 'brakeFluid', label: 'Bremsflüssigkeit', icon: '🛑', example: 'z. B. DOT 4', prefix: 'Bremsflüssigkeit' },
  { key: 'brakePadsFront', label: 'Bremsbeläge vorne', icon: '🛑', example: 'Teilenummer', prefix: 'Bremsbeläge' },
  { key: 'brakePadsRear', label: 'Bremsbeläge hinten', icon: '🛑', example: 'Teilenummer', prefix: 'Bremsbeläge' },
];
const FIELD = Object.fromEntries(SPEC_FIELDS.map((f) => [f.key, f]));

const GROUPS = [
  ['Öl & Filter', ['engineOil', 'oilAmount', 'oilFilter', 'gearOil', 'twoStrokeOil']],
  ['Motor', ['airFilter', 'sparkPlug', 'coolant', 'battery']],
  ['Kette', ['chain', 'sprockets']],
  ['Reifen', ['tireFront', 'tireRear', 'tirePressure']],
  ['Bremsen', ['brakeFluid', 'brakePadsFront', 'brakePadsRear']],
];

const SHOPS = [
  { name: 'Louis', url: (q) => `https://www.louis.at/suche?q=${encodeURIComponent(q)}` },
  { name: 'Polo', url: (q) => `https://www.polo-motorrad.com/de-at/search?query=${encodeURIComponent(q)}` },
  { name: 'Amazon', url: (q) => `https://www.amazon.de/s?k=${encodeURIComponent(q)}` },
  { name: 'Preisvergleich', url: (q) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}` },
];

// Welche Teile gehören zu welcher Wartung? (Schlüssel wie in service.js → TASKS)
const TASK_FIELDS = {
  oil: ['engineOil', 'oilAmount', 'oilFilter', 'gearOil', 'twoStrokeOil'],
  'chain-lube': ['chain'],
  'chain-clean': ['chain'],
  'chain-replace': ['chain', 'sprockets'],
  'tire-front': ['tireFront', 'tirePressure'],
  'tire-rear': ['tireRear', 'tirePressure'],
  brakes: ['brakePadsFront', 'brakePadsRear', 'brakeFluid'],
  service: ['engineOil', 'oilAmount', 'oilFilter', 'airFilter', 'sparkPlug', 'brakeFluid', 'coolant'],
};
// Eigene Aufgaben: anhand der Bezeichnung zuordnen
const NAME_RULES = [
  [/bremsfl/i, ['brakeFluid']], [/luftfilter/i, ['airFilter']], [/zünd/i, ['sparkPlug']],
  [/kühl/i, ['coolant']], [/batter/i, ['battery']], [/getriebe/i, ['gearOil']], [/zweitakt|2t/i, ['twoStrokeOil']],
  [/reifen/i, ['tireFront', 'tireRear', 'tirePressure']], [/kette/i, ['chain', 'sprockets']],
  [/brems/i, ['brakePadsFront', 'brakePadsRear', 'brakeFluid']], [/öl/i, ['engineOil', 'oilAmount', 'oilFilter']],
];
// Verbrauchsmaterial ohne eigenes Feld
const TASK_EXTRAS = {
  'chain-lube': ['Kettenspray Motorrad'],
  'chain-clean': ['Kettenreiniger Motorrad', 'Kettenspray Motorrad'],
};

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Gespeicherte Werte eines Motorrads */
export function specValues(bike) {
  return bike?.specs?.values || {};
}

function fieldsForTask(task, name) {
  if (TASK_FIELDS[task]) return TASK_FIELDS[task];
  const rule = NAME_RULES.find(([re]) => re.test(name || ''));
  return rule ? rule[1] : SPEC_FIELDS.map((f) => f.key);
}

/**
 * Suchbegriffe für die Shops: Alternativen ("A / B") einzeln, nur die Kernangabe
 * (ohne Klammern und Füllmengen), z. B. "SAE 10W-40, 0,8 l" → "Getriebeöl SAE 10W-40"
 */
function queriesFor(f, value, bike) {
  const queries = value.split(/\s+\/\s+|;/).slice(0, 2).map((alt) => {
    // Mengen zuerst entfernen – sonst würde das Dezimalkomma in "0,8 l" als Trenner gelten
    const core = alt.replace(/\([^)]*\)/g, '')
      .replace(/\b(ca\.?\s*)?\d+(?:[.,]\d+)?\s*(l|ml|liter)\b/gi, '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, f.segments || 2).join(' ')
      .replace(/\s+/g, ' ').trim()
      .split(' ').slice(0, 6).join(' ');
    const model = f.withBike ? `${bike.brand || ''} ${bike.model || ''}`.trim() : '';
    return [f.prefix, model, core].filter(Boolean).join(' ');
  });
  return queries.filter((q, i) => q && queries.indexOf(q) === i);
}

function shopLinks(query) {
  return `<div class="shop-row">
      <span class="muted small">„${esc(query)}"</span>
      <div class="shop-links">${SHOPS.map((s) => `<a class="shop-btn" href="${esc(s.url(query))}" target="_blank" rel="noopener">${s.name}</a>`).join('')}</div>
    </div>`;
}

/** Kurzüberblick für die Service-Seite */
export function specsSummary(bike) {
  const v = specValues(bike);
  const items = ['engineOil', 'gearOil', 'oilFilter', 'tireFront', 'tireRear', 'chain'].filter((k) => v[k]).slice(0, 4);
  if (!items.length) return '';
  return items.map((k) => `<div class="kv"><span class="k">${FIELD[k].label}</span><span class="v">${esc(v[k])}</span></div>`).join('');
}

/** Infokasten zur letzten KI-Recherche */
function aiInfo(meta, cached) {
  if (!meta?.aiAt) return '';
  const sources = (meta.aiSources || []).map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ');
  return `<div class="notice ai-info"><span aria-hidden="true">🤖</span><div>
      <b>KI-Recherche vom ${fmtDate(meta.aiAt)}</b> · Sicherheit: ${esc(meta.aiConfidence || '–')}
      ${meta.aiModel ? `<br><span class="muted small">Modell: ${esc(meta.aiModel)}</span>` : ''}
      ${cached ? ' · aus dem Zwischenspeicher' : ''}
      ${meta.aiNotes ? `<br>${esc(meta.aiNotes)}` : ''}
      ${sources ? `<br><span class="small">Quellen: ${sources}</span>` : ''}
      <br><span class="muted small">Ohne Gewähr – bitte mit dem Handbuch abgleichen.</span>
      ${meta.aiAt ? '<br><button type="button" class="btn btn-sm btn-ghost" data-ai-force>Neu recherchieren</button>' : ''}
    </div></div>`;
}

/**
 * Wartungsdaten ansehen/bearbeiten. autoAi: KI-Recherche sofort starten.
 */
export async function openSpecsForm(bike, { autoAi = false } = {}) {
  const specs = bike.specs || {};
  const v = specs.values || {};
  let aiMeta = specs.aiAt
    ? { aiAt: specs.aiAt, aiConfidence: specs.aiConfidence, aiNotes: specs.aiNotes, aiSources: specs.aiSources, aiModel: specs.aiModel }
    : null;

  const groups = GROUPS.map(([title, keys]) => `<div class="form-sub">${title}</div>
      ${keys.map((k) => field({ label: `${FIELD[k].icon} ${FIELD[k].label}`, name: k, value: v[k] || '', placeholder: FIELD[k].example })).join('')}`).join('');

  const body = `
    <div class="ai-box">
      <p class="small muted">Trag die Daten aus dem Handbuch ein – oder lass sie von der KI im Web recherchieren
        (dauert ca. 30–60 Sekunden). Leere Felder werden ausgefüllt, Abweichungen nur vorgeschlagen.</p>
      <button type="button" class="btn btn-block" data-ai>✨ Mit KI ausfüllen</button>
      <div id="ai-result">${aiInfo(aiMeta)}</div>
    </div>
    ${groups}
    ${field({ label: 'Notizen', name: 'specNotes', type: 'textarea', value: specs.notes || '', placeholder: 'z. B. Drehmomente, Werkstatt, Bezugsquelle' })}`;

  openSheet({
    title: `📋 Wartungsdaten – ${bike.name}`,
    body,
    footer: `<button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>`,
    onOpen: (dlg, form) => {
      const btn = form.querySelector('[data-ai]');
      const box = form.querySelector('#ai-result');

      const runAi = async (force) => {
        if (!bike.brand || !bike.model) {
          toast('Bitte zuerst beim Motorrad (Garage → Bearbeiten) Marke und Modell eintragen.', 'error', 6000);
          return;
        }
        // Anbieter, Schlüssel und Modell aus den Einstellungen (nur auf diesem Gerät gespeichert)
        const ai = { provider: 'openrouter', apiKey: '', model: 'openrouter/free', web: false, ...((await db.getDeviceSettings()).ai || {}) };
        if (ai.provider !== 'anthropic' && !ai.apiKey) {
          const name = ai.provider === 'groq' ? 'Groq' : 'OpenRouter';
          toast(`Trag zuerst deinen ${name}-Schlüssel ein: Einstellungen → 🤖 KI für Wartungsdaten.`, 'error', 7000);
          return;
        }
        btn.disabled = true;
        btn.textContent = '✨ Recherchiere … (bis zu 1 Minute)';
        try {
          const { workerRequest } = await import('./push.js');
          const r = await workerRequest('POST', '/api/ai/specs', {
            brand: bike.brand, model: bike.model, year: bike.year || null, meter: bike.meter || 'km', force,
            provider: ai.provider, apiKey: ai.apiKey, model: ai.model, web: !!ai.web,
          }, { timeout: 150000 });
          let filled = 0;
          let offered = 0;
          form.querySelectorAll('.ai-hint').forEach((h) => h.remove());
          for (const f of SPEC_FIELDS) {
            const val = (r.specs?.[f.key] || '').trim();
            const input = form.elements[f.key];
            if (!val || !input) continue;
            if (!input.value.trim()) {
              input.value = val;
              input.classList.add('ai-filled');
              filled++;
            } else if (norm(input.value) !== norm(val)) {
              // Abweichung: nur anbieten, nicht überschreiben
              const hint = document.createElement('div');
              hint.className = 'ai-hint';
              hint.innerHTML = `KI: <b>${esc(val)}</b> <button type="button" class="btn btn-sm btn-ghost">übernehmen</button>`;
              hint.querySelector('button').addEventListener('click', () => {
                input.value = val;
                input.classList.add('ai-filled');
                hint.remove();
              });
              input.closest('.field').after(hint);
              offered++;
            }
          }
          aiMeta = { aiAt: r.fetchedAt, aiConfidence: r.confidence, aiNotes: r.notes, aiSources: r.sources, aiModel: r.model };
          box.innerHTML = aiInfo(aiMeta, r.cached);
          toast(filled || offered
            ? `${filled} Felder ausgefüllt${offered ? `, ${offered} Abweichungen zum Prüfen` : ''} – bitte kontrollieren und speichern.`
            : 'Die KI hat nichts Neues gefunden.', 'ok', 6000);
        } catch (err) {
          toast(err.message, 'error', 8000);
        } finally {
          btn.disabled = false;
          btn.textContent = '✨ Mit KI ausfüllen';
        }
      };

      btn.addEventListener('click', () => runAi(false));
      box.addEventListener('click', (e) => { if (e.target.closest('[data-ai-force]')) runAi(true); });
      if (autoAi) runAi(false);
    },
    onSubmit: async (form, close) => {
      const values = {};
      for (const f of SPEC_FIELDS) {
        const val = form.elements[f.key].value.trim();
        if (val) values[f.key] = val;
      }
      const fresh = await db.get('bikes', bike.id);
      await db.put('bikes', {
        ...fresh,
        specs: { values, notes: form.elements.specNotes.value.trim(), ...(aiMeta || {}), updatedAt: new Date().toISOString() },
      });
      close();
      toast('Wartungsdaten gespeichert', 'ok');
    },
  });
}

/** „🛒 Teile": was man für eine Wartung braucht – mit Einkaufs-Links */
export async function openPartsSheet(bike, task, title, ivName) {
  const v = specValues(bike);
  const keys = fieldsForTask(task, ivName);
  const parts = [];

  for (const k of keys) {
    if (!v[k]) continue;
    const f = FIELD[k];
    parts.push(`<div class="part">
        <div class="part-head"><span aria-hidden="true">${f.icon}</span> ${f.label}</div>
        <div class="part-val">${esc(v[k])}</div>
        ${f.prefix ? queriesFor(f, v[k], bike).map(shopLinks).join('') : ''}
      </div>`);
  }

  // Zuletzt verwendet laut Logbuch
  const entries = await getEntries(bike.id);
  const pos = task === 'tire-front' ? ['front', 'both'] : task === 'tire-rear' ? ['rear', 'both'] : null;
  const last = task === 'oil' ? entries.find((e) => e.type === 'oil' && e.product)
    : pos ? entries.find((e) => e.type === 'tire' && e.model && pos.includes(e.position)) : null;
  if (last) {
    const what = task === 'oil' ? last.product : last.model;
    const prefix = task === 'oil' ? 'Motoröl' : 'Motorradreifen';
    parts.unshift(`<div class="part">
        <div class="part-head"><span aria-hidden="true">🕘</span> Zuletzt verwendet (${fmtDate(last.date)}${pos ? `, ${POSITIONS[last.position]}` : ''})</div>
        <div class="part-val">${esc(what)}</div>
        ${shopLinks(`${prefix} ${what}`)}
      </div>`);
  }

  for (const q of TASK_EXTRAS[task] || []) {
    parts.push(`<div class="part"><div class="part-head"><span aria-hidden="true">🧴</span> ${esc(q.replace(' Motorrad', ''))}</div>${shopLinks(q)}</div>`);
  }

  const hasSpecs = keys.some((k) => v[k]);
  const body = `${hasSpecs ? '' : `<div class="empty"><div class="e">📋</div>
        <p>Für ${esc(bike.name)} sind noch keine Wartungsdaten eingetragen.</p>
        <div class="stack">
          <button type="button" class="btn btn-primary" data-open-specs="ai">✨ Mit KI recherchieren</button>
          <button type="button" class="btn" data-open-specs="manual">Selbst eintragen</button>
        </div></div>`}
    ${parts.join('')}
    <p class="muted small mt">Angaben ohne Gewähr – vor dem Kauf mit dem Handbuch abgleichen.
      Die Links öffnen die Suche im jeweiligen Shop.</p>
    ${hasSpecs ? '<button type="button" class="btn btn-block btn-ghost" data-open-specs="manual">📋 Wartungsdaten bearbeiten</button>' : ''}`;

  openSheet({
    title: `🛒 ${title}`,
    body,
    onOpen: (dlg, form, close) => {
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-open-specs]');
        if (!b) return;
        close();
        openSpecsForm(bike, { autoAi: b.dataset.openSpecs === 'ai' });
      });
    },
  });
}
