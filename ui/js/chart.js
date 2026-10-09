// Charts are built only from the cell text of a table the backend already returned.
// Values are parsed verbatim (no scaling, no recalculation); anything unparseable blocks the chart.
import { esc } from './markdown.js';

export const PALETTE = ['#8A7652', '#A7A98B', '#C7A889', '#64816A', '#B18A50', '#B66D63'];

export function parseCell(raw) {
  const t = String(raw ?? '').replace(/\[C\d+\]/g, '').replace(/<br\s*\/?>/gi, ' ').trim();
  const m = t.match(/^(\(|-|−)?\s*([\d][\d,]*\.?\d*)\s*(\))?\s*(.*)$/);
  if (!m) return null;
  const v = parseFloat(m[2].replace(/,/g, ''));
  if (Number.isNaN(v)) return null;
  const neg = m[1] === '(' && m[3] === ')' || m[1] === '-' || m[1] === '−';
  return { v: neg ? -v : v, unit: m[4].trim().toLowerCase(), text: t };
}

/** Returns {ok:true, spec} or {ok:false, reason}. */
export function specFromTable(tbl) {
  const { headers, rows, title } = tbl;
  if (rows.length < 2 && headers.length < 3) return { ok: false, reason: 'The table has too few rows to chart.' };
  const cols = [];
  for (let c = 1; c < headers.length; c++) {
    const cells = rows.map(r => parseCell(r[c]));
    const good = cells.filter(Boolean).length;
    if (good >= Math.max(2, Math.ceil(rows.length * 0.8))) {
      const unitSet = [...new Set(cells.filter(Boolean).map(x => x.unit))];
      cols.push({ c, name: headers[c].replace(/\[C\d+\]/g, '').trim(), cells, unit: unitSet.length === 1 ? unitSet[0] : '' , mixedUnit: unitSet.length > 1 });
    }
  }
  if (!cols.length) return { ok: false, reason: 'No numeric column in this table has enough parseable values to chart.' };
  const baseUnit = cols[0].unit;
  const same = cols.filter(c => !c.mixedUnit && c.unit === baseUnit);
  const omitted = cols.length - same.length;
  if (!same.length) return { ok: false, reason: 'Values in this table use mixed units, so they cannot be plotted on one axis.' };
  const cats = rows.map(r => String(r[0] ?? '').replace(/\[C\d+\]/g, '').trim());
  const rowsKeep = rows.map((_, i) => i).filter(i => same.some(s => s.cells[i]));
  const periodLike = cats.length >= 3 && cats.every(c => /^(fy\s?)?\d{2,4}([-–/]\d{2,4})?$|^q[1-4]/i.test(c));
  const cites = [...new Set(rows.flat().join(' ').match(/\[C\d+\]/g) || [])];
  return { ok: true, spec: { title: title || headers[0] || 'Table', kind: periodLike ? 'line' : 'bar',
    cats: rowsKeep.map(i => cats[i]), unit: baseUnit, series: same.map(s => ({ name: s.name, values: rowsKeep.map(i => s.cells[i]?.v ?? null) })),
    omitted, cites, headers, rows: rowsKeep.map(i => rows[i]) } };
}

const fmt = v => Math.abs(v) >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(Math.round(v * 100) / 100);

function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

