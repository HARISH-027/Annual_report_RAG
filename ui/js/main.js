import { getMeta, chat, chatStream } from './api.js';
import { esc, renderMarkdown } from './markdown.js';
import { specFromTable, renderChart } from './chart.js';
import { Storyboard } from './storyboard.js';
import { store, loadConversations, saveConversations, uid, relTime } from './state.js';

const $ = s => document.querySelector(s);
const app = $('#app'), thread = $('#thread'), scroller = $('#scroll'), q = $('#q'), form = $('#form'), sendBtn = $('#send');
const REQUEST_TIMEOUT_MS = 300000;
const CHART_WORDS = /\b(chart|graph|plot|visuali[sz]e|visuali[sz]ation)\b/i;

const S = {
  meta: null, convs: loadConversations(), active: null, selCo: new Set(), selSk: new Set(),
  busy: false, abort: null, evTurn: null, tablesByBody: new WeakMap(), results: new Map(),
};
const board = new Storyboard($('#story-body'));
const companyName = k => S.meta?.companies.find(c => c.key === k)?.name || k.replace(/_/g, ' ');

/* ---------------- layout helpers */
const wide = matchMedia('(min-width:1101px)');
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)');
let storyOpen = store.get('finora.story', null);
if (storyOpen == null) storyOpen = wide.matches;
let storyHidden = store.get('finora.storyHidden', false);

function placeStory() {
  const story = $('#story');
  (wide.matches ? $('.rail-inner') : $('#story-slot-mobile')).append(story);
  story.style.cssText = wide.matches ? '' : 'border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);margin-bottom:8px;max-height:46vh;overflow:auto';
  layoutRail();
}
function layoutRail() {
  const evOpen = !$('#ev-panel').hidden;
  const story = $('#story');
  story.hidden = storyHidden;
  story.classList.toggle('collapsed', !storyOpen);
  $('#story-toggle').setAttribute('aria-expanded', String(storyOpen));
  $('#story-toggle').setAttribute('aria-label', storyOpen ? 'Collapse workspace pane' : 'Expand workspace pane');
  $('#story-toggle').style.transform = storyOpen ? '' : 'rotate(180deg)';
  const railNeeded = evOpen || (wide.matches && !storyHidden && storyOpen);
  $('#rail').classList.toggle('open', railNeeded);
  $('#story-fab').classList.toggle('show', wide.matches && !storyHidden && !storyOpen && !evOpen);
  // when the story is docked in the rail, a collapsed story still needs its header visible only if evidence is open
  if (wide.matches && !storyOpen && !evOpen) story.hidden = true;
}
function setStory(open) { storyOpen = open; store.set('finora.story', open); layoutRail(); }
wide.addEventListener('change', placeStory);

/* ---------------- boot */
async function init() {
  placeStory();
  renderConvs(); renderScope(); renderThread();
  try {
    S.meta = await getMeta();
    setStatus(true, `${S.meta.chunks.toLocaleString()} passages indexed`);
    board.setSkills(S.meta.skills);
  } catch (e) { setStatus(false, 'Backend unavailable'); }
  renderDialogs(); renderScope(); renderThread();
}
function setStatus(ok, text) { $('#status').innerHTML = `<span class="dot ${ok ? '' : 'off'}"></span><span>${esc(text)}</span>`; }

/* ---------------- conversations */
const activeConv = () => S.convs.find(c => c.id === S.active);
function renderConvs() {
  const term = $('#convsearch').value.trim().toLowerCase();
  const list = S.convs.filter(c => !term || c.title.toLowerCase().includes(term));
  $('#convs').innerHTML = list.length ? list.map(c => `<div class="conv ${c.id === S.active ? 'active' : ''}" role="listitem">
      <button class="conv-main" data-open="${c.id}" ${c.id === S.active ? 'aria-current="true"' : ''}><b>${esc(c.title)}</b><small>${relTime(c.updated)}</small></button>
      <button class="icon-btn del" data-del="${c.id}" aria-label="Delete conversation ${esc(c.title)}"><svg class="ico" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>`).join('')
    : `<div style="padding:8px 10px;color:var(--text-2);font-size:13px">${term ? 'No matches.' : 'Your analyses will appear here. History is stored in this browser only.'}</div>`;
}
function persist() { S.convs.sort((a, b) => b.updated - a.updated); S.convs = saveConversations(S.convs); renderConvs(); }
function newAnalysis() {
  if (S.busy) return;
  S.active = null; closeEvidence(); renderThread(); renderConvs(); q.focus(); app.classList.remove('drawer-open'); $('#scrim').hidden = true;
}

