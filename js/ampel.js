// ampel.js – Fahr-Ampel: bewertet Wetterstunden nach einstellbaren Grenzwerten
// und fasst einen Tag in einem kurzen Satz zusammen.
//
// Reine Logik ohne DOM und ohne Browser-APIs – wird später auch vom Cloudflare Worker
// (Push-Benachrichtigungen) verwendet. Stufen: 0 = Grün, 1 = Gelb, 2 = Rot.

export const LEVELS = [
  { key: 'green', label: 'Gut', verdict: 'Gutes Fahrwetter' },
  { key: 'yellow', label: 'Geht so', verdict: 'Geht so' },
  { key: 'red', label: 'Lieber nicht', verdict: 'Lieber nicht fahren' },
];

// Wettercodes (WMO), die unabhängig von den Grenzwerten zählen
const THUNDER = [95, 96, 99];
const SNOW = [71, 73, 75, 77, 85, 86];
const FREEZING = [56, 57, 66, 67];
const FOG = [45, 48];

// Bezeichnungen für die Zusammenfassung ("ab 17 Uhr Regen")
const KIND_LABELS = {
  storm: 'Gewitter',
  snow: 'Schnee',
  ice: 'Glättegefahr',
  rain: 'Regen',
  wet: 'nasse Straße',
  wind: 'starker Wind',
  cold: 'zu kalt',
  fog: 'Nebel',
};

// Ab dieser Regenmenge der letzten 2 Stunden gilt die Straße als noch nass (mm)
const WET_ROAD_MM = 1;

/** Zahl mit einer Nachkommastelle und Dezimalkomma */
const n1 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
const n0 = (v) => String(Math.round(v));

/**
 * Eine Stunde bewerten.
 * h: { temp, rainProb, rain, gust, code }   t: Grenzwerte (siehe db.js → thresholds)
 * prev: die Stunden davor (für "Straße noch nass")
 * → { level, reasons: [{ level, kind, text }] } – Gründe nach Schwere sortiert
 */
export function rateHour(h, t, prev = []) {
  const reasons = [];
  const add = (level, kind, text) => {
    const existing = reasons.find((r) => r.kind === kind);
    if (existing && existing.level >= level) return;
    if (existing) reasons.splice(reasons.indexOf(existing), 1);
    reasons.push({ level, kind, text });
  };

  // Gewitter, Schnee, gefrierender Regen
  if (THUNDER.includes(h.code)) add(2, 'storm', 'Gewitter');
  if (SNOW.includes(h.code)) add(2, 'snow', 'Schnee');
  if (FREEZING.includes(h.code)) add(2, 'ice', 'Gefrierender Regen');

  // Regen: Gelb, wenn Wahrscheinlichkeit ODER Menge über dem Grenzwert liegt,
  // Rot, wenn beides zutrifft oder einer der Rot-Grenzwerte überschritten ist
  const prob = h.rainProb ?? 0;
  const mm = h.rain ?? 0;
  const probHigh = prob > t.rainProbYellow;
  const mmHigh = mm > t.rainMmYellow;
  if (prob > t.rainProbRed || mm > t.rainMmRed || (probHigh && mmHigh)) {
    add(2, 'rain', `Regen ${n0(prob)} % · ${n1(mm)} mm`);
  } else if (probHigh || mmHigh) {
    add(1, 'rain', mmHigh ? `Regen ${n1(mm)} mm` : `Regenrisiko ${n0(prob)} %`);
  } else {
    // Trocken, aber kurz davor hat es geregnet → Straße wahrscheinlich noch nass
    const recent = prev.slice(-2).reduce((s, x) => s + (x.rain || 0), 0);
    if (recent >= WET_ROAD_MM) add(1, 'wet', 'Straße noch nass');
  }

  // Temperatur
  if (h.temp < t.tempRed) add(2, 'ice', `Glättegefahr (${n1(h.temp)} °C)`);
  else if (h.temp < t.tempYellow) add(1, 'cold', `Kalt (${n1(h.temp)} °C)`);

  // Böen
  if (h.gust > t.gustRed) add(2, 'wind', `Sturmböen ${n0(h.gust)} km/h`);
  else if (h.gust > t.gustYellow) add(1, 'wind', `Böen ${n0(h.gust)} km/h`);

  if (FOG.includes(h.code)) add(1, 'fog', 'Nebel');

  reasons.sort((a, b) => b.level - a.level);
  return { level: reasons.length ? reasons[0].level : 0, reasons };
}

/** Alle Stunden bewerten (chronologisch sortiert übergeben) */
export function rateHours(hours, t) {
  return hours.map((h, i) => ({ ...h, ...rateHour(h, t, hours.slice(Math.max(0, i - 2), i)) }));
}

