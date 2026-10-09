// "Inside the AI Workspace": an SVG office scene driven only by real request lifecycle / pipeline stage events.
import { esc } from './markdown.js';

const STATION = { desk: [125, 152], skill: [190, 152], shelf: [48, 152], board: [255, 152], tray: [286, 152] };
const STEP_LABEL = {
  task: 'Task received', plan: 'Understanding the question', skill: 'Selecting analysis skill', retrieve: 'Retrieving evidence',
  generate: 'Drafting the answer', verify: 'Checking citations and figures', cache: 'Reusing a stored answer',
  wait: 'Waiting for the backend (no live stage events)', scope: 'Out of scope: no retrieval needed',
};
const SHORT = t => (t || '').replace(/^CA Auditor\s*[-:]?\s*/i, 'Auditor ').split(/[\s/]+/).slice(0, 2).join(' ').slice(0, 11);

export class Storyboard {
  constructor(root) {
    this.root = root;
    this.skills = [];
    this.reset();
    this.build();
    this.render();
  }
  setSkills(skills) { this.skills = skills; this.build(); this.render(); }

  reset() {
    this.state = 'idle'; this.steps = []; this.station = 'desk'; this.query = ''; this.selected = [];
    this.retrieved = null; this.grounding = null; this.error = ''; this.inferred = false; this.flow = false; this.working = false;
  }
  // ---- lifecycle
  start(query) {
    this.reset(); this.state = 'running'; this.query = query;
    this.steps = [{ id: 'task', status: 'completed' }, { id: 'plan', status: 'pending' }];
    this.station = 'desk'; this.render();
  }
  inferWait() { this.inferred = true; this.setStep('wait', 'running'); this.working = true; this.render(); }
  event(ev) {
    const id = ev.stage;
    if (id === 'cache') { this.steps = this.steps.filter(s => s.id !== 'plan'); this.setStep('cache', 'completed'); }
    else if (id === 'skill') {
      this.selected.push(ev.skill_name); this.station = 'skill';
      const ex = this.steps.find(s => s.id === 'skill');
      this.setStep('skill', 'completed', 'Skill: ' + this.selected.map(n => this.titleOf(n)).join(', '));
      if (!ex) this.steps.splice(this.steps.findIndex(s => s.id === 'plan') + 1, 0, this.steps.pop());
    } else {
      this.setStep(id, ev.status, null);
      if (id === 'plan' && ev.status === 'completed') {
        this.planInfo = ev;
        if (ev.intent === 'out_of_scope') this.setStep('scope', 'skipped');
      }
      if (id === 'retrieve') { this.station = 'shelf'; this.flow = ev.status === 'running'; if (ev.status === 'completed') this.retrieved = ev; }
      if (id === 'generate') { this.station = 'desk'; this.flow = false; }
      if (id === 'verify') { this.station = 'board'; if (ev.status === 'completed') this.grounding = ev.grounding; }
      if (id === 'plan') this.station = 'desk';
    }
    this.working = ev.status === 'running' || id === 'skill';
    this.msg = ev.display_message; this.render();
  }
  done(result) {
    if (this.inferred) { this.steps = this.steps.filter(s => s.id !== 'wait'); this.reconstruct(result); }
    this.steps.forEach(s => { if (s.status === 'running') s.status = 'completed'; });
    this.steps = this.steps.filter(s => s.status !== 'pending');
    this.state = 'done'; this.station = 'tray'; this.flow = false; this.working = false; this.msg = ''; this.render();
  }
  fail(message) {
    this.steps.forEach(s => { if (s.status === 'running' || s.status === 'pending') { if (s.status === 'running') s.status = 'failed'; } });
    if (!this.steps.some(s => s.status === 'failed')) { const p = this.steps.find(s => s.status === 'pending'); if (p) p.status = 'failed'; }
    this.steps = this.steps.filter(s => s.status !== 'pending');
    this.state = 'failed'; this.error = message; this.flow = false; this.working = false; this.station = 'desk'; this.render();
  }
  reconstruct(r) {   // fallback path: only what the final response itself confirms
    const add = (id, label) => this.steps.push({ id, status: 'completed', label });
    add('plan', `Question classified as '${r.plan.intent}' (from response)`);
    if (r.plan.skills?.length) { this.selected = r.plan.skills; add('skill', 'Skill: ' + r.plan.skills.map(n => this.titleOf(n)).join(', ')); }
    if (r.plan.intent !== 'out_of_scope') add('retrieve', `Retrieved ${r.evidence.length} evidence items (from response)`);
    if (r.grounding) { this.grounding = r.grounding.status; add('verify', 'Grounding check: ' + r.grounding.status); }
    this.retrieved = { count: r.evidence.length };
  }
  setStep(id, status, label) {
    let s = this.steps.find(x => x.id === id);
    if (!s) { s = { id, status }; this.steps.push(s); }
    s.status = status; if (label) s.label = label;
  }
  titleOf(name) { return this.skills.find(s => s.name === name)?.title || name.replace(/_/g, ' '); }

