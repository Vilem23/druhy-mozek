'use strict';

/* ========== Stav a ukládání ========== */
const LS = 'napady.v1';
const LS_DRAFT = 'napady.draft';
// "gemini-flash-latest" ukazuje na preview model, který bývá přetížený, proto stabilní verze.
const DEFAULTS = { key: '', model: 'gemini-2.5-flash', projects: [], ideas: [] };
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(LS));
    if (d) {
      if (d.model === 'gemini-flash-latest') d.model = DEFAULTS.model;   // starý výchozí model
      return Object.assign({}, DEFAULTS, d);
    }
  } catch (e) { /* poškozená data -> začneme znovu */ }
  return Object.assign({}, DEFAULTS, { projects: [], ideas: [] });
}
let S = load();
function save() { localStorage.setItem(LS, JSON.stringify(S)); }

let draft = localStorage.getItem(LS_DRAFT) || '';
let view = 'write';
let curProject = null;          // id projektu v detailu ('' = Nezařazeno)
let projAnswers = {};           // id projektu -> odpověď "kde jsem skončil"
let busyProj = {};
const busyCheck = new Set();    // id nápadů, u kterých se právě tvoří checklist
const showOrig = new Set();    // id nápadů, u kterých je teď vidět původní zápis
let testRes = null;            // výsledek "Otestovat spojení" v Nastavení
const audioStore = new Map();   // id nápadu -> nahrávka (jen v paměti, pro opakování)

function toast(msg, undoable) {
  const t = $('#toast');
  if (undoable) t.innerHTML = `<span>${esc(msg)}</span><button data-act="undo">Vrátit</button>`;
  else t.textContent = msg;
  t.classList.toggle('act', !!undoable);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), undoable ? 7000 : 2600);
}

/* ========== Vrácení kroku ==========
   Před každou změnou dat (mazání, přesun, úprava projektu, zásah AI…) se uloží kopie dat.
   Vrátit jde až posledních 10 kroků, od nejnovějšího. */
const LS_UNDO = 'napady.undo';
let undoStack = [];
try { undoStack = JSON.parse(localStorage.getItem(LS_UNDO)) || []; } catch (e) { /* prázdné */ }
if (!Array.isArray(undoStack)) undoStack = [];
function saveUndo() {
  for (;;) {
    try { localStorage.setItem(LS_UNDO, JSON.stringify(undoStack)); return; }
    catch (e) { if (undoStack.length <= 1) return; undoStack.shift(); }   // plné úložiště: zahodit nejstarší
  }
}
function checkpoint(label, data) {
  const e = { id: uid(), label, at: Date.now(), data: data || JSON.stringify({ projects: S.projects, ideas: S.ideas }) };
  undoStack.push(e);
  if (undoStack.length > 10) undoStack.shift();
  saveUndo();
  return e;
}
function undoLast() {
  const e = undoStack.pop();
  if (!e) { toast('Není co vracet.'); return; }
  try {
    const d = JSON.parse(e.data);
    if (!Array.isArray(d.ideas) || !Array.isArray(d.projects)) throw new Error();
    S.projects = d.projects; S.ideas = d.ideas; save();
  } catch (err) { toast('Vrácení se nepovedlo.'); return; }
  saveUndo();
  if (typeof chat !== 'undefined') { chat.msgs.forEach(m => { if (m.undoId === e.id) m.undone = true; }); saveChat(); }
  render();
  toast('Vráceno: ' + e.label);
}

/* ========== Gemini ========== */
/* Jedno volání Gemini. Vybraný model první; když je přetížený (429/5xx) nebo neexistuje (404), zkusí se záložní. */
async function geminiCall(body, valid = j => j?.candidates?.[0]?.content?.parts?.length) {
  if (!S.key) throw new Error('Chybí API klíč (Nastavení).');
  if (/[^\x21-\x7E]/.test(S.key)) throw new Error('API klíč obsahuje mezeru nebo neplatný znak. Vložte ho znovu v Nastavení.');
  let lastErr;
  for (const model of [...new Set([S.model, ...FALLBACK_MODELS])]) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.key },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('Nelze se spojit s Gemini (' + e.message + '). Zkontrolujte internet a že je API klíč vložený celý.');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      lastErr = new Error(j?.error?.message || ('Chyba ' + r.status));
      if ([404, 429, 500, 503, 504].includes(r.status)) continue;
      throw lastErr;
    }
    if (!valid(j)) { lastErr = new Error('AI nevrátila žádný text.'); continue; }
    return j;
  }
  throw lastErr;
}