/* ---------------- scope (companies / lenses) */
function renderScope() {
  const co = S.selCo.size ? [...S.selCo].map(companyName).join(', ') : 'All reports';
  const sk = S.selSk.size ? [...S.selSk].map(n => S.meta?.skills.find(s => s.name === n)?.title || n).join(', ') : 'Auto lens';
  $('#scope-chips').innerHTML = `<button type="button" class="scope-btn" data-dlg="dlg-corpus" title="Choose which reports to search">Reports: ${esc(co.length > 28 ? co.slice(0, 27) + '…' : co)}</button>
    <button type="button" class="scope-btn" data-dlg="dlg-lens" title="Choose an analysis lens">${esc(sk.length > 28 ? sk.slice(0, 27) + '…' : sk)}</button>`;
  $('#ctx-scope').textContent = `${co} · FY 2024-25 · ${sk}`;
  $('#ctx-title').textContent = activeConv()?.title || 'New analysis';
}

/* ---------------- welcome */
function suggestions() {
  const m = S.meta, names = m ? m.companies.map(c => c.name) : [];
  const a = names[0], b = names[1];
  const has = n => !m || m.skills.some(s => s.name === n);
  const t = [];
  if (has('financial_analysis')) t.push(['Analyze the financial statements', `Summarise revenue, profit and balance sheet position of ${a || 'ONGC'}`, `Summarise the key financial figures reported by ${a || 'ONGC'}: revenue, profit after tax and balance sheet position`]);
  if (has('ca_auditor')) t.push(['Review the auditor’s report', 'Opinion, key audit matters and remarks', `Give a CA auditor review of ${names[4] || 'SAIL'}: opinion, key audit matters and remarks`]);
  if (has('ca_auditor_observations')) t.push(['Find audit observations', 'Management-letter style findings with evidence', `Raise CA auditor observations on ${a || 'ONGC'}'s contingent liabilities`]);
  if (has('risk_analysis')) t.push(['Summarize key risks', 'Disclosed risks and areas needing review', `What are the main risks disclosed by ${names[3] || 'Hindustan Copper'}?`]);
  if (has('comparison')) t.push(['Compare reported figures', 'Side by side from the reports, with a chart option', `Compare revenue from operations and profit after tax of ${names[4] || 'SAIL'} and ${names[3] || 'Hindustan Copper'}`]);
  if (has('pain_points')) t.push(['Surface operating pain points', 'Challenges and worsening metrics', `What pain points does ${names[2] || 'IRCTC'} report?`]);
  return t.slice(0, 6);
}
function welcomeHTML() {
  const corpus = S.meta ? S.meta.companies.map(c => esc(c.name)).join(' · ') + ' · FY 2024-25' : '';
  return `<section class="welcome"><img class="mark" src="/static/assets/logo.svg" alt="">
    <h1>Financial intelligence, grounded in evidence.</h1>
    <p class="lead">Explore financial statements, investigate audit observations, compare reported figures, and trace every answer back to the source passages.</p>
    <div class="corpus">${corpus ? 'Searching: ' + corpus : 'Connecting to the backend…'}</div>
    <div class="tiles">${suggestions().map(([h, d, p]) => `<button class="tile" data-ask="${esc(p)}"><b>${esc(h)}</b><span>${esc(d)}</span></button>`).join('')}</div></section>`;
}

/* ---------------- thread */
function renderThread() {
  const c = activeConv();
  S.results.clear();
  if (!c) { thread.innerHTML = welcomeHTML(); renderScope(); return; }
  thread.innerHTML = '';
  c.messages.forEach((m, i) => {
    if (m.role === 'user') thread.append(userEl(m.text));
    else { const box = answerShell(); fill(box, m.result, m.text, c.messages[i - 1]?.text || ''); thread.lastElementChild.append(box); }
  });
  renderScope();
}
function userEl(text) {
  const t = document.createElement('div'); t.className = 'turn';
  t.innerHTML = `<div class="user-q"><div>${esc(text)}</div></div>`;
  return t;
}
function answerShell() {
  const box = document.createElement('div'); box.className = 'ans';
  box.innerHTML = `<img class="av" src="/static/assets/logo.svg" alt=""><div class="body"></div>`;
  return box;
}
const bodyOf = box => box.querySelector('.body');

