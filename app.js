'use strict';

/* ========== Stav a ukládání ========== */
const LS = 'napady.v1';
const LS_DRAFT = 'napady.draft';
const DEFAULTS = { key: '', model: 'gemini-flash-latest', projects: [], ideas: [] };

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(LS));
    if (d) return Object.assign({}, DEFAULTS, d);
  } catch (e) { /* poškozená data -> začneme znovu */ }
  return Object.assign({}, DEFAULTS, { projects: [], ideas: [] });
}
let S = load();
function save() { localStorage.setItem(LS, JSON.stringify(S)); }

let draft = localStorage.getItem(LS_DRAFT) || '';
let view = 'write';
let curProject = null;          // id projektu v detailu ('' = Nezařazeno)
let ask = { q: '', a: '', busy: false };
let projAnswers = {};           // id projektu -> odpověď "kde jsem skončil"
let busyProj = {};
const audioStore = new Map();   // id nápadu -> nahrávka (jen v paměti, pro opakování)

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ========== Gemini ========== */
async function gemini({ parts, system, schema }) {
  if (!S.key) throw new Error('Chybí API klíč (Nastavení).');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2 }
  };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.model)}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.key },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || ('Chyba ' + r.status));
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('AI nevrátila žádný text.');
  return schema ? JSON.parse(text) : text.trim();
}

const blobToBase64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

function projectContext() {
  if (!S.projects.length) return '(zatím žádné projekty)';
  return S.projects.map(p => {
    const last = S.ideas.filter(i => i.projectId === p.id && (i.summary || i.text)).slice(0, 3)
      .map(i => '   - ' + (i.summary || i.text).slice(0, 120)).join('\n');
    return `• ${p.name}${p.desc ? ' – ' + p.desc : ''}${last ? '\n   Poslední nápady:\n' + last : ''}`;
  }).join('\n');
}

const SORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    clean: { type: 'STRING' },
    project: { type: 'STRING' },
    newProject: { type: 'STRING' },
    summary: { type: 'STRING' }
  },
  required: ['clean', 'project', 'summary']
};

async function enrich(id) {
  const idea = S.ideas.find(i => i.id === id);
  if (!idea) return;
  if (!S.key) { idea.status = 'nokey'; save(); render(); return; }

  const parts = [];
  const blob = audioStore.get(id);
  if (blob) {
    parts.push({ inline_data: { mime_type: (blob.type || 'audio/mp4').split(';')[0], data: await blobToBase64(blob) } });
  }
  if (idea.text) parts.push({ text: 'Text nápadu:\n' + idea.text });
  if (!parts.length) return;

  const system =
`Jsi pomocník pro člověka s krátkou pamětí, který si zapisuje nápady. Dostaneš nápad jako text nebo hlasovou nahrávku (česky).
1) Pokud je to nahrávka, přepiš ji do pole "transcript". U textu nech "transcript" prázdné.
2) Do pole "clean" dej vyčištěný text nápadu: oprav překlepy a vycpávky ("ehm", opakování), ale nic nevymýšlej a zachovej všechny detaily.
3) Do pole "project" dej PŘESNÝ název nejvhodnějšího z existujících projektů. Pokud žádný jasně nesedí, nech prázdné.
4) Pokud žádný projekt nesedí a nápad vypadá jako samostatné téma, navrhni do "newProject" krátký název nového projektu, jinak nech prázdné.
5) Do "summary" dej shrnutí jednou krátkou větou.
Existující projekty:
${projectContext()}`;

  idea.status = blob ? 'transcribing' : 'pending';
  render();
  try {
    const out = await gemini({ parts, system, schema: SORT_SCHEMA });
    if (blob) idea.text = (out.transcript || out.clean || '').trim() || idea.text;
    else if (out.clean) idea.text = out.clean.trim();
    idea.summary = (out.summary || '').trim();
    const match = S.projects.find(p => p.name.toLowerCase() === (out.project || '').trim().toLowerCase());
    idea.projectId = match ? match.id : '';
    idea.suggest = !match && out.newProject ? out.newProject.trim() : '';
    idea.status = 'done';
    idea.err = '';
    audioStore.delete(id);
  } catch (e) {
    idea.status = 'error';
    idea.err = e.message;
  }
  save(); render();
}