const textOf = j => j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

async function gemini({ parts, system, schema }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2 }
  };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const j = await geminiCall(body, textOf);
  return schema ? JSON.parse(textOf(j)) : textOf(j).trim();
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
    summary: { type: 'STRING' },
    checklist: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['clean', 'project', 'summary']
};

const toChecklist = arr => (Array.isArray(arr) ? arr : [])
  .map(t => String(t).trim()).filter(Boolean).slice(0, 20).map(t => ({ t, done: false }));
const checkText = i => (i.checklist && i.checklist.length)
  ? ' Checklist: ' + i.checklist.map(c => `[${c.done ? 'x' : ' '}] ${c.t}`).join('; ') : '';

async function enrich(id) {
  const idea = S.ideas.find(i => i.id === id);
  if (!idea) return;
  if (!S.key) { idea.status = 'nokey'; save(); render(); return; }

  const parts = [];
  const blob = audioStore.get(id);
  if (blob) {
    parts.push({ inline_data: { mime_type: (blob.type || 'audio/mp4').split(';')[0], data: await blobToBase64(blob) } });
  }
  const said = idea.original || idea.text;     // vždy posíláme původní znění, ne už upravený text
  if (said) parts.push({ text: 'Text nápadu:\n' + said });
  if (!parts.length) return;

  const system =
`Jsi pomocník pro člověka s krátkou pamětí, který si zapisuje nápady. Dostaneš nápad jako text nebo hlasovou nahrávku (česky).
1) Pokud je to nahrávka, přepiš ji DOSLOVA do pole "transcript" (bez úprav). U textu nech "transcript" prázdné.
2) Do pole "clean" dej nápad přepsaný do přehledného, lépe zorganizovaného textu: oprav překlepy a vycpávky ("ehm", opakování), seřaď myšlenky logicky a rozděl je do krátkých odstavců. Pokud nápad obsahuje více bodů, kroků nebo úkolů, napiš je jako odrážky, každou na novém řádku začínající "- ". Používej jen prostý text (žádný markdown, žádné hvězdičky ani #). Nic nevymýšlej a nepřidávej nové informace, zachovej všechny detaily, čísla a jména. Krátkou jednoduchou větu jen vyčisti, nedělej z ní zbytečně dlouhý text. Pokud vyplníš "checklist" (bod 6), úkoly v "clean" neopakuj jako odrážky; nech tam jen krátký souvislý kontext nápadu.
3) Do pole "project" dej PŘESNÝ název nejvhodnějšího z existujících projektů. Pokud žádný jasně nesedí, nech prázdné.
4) Pokud žádný projekt nesedí a nápad vypadá jako samostatné téma, navrhni do "newProject" krátký název nového projektu, jinak nech prázdné.
5) Do "summary" dej shrnutí jednou krátkou větou.
6) Pokud nápad obsahuje více konkrétních úkolů, kroků nebo věcí k udělání (nebo o checklist uživatel výslovně řekne), dej je do pole "checklist" jako krátké samostatné položky (jedna úloha na položku, stručně, max. 20 položek, nic nevymýšlej). U nápadu, který úkoly nemá, nech "checklist" prázdné pole.
Existující projekty:
${projectContext()}`;

  idea.status = blob ? 'transcribing' : 'pending';
  render();
  try {
    const out = await gemini({ parts, system, schema: SORT_SCHEMA });
    // original = co uživatel skutečně řekl/napsal; text = přehledná verze od AI
    if (blob) idea.original = (out.transcript || out.clean || '').trim() || idea.original || idea.text;
    else if (!idea.original) idea.original = idea.text;
    idea.text = (out.clean || '').trim() || idea.original;
    idea.summary = (out.summary || '').trim();
    const items = toChecklist(out.checklist);
    if (items.length) idea.checklist = items;
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
  const idea = { id: uid(), text, original: text, projectId: '', summary: '', created: Date.now(), status: 'pending' };
  S.ideas.unshift(idea);
  if (blob) audioStore.set(idea.id, blob);
  draft = ''; localStorage.removeItem(LS_DRAFT);
  save(); render();
  toast('Uloženo');
  await enrich(idea.id);
}

/* Nahrávání hlasu */
let rec = null, chunks = [], recording = false, recTarget = 'idea';
async function toggleRec() {
  if (recording) { rec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Tento prohlížeč neumí nahrávat.'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recTarget = view === 'chat' ? 'chat' : 'idea';
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recording = false;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' });
      updateRecUI();
      if (blob.size < 1000) { toast('Nahrávka byla příliš krátká.'); return; }
      recTarget === 'chat' ? sendChat('', blob) : submit(blob);
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
  const b = $('#mic');
  if (b) { b.classList.toggle('rec', recording); b.innerHTML = micInner(); }
  const c = $('#chatmic');
  if (c) { c.classList.toggle('rec', recording); c.innerHTML = recording ? ic('stop', 'fill') : ic('mic'); }
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
  const hasOrig = !!i.original && i.original !== i.text;
  const orig = hasOrig && showOrig.has(i.id);
  const canRetry = (i.status === 'error' || i.status === 'nokey') && S.key;
  const mk = i.suggest && !i.projectId;
  const cl = i.checklist || [];
  const busy = busyCheck.has(i.id);
  const canCheck = !cl.length && i.status === 'done' && i.text && S.key;
  const checklist = cl.length ? `<div class="check-head"><span>Checklist · ${cl.filter(c => c.done).length}/${cl.length}</span>
      <button class="icon-btn mini" data-act="delcheck" data-id="${i.id}" aria-label="Odebrat checklist">${ic('trash')}</button></div>
    <div class="check">${cl.map((c, n) => `<button class="item ${c.done ? 'done' : ''}" data-act="tick" data-id="${i.id}" data-n="${n}" aria-pressed="${c.done}">
      <span class="box">${c.done ? ic('check') : ''}</span><span>${esc(c.t)}</span></button>`).join('')}</div>` : '';
  return `<div class="card">
    <div class="card-top">
      ${name ? `<span class="tag">${esc(name)}</span>` : '<span class="tag none">Nezařazeno</span>'}
      <span class="card-meta"><span class="date">${fmt(i.created)}</span>${hasOrig
        ? `<button class="icon-btn mini ${orig ? 'on' : ''}" data-act="toggleorig" data-id="${i.id}" aria-pressed="${orig}" aria-label="${orig ? 'Zobrazit upravený text' : 'Zobrazit původní zápis'}">${ic('quote')}</button>` : ''}</span>
    </div>
    ${orig ? '<div class="orig-label">Původní zápis</div>' : ''}
    <div class="txt ${orig ? 'orig' : ''}">${orig ? esc(i.original) : text}</div>
    ${checklist}
    ${i.summary && i.summary !== i.text ?`<div class="summary">${ic('sparkles')}<span>${esc(i.summary)}</span></div>` : ''}
    ${status}
    ${mk || canRetry || canCheck ? `<div class="actions">
      ${canCheck ? `<button class="btn small ghost" data-act="mkcheck" data-id="${i.id}" ${busy ? 'disabled' : ''}>${busy ? ic('loader', 'spin') + 'Tvořím…' : ic('list') + 'Udělat checklist'}</button>` : ''}
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

  settings() {
    return `<h1>Nastavení</h1>
      <div class="group">
        <label for="key">Gemini API klíč</label>
        <input id="key" type="password" autocomplete="off" placeholder="AIza…" value="${esc(S.key)}">
        <small>Zdarma z <b>aistudio.google.com/apikey</b>. Klíč zůstává jen v tomto telefonu.</small>
        <label for="model">Model</label>
        <input id="model" type="text" autocapitalize="off" autocorrect="off" value="${esc(S.model)}">
        <small>Výchozí „gemini-2.5-flash“ je stabilní a rychlý. Když je přetížený, appka sama zkusí záložní model.</small>
        <button class="btn" data-act="savesettings">${ic('check')}Uložit nastavení</button>
        <button class="btn ghost" data-act="testkey" ${testRes && testRes.busy ? 'disabled' : ''}>${testRes && testRes.busy ? ic('loader', 'spin') + 'Zkouším…' : ic('sparkles') + 'Otestovat spojení'}</button>
        ${testRes && !testRes.busy ? `<div class="status ${testRes.ok ? '' : 'warn'}">${ic(testRes.ok ? 'check' : 'alert')}<span>${esc(testRes.msg)}</span></div>` : ''}
      </div>
      <h2>Záloha</h2>
      <div class="group">
        <small>Data jsou jen v telefonu. Občas je zálohujte.</small>
        <button class="btn ghost" data-act="export">${ic('download')}Exportovat zálohu</button>
        <button class="btn ghost" data-act="import">${ic('upload')}Obnovit ze zálohy</button>
        <input id="file" type="file" accept="application/json,.json" hidden>
      </div>
      <h2>Vrátit krok</h2>
      <div class="group">
        <small>${undoStack.length
          ? `Poslední krok: <b>${esc(undoStack[undoStack.length - 1].label)}</b> (${fmt(undoStack[undoStack.length - 1].at)}). Před každou změnou se stav uloží, vrátit jde až posledních 10 kroků.`
          : 'Zatím není co vracet. Před každou změnou (mazání, přesun, zásah AI…) se stav uloží a půjde vrátit.'}</small>
        <button class="btn ghost" data-act="undo" ${undoStack.length ? '' : 'disabled'}>${ic('retry')}Vrátit poslední krok</button>
      </div>
      <p class="stats"><span>Nápadů: ${S.ideas.length}</span><span>·</span><span>Projektů: ${S.projects.length}</span></p>`;
  }
};

function render() {
  const navView = view === 'project' ? 'projects' : view;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === navView));
  const main = $('#main');
  const scroll = main.scrollTop;
  const chatView = view === 'chat';
  main.classList.toggle('chatview', chatView);
  main.innerHTML = views[view]();
  main.scrollTop = chatView ? main.scrollHeight : scroll;
  if (chatView) { const q = $('#chatq'); if (q) autosize(q); }
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
    checkpoint('Nový projekt');
    S.projects.push({ id: uid(), name, desc });
    save(); render(); toast('Projekt založen', true);
  },
  editproj() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    const name = (prompt('Název projektu:', p.name) || '').trim();
    if (!name) return;
    const desc = prompt('Popis projektu:', p.desc || '');
    checkpoint('Upraven projekt');
    p.name = name; if (desc !== null) p.desc = desc.trim();
    save(); render();
  },
  delproj() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    checkpoint('Smazán projekt');
    S.ideas.forEach(i => { if (i.projectId === p.id) i.projectId = ''; });
    S.projects = S.projects.filter(x => x.id !== p.id);
    save(); view = 'projects'; render(); toast('Projekt smazán, nápady jsou v Nezařazeno', true);
  },
  mkproj(el) {
    const idea = S.ideas.find(i => i.id === el.dataset.id); if (!idea) return;
    const name = (prompt('Název nového projektu:', idea.suggest) || '').trim();
    if (!name) return;
    const p = { id: uid(), name, desc: '' };
    checkpoint('Nový projekt');
    S.projects.push(p);
    idea.projectId = p.id; idea.suggest = '';
    save(); render(); toast('Projekt založen', true);
  },
  del(el) {
    if (!S.ideas.some(i => i.id === el.dataset.id)) return;
    checkpoint('Smazán nápad');
    S.ideas = S.ideas.filter(i => i.id !== el.dataset.id);
    audioStore.delete(el.dataset.id);
    save(); render(); toast('Nápad smazán', true);
  },
  undo() { undoLast(); },
  retry(el) { enrich(el.dataset.id); },
  tick(el) {
    const idea = S.ideas.find(i => i.id === el.dataset.id);
    const c = idea && idea.checklist && idea.checklist[+el.dataset.n];
    if (!c) return;
    c.done = !c.done; save(); render();
  },
  delcheck(el) {
    const idea = S.ideas.find(i => i.id === el.dataset.id); if (!idea) return;
    checkpoint('Odebrán checklist');
    delete idea.checklist; save(); render(); toast('Checklist odebrán', true);
  },
  async mkcheck(el) {
    const idea = S.ideas.find(i => i.id === el.dataset.id); if (!idea) return;
    busyCheck.add(idea.id); render();
    try {
      const out = await gemini({
        system: 'Z textu nápadu vytvoř checklist: krátké samostatné úkoly nebo kroky (jeden na položku, maximálně 20, česky). Nic nevymýšlej a nepřidávej, co v textu není. Pokud text nemá žádné konkrétní úkoly, rozděl nápad na rozumné kroky, jak ho zrealizovat.',
        parts: [{ text: idea.original || idea.text }],
        schema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['items'] }
      });
      const items = toChecklist(out.items);
      if (items.length) { checkpoint('Vytvořen checklist'); idea.checklist = items; } else toast('AI žádné položky nenašla.');
      save();
    } catch (e) { toast(e.message.slice(0, 120)); }
    busyCheck.delete(idea.id); render();
  },
  toggleorig(el) {
    const id = el.dataset.id;
    showOrig.has(id) ? showOrig.delete(id) : showOrig.add(id);
    render();
  },

  async where() {
    const p = S.projects.find(p => p.id === curProject); if (!p) return;
    const items = S.ideas.filter(i => i.projectId === p.id && i.text);
    if (!items.length) { toast('V projektu zatím nic není.'); return; }
    busyProj[p.id] = true; render();
    try {
      projAnswers[p.id] = await gemini({
        system: 'Pomáháš člověku s krátkou pamětí. Z jeho zápisků v projektu stručně česky shrň: 1) co k projektu řešil, 2) kde skončil, 3) co by mohl udělat dál. Piš jednoduše, krátce, maximálně 6 vět. Nic si nevymýšlej.',
        parts: [{ text: `Projekt: ${p.name}\n${p.desc || ''}\n\nZápisky (od nejnovějšího):\n` + items.slice(0, 80).map(i => `[${fmt(i.created)}] ${i.text.slice(0, 500)}${checkText(i)}`).join('\n') }]
      });
    } catch (e) { projAnswers[p.id] = 'Chyba: ' + e.message; }
    busyProj[p.id] = false; render();
  },

  savesettings() {
    S.key = ($('#key').value || '').replace(/\s+/g, '');
    S.model = ($('#model').value || '').trim() || DEFAULTS.model;
    save(); toast('Nastavení uloženo');
    // Nápady uložené bez AI se zpracují teď.
    S.ideas.filter(i => i.status === 'nokey').forEach(i => enrich(i.id));
  },

  async testkey() {
    actions.savesettings();
    testRes = { busy: true }; render();
    const probe = async (label, fn) => {
      try { await fn(); return `${label}: OK`; } catch (e) { return `${label}: selhalo (${e.message})`; }
    };
    const lines = [
      await probe('Internet', () => fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store' })),
      await probe('Server Google AI', () => fetch('https://generativelanguage.googleapis.com/', { mode: 'no-cors', cache: 'no-store' }))
    ];
    let ok = false;
    try {
      await gemini({ system: 'Odpovídej jedním slovem.', parts: [{ text: 'Odpověz: OK' }] });
      lines.push('Gemini: OK'); ok = true;
    } catch (e) { lines.push('Gemini: ' + e.message); }
    testRes = { ok, msg: lines.join('\n') };
    render();
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
    if (idea) { checkpoint('Přesunut nápad'); idea.projectId = el.value; idea.suggest = ''; save(); render(); toast('Nápad přesunut', true); }
  }
  if (el.id === 'file' && el.files[0]) {
    el.files[0].text().then(t => {
      try {
        const d = JSON.parse(t);
        if (!Array.isArray(d.ideas) || !Array.isArray(d.projects)) throw new Error();
        if (!confirm(`Obnovit ze zálohy (${d.ideas.length} nápadů, ${d.projects.length} projektů)? Současná data budou nahrazena.`)) return;
        checkpoint('Obnovení ze zálohy');
        S.ideas = d.ideas; S.projects = d.projects; save(); render(); toast('Obnoveno', true);
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

/* ========== Potažení dolů = obnovit appku ========== */
(() => {
  const main = $('#main'), ptr = $('#ptr');
  const TRIGGER = 56, MAX = 84;
  let y0 = null, pull = 0;
  const show = px => {
    ptr.style.opacity = Math.min(1, px / 30);
    ptr.style.transform = `translate(-50%, ${px - 70}px)`;
    ptr.firstElementChild.style.transform = `rotate(${px * 4}deg)`;
  };
  main.addEventListener('touchstart', e => {
    const free = main.scrollTop <= 0 && !recording && !e.target.closest('textarea,input,select');
    y0 = free ? e.touches[0].clientY : null;
    pull = 0;
    ptr.classList.remove('snap');
  }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (y0 === null) return;
    if (main.scrollTop > 0) { y0 = null; show(0); return; }
    pull = Math.max(0, Math.min(MAX, (e.touches[0].clientY - y0) * 0.5));
    show(pull);
  }, { passive: true });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    ptr.classList.add('snap');
    if (pull >= TRIGGER) {
      show(TRIGGER);
      ptr.firstElementChild.classList.add('spin');
      setTimeout(() => location.reload(), 250);
    } else show(0);
    pull = 0;
  };
  main.addEventListener('touchend', end);
  main.addEventListener('touchcancel', end);
})();

/* ========== Start ========== */
// Nápady, které při zavření appky zůstaly "ve zpracování", označíme k opakování.
S.ideas.forEach(i => { if (i.status === 'pending' || i.status === 'transcribing') i.status = 'error'; });
save();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
