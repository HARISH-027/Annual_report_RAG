// Safe markdown renderer (escapes HTML first). Collects tables so they can be charted from their exact cell text.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function inline(s) {
  s = esc(s).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>');
  return s.replace(/\[(C\d+)\]/g, '<button type="button" class="cite" data-c="$1" aria-label="Open source $1">$1</button>');
}

const isNumeric = c => /^[\s(−-]*[\d][\d,]*\.?\d*\)?\s*(%|[A-Za-z. ]{0,14})?(\s*\[C\d+\])*\s*$/.test(c);

export function renderMarkdown(src) {
  const L = String(src || '').replace(/\r/g, '').split('\n');
  const tables = [];
  let h = '', i = 0, lastHeading = '';
  const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  while (i < L.length) {
    const l = L[i];
    if (isRow(l) && i + 1 < L.length && /^\s*\|[\s:|-]+\|\s*$/.test(L[i + 1])) {
      const head = row(l); i += 2;
      const rows = [];
      while (i < L.length && isRow(L[i])) { rows.push(row(L[i])); i++; }
      const idx = tables.push({ headers: head, rows, title: lastHeading }) - 1;
      const numCols = head.map((_, c) => rows.length && rows.every(r => !r[c] || isNumeric(r[c])) ? 1 : 0);
      const body = rows.map(r => '<tr>' + head.map((_, c) => `<td${numCols[c] && c > 0 ? ' class="num"' : ''}>${inline(r[c] ?? '')}</td>`).join('') + '</tr>').join('');
      h += `<div class="tbl" data-t="${idx}"><div class="tbl-scroll"><table><thead><tr>${head.map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`
        + `<div class="tbl-bar"><button type="button" class="link-btn" data-chart="${idx}">Visualize this table</button></div></div>`;
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { lastHeading = m[2].replace(/[*`]/g, ''); h += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^\s*[-*•]\s+/.test(l)) { h += '<ul>'; while (i < L.length && /^\s*[-*•]\s+/.test(L[i])) { h += '<li>' + inline(L[i].replace(/^\s*[-*•]\s+/, '')) + '</li>'; i++; } h += '</ul>'; continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { h += '<ol>'; while (i < L.length && /^\s*\d+[.)]\s+/.test(L[i])) { h += '<li>' + inline(L[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'; i++; } h += '</ol>'; continue; }
    if (l.trim() === '') { i++; continue; }
    const p = [l]; i++;
    while (i < L.length && L[i].trim() !== '' && !/^(#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(L[i])) { p.push(L[i]); i++; }
    h += '<p>' + inline(p.join(' ')) + '</p>';
  }
  return { html: h, tables };
}