function tagsHTML(r) {
  const p = r.plan, g = r.grounding; let h = `<span class="tag">${esc(p.intent)}</span>`;
  (p.companies || []).forEach(c => h += `<span class="tag">${esc(companyName(c))}</span>`);
  (p.skills || []).forEach(s => h += `<span class="tag">Skill: ${esc(S.meta?.skills.find(x => x.name === s)?.title || s.replace(/_/g, ' '))}</span>`);
  if (g) {
    const cls = g.status === 'verified' ? 'good' : g.status === 'partial' ? 'warn' : 'bad';
    const label = { verified: 'Citations and figures matched', partial: 'Partly verified', unverified: 'Unverified' }[g.status];
    h += `<span class="tag ${cls}" title="${g.numbers_checked} figures checked, ${g.citations} citations">${label}</span>`;
  }
  return h;
}
function followUps(r) {
  const p = r.plan, co = p.companies?.[0] ? companyName(p.companies[0]) : null;
  if (p.intent === 'out_of_scope' || !co) return [];
  const has = n => S.meta?.skills.some(s => s.name === n);
  const out = [];
  if (p.intent !== 'observations' && has('ca_auditor_observations')) out.push(`Raise CA auditor observations on ${co}`);
  if (p.intent !== 'risk' && has('risk_analysis')) out.push(`What are the main risks disclosed by ${co}?`);
  if (p.intent !== 'financial' && has('financial_analysis')) out.push(`Summarise the key financial figures reported by ${co}`);
  const other = S.meta?.companies.find(c => !p.companies.includes(c.key));
  if (other && has('comparison') && p.companies.length === 1) out.push(`Compare ${co} and ${other.name} on revenue and profit after tax`);
  return out.slice(0, 3);
}

function fill(box, r, answerText, question) {
  const body = bodyOf(box), { html, tables } = renderMarkdown(r.answer);
  const id = uid(); S.results.set(id, r); box.dataset.rid = id;
  const ev = r.evidence || [], u = r.usage || {};
  const notFound = /^Not found in the available reports/i.test(r.answer || '');
  body.innerHTML = `<div class="tags">${tagsHTML(r)}</div>
    <div class="md">${html}</div>
    ${r.grounding?.numbers_unmatched?.length ? `<div class="note-box"><b>Check these figures:</b> ${esc(r.grounding.numbers_unmatched.join(', '))} were not found verbatim in the retrieved evidence. They may be derived or reformatted; verify against the source.</div>` : ''}
    ${notFound ? `<div class="note-box">The pipeline did not find adequate evidence for this question in the indexed reports. Try naming a company or narrowing the scope.</div>` : ''}
    <div class="actions">
      ${ev.length ? `<button class="link-btn" data-evidence>Evidence (${ev.length})</button>` : ''}
      <button class="link-btn" data-copy="answer">Copy answer</button>
      ${ev.length ? `<button class="link-btn" data-copy="refs">Copy references</button>` : ''}
      <button class="link-btn" data-trace>How this was answered</button>
      <span>${(u.prompt + u.completion).toLocaleString()} tokens · ${u.calls} model call${u.calls === 1 ? '' : 's'}${r.cached ? ' · cached' : ''} · ${r.seconds}s</span>
    </div>
    <ul class="trace" hidden>${(r.trace || []).map(t => `<li>${esc(t)}</li>`).join('')}${r.plan.q ? `<li>Query used for retrieval: “${esc(r.plan.q)}”</li>` : ''}</ul>
    <div class="followups">${followUps(r).map(f => `<button class="chip" data-ask="${esc(f)}">${esc(f)}</button>`).join('')}</div>`;
  S.tablesByBody.set(body.querySelector('.md'), tables);
  box.dataset.q = question;
}

