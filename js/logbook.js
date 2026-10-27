// logbook.js – Logbuch: Motorräder (Garage), Tankstopps, Wartungseinträge,
// Verbrauchsberechnung, Statistik und Diagramme (Chart.js).
// Funktioniert komplett offline – alle Daten liegen in IndexedDB (db.js).

import * as db from './db.js';
import {
  esc, fmtNum, fmtEuro, fmtDate, fmtDateShort, fmtMonthYear, MONTHS_SHORT,
  parseDecimal, parseInteger, todayISO, field, switchRow, segInput, setFieldError, clearFieldErrors,
  openSheet, confirmDialog, toast, loadScript, imageToDataURL, ICONS,
} from './ui.js';

export const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';

// Eintragstypen mit Beschriftung und Symbol
export const ENTRY_TYPES = {
  fuel: { label: 'Tanken', icon: '⛽' },
  oil: { label: 'Ölwechsel', icon: '🛢️' },
  tire: { label: 'Reifen', icon: '🛞' },
  chain: { label: 'Kette', icon: '⛓️' },
  brakes: { label: 'Bremsbeläge', icon: '🛑' },
  service: { label: 'Service', icon: '🔧' },
  repair: { label: 'Reparatur', icon: '🛠️' },
  other: { label: 'Sonstiges', icon: '📝' },
};

export const POSITIONS = { front: 'Vorne', rear: 'Hinten', both: 'Beide' };
export const CHAIN_ACTIONS = { clean: 'Reinigen', lube: 'Schmieren', replace: 'Wechseln' };

// Zähler pro Motorrad: Kilometer oder Betriebsstunden (Enduros werden nach Bh gewartet).
// Das Feld "odometer" eines Eintrags enthält den Stand in der Einheit seines Motorrads.
export const METERS = {
  km: {
    label: 'Kilometer',
    short: 'km',
    reading: 'Kilometerstand',
    usage: 'Gefahren',
    usagePer: 'Gefahrene km pro',
    decimals: 0,
    consumption: 'l/100 km',  // Verbrauch = Liter / km × 100
    perFactor: 100,
    costPer: '€/100 km',
    tankLabel: 'Reichweite mit vollem Tank (ca.)',
  },
  h: {
    label: 'Betriebsstunden',
    short: 'Bh',
    reading: 'Betriebsstunden',
    usage: 'Betriebsstunden',
    usagePer: 'Betriebsstunden pro',
    decimals: 1,
    consumption: 'l/h',       // Verbrauch = Liter / Stunden
    perFactor: 1,
    costPer: '€/h',
    tankLabel: 'Laufzeit mit vollem Tank (ca.)',
  },
};

/** Zähler-Einheit eines Motorrads (Standard: Kilometer) */
export function meterOf(bike) {
  return METERS[bike?.meter] || METERS.km;
}

/** Zählerstand oder -differenz formatieren → "12.345 km" bzw. "123,4 Bh" */
export function fmtMeter(value, bike) {
  const m = meterOf(bike);
  return Number.isFinite(value) ? `${fmtNum(value, m.decimals)} ${m.short}` : '–';
}

/** Eingabe eines Zählerstands lesen (km ganzzahlig, Bh mit Kommastelle) */
export function parseMeter(input, bike) {
  return meterOf(bike).decimals ? parseDecimal(input) : parseInteger(input);
}

const SUBVIEWS = { verlauf: 'Verlauf', verbrauch: 'Verbrauch', statistik: 'Statistik', garage: 'Garage' };

// Platzhalter-Texte für die Bezeichnung bei freien Eintragstypen
const TITLE_HINTS = {
  service: 'z. B. Großes Service, 10.000-km-Inspektion',
  repair: 'z. B. Batterie getauscht, Kupplungszug',
  other: 'z. B. Vignette, Versicherung, Zubehör',
};

// ======================================================================
// Datenzugriff
// ======================================================================