export function renderChart(spec) {
  const W = 640, H = 300, m = { l: 64, r: 16, t: 14, b: 62 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = spec.series.flatMap(s => s.values.filter(v => v != null));
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const top = hi > 0 ? niceMax(hi) : 0, bot = lo < 0 ? -niceMax(-lo) : 0;
  const y = v => m.t + ih * (1 - (v - bot) / ((top - bot) || 1));
  const n = spec.cats.length, k = spec.series.length;
  const gw = iw / n, bw = Math.min(46, (gw * 0.72) / k);
  let g = '';
  for (let t = 0; t <= 4; t++) {
    const v = bot + ((top - bot) * t) / 4;
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#E8E3DA"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6B675E">${esc(fmt(v))}</text>`;
  }
  g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="#D9D2C5"/>`;
  const title = (a, b, s) => `<title>${esc(a)} · ${esc(b)}: ${esc(fmt(s))}${spec.unit ? ' ' + esc(spec.unit) : ''}</title>`;
  if (spec.kind === 'line') {
    spec.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => v == null ? null : [m.l + gw * (i + .5), y(v)]);
      const d = pts.filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
      g += `<path d="${d}" fill="none" stroke="${PALETTE[si % 6]}" stroke-width="2.2" class="bar" style="animation-name:none"/>`;
      pts.forEach((p, i) => { if (p) g += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#fff" stroke="${PALETTE[si % 6]}" stroke-width="2">${title(spec.cats[i], s.name, s.values[i])}</circle>`; });
    });
  } else {
    spec.series.forEach((s, si) => s.values.forEach((v, i) => {
      if (v == null) return;
      const x = m.l + gw * i + (gw - bw * k) / 2 + bw * si;
      const y0 = y(0), y1 = y(v);
      g += `<rect class="bar" x="${x}" y="${Math.min(y0, y1)}" width="${bw - 2}" height="${Math.max(1, Math.abs(y0 - y1))}" rx="2" fill="${v < 0 ? '#B66D63' : PALETTE[si % 6]}">${title(spec.cats[i], s.name, v)}</rect>`;
      if (n * k <= 12) g += `<text x="${x + (bw - 2) / 2}" y="${v < 0 ? y1 + 12 : y1 - 4}" text-anchor="middle" font-size="10.5" fill="#302E29">${esc(fmt(v))}</text>`;
    }));
  }
  spec.cats.forEach((c, i) => {
    const label = c.length > 16 ? c.slice(0, 15) + '…' : c;
    g += `<text x="${m.l + gw * (i + .5)}" y="${H - m.b + 16}" font-size="11" fill="#6B675E" text-anchor="${n > 4 ? 'end' : 'middle'}" ${n > 4 ? `transform="rotate(-30 ${m.l + gw * (i + .5)} ${H - m.b + 16})"` : ''}>${esc(label)}<title>${esc(c)}</title></text>`;
  });
  const legend = spec.series.map((s, si) => `<span><i style="background:${PALETTE[si % 6]}"></i>${esc(s.name)}</span>`).join('');
  const table = `<details><summary class="link-btn">Exact values</summary><div class="tbl-scroll"><table><thead><tr>${spec.headers.map(h => `<th>${esc(h.replace(/\[C\d+\]/g, ''))}</th>`).join('')}</tr></thead><tbody>${spec.rows.map(r => '<tr>' + spec.headers.map((_, c) => `<td>${esc(String(r[c] ?? '').replace(/\[C\d+\]/g, ''))}</td>`).join('') + '</tr>').join('')}</tbody></table></div></details>`;
  const unitTxt = spec.unit ? `Unit as reported: ${esc(spec.unit)}` : 'Units and period: as stated in the source table';
  return `<figure class="chart" role="group" aria-label="${esc(spec.title)} chart"><h4>${esc(spec.title)}</h4>
    <div class="meta">${unitTxt}${spec.omitted ? ` · ${spec.omitted} column(s) with different units omitted` : ''}${spec.cites.length ? ' · Evidence: ' + spec.cites.map(c => esc(c.slice(1, -1))).join(', ') : ''}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)}">${g}<text x="14" y="${m.t + ih / 2}" font-size="11" fill="#6B675E" transform="rotate(-90 14 ${m.t + ih / 2})" text-anchor="middle">${spec.unit ? esc(spec.unit) : 'Value'}</text></svg>
    <div class="legend">${legend}</div>${table}
    <div class="meta" style="margin-top:6px">Plotted exactly as written in the answer's table; no values were recalculated.</div></figure>`;
}