/* ---------------- evidence panel */
function openEvidence(rid, cid) {
  const r = S.results.get(rid); if (!r?.evidence?.length) return;
  S.evTurn = rid;
  $('#ev-title').textContent = `Evidence · ${r.evidence.length} retrieved passages`;
  $('#ev-list').innerHTML = `<p style="font-size:12.5px;color:var(--text-2);margin:0 0 10px">Passages below were retrieved from the reports. The answer text is the model’s interpretation of them.</p>` + r.evidence.map(e => `
    <article class="ev-item ${e.cid === cid ? 'open hl' : ''}" data-id="${e.cid}">
      <button class="ev-head" aria-expanded="${e.cid === cid}"><span class="l1"><b>${e.cid}</b><span>${esc(companyName(e.company))}</span><span class="tag">${esc(e.kind)}${e.stmt ? ' · ' + esc(e.stmt.replace(/_/g, ' ')) : ''}</span>${e.page != null ? `<span>p.${esc(e.page)}</span>` : ''}</span>
      <span class="l2">${esc((e.title || e.section || '').slice(0, 110))}</span></button>
      <div class="ev-body"><p class="ev-kind">Retrieved source text${e.unit ? ' · unit: ' + esc(e.unit) : ''} · ${esc(e.doc_id || '')}</p><div class="ev-text">${esc(e.text)}</div>
      <button class="link-btn" data-copyref="${e.cid}">Copy reference</button></div></article>`).join('');
  $('#ev-panel').hidden = false; layoutRail();
  document.querySelectorAll('.cite.on').forEach(c => c.classList.remove('on'));
  document.querySelectorAll(`.ans[data-rid="${rid}"] .cite[data-c="${cid}"]`).forEach(c => c.classList.add('on'));
  if (cid) { const it = $(`#ev-list [data-id="${cid}"]`); it?.scrollIntoView({ block: 'nearest', behavior: prefersReduced.matches ? 'auto' : 'smooth' }); setTimeout(() => it?.classList.remove('hl'), 1800); }
}
function closeEvidence() { $('#ev-panel').hidden = true; S.evTurn = null; document.querySelectorAll('.cite.on').forEach(c => c.classList.remove('on')); layoutRail(); }
const refText = e => `${companyName(e.company)}, ${e.doc_id || ''}${e.page != null ? ', p.' + e.page : ''}${e.section ? ', ' + e.section : ''} [${e.cid}]`;
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1400); }
  catch { btn.textContent = 'Copy failed'; }
}

/* ---------------- chart */
function toggleChart(btn) {
  const tbl = btn.closest('.tbl'), next = tbl.nextElementSibling;
  if (next?.classList.contains('chart') || next?.classList.contains('note-box')) { next.remove(); btn.textContent = 'Visualize this table'; return; }
  const tables = S.tablesByBody.get(btn.closest('.md'));
  const res = specFromTable(tables[+btn.dataset.chart]);
  const el = document.createElement('div');
  if (res.ok) { el.innerHTML = renderChart(res.spec); btn.textContent = 'Hide chart'; tbl.after(el.firstElementChild); }
  else { el.className = 'note-box'; el.textContent = `Cannot chart this table: ${res.reason} Nothing was estimated.`; tbl.after(el); }
}
function autoChart(box) {
  const md = box.querySelector('.md'), tables = S.tablesByBody.get(md) || [];
  const i = tables.findIndex(t => specFromTable(t).ok);
  if (i >= 0) toggleChart(md.querySelector(`[data-chart="${i}"]`));
  else {
    const n = document.createElement('div'); n.className = 'note-box';
    n.textContent = tables.length ? 'You asked for a chart, but no table in this answer has enough consistent numeric values to plot. Nothing was estimated.'
      : 'You asked for a chart, but the answer contains no table of figures to plot. Try asking for the figures in a table first, for example “show revenue and profit after tax as a table”.';
    md.after(n);
  }
}