export async function getBikes() {
  const bikes = await db.getAll('bikes');
  return bikes.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/** Aktives Motorrad (oder das erste, falls keines gewählt ist) */
export async function getActiveBike() {
  const [bikes, settings] = await Promise.all([getBikes(), db.getSettings()]);
  return bikes.find((b) => b.id === settings.activeBikeId) || bikes[0] || null;
}

export async function setActiveBike(id) {
  await db.saveSettings({ activeBikeId: id });
  window.dispatchEvent(new CustomEvent('bike-changed', { detail: { id } }));
}

/** Einträge eines Motorrads, neueste zuerst */
export async function getEntries(bikeId) {
  if (!bikeId) return [];
  const list = await db.getAllByIndex('entries', 'bikeId', bikeId);
  return list.sort((a, b) =>
    b.date.localeCompare(a.date)
    || (b.odometer ?? 0) - (a.odometer ?? 0)
    || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ======================================================================
// Berechnungen
// ======================================================================

/**
 * Verbrauchsauswertung. Der Verbrauch ist nur zwischen zwei VOLLtankungen korrekt:
 * Liter aller Tankstopps nach der vorigen Volltankung (inkl. Teilbetankungen)
 * geteilt durch die seither gefahrenen Kilometer (→ l/100 km) bzw. Betriebsstunden (→ l/h).
 */
export function calcFuel(entries, bike) {
  const factor = meterOf(bike).perFactor;
  const fuel = entries
    .filter((e) => e.type === 'fuel' && e.liters > 0 && Number.isFinite(e.odometer))
    .sort((a, b) => a.odometer - b.odometer || a.date.localeCompare(b.date));

  const perEntry = new Map(); // Eintrags-ID → Verbrauch (l/100 km bzw. l/h)
  const segments = [];        // abgeschlossene Abschnitte zwischen zwei Volltankungen
  let lastFull = null;
  let liters = 0;
  let cost = 0;

  for (const e of fuel) {
    if (lastFull) {
      liters += e.liters;
      cost += e.cost || 0;
    }
    if (e.full) {
      if (lastFull && e.odometer > lastFull.odometer) {
        const usage = e.odometer - lastFull.odometer; // km bzw. Bh
        const consumption = (liters / usage) * factor;
        perEntry.set(e.id, consumption);
        segments.push({ date: e.date, usage, liters, cost, consumption });
      }
      lastFull = e;
      liters = 0;
      cost = 0;
    }
  }

  const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
  const allFuel = entries.filter((e) => e.type === 'fuel' && e.liters > 0);
  const priced = allFuel.filter((e) => e.cost > 0);
  const segUsage = sum(segments, (s) => s.usage);

  return {
    count: allFuel.length,
    perEntry,
    segments,
    totalLiters: sum(allFuel, (e) => e.liters),
    totalCost: sum(allFuel, (e) => e.cost || 0),
    avgConsumption: segUsage ? (sum(segments, (s) => s.liters) / segUsage) * factor : null,
    lastConsumption: segments.length ? segments[segments.length - 1].consumption : null,
    avgPricePerLiter: priced.length ? sum(priced, (e) => e.cost) / sum(priced, (e) => e.liters) : null,
    fuelCostPerUnit: segUsage ? sum(segments, (s) => s.cost) / segUsage : null, // € pro km bzw. Bh
  };
}

/** Alle bekannten Zählerstände (Datum + km bzw. Bh), chronologisch */
export function odometerReadings(entries, bike) {
  const readings = entries
    .filter((e) => Number.isFinite(e.odometer))
    .map((e) => ({ date: e.date, odo: e.odometer }));
  if (bike && Number.isFinite(bike.odometer) && bike.odometerDate) {
    readings.push({ date: bike.odometerDate, odo: bike.odometer });
  }
  return readings.sort((a, b) => a.date.localeCompare(b.date) || a.odo - b.odo);
}

/** Aktueller (höchster bekannter) Zählerstand */
export function currentOdometer(entries, bike) {
  const readings = odometerReadings(entries, bike);
  return readings.length ? Math.max(...readings.map((r) => r.odo)) : null;
}

/**
 * Gefahrene km bzw. gelaufene Bh in einem Zeitraum [start, end] (ISO-Daten, inklusive).
 * Ausgangspunkt ist der letzte Stand VOR dem Zeitraum, sonst der erste darin.
 */
export function usageInRange(readings, start, end) {
  let before = null;
  let first = null;
  let max = null;
  for (const r of readings) {
    if (r.date < start) before = before == null ? r.odo : Math.max(before, r.odo);
    else if (r.date <= end) {
      if (first == null) first = r.odo;
      max = max == null ? r.odo : Math.max(max, r.odo);
    }
  }
  if (max == null) return 0;
  return Math.max(0, max - (before ?? first));
}

/** Kurzer Titel eines Eintrags für Listen */
export function entryTitle(e) {
  const type = ENTRY_TYPES[e.type] || ENTRY_TYPES.other;
  switch (e.type) {
    case 'fuel':
      return `Tanken · ${fmtNum(e.liters, 2)} l${e.full ? '' : ' (Teil)'}`;
    case 'oil':
      return `Ölwechsel${e.oilFilter ? ' + Filter' : ''}${e.product ? ` · ${e.product}` : ''}`;
    case 'tire':
      return `Reifen ${POSITIONS[e.position] ? POSITIONS[e.position].toLowerCase() : ''}${e.model ? ` · ${e.model}` : ''}`;
    case 'chain': {
      const actions = (e.actions || []).map((a) => CHAIN_ACTIONS[a]?.toLowerCase()).filter(Boolean);
      return `Kette${actions.length ? `: ${actions.join(', ')}` : ''}`;
    }
    case 'brakes':
      return `Bremsbeläge ${POSITIONS[e.position] ? POSITIONS[e.position].toLowerCase() : ''}`;
    default:
      return e.title || type.label;
  }
}

/** Summe je Schlüssel, z. B. Kosten pro Monat */
function sumBy(list, keyFn, valueFn) {
  const map = new Map();
  for (const x of list) {
    const k = keyFn(x);
    map.set(k, (map.get(k) || 0) + valueFn(x));
  }
  return map;
}

/** Die letzten n Monate als [{ key: 'YYYY-MM', label: 'Okt 26' }] */
function lastMonths(n) {
  const now = new Date();
  const result = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
    });
  }
  return result;
}

// ======================================================================
// Ansicht
// ======================================================================

let root = null;
const state = { sub: 'verlauf', filter: 'all', year: null };
let ctx = { bikes: [], bike: null, entries: [], fuel: null };
let charts = [];

/** Einmalig beim ersten Öffnen des Tabs */
export function init(el) {
  root = el;
  root.addEventListener('click', onClick);
}

/** Bei jedem Öffnen des Tabs (sub = Unteransicht aus der URL, z. B. #logbuch/statistik) */
export async function show(sub) {
  if (sub && SUBVIEWS[sub]) state.sub = sub;
  await render();
}

let renderSeq = 0; // verhindert, dass sich zwei gleichzeitige Renders in die Quere kommen