/* ========== Zápis nápadu ========== */
async function submit(blob) {
  const text = draft.trim();
  if (!text && !blob) { toast('Nejdřív něco napište nebo nahrajte.'); return; }
  const idea = { id: uid(), text, projectId: '', summary: '', created: Date.now(), status: 'pending' };
  S.ideas.unshift(idea);
  if (blob) audioStore.set(idea.id, blob);
  draft = ''; localStorage.removeItem(LS_DRAFT);
  save(); render();
  toast('Uloženo');
  await enrich(idea.id);
}

/* Nahrávání hlasu */
let rec = null, chunks = [], recording = false;
async function toggleRec() {
  if (recording) { rec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Tento prohlížeč neumí nahrávat.'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recording = false;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' });
      updateRecUI();
      if (blob.size < 1000) { toast('Nahrávka byla příliš krátká.'); return; }
      submit(blob);
    };
    rec.start();
    recording = true;
    updateRecUI();
  } catch (e) {
    toast('Mikrofon není povolený (Nastavení iPhonu → Safari / Nápady → Mikrofon).');
  }
}
const micInner = () => recording ? ic('stop', 'fill') + 'Zastavit' : ic('mic') + 'Nahrát hlas';
function updateRecUI() {
  const b = $('#mic'); if (!b) return;
  b.classList.toggle('rec', recording);
  b.innerHTML = micInner();
}

/* ========== Vykreslování ========== */
const fmt = ts => new Date(ts).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const projName = id => (S.projects.find(p => p.id === id) || {}).name || '';