/* ---------------- ask */
const history = () => {
  const m = activeConv()?.messages || [], out = [];
  for (let i = 0; i < m.length - 1; i++) if (m[i].role === 'user' && m[i + 1].role === 'assistant') out.push({ q: m[i].text, a: (m[i + 1].text || '').slice(0, 300) });
  return out.slice(-3);
};
function setBusy(b) {
  S.busy = b; q.readOnly = b; sendBtn.classList.toggle('stop', b); sendBtn.type = b ? 'button' : 'submit';
  $('#send-label').textContent = b ? 'Stop' : 'Ask';
}
async function ask(text) {
  text = text.trim(); if (!text || S.busy) return;
  let conv = activeConv();
  if (!conv) { conv = { id: uid(), title: text.slice(0, 60), updated: Date.now(), messages: [] }; S.convs.unshift(conv); S.active = conv.id; thread.innerHTML = ''; }
  const payload = { query: text, history: history(), companies: [...S.selCo], skills: [...S.selSk] };
  const turn = userEl(text); thread.append(turn);
  const box = answerShell(); turn.append(box);
  bodyOf(box).innerHTML = `<div class="pending"><span class="spin"></span><span id="pend-msg">Working… long audit answers can take up to a minute.</span></div>`;
  q.value = ''; q.style.height = 'auto'; setBusy(true); renderScope();
  turn.scrollIntoView({ block: 'start', behavior: prefersReduced.matches ? 'auto' : 'smooth' });
  board.start(text);
  const ac = new AbortController(); S.abort = ac;
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; ac.abort(); }, REQUEST_TIMEOUT_MS);
  const onStage = ev => { board.event(ev); const p = $('#pend-msg'); if (p && ev.display_message) p.textContent = ev.display_message; };
  try {
    let r;
    try { r = await chatStream(payload, ac.signal, onStage); }
    catch (e) { if (!e.noStream) throw e; board.inferWait(); r = await chat(payload, ac.signal); }
    board.done(r);
    conv.messages.push({ role: 'user', text }, { role: 'assistant', text: r.answer, result: r });
    conv.updated = Date.now(); persist();
    fill(box, r, r.answer, text); renderScope();
    if (CHART_WORDS.test(text)) autoChart(box);
    setStatus(true, `${S.meta?.chunks?.toLocaleString() ?? ''} passages indexed`);
  } catch (e) {
    const aborted = e.name === 'AbortError';
    const msg = aborted ? (timedOut ? 'The request timed out after 5 minutes.' : 'You stopped waiting. The backend may still finish this request in the background.')
      : (e instanceof TypeError ? 'Cannot reach the FINORA backend. Check that the server is running.' : e.message);
    if (e instanceof TypeError) setStatus(false, 'Backend unavailable');
    board.fail(msg);
    bodyOf(box).innerHTML = `<div class="err" role="alert"><b>${aborted && !timedOut ? 'Stopped' : 'This request did not complete'}</b><p>${esc(msg)}</p>
      <p style="color:var(--text-2);font-size:13px;margin:0 0 8px">No answer was produced. Your question has been returned to the input box.</p><button type="button" data-retry>Retry</button></div>`;
    box.dataset.q = text; if (!q.value) q.value = text;
    if (!conv.messages.length) { S.convs = S.convs.filter(c => c !== conv); S.active = null; renderConvs(); }
  } finally { clearTimeout(timer); S.abort = null; setBusy(false); if (matchMedia('(pointer:fine)').matches) q.focus(); }
}

/* ---------------- dialogs */
function renderDialogs() {
  const m = S.meta; if (!m) return;
  $('#corpus-body').innerHTML = `<p style="margin-top:0;color:var(--text-2)">${m.chunks.toLocaleString()} passages indexed across ${m.companies.length} FY 2024-25 annual reports (embedding model ${esc(m.embed_model)}). The corpus is pre-indexed; uploading new documents is not supported by this backend.</p>
    <p style="font-size:13px;margin:0">Choose reports to search (none selected = all).</p>` + m.companies.map(c => `<label class="row"><input type="checkbox" data-co="${esc(c.key)}" ${S.selCo.has(c.key) ? 'checked' : ''}><span><b>${esc(c.name)}</b><small>Annual report FY 2024-25 · indexed</small></span></label>`).join('');
  $('#lens-body').innerHTML = `<p style="margin-top:0;color:var(--text-2)">By default the lens is chosen automatically from your question. Select one or more to force them.</p>` + m.skills.map(s => `<label class="row"><input type="checkbox" data-sk="${esc(s.name)}" ${S.selSk.has(s.name) ? 'checked' : ''}><span><b>${esc(s.title)}</b><small>${esc(s.description)}</small></span></label>`).join('');
  $('#settings-body').innerHTML = `<label class="row"><input type="checkbox" id="set-story" ${storyHidden ? '' : 'checked'}><span><b>Show “Inside the AI Workspace”</b><small>The pane that visualises the real pipeline stages for each request.</small></span></label>
    <div class="row"><span><b>Model</b><small>${esc(m.model)} (configured on the server)</small></span></div>
    <div class="row"><span><b>Conversation history</b><small>Stored only in this browser; the backend keeps no sessions.</small><br><button class="btn danger" id="clear-hist">Clear all history</button></span></div>`;
}