  // ---- drawing
  build() {
    const cards = this.skills.slice(0, 6).map((s, i) => {
      const x = 106 + (i % 3) * 38, y = 28 + Math.floor(i / 3) * 24;
      return `<g data-skill="${esc(s.name)}"><rect class="skill-card" x="${x}" y="${y}" width="35" height="20" rx="3"/><text x="${x + 17.5}" y="${y + 12.5}" font-size="5.6" text-anchor="middle" fill="#302E29">${esc(SHORT(s.title))}</text></g>`;
    }).join('');
    const books = [['#8A7652', 20], ['#A7A98B', 24], ['#C7A889', 18], ['#8A7652', 22], ['#A7A98B', 16]].map((b, i) => `<rect x="${14 + i * 11}" y="${58 - b[1] + 6}" width="9" height="${b[1]}" rx="1" fill="${b[0]}"/>`).join('')
      + [['#C7A889', 22], ['#8A7652', 18], ['#A7A98B', 24], ['#C7A889', 20], ['#8A7652', 16]].map((b, i) => `<rect x="${14 + i * 11}" y="${92 - b[1] + 6}" width="9" height="${b[1]}" rx="1" fill="${b[0]}"/>`).join('');
    const docs = [0, 1, 2].map(i => `<rect class="s-doc s-flying" x="${30 + i * 4}" y="${84 + i * 4}" width="14" height="18" rx="1.5" style="--dx:${86 - i * 4}px;--dy:${44 - i * 4}px;animation-delay:${i * 0.45}s"/>`).join('');
    this.root.innerHTML = `
      <div class="scene"><svg id="sc" viewBox="0 0 320 180" role="img" aria-label="Animated office scene showing the current stage of the AI analyst's work">
        <rect width="320" height="180" fill="#FAF9F6"/><rect y="156" width="320" height="24" fill="#F4F1EB"/>
        <g><rect x="8" y="22" width="76" height="86" rx="4" fill="#fff" stroke="#D9D2C5"/><line x1="8" x2="84" y1="64" y2="64" stroke="#D9D2C5"/>${books}<text x="46" y="118" font-size="6.5" text-anchor="middle" fill="#6B675E">Report library</text></g>
        <g><rect x="100" y="18" width="120" height="58" rx="4" fill="#fff" stroke="#D9D2C5"/>${cards}<text x="160" y="85" font-size="6.5" text-anchor="middle" fill="#6B675E">Analysis skills</text></g>
        <g><rect x="232" y="18" width="80" height="62" rx="4" fill="#fff" stroke="#D9D2C5"/><text id="ev-t1" x="272" y="38" font-size="7" text-anchor="middle" fill="#302E29"></text><text id="ev-t2" x="272" y="50" font-size="6" text-anchor="middle" fill="#6B675E"></text><text id="ev-t3" x="272" y="66" font-size="6.5" text-anchor="middle" fill="#64816A"></text><text x="272" y="89" font-size="6.5" text-anchor="middle" fill="#6B675E">Evidence board</text></g>
        <g><rect x="92" y="126" width="136" height="8" rx="2" fill="#C7A889"/><rect x="100" y="134" width="5" height="22" fill="#A98F70"/><rect x="215" y="134" width="5" height="22" fill="#A98F70"/>
          <rect x="146" y="104" width="38" height="22" rx="2" fill="#fff" stroke="#8A7652"/><line x1="152" x2="178" y1="111" y2="111" stroke="#C7A889"/><line x1="152" x2="172" y1="117" y2="117" stroke="#E8E3DA"/><rect x="161" y="126" width="8" height="2" fill="#8A7652"/></g>
        <g><rect x="250" y="134" width="60" height="10" rx="2" fill="#C7A889"/><rect x="254" y="144" width="4" height="12" fill="#A98F70"/><rect x="302" y="144" width="4" height="12" fill="#A98F70"/><g class="report"><rect x="262" y="118" width="22" height="18" rx="1.5" fill="#fff" stroke="#8A7652"/><line x1="266" x2="280" y1="124" y2="124" stroke="#C7A889"/><line x1="266" x2="276" y1="129" y2="129" stroke="#E8E3DA"/></g><text x="280" y="167" font-size="6.5" text-anchor="middle" fill="#6B675E">Output tray</text></g>
        ${docs}
        <g class="analyst" id="analyst"><ellipse cx="0" cy="1" rx="10" ry="2.5" fill="#E8E3DA"/><rect x="-7" y="-30" width="14" height="28" rx="6" fill="#A7A98B"/><circle cy="-37" r="7" fill="#E9D8C4" stroke="#C7A889"/><path d="M-7-39c1-6 13-6 14 0" fill="#6F5D3C"/><g class="arm"><path d="M6-26l9 8" stroke="#8A7652" stroke-width="3.2" stroke-linecap="round"/></g><g class="fail-mark"><circle cx="12" cy="-48" r="6" fill="#B66D63"/><text x="12" y="-45.5" font-size="8" text-anchor="middle" fill="#fff" font-weight="700">!</text></g></g>
      </svg></div>
      <div class="story-now" id="now" aria-live="polite"></div>
      <ol class="steps" id="steps"></ol>
      <div class="story-note" id="snote"></div>`;
  }

