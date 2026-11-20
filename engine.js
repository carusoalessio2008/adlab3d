
export function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseDur(s) {
  if (!s) return null;
  let sec = 0, found = false;
  const parts = [
    [/(\d+(?:\.\d+)?)\s*d/i, 86400],
    [/(\d+(?:\.\d+)?)\s*h/i, 3600],
    [/(\d+(?:\.\d+)?)\s*m(?!s)/i, 60],
    [/(\d+(?:\.\d+)?)\s*s/i, 1]
  ];
  for (const [re, mult] of parts) {
    const m = s.match(re);
    if (m) { sec += parseFloat(m[1]) * mult; found = true; }
  }
  return found ? sec : null;
}

export function parseGcode(txt) {
  const res = { minutes: null, grams: null };
  const tre = [
    /;\s*estimated printing time \(normal mode\)\s*[=:]\s*([^\r\n;]+)/i,
    /;\s*total estimated time\s*[=:]\s*([^\r\n;]+)/i,
    /;\s*model printing time\s*[=:]\s*([^\r\n;]+)/i,
    /;TIME:(\d+)/i // Cura (secondi)
  ];
  for (let i = 0; i < tre.length; i++) {
    const m = txt.match(tre[i]);
    if (m) {
      const s = i === 3 ? parseFloat(m[1]) : parseDur(m[1]);
      if (s !== null) { res.minutes = Math.max(1, Math.round(s / 60)); break; }
    }
  }
  const wre = [
    /;\s*total filament weight \[g\]\s*[=:]\s*([ \d.,]+)/i,
    /;\s*total filament used \[g\]\s*[=:]\s*([ \d.,]+)/i,
    /;\s*filament used \[g\]\s*[=:]\s*([ \d.,]+)/i
  ];
  for (const re of wre) {
    const w = txt.match(re);
    if (w) {
      const g = w[1].split(',').map(x => parseFloat(x)).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      if (g > 0) { res.grams = Math.round(g * 100) / 100; break; }
    }
  }
  return res;
}

export function machHour(p) {
  const y = num(p.years), h = num(p.hoursDay);
  if (y <= 0 || h <= 0) return 0;
  return (num(p.price) / (y * 365 * h)) * (1 + num(p.repair) / 100);
}

export function calcQuote(q) {
  const hrs = num(q.hours) + num(q.minutes) / 60;
  const mat = num(q.spoolWeight) > 0 ? (num(q.grams) / num(q.spoolWeight)) * num(q.spoolPrice) : 0;
  const en = (num(q.watts) / 1000) * hrs * num(q.energy);
  const lab = (num(q.prepMin) / 60) * num(q.prepRate) + (num(q.postMin) / 60) * num(q.postRate);
  const mach = hrs * machHour({ price: q.machPrice, years: q.years, hoursDay: q.hoursDay, repair: q.repair });
  const oth = (q.extras || []).reduce((a, x) => a + num(x.amount), 0);

  const def = [
    ['mat', 'Filamento', mat, q.markMat],
    ['en', 'Elettricità', en, q.markEn],
    ['lab', 'Manodopera', lab, q.markLab],
    ['mach', 'Macchina e manutenzione', mach, q.markMach],
    ['oth', 'Altri costi', oth, q.markOther]
  ];

  const rows = def.map(([id, label, cost, mark]) => {
    const m = num(mark);
    return { id, label, cost, mark: m, price: cost * (1 + m / 100) };
  });

  const cost = rows.reduce((a, r) => a + r.cost, 0);
  const sub = rows.reduce((a, r) => a + r.price, 0);
  const min = num(q.minPrice);
  const minApplied = sub < min;
  const net = Math.round(Math.max(sub, min) * 100) / 100;
  const vat = Math.round(net * num(q.vat)) / 100;
  const total = Math.round((net + vat) * 100) / 100;

  return { hrs, rows, cost, sub, minApplied, net, vat, total };
}