function ideaCard(i) {
  const name = projName(i.projectId);
  const st = {
    transcribing: ['loader', 'Přepisuji a třídím…', '', 'spin'],
    pending: ['loader', 'Třídím…', '', 'spin'],
    nokey: ['info', 'Uloženo bez AI (chybí API klíč v Nastavení).', '', ''],
    error: ['alert', 'AI se nepovedla, ale nápad je uložený. ' + esc(i.err || ''), 'warn', '']
  }[i.status];
  const status = st ? `<div class="status ${st[2]}">${ic(st[0], st[3])}<span>${st[1]}</span></div>` : '';
  const text = i.text ? esc(i.text) : '<i class="small">(nahrávka zatím není přepsaná)</i>';
  const opts = ['<option value="">Nezařazeno</option>']
    .concat(S.projects.map(p => `<option value="${p.id}" ${p.id === i.projectId ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
  const canRetry = (i.status === 'error' || i.status === 'nokey') && S.key;
  const mk = i.suggest && !i.projectId;
  return `<div class="card">
    <div class="card-top">
      ${name ? `<span class="tag">${esc(name)}</span>` : '<span class="tag none">Nezařazeno</span>'}
      <span class="date">${fmt(i.created)}</span>
    </div>
    <div class="txt">${text}</div>
    ${i.summary && i.summary !== i.text ? `<div class="summary">${ic('sparkles')}<span>${esc(i.summary)}</span></div>` : ''}
    ${status}
    ${mk || canRetry ? `<div class="actions">
      ${mk ? `<button class="btn small soft" data-act="mkproj" data-id="${i.id}">${ic('plus')}Založit projekt „${esc(i.suggest)}“</button>` : ''}
      ${canRetry ? `<button class="btn small ghost" data-act="retry" data-id="${i.id}">${ic('retry')}Zkusit znovu</button>` : ''}
    </div>` : ''}
    <div class="card-foot">
      <select data-act="mv" data-id="${i.id}" aria-label="Projekt">${opts}</select>
      <button class="icon-btn" data-act="del" data-id="${i.id}" aria-label="Smazat">${ic('trash')}</button>
    </div>
  </div>`;
}

const views = {
  write() {
    const recent = S.ideas.slice(0, 6).map(ideaCard).join('');
    return `<h1>Nový nápad</h1>
      <div class="composer">
        <textarea id="draft" placeholder="Co vás napadlo?" enterkeyhint="done">${esc(draft)}</textarea>
        <div class="composer-bar">
          <button class="btn ghost mic ${recording ? 'rec' : ''}" id="mic" data-act="mic" aria-label="Nahrát hlas">${micInner()}</button>
          <button class="btn" data-act="save">Uložit${ic('send')}</button>
        </div>
      </div>
      ${recent ? '<h2>Naposledy</h2>' + recent : ''}`;
  },

  projects() {
    const unsorted = S.ideas.filter(i => !S.projects.some(p => p.id === i.projectId));
    const list = S.projects.map(p => {
      const items = S.ideas.filter(i => i.projectId === p.id);
      const last = items[0];
      return `<button class="proj" data-act="openproj" data-id="${p.id}">
        <div class="body">
          <div class="row"><b>${esc(p.name)}</b><span class="badge">${items.length}</span></div>
          <div class="meta">${last ? esc((last.summary || last.text).slice(0, 110)) : 'Zatím bez nápadů'}</div>
        </div>${ic('right')}
      </button>`;
    }).join('');
    return `<h1>Projekty</h1>
      ${list || `<div class="empty">${ic('folder')}<p>Zatím žádné projekty.<br>Založte první, AI pak bude nápady řadit sama.</p></div>`}
      ${unsorted.length ? `<button class="proj" data-act="openproj" data-id=""><div class="body"><div class="row"><b>Nezařazeno</b><span class="badge">${unsorted.length}</span></div></div>${ic('right')}</button>` : ''}
      <button class="btn" data-act="newproj">${ic('plus')}Nový projekt</button>`;
  },

  project() {
    const isNone = curProject === '';
    const p = S.projects.find(p => p.id === curProject);
    if (!isNone && !p) { view = 'projects'; return views.projects(); }
    const items = S.ideas.filter(i => isNone ? !S.projects.some(x => x.id === i.projectId) : i.projectId === curProject);
    const ans = projAnswers[curProject];
    const busy = busyProj[curProject];
    return `<button class="back" data-act="back">${ic('left')}Projekty</button>
      <h1>${isNone ? 'Nezařazeno' : esc(p.name)}</h1>
      ${!isNone && p.desc ? `<p class="small" style="margin-top:-8px">${esc(p.desc)}</p>` : ''}
      ${!isNone ? `<button class="btn" data-act="where" ${busy ? 'disabled' : ''}>${busy ? ic('loader', 'spin') + 'Čtu zápisky…' : ic('compass') + 'Kde jsem skončil?'}</button>` : ''}
      ${ans ? `<div class="answer">${ic('sparkles')}<div>${esc(ans)}</div></div>` : ''}
      <h2>Nápady · ${items.length}</h2>
      ${items.map(ideaCard).join('') || '<p class="small">Nic tu zatím není.</p>'}
      ${!isNone ? `<div class="actions" style="margin-top:14px">
        <button class="btn ghost small" data-act="editproj">${ic('edit')}Upravit</button>
        <button class="btn ghost small danger" data-act="delproj">${ic('trash')}Smazat projekt</button>
      </div>` : ''}`;
  },

  ask() {
    return `<h1>Zeptat se</h1>
      <p class="small">Zeptejte se na cokoli ze svých zápisků, např. „Co jsem vymýšlel k eshopu?“ nebo „Jaké nápady jsem měl minulý týden?“</p>
      <div class="composer">
        <textarea id="askq" placeholder="Vaše otázka…" style="min-height:90px">${esc(ask.q)}</textarea>
      </div>
      <button class="btn" data-act="doask" ${ask.busy ? 'disabled' : ''}>${ask.busy ? ic('loader', 'spin') + 'Přemýšlím…' : ic('sparkles') + 'Zeptat se'}</button>
      ${ask.a ? `<div class="answer">${ic('sparkles')}<div>${esc(ask.a)}</div></div>` : ''}`;
  },

  settings() {
    return `<h1>Nastavení</h1>
      <div class="group">
        <label for="key">Gemini API klíč</label>
        <input id="key" type="password" autocomplete="off" placeholder="AIza…" value="${esc(S.key)}">
        <small>Zdarma z <b>aistudio.google.com/apikey</b>. Klíč zůstává jen v tomto telefonu.</small>
        <label for="model">Model</label>
        <input id="model" type="text" autocapitalize="off" autocorrect="off" value="${esc(S.model)}">
        <small>Výchozí „gemini-flash-latest“ je rychlý a levný. Při chybě modelu zkuste jiný z AI Studia.</small>
        <button class="btn" data-act="savesettings">${ic('check')}Uložit nastavení</button>
      </div>
      <h2>Záloha</h2>
      <div class="group">
        <small>Data jsou jen v telefonu. Občas je zálohujte.</small>
        <button class="btn ghost" data-act="export">${ic('download')}Exportovat zálohu</button>
        <button class="btn ghost" data-act="import">${ic('upload')}Obnovit ze zálohy</button>
        <input id="file" type="file" accept="application/json,.json" hidden>
      </div>
      <p class="stats"><span>Nápadů: ${S.ideas.length}</span><span>·</span><span>Projektů: ${S.projects.length}</span></p>`;
  }
};

function render() {
  const navView = view === 'project' ? 'projects' : view;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === navView));
  const main = $('#main');
  const scroll = main.scrollTop;
  main.innerHTML = views[view]();
  main.scrollTop = scroll;
}

/* ========== Akce ========== */
const actions = {
  save() { submit(null); },
  mic() { toggleRec(); },

  openproj(el) { curProject = el.dataset.id; view = 'project'; render(); },
  back() { view = 'projects'; render(); },

  newproj() {
    const name = (prompt('Název projektu:') || '').trim();
    if (!name) return;
    const desc = (prompt('Krátký popis (pomáhá AI poznat, co do projektu patří). Můžete nechat prázdné:') || '').trim();
    S.projects.push({ id: uid(), name, desc });
    save(); render(); toast('Projekt založen');
  },
  editproj() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    const name = (prompt('Název projektu:', p.name) || '').trim();
    if (!name) return;
    const desc = prompt('Popis projektu:', p.desc || '');
    p.name = name; if (desc !== null) p.desc = desc.trim();
    save(); render();
  },
  delproj() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    if (!confirm(`Smazat projekt „${p.name}“? Nápady zůstanou jako Nezařazeno.`)) return;
    S.ideas.forEach(i => { if (i.projectId === p.id) i.projectId = ''; });
    S.projects = S.projects.filter(x => x.id !== p.id);
    save(); view = 'projects'; render();
  },
  mkproj(el) {
    const idea = S.ideas.find(i => i.id === el.dataset.id); if (!idea) return;
    const name = (prompt('Název nového projektu:', idea.suggest) || '').trim();
    if (!name) return;
    const p = { id: uid(), name, desc: '' };
    S.projects.push(p);
    idea.projectId = p.id; idea.suggest = '';
    save(); render(); toast('Projekt založen');
  },
  del(el) {
    if (!confirm('Opravdu smazat tento nápad?')) return;
    S.ideas = S.ideas.filter(i => i.id !== el.dataset.id);
    audioStore.delete(el.dataset.id);
    save(); render();
  },
  retry(el) { enrich(el.dataset.id); },

  async where() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    const items = S.ideas.filter(i => i.projectId === p.id && i.text);
    if (!items.length) { toast('V projektu zatím nic není.'); return; }
    busyProj[p.id] = true; render();
    try {
      projAnswers[p.id] = await gemini({
        system: 'Pomáháš člověku s krátkou pamětí. Z jeho zápisků v projektu stručně česky shrň: 1) co k projektu řešil, 2) kde skončil, 3) co by mohl udělat dál. Piš jednoduše, krátce, maximálně 6 vět. Nic si nevymýšlej.',
        parts: [{ text: `Projekt: ${p.name}\n${p.desc || ''}\n\nZápisky (od nejnovějšího):\n` + items.slice(0, 80).map(i => `[${fmt(i.created)}] ${i.text.slice(0, 500)}`).join('\n') }]
      });
    } catch (e) { projAnswers[p.id] = 'Chyba: ' + e.message; }
    busyProj[p.id] = false; render();
  },

  async doask() {
    ask.q = ($('#askq').value || '').trim();
    if (!ask.q) return;
    if (!S.ideas.length) { ask.a = 'Zatím nemáte žádné zápisky.'; render(); return; }
    ask.busy = true; ask.a = ''; render();
    const notes = S.ideas.filter(i => i.text).slice(0, 300)
      .map(i => `[${fmt(i.created)}] [${projName(i.projectId) || 'Nezařazeno'}] ${i.text.slice(0, 400)}`).join('\n');
    try {
      ask.a = await gemini({
        system: 'Odpovídáš česky, stručně a jednoduše (člověk má krátkou paměť). Vycházej pouze z poskytnutých zápisků. Pokud odpověď v zápiscích není, řekni to. Dnes je ' + new Date().toLocaleDateString('cs-CZ') + '.',
        parts: [{ text: `Zápisky (od nejnovějšího):\n${notes}\n\nOtázka: ${ask.q}` }]
      });
    } catch (e) { ask.a = 'Chyba: ' + e.message; }
    ask.busy = false; render();
  },

  savesettings() {
    S.key = ($('#key').value || '').trim();
    S.model = ($('#model').value || '').trim() || DEFAULTS.model;
    save(); toast('Nastavení uloženo');
    // Nápady uložené bez AI se zpracují teď.
    S.ideas.filter(i => i.status === 'nokey').forEach(i => enrich(i.id));
  },

  async export() {
    const json = JSON.stringify({ projects: S.projects, ideas: S.ideas, exported: new Date().toISOString() }, null, 1);
    const name = `napady-zaloha-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  import() { $('#file').click(); }
};

document.addEventListener('click', e => {
  const nav = e.target.closest('nav button');
  if (nav) { view = nav.dataset.v; render(); $('#main').scrollTop = 0; return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'mv') {
    const idea = S.ideas.find(i => i.id === el.dataset.id);
    if (idea) { idea.projectId = el.value; idea.suggest = ''; save(); render(); }
  }
  if (el.id === 'file' && el.files[0]) {
    el.files[0].text().then(t => {
      try {
        const d = JSON.parse(t);
        if (!Array.isArray(d.ideas) || !Array.isArray(d.projects)) throw new Error();
        if (!confirm(`Obnovit ze zálohy (${d.ideas.length} nápadů, ${d.projects.length} projektů)? Současná data budou nahrazena.`)) return;
        S.ideas = d.ideas; S.projects = d.projects; save(); render(); toast('Obnoveno');
      } catch (err) { toast('Soubor zálohy není platný.'); }
    });
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'draft') {
    draft = e.target.value;
    localStorage.setItem(LS_DRAFT, draft);   // rozepsaný nápad přežije zavření appky
  }
});

/* ========== Start ========== */
// Nápady, které při zavření appky zůstaly "ve zpracování", označíme k opakování.
S.ideas.forEach(i => { if (i.status === 'pending' || i.status === 'transcribing') i.status = 'error'; });
save();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