  render() {
    const sc = this.root.querySelector('svg'); if (!sc) return;
    sc.classList.toggle('flow', this.flow);
    sc.classList.toggle('done', this.state === 'done');
    sc.classList.toggle('fail', this.state === 'failed');
    sc.classList.toggle('working', this.working && this.state === 'running');
    const [x, y] = STATION[this.station] || STATION.desk;
    sc.querySelector('#analyst').style.transform = `translate(${x}px,${y}px)`;
    sc.querySelectorAll('[data-skill]').forEach(g => g.firstElementChild.classList.toggle('sel', this.selected.includes(g.dataset.skill)));
    const t = (id, v) => { sc.querySelector(id).textContent = v || ''; };
    t('#ev-t1', this.retrieved ? `${this.retrieved.count} evidence items` : '');
    t('#ev-t2', this.retrieved?.sources?.length ? this.retrieved.sources.map(s => s.replace('_', ' ')).join(', ').slice(0, 30) : '');
    t('#ev-t3', this.grounding ? 'Grounding: ' + this.grounding : '');

    const now = this.root.querySelector('#now');
    const head = { idle: 'Idle', running: 'Working', done: 'Analysis ready', failed: 'Stopped: request failed' }[this.state];
    let body = '';
    if (this.state === 'idle') body = 'Waiting for your next question.';
    else if (this.state === 'running') body = this.msg || 'Request sent to the backend.';
    else if (this.state === 'failed') body = this.error || 'The request did not complete.';
    else body = 'The completed answer is in the conversation.';
    now.innerHTML = `<b>${esc(head)}</b>${this.query ? `<span title="${esc(this.query)}">Task: “${esc(this.query.length > 90 ? this.query.slice(0, 89) + '…' : this.query)}”</span><br>` : ''}${esc(body)}`;
    this.root.querySelector('#steps').innerHTML = this.steps.map(s =>
      `<li class="${s.status}"><i aria-hidden="true"></i><span>${esc(s.label || STEP_LABEL[s.id] || s.id)}<span class="sr-only"> (${s.status})</span></span></li>`).join('');
    this.root.querySelector('#snote').textContent = this.inferred
      ? 'Live stage events were unavailable; stages are reconstructed from the final response only.'
      : (this.state === 'idle' ? 'Stages shown are reported by the backend as each step runs.' : '');
  }
}