async function render() {
  const seq = ++renderSeq;
  const bikes = await getBikes();
  const bike = await getActiveBike();
  const entries = bike ? await getEntries(bike.id) : [];
  if (seq !== renderSeq) return;
  destroyCharts();
  ctx = { bikes, bike, entries, fuel: calcFuel(entries, bike) };

  const nav = `<nav class="subnav" aria-label="Logbuch-Bereiche">${Object.entries(SUBVIEWS).map(([key, label]) =>
    `<a href="#logbuch/${key}" class="${state.sub === key ? 'active' : ''}" ${state.sub === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;

  if (!bikes.length && state.sub !== 'garage') {
    root.innerHTML = `${nav}
      <div class="empty">
        <div class="e">🏍️</div>
        <h3>Willkommen!</h3>
        <p>Lege zuerst dein Motorrad an. Danach kannst du Tankstopps, Ölwechsel, Reifen &amp; Co. eintragen.</p>
        <button type="button" class="btn btn-primary" data-action="new-bike">${ICONS.plus} Motorrad anlegen</button>
      </div>`;
    return;
  }

  const chartDefs = [];
  let body = '';
  if (state.sub === 'verlauf') body = renderVerlauf();
  if (state.sub === 'verbrauch') body = renderVerbrauch(chartDefs);
  if (state.sub === 'statistik') body = renderStatistik(chartDefs);
  if (state.sub === 'garage') body = renderGarage();

  const fab = state.sub === 'garage' || !bike ? '' : `<button type="button" class="fab" data-action="new-entry"
      ${state.sub === 'verbrauch' ? 'data-type="fuel"' : ''} aria-label="Neuer Eintrag">${ICONS.plus}</button>`;

  root.innerHTML = nav + body + fab;
  await drawCharts(chartDefs, seq);
}

// ---------- Verlauf ----------

function renderVerlauf() {
  const { entries, fuel } = ctx;
  if (!entries.length) {
    return `<div class="empty">
      <div class="e">📒</div>
      <h3>Noch keine Einträge</h3>
      <p>Tippe auf <strong>+</strong>, um deinen ersten Tankstopp oder eine Wartung einzutragen.</p>
    </div>`;
  }

  // Filter-Chips nur für Typen, die auch vorkommen
  const present = new Set(entries.map((e) => e.type));
  if (state.filter !== 'all' && !present.has(state.filter)) state.filter = 'all';
  const chips = `<div class="chips" role="toolbar" aria-label="Nach Typ filtern">
    <button type="button" class="chip ${state.filter === 'all' ? 'active' : ''}" data-action="filter" data-type="all">Alle</button>
    ${Object.entries(ENTRY_TYPES).filter(([k]) => present.has(k)).map(([k, t]) =>
      `<button type="button" class="chip ${state.filter === k ? 'active' : ''}" data-action="filter" data-type="${k}">${t.icon} ${t.label}</button>`).join('')}
  </div>`;

  const list = state.filter === 'all' ? entries : entries.filter((e) => e.type === state.filter);
  let html = '';
  let month = '';
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (m !== month) {
      month = m;
      html += `<div class="list-head">${fmtMonthYear(`${m}-01`)}</div>`;
    }
    const sub = [fmtDate(e.date)];
    if (Number.isFinite(e.odometer)) sub.push(fmtMeter(e.odometer, ctx.bike));
    if (fuel.perEntry.has(e.id)) sub.push(`${fmtNum(fuel.perEntry.get(e.id), 1)} ${meterOf(ctx.bike).consumption}`);
    const pricePerLiter = e.type === 'fuel' && e.cost > 0 && e.liters > 0
      ? `<small>${fmtNum(e.cost / e.liters, 3)} €/l</small>` : '';
    html += `<button type="button" class="item" data-action="edit-entry" data-id="${esc(e.id)}">
      <span class="ico" aria-hidden="true">${(ENTRY_TYPES[e.type] || ENTRY_TYPES.other).icon}</span>
      <span class="main"><span class="t">${esc(entryTitle(e))}</span><span class="s">${sub.map((s) => `<span class="nw">${s}</span>`).join(' · ')}</span></span>
      <span class="amt">${e.cost ? fmtEuro(e.cost) : ''}${pricePerLiter}</span>
    </button>`;
  }
  return `${chips}<div class="list">${html}</div>`;
}

// ---------- Verbrauch ----------