/* ---------------- events */
document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-dlg], .scrim'); if (!t) return;
  const ans = t.closest('.ans');
  if (t.dataset.ask) { if (!S.busy) ask(t.dataset.ask); else q.value = t.dataset.ask; }
  else if (t.classList.contains('cite')) openEvidence(ans.dataset.rid, t.dataset.c);
  else if ('evidence' in t.dataset) openEvidence(ans.dataset.rid);
  else if (t.dataset.copy === 'answer') copy(S.results.get(ans.dataset.rid).answer, t);
  else if (t.dataset.copy === 'refs') {
    const r = S.results.get(ans.dataset.rid), cited = new Set((r.answer.match(/\[(C\d+)\]/g) || []).map(x => x.slice(1, -1)));
    copy(r.evidence.filter(x => cited.has(x.cid)).map(refText).join('\n') || 'No cited passages.', t);
  } else if (t.dataset.copyref) copy(refText(S.results.get(S.evTurn).evidence.find(x => x.cid === t.dataset.copyref)), t);
  else if ('trace' in t.dataset) { const l = ans.querySelector('.trace'); l.hidden = !l.hidden; }
  else if (t.dataset.chart != null) toggleChart(t);
  else if ('retry' in t.dataset) { const text = ans.dataset.q; ans.closest('.turn').remove(); ask(text); }
  else if (t.dataset.open) { if (!S.busy) { S.active = t.dataset.open; closeEvidence(); renderThread(); renderConvs(); app.classList.remove('drawer-open'); $('#scrim').hidden = true; scroller.scrollTop = 0; } }
  else if (t.dataset.del) { if (!S.busy) { S.convs = S.convs.filter(c => c.id !== t.dataset.del); if (S.active === t.dataset.del) { S.active = null; renderThread(); } persist(); } }
  else if (t.dataset.dlg) { $('#' + t.dataset.dlg).showModal(); app.classList.remove('drawer-open'); $('#scrim').hidden = true; }
  else if ('close' in t.dataset) t.closest('dialog').close();
  else if (t.id === 'new') newAnalysis();
  else if (t.id === 'collapse') { app.classList.toggle('side-collapsed'); t.setAttribute('aria-label', app.classList.contains('side-collapsed') ? 'Expand sidebar' : 'Collapse sidebar'); }
  else if (t.id === 'menu') { app.classList.add('drawer-open'); $('#scrim').hidden = false; }
  else if (t.classList.contains('scrim')) { app.classList.remove('drawer-open'); t.hidden = true; }
  else if (t.id === 'ev-close') closeEvidence();
  else if (t.id === 'story-toggle') setStory(!storyOpen);
  else if (t.id === 'story-fab') setStory(true);
  else if (t.id === 'clear-hist') { S.convs = []; S.active = null; persist(); renderThread(); $('#dlg-settings').close(); }
  else if (t.classList.contains('ev-head')) { const it = t.closest('.ev-item'); it.classList.toggle('open'); t.setAttribute('aria-expanded', it.classList.contains('open')); }
  else if (t.id === 'send' && S.busy) S.abort?.abort();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.co) { t.checked ? S.selCo.add(t.dataset.co) : S.selCo.delete(t.dataset.co); renderScope(); }
  else if (t.dataset.sk) { t.checked ? S.selSk.add(t.dataset.sk) : S.selSk.delete(t.dataset.sk); renderScope(); }
  else if (t.id === 'set-story') { storyHidden = !t.checked; store.set('finora.storyHidden', storyHidden); layoutRail(); }
});
form.addEventListener('submit', e => { e.preventDefault(); ask(q.value); });
q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.busy) ask(q.value); } });
q.addEventListener('input', () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 160) + 'px'; });
$('#convsearch').addEventListener('input', renderConvs);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#ev-panel').hidden && !document.querySelector('dialog[open]')) closeEvidence(); });
window.addEventListener('offline', () => setStatus(false, 'You are offline'));
window.addEventListener('online', () => setStatus(!!S.meta, S.meta ? 'Back online' : 'Backend unavailable'));

init();