/** Längste zusammenhängende Folge von Stunden, die test() erfüllen */
function longestRun(hours, test) {
  let best = null;
  let cur = null;
  hours.forEach((h, i) => {
    const contiguous = cur && hours[i - 1].hour === h.hour - 1;
    if (test(h)) {
      cur = contiguous ? { ...cur, end: i, len: cur.len + 1 } : { start: i, end: i, len: 1 };
      if (!best || cur.len > best.len) best = cur;
    } else {
      cur = null;
    }
  });
  return best && { ...best, from: hours[best.start].hour, to: hours[best.end].hour + 1 };
}

/** Häufigster (schwerster) Grund in einer Reihe von Stunden → "Regen" */
function mainKind(hours) {
  const score = new Map();
  for (const h of hours) {
    const r = h.reasons?.[0];
    if (r) score.set(r.kind, (score.get(r.kind) || 0) + 1 + r.level);
  }
  const [kind] = [...score.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return kind ? KIND_LABELS[kind] : '';
}

/** Die zwei wichtigsten Gründe eines Tages → "Regen, starker Wind" */
function topKinds(hours) {
  const score = new Map();
  for (const h of hours) for (const r of h.reasons || []) score.set(r.kind, (score.get(r.kind) || 0) + r.level);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => KIND_LABELS[k]);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Tagesfazit innerhalb der Fahrzeit (t.rideFrom bis t.rideTo Uhr).
 * dayHours: bewertete Stunden EINES Tages (aus rateHours)
 * fromHour: für "heute" die aktuelle Stunde (vergangene Stunden zählen nicht)
 * → { level (0–2 oder null), text, best: { from, to } | null, stats }
 */
export function summarizeDay(dayHours, t, { fromHour = 0 } = {}) {
  const start = Math.max(t.rideFrom, fromHour);
  const end = t.rideTo;
  const win = dayHours.filter((h) => h.hour >= start && h.hour < end);

  if (!win.length) {
    return {
      level: null,
      text: fromHour > 0 ? `Die Fahrzeit für heute ist vorbei (bis ${end} Uhr).` : 'Keine Daten für die Fahrzeit.',
      best: null,
      stats: null,
    };
  }

  const stats = {
    tempMin: Math.min(...win.map((h) => h.temp)),
    tempMax: Math.max(...win.map((h) => h.temp)),
    gustMax: Math.max(...win.map((h) => h.gust || 0)),
    rainSum: win.reduce((s, h) => s + (h.rain || 0), 0),
    green: win.filter((h) => h.level === 0).length,
    hours: win.length,
  };

  // Grün braucht mindestens 3 gute Stunden am Stück (oder die ganze verbleibende Zeit)
  const need = Math.min(3, win.length);
  const green = longestRun(win, (h) => h.level === 0);
  const okay = longestRun(win, (h) => h.level <= 1);
  let level = 2;
  if (green && green.len >= need) level = 0;
  else if (okay && okay.len >= need) level = 1;

  const parts = [];
  const run = level === 0 ? green : level === 1 ? okay : null;

  if (run) {
    // Stunden außerhalb der besten Phase, die schlechter sind als die Phase selbst
    const worse = (h) => h.level > level;
    if (run.len === win.length) {
      parts.push(level === 0
        ? (fromHour > t.rideFrom ? `ideal bis ${run.to} Uhr` : `den ganzen Tag ideal (${run.from}–${run.to} Uhr)`)
        : `durchgehend nur mäßig: ${topKinds(win).join(', ')}`);
    } else {
      const before = win.slice(0, run.start).filter(worse);
      if (before.length) parts.push(`bis ${run.from} Uhr ${mainKind(before)}`);
      if (level === 0) {
        parts.push(`ideal von ${run.from}–${run.to} Uhr`);
      } else {
        const kinds = topKinds(win.slice(run.start, run.end + 1));
        parts.push(`am ehesten ${run.from}–${run.to} Uhr${kinds.length ? ` (${kinds.join(', ')})` : ''}`);
      }
      const after = win.slice(run.end + 1).find(worse);
      if (after) {
        parts.push(`ab ${after.hour} Uhr ${mainKind([after])}`);
        // Wird es danach wieder gut (mind. 2 Stunden)? → "ab 16 Uhr wieder gut"
        const rest = win.slice(win.indexOf(after) + 1);
        const again = longestRun(rest, (h) => h.level <= level);
        if (again && again.len >= 2) parts.push(`ab ${again.from} Uhr wieder ${level === 0 ? 'gut' : 'okay'}`);
      }
    }
  } else {
    parts.push(`kein gutes Fahrwetter: ${topKinds(win).join(', ')}`);
    const least = longestRun(win, (h) => h.level <= 1);
    if (least) parts.push(`am ehesten ${least.from}–${least.to} Uhr`);
  }

  return {
    level,
    text: capitalize(parts.join(', ')),
    best: run ? { from: run.from, to: run.to } : null,
    stats,
  };
}