function renderVerbrauch(chartDefs) {
  const { bike, fuel, entries } = ctx;
  const m = meterOf(bike);
  if (!fuel.count) {
    return `<div class="empty">
      <div class="e">⛽</div>
      <h3>Noch keine Tankstopps</h3>
      <p>Trage beim Tanken ${m.reading}, Liter und Preis ein – die App rechnet Verbrauch und Kosten aus.</p>
      <button type="button" class="btn btn-primary" data-action="new-entry" data-type="fuel">${ICONS.plus} Tankstopp eintragen</button>
    </div>`;
  }

  // Reichweite (km) bzw. Laufzeit (Bh) mit einer Tankfüllung
  const range = bike?.tankVolume && fuel.avgConsumption ? (bike.tankVolume / fuel.avgConsumption) * m.perFactor : null;
  const kpi = (label, value, unit = '', wide = false) =>
    `<div class="kpi ${wide ? 'wide' : ''}"><div class="l">${label}</div><div class="v">${value}<span class="u">${unit}</span></div></div>`;

  let html = `<div class="kpis">
    ${kpi('Ø Verbrauch', fmtNum(fuel.avgConsumption, 1), m.consumption)}
    ${kpi('Zuletzt', fmtNum(fuel.lastConsumption, 1), m.consumption)}
    ${kpi('Ø Preis', fmtNum(fuel.avgPricePerLiter, 3), '€/l')}
    ${kpi('Spritkosten', fmtNum(fuel.fuelCostPerUnit != null ? fuel.fuelCostPerUnit * m.perFactor : null, 2), m.costPer)}
    ${kpi('Getankt gesamt', fmtNum(fuel.totalLiters, 1), 'l')}
    ${kpi('Tankstopps', fmtNum(fuel.count), `· ${fmtEuro(fuel.totalCost)}`)}
    ${range ? kpi(m.tankLabel, fmtNum(range, m.decimals), m.short, true) : ''}
  </div>`;

  if (!fuel.segments.length) {
    html += `<div class="card"><p class="muted">Für den Verbrauch braucht es mindestens <strong>zwei Volltankungen</strong>.
      Teilbetankungen dazwischen werden automatisch mitgerechnet.</p></div>`;
  } else {
    html += `<div class="card"><h3>Verbrauch (${m.consumption})</h3><div class="chart-box"><canvas id="chart-consumption"></canvas></div></div>`;
    const segs = fuel.segments;
    chartDefs.push({
      id: 'chart-consumption',
      config: {
        type: 'line',
        data: {
          labels: segs.map((s) => fmtDateShort(s.date) + s.date.slice(2, 4)),
          datasets: [{
            label: m.consumption,
            data: segs.map((s) => Math.round(s.consumption * 100) / 100),
            borderColor: '#ff9a1f',
            backgroundColor: 'rgba(255,154,31,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
          }],
        },
        options: {
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => `${fmtNum(c.parsed.y, 1)} ${m.consumption}` } },
          },
          scales: { y: { ticks: { callback: (v) => fmtNum(v, 1) } } },
        },
      },
    });
  }

  // Tankkosten der letzten 12 Monate
  const months = lastMonths(12);
  const fuelByMonth = sumBy(entries.filter((e) => e.type === 'fuel'), (e) => e.date.slice(0, 7), (e) => e.cost || 0);
  html += `<div class="card"><h3>Tankkosten pro Monat</h3><div class="chart-box"><canvas id="chart-fuelcost"></canvas></div></div>`;
  chartDefs.push({
    id: 'chart-fuelcost',
    config: {
      type: 'bar',
      data: {
        labels: months.map((m) => m.label),
        datasets: [{
          label: 'Tankkosten',
          data: months.map((m) => Math.round((fuelByMonth.get(m.key) || 0) * 100) / 100),
          backgroundColor: '#ff9a1f',
          borderRadius: 6,
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => fmtEuro(c.parsed.y) } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${fmtNum(v)} €` } } },
      },
    },
  });

  html += `<p class="muted small">Der Verbrauch wird nur zwischen zwei Volltankungen berechnet. Vergiss keinen Tankstopp,
    sonst stimmt der Wert für diesen Abschnitt nicht.</p>`;
  return html;
}

// ---------- Statistik ----------

function renderStatistik(chartDefs) {
  const { bike, entries } = ctx;
  const unit = meterOf(bike);
  if (!entries.length) {
    return `<div class="empty"><div class="e">📊</div><h3>Noch keine Daten</h3>
      <p>Sobald du Einträge mit ${unit.reading} hast, siehst du hier ${unit === METERS.h ? 'Betriebsstunden' : 'gefahrene Kilometer'} und Kosten.</p></div>`;
  }

  const readings = odometerReadings(entries, bike);
  const years = [...new Set(entries.map((e) => e.date.slice(0, 4)))].sort().reverse();
  const thisYear = String(new Date().getFullYear());
  if (!state.year || (state.year !== 'all' && !years.includes(state.year))) {
    state.year = years.includes(thisYear) ? thisYear : years[0];
  }
  const all = state.year === 'all';

  const chips = `<div class="chips" role="toolbar" aria-label="Zeitraum">
    ${years.map((y) => `<button type="button" class="chip ${state.year === y ? 'active' : ''}" data-action="year" data-year="${y}">${y}</button>`).join('')}
    <button type="button" class="chip ${all ? 'active' : ''}" data-action="year" data-year="all">Gesamt</button>
  </div>`;

  const inPeriod = all ? entries : entries.filter((e) => e.date.startsWith(state.year));
  // Gefahrene km bzw. gelaufene Betriebsstunden im Zeitraum
  const usage = all
    ? (readings.length ? readings[readings.length - 1].odo - readings[0].odo : 0)
    : usageInRange(readings, `${state.year}-01-01`, `${state.year}-12-31`);
  const totalCost = inPeriod.reduce((s, e) => s + (e.cost || 0), 0);
  const fuelCost = inPeriod.filter((e) => e.type === 'fuel').reduce((s, e) => s + (e.cost || 0), 0);

  const kpi = (label, value, suffix = '') =>
    `<div class="kpi"><div class="l">${label}</div><div class="v">${value}<span class="u">${suffix}</span></div></div>`;
  let html = chips + `<div class="kpis">
    ${kpi(unit.usage, fmtNum(usage, unit.decimals), unit.short)}
    ${kpi('Gesamtkosten', fmtEuro(totalCost))}
    ${kpi(`Kosten pro ${unit.short}`, usage ? fmtNum(totalCost / usage, 2) : '–', '€')}
    ${kpi('davon Sprit', fmtEuro(fuelCost))}
  </div>`;

  // km bzw. Bh pro Monat (Jahr) oder pro Jahr (Gesamt)
  const round = (v) => Math.round(v * 10 ** unit.decimals) / 10 ** unit.decimals;
  let labels;
  let values;
  if (all) {
    const ys = [...years].reverse();
    labels = ys;
    values = ys.map((y) => round(usageInRange(readings, `${y}-01-01`, `${y}-12-31`)));
  } else {
    labels = MONTHS_SHORT;
    values = MONTHS_SHORT.map((_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return round(usageInRange(readings, `${state.year}-${mm}-01`, `${state.year}-${mm}-31`));
    });
  }
  html += `<div class="card"><h3>${unit.usagePer} ${all ? 'Jahr' : 'Monat'}</h3>
    <div class="chart-box"><canvas id="chart-usage"></canvas></div></div>`;
  chartDefs.push({
    id: 'chart-usage',
    config: {
      type: 'bar',
      data: { labels, datasets: [{ label: unit.short, data: values, backgroundColor: '#2fbf71', borderRadius: 6 }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtMeter(c.parsed.y, bike) } } },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmtNum(v) } } },
      },
    },
  });

  // Kosten aufgeschlüsselt nach Typ
  const byType = [...sumBy(inPeriod, (e) => e.type, (e) => e.cost || 0)]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  html += `<div class="card"><h3>Kosten nach Art</h3>`;
  if (!byType.length) {
    html += `<p class="muted">Keine Kosten im gewählten Zeitraum.</p>`;
  } else {
    html += `<div class="bars">${byType.map(([type, value]) => {
      const t = ENTRY_TYPES[type] || ENTRY_TYPES.other;
      const pct = totalCost ? (value / totalCost) * 100 : 0;
      return `<div class="bar-row">
        <span>${t.icon} ${t.label} <span class="muted small">${fmtNum(pct)} %</span></span>
        <span class="amt">${fmtEuro(value)}</span>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>`;
    }).join('')}</div>`;
  }
  html += `</div>`;

  // Jahresübersicht
  if (all) {
    html += `<div class="card"><h3>Jahresübersicht</h3><table class="tbl">
      <thead><tr><th>Jahr</th><th>${unit.short}</th><th>Kosten</th><th>€/${unit.short}</th></tr></thead><tbody>
      ${years.map((y) => {
        const u = usageInRange(readings, `${y}-01-01`, `${y}-12-31`);
        const c = entries.filter((e) => e.date.startsWith(y)).reduce((s, e) => s + (e.cost || 0), 0);
        return `<tr><td>${y}</td><td>${fmtNum(u, unit.decimals)}</td><td>${fmtEuro(c)}</td><td>${u ? fmtNum(c / u, 2) : '–'}</td></tr>`;
      }).join('')}
      </tbody></table></div>`;
  }

  html += `<p class="muted small">${unit === METERS.h ? 'Die Betriebsstunden' : 'Die gefahrenen Kilometer'} werden aus den
    Zählerständen (${unit.reading}) aller Einträge berechnet.</p>`;
  return html;
}

// ---------- Garage (Motorräder) ----------

function renderGarage() {
  const { bikes, bike: active } = ctx;
  const cards = bikes.map((b) => {
    const isActive = active && b.id === active.id;
    const meta = [b.brand, b.model].filter(Boolean).join(' ');
    return `<div class="card">
      <div class="bike">
        <div class="photo" ${b.photo ? `style="background-image:url('${b.photo}')"` : ''}>${b.photo ? '' : '🏍️'}</div>
        <div>
          <div class="name">${esc(b.name)} ${isActive ? '<span class="badge">Aktiv</span>' : ''}</div>
          <div class="meta">${esc(meta)}${b.year ? ` · Bj. ${esc(b.year)}` : ''}${b.tankVolume ? ` · ${fmtNum(b.tankVolume, 1)} l Tank` : ''}
            · Zähler: ${meterOf(b).label}</div>
          ${b.plate ? `<div class="plate"><span>${esc(b.plate)}</span></div>` : ''}
        </div>
      </div>
      <div class="row mt">
        ${isActive ? '' : `<button type="button" class="btn btn-sm btn-primary" data-action="activate-bike" data-id="${esc(b.id)}">${ICONS.check} Aktiv setzen</button>`}
        <button type="button" class="btn btn-sm" data-action="edit-bike" data-id="${esc(b.id)}">${ICONS.edit} Bearbeiten</button>
        <button type="button" class="btn btn-sm" data-action="bike-specs" data-id="${esc(b.id)}">📋 Wartungsdaten</button>
      </div>
    </div>`;
  }).join('');

  return `${cards || '<p class="muted">Noch keine Motorräder angelegt.</p>'}
    <button type="button" class="btn btn-block ${bikes.length ? '' : 'btn-primary'}" data-action="new-bike">${ICONS.plus} Motorrad hinzufügen</button>`;
}

// ---------- Diagramme ----------

function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

async function drawCharts(defs, seq) {
  if (!defs.length) return;
  try {
    await loadScript(CHART_JS_URL);
  } catch (err) {
    for (const d of defs) {
      const box = document.getElementById(d.id)?.parentElement;
      if (box) box.innerHTML = `<p class="muted">Diagramm nicht verfügbar: ${esc(err.message)}</p>`;
    }
    return;
  }
  if (seq !== renderSeq) return; // inzwischen neu gerendert
  applyChartTheme();
  for (const d of defs) {
    const canvas = document.getElementById(d.id);
    if (canvas?.isConnected) charts.push(new window.Chart(canvas, d.config));
  }
}

function applyChartTheme() {
  const C = window.Chart;
  C.defaults.color = '#9aa4b2';
  C.defaults.borderColor = 'rgba(255,255,255,0.08)';
  C.defaults.font.family = getComputedStyle(document.body).fontFamily;
  C.defaults.font.size = 13;
  C.defaults.maintainAspectRatio = false;
  C.defaults.locale = 'de-DE';
}

// ======================================================================
// Interaktion
// ======================================================================

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, type, year } = el.dataset;
  switch (action) {
    case 'new-entry':
      if (type) openEntryForm(type);
      else openTypePicker();
      break;
    case 'edit-entry': {
      const entry = ctx.entries.find((x) => x.id === id);
      if (entry) openEntryForm(entry.type, entry);
      break;
    }
    case 'filter':
      state.filter = type;
      await render();
      break;
    case 'year':
      state.year = year;
      await render();
      break;
    case 'new-bike':
      openBikeForm();
      break;
    case 'edit-bike':
      openBikeForm(ctx.bikes.find((b) => b.id === id));
      break;
    case 'bike-specs': {
      // dynamisch geladen: specs.js nutzt selbst Funktionen aus diesem Modul
      const { openSpecsForm } = await import('./specs.js');
      openSpecsForm(ctx.bikes.find((b) => b.id === id));
      break;
    }
    case 'activate-bike':
      await setActiveBike(id);
      toast('Aktives Motorrad gewechselt', 'ok');
      await render();
      break;
    default:
  }
}

/** Auswahl des Eintragstyps (Tanken groß, weil am häufigsten) */
export function openTypePicker() {
  const buttons = Object.entries(ENTRY_TYPES).map(([key, t]) =>
    `<button type="button" class="type-btn ${key === 'fuel' ? 'big' : ''}" data-type="${key}">
      <span class="e" aria-hidden="true">${t.icon}</span><span>${t.label}</span></button>`).join('');
  openSheet({
    title: 'Neuer Eintrag',
    body: `<div class="type-grid">${buttons}</div>`,
    onOpen: (dlg, form, close) => {
      dlg.addEventListener('click', (e) => {
        const btn = e.target.closest('.type-btn');
        if (!btn) return;
        close();
        openEntryForm(btn.dataset.type);
      });
    },
  });
}

/**
 * Formular für einen Logbuch-Eintrag (neu oder bearbeiten).
 * preset: optionale Vorbelegung für neue Einträge (z. B. aus dem Service-Tab)
 */
export async function openEntryForm(type, entry = null, preset = {}) {
  const bike = await getActiveBike();
  if (!bike) {
    toast('Bitte zuerst ein Motorrad anlegen.', 'error');
    return;
  }
  const entries = await getEntries(bike.id);
  const e = entry || { type, date: todayISO(), full: true, ...preset };
  const t = ENTRY_TYPES[type] || ENTRY_TYPES.other;
  const lastOdo = currentOdometer(entries.filter((x) => x.id !== e.id), bike);
  const dec = (v, d = 2) => (Number.isFinite(v) ? fmtNum(v, d) : '');
  const unit = meterOf(bike);

  let specific = '';
  if (type === 'fuel') {
    specific = `<div class="grid2">
        ${field({ label: 'Liter', name: 'liters', inputmode: 'decimal', value: dec(e.liters), placeholder: '0,00', required: true })}
        ${field({ label: 'Preis gesamt (€)', name: 'cost', inputmode: 'decimal', value: dec(e.cost), placeholder: '0,00' })}
      </div>
      <div class="calc-line" id="ppl" hidden></div>
      ${switchRow({ label: 'Voll getankt', name: 'full', checked: e.full !== false, hint: 'Nur dann kann der Verbrauch berechnet werden' })}`;
  } else if (type === 'oil') {
    specific = `${switchRow({ label: 'Ölfilter gewechselt', name: 'oilFilter', checked: !!e.oilFilter })}
      ${field({ label: 'Öl (Marke / Viskosität)', name: 'product', value: e.product || '', placeholder: 'z. B. 10W-40 teilsynthetisch' })}`;
  } else if (type === 'tire') {
    specific = `${segInput({ label: 'Position', name: 'position', options: POSITIONS, value: e.position || 'rear' })}
      ${field({ label: 'Reifenmodell', name: 'model', value: e.model || '', placeholder: 'z. B. Michelin Road 6' })}`;
  } else if (type === 'chain') {
    specific = segInput({ label: 'Was wurde gemacht?', name: 'actions', options: CHAIN_ACTIONS, value: e.actions || ['clean', 'lube'], multi: true });
  } else if (type === 'brakes') {
    specific = segInput({ label: 'Position', name: 'position', options: POSITIONS, value: e.position || 'front' });
  } else {
    specific = field({ label: 'Bezeichnung', name: 'title', value: e.title || '', placeholder: TITLE_HINTS[type] || '' });
  }

  const body = `
    <div class="grid2">
      ${field({ label: 'Datum', name: 'date', type: 'date', value: e.date, required: true })}
      ${field({
        label: unit.reading, name: 'odometer', inputmode: unit.decimals ? 'decimal' : 'numeric',
        value: dec(e.odometer, unit.decimals),
        placeholder: lastOdo ? fmtNum(lastOdo, unit.decimals) : unit.short, required: type === 'fuel',
        hint: lastOdo ? `zuletzt ${fmtMeter(lastOdo, bike)}` : '',
      })}
    </div>
    ${specific}
    ${type === 'fuel' ? '' : field({ label: 'Kosten (€)', name: 'cost', inputmode: 'decimal', value: dec(e.cost), placeholder: '0,00' })}
    ${field({ label: 'Notiz', name: 'note', type: 'textarea', value: e.note || '', placeholder: 'optional' })}`;

  const footer = `${entry ? `<button type="button" class="btn btn-danger-ghost" data-delete aria-label="Eintrag löschen">${ICONS.trash}</button>` : ''}
    <button type="button" class="btn" data-close>Abbrechen</button>
    <button type="submit" class="btn btn-primary">Speichern</button>`;

  openSheet({
    title: `${t.icon} ${entry ? `${t.label} bearbeiten` : t.label}`,
    body,
    footer,
    onOpen: (dlg, form, close) => {
      // Live-Anzeige Preis pro Liter
      if (type === 'fuel') {
        const update = () => {
          const l = parseDecimal(form.elements.liters.value);
          const c = parseDecimal(form.elements.cost.value);
          const box = form.querySelector('#ppl');
          box.hidden = !(l > 0 && c > 0);
          if (!box.hidden) box.textContent = `= ${fmtNum(c / l, 3)} €/l`;
        };
        form.elements.liters.addEventListener('input', update);
        form.elements.cost.addEventListener('input', update);
        update();
      }
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await confirmDialog(`${entryTitle(entry)} vom ${fmtDate(entry.date)} wirklich löschen?`, { ok: 'Löschen', danger: true })) return;
        await db.remove('entries', entry.id);
        close();
        toast('Eintrag gelöscht', 'ok');
        if (root) await render();
      });
    },
    onSubmit: async (form, close) => {
      clearFieldErrors(form);
      const f = form.elements;
      let ok = true;
      const fail = (name, msg) => { setFieldError(form, name, msg); ok = false; };

      const date = f.date.value;
      if (!date) fail('date', 'Bitte ein Datum wählen.');
      const odometer = parseMeter(f.odometer.value, bike);
      if (Number.isNaN(odometer) || odometer < 0) fail('odometer', `Bitte eine gültige Zahl eingeben, z. B. ${unit.decimals ? '123,5' : '12.345'}`);
      else if (type === 'fuel' && odometer == null) fail('odometer', `Für die Verbrauchsberechnung wird der Stand (${unit.label}) benötigt.`);
      const cost = parseDecimal(f.cost.value);
      if (Number.isNaN(cost) || cost < 0) fail('cost', 'Bitte einen gültigen Betrag eingeben, z. B. 24,90');

      const data = {
        id: e.id || db.uid(),
        bikeId: bike.id,
        type,
        date,
        odometer,
        cost: cost ?? null,
        note: f.note.value.trim(),
        createdAt: e.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (type === 'fuel') {
        const liters = parseDecimal(f.liters.value);
        if (!(liters > 0)) fail('liters', 'Bitte die getankten Liter eingeben, z. B. 12,5');
        data.liters = liters;
        data.full = f.full.checked;
      } else if (type === 'oil') {
        data.oilFilter = f.oilFilter.checked;
        data.product = f.product.value.trim();
      } else if (type === 'tire') {
        data.position = form.querySelector('[name="position"]:checked')?.value || 'rear';
        data.model = f.model.value.trim();
      } else if (type === 'chain') {
        data.actions = [...form.querySelectorAll('[name="actions"]:checked')].map((x) => x.value);
        if (!data.actions.length) fail('actions', 'Bitte mindestens eine Tätigkeit wählen.');
      } else if (type === 'brakes') {
        data.position = form.querySelector('[name="position"]:checked')?.value || 'front';
      } else {
        data.title = f.title.value.trim();
      }
      if (!ok) return;

      // Plausibilität: passt der Zählerstand zu den anderen Einträgen?
      if (odometer != null) {
        // entries ist absteigend sortiert → erster Treffer = zeitlich nächster Widerspruch
        const others = entries.filter((x) => x.id !== data.id && Number.isFinite(x.odometer));
        const conflict = others.find((x) => x.date < date && x.odometer > odometer)
          || [...others].reverse().find((x) => x.date > date && x.odometer < odometer);
        if (conflict && !await confirmDialog(
          `Der Stand ${fmtMeter(odometer, bike)} passt nicht zum Eintrag vom ${fmtDate(conflict.date)} (${fmtMeter(conflict.odometer, bike)}).\nTrotzdem speichern?`,
          { title: `${unit.reading} prüfen`, ok: 'Speichern' },
        )) return;
      }
      if (type === 'fuel' && bike.tankVolume && data.liters > bike.tankVolume * 1.05) {
        if (!await confirmDialog(
          `${fmtNum(data.liters, 2)} l ist mehr als das Tankvolumen (${fmtNum(bike.tankVolume, 1)} l).\nTrotzdem speichern?`,
          { title: 'Liter prüfen', ok: 'Speichern' },
        )) return;
      }

      await db.put('entries', data);
      close();
      toast(entry ? 'Eintrag gespeichert' : `${t.label} eingetragen`, 'ok');
      if (root) await render();
    },
  });
}

/** Formular für ein Motorrad (neu oder bearbeiten) */
export async function openBikeForm(bike = null) {
  const b = bike || {};
  const body = `
    ${field({ label: 'Name', name: 'name', value: b.name || '', placeholder: 'z. B. Meine Tracer', required: true })}
    <div class="grid2">
      ${field({ label: 'Marke', name: 'brand', value: b.brand || '', placeholder: 'z. B. Yamaha' })}
      ${field({ label: 'Modell', name: 'model', value: b.model || '', placeholder: 'z. B. Tracer 9' })}
      ${field({ label: 'Baujahr', name: 'year', inputmode: 'numeric', value: b.year || '', placeholder: 'z. B. 2021' })}
      ${field({ label: 'Tankvolumen (l)', name: 'tankVolume', inputmode: 'decimal', value: b.tankVolume ? fmtNum(b.tankVolume, 1) : '', placeholder: 'z. B. 18' })}
    </div>
    ${field({ label: 'Kennzeichen', name: 'plate', value: b.plate || '', placeholder: 'z. B. W-12345X', attrs: 'autocapitalize="characters"' })}
    ${segInput({ label: 'Zähler', name: 'meter', options: { km: 'Kilometer', h: 'Betriebsstunden' }, value: b.meter || 'km' })}
    <p class="muted small" style="margin-top:-6px">${'Enduros und Crosser werden meist nach Betriebsstunden (Bh) gewartet – '
      + 'dann gibst du überall Bh statt km ein, der Verbrauch wird in l/h berechnet.'}</p>
    <div class="field">
      <span class="lbl">Foto (optional)</span>
      <div class="bike">
        <div class="photo" id="photo-preview">${b.photo ? '' : '🏍️'}</div>
        <div class="row">
          <label class="btn btn-sm">📷 Foto wählen<input type="file" accept="image/*" id="photo-input" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost" id="photo-remove" ${b.photo ? '' : 'hidden'}>Entfernen</button>
        </div>
      </div>
    </div>`;

  const footer = `${bike ? `<button type="button" class="btn btn-danger-ghost" data-delete aria-label="Motorrad löschen">${ICONS.trash}</button>` : ''}
    <button type="button" class="btn" data-close>Abbrechen</button>
    <button type="submit" class="btn btn-primary">Speichern</button>`;

  let photo = b.photo || null;

  openSheet({
    title: bike ? 'Motorrad bearbeiten' : 'Neues Motorrad',
    body,
    footer,
    onOpen: (dlg, form, close) => {
      const preview = form.querySelector('#photo-preview');
      const removeBtn = form.querySelector('#photo-remove');
      const showPhoto = () => {
        preview.style.backgroundImage = photo ? `url('${photo}')` : '';
        preview.textContent = photo ? '' : '🏍️';
        removeBtn.hidden = !photo;
      };
      showPhoto();
      form.querySelector('#photo-input').addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          photo = await imageToDataURL(file);
          showPhoto();
        } catch {
          toast('Das Foto konnte nicht gelesen werden.', 'error');
        }
      });
      removeBtn.addEventListener('click', () => { photo = null; showPhoto(); });

      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        const count = (await getEntries(bike.id)).length;
        if (!await confirmDialog(
          `„${bike.name}" und ${count === 1 ? 'einen Eintrag' : `alle ${count} Einträge`} endgültig löschen?\nTipp: Vorher in den Einstellungen ein Backup machen.`,
          { ok: 'Endgültig löschen', danger: true },
        )) return;
        await db.removeByIndex('entries', 'bikeId', bike.id);
        await db.removeByIndex('intervals', 'bikeId', bike.id);
        await db.remove('bikes', bike.id);
        const settings = await db.getSettings();
        if (settings.activeBikeId === bike.id) {
          const rest = await getBikes();
          await setActiveBike(rest[0]?.id || null);
        }
        close();
        toast('Motorrad gelöscht', 'ok');
        if (root) await render();
      });
    },
    onSubmit: async (form, close) => {
      clearFieldErrors(form);
      const f = form.elements;
      const name = f.name.value.trim();
      if (!name) { setFieldError(form, 'name', 'Bitte einen Namen eingeben.'); return; }
      const tankVolume = parseDecimal(f.tankVolume.value);
      if (Number.isNaN(tankVolume)) { setFieldError(form, 'tankVolume', 'Bitte eine Zahl eingeben, z. B. 17,5'); return; }
      const year = parseInteger(f.year.value);
      const meter = form.querySelector('[name="meter"]:checked')?.value || 'km';

      // Zähler bei vorhandenen Einträgen umstellen? Die Zahlen bleiben gleich, nur die Einheit ändert sich.
      if (bike && (bike.meter || 'km') !== meter) {
        const count = (await getEntries(bike.id)).filter((x) => Number.isFinite(x.odometer)).length;
        if (count && !await confirmDialog(
          `${count} Einträge haben schon einen Stand in ${meterOf(bike).label}. Nach dem Umstellen werden diese Zahlen `
          + `als ${METERS[meter].label} gelesen.\nNur umstellen, wenn sie eigentlich schon ${METERS[meter].label} sind.`,
          { title: 'Zähler umstellen?', ok: 'Umstellen' },
        )) return;
      }

      const data = {
        ...b,
        id: b.id || db.uid(),
        name,
        brand: f.brand.value.trim(),
        model: f.model.value.trim(),
        year: year || null,
        plate: f.plate.value.trim().toUpperCase(),
        tankVolume: tankVolume || null,
        meter,
        photo,
        createdAt: b.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.put('bikes', data);

      // Erstes Motorrad automatisch aktiv setzen
      const settings = await db.getSettings();
      const bikes = await getBikes();
      if (!settings.activeBikeId || !bikes.some((x) => x.id === settings.activeBikeId)) {
        await setActiveBike(data.id);
      }
      close();
      toast(bike ? 'Motorrad gespeichert' : 'Motorrad angelegt', 'ok');
      if (root) await render();
    },
  });
}

/** Auswahl des aktiven Motorrads (aus der Kopfzeile) */
export async function openBikePicker() {
  const [bikes, active] = await Promise.all([getBikes(), getActiveBike()]);
  const items = bikes.map((b) => `<button type="button" class="item" data-pick="${esc(b.id)}">
      <span class="ico" aria-hidden="true">🏍️</span>
      <span class="main"><span class="t">${esc(b.name)}</span><span class="s">${esc([b.brand, b.model].filter(Boolean).join(' '))}</span></span>
      <span class="amt">${active?.id === b.id ? '<span class="badge">Aktiv</span>' : ''}</span>
    </button>`).join('');
  openSheet({
    title: 'Motorrad wählen',
    body: `<div class="list">${items}</div>
      <a href="#logbuch/garage" class="btn btn-block mt" data-close>Motorräder verwalten</a>`,
    onOpen: (dlg, form, close) => {
      dlg.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-pick]');
        if (!btn) return;
        await setActiveBike(btn.dataset.pick);
        close();
      });
    },
  });
}
