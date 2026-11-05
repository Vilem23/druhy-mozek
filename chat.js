'use strict';

/* ========== AI chat ==========
   Odpovídá na cokoli a přes nástroje (function calling) umí upravovat nápady, projekty a checklisty.
   Před každým zásahem se přes checkpoint() uloží kopie dat, aby šlo tlačítkem „Vrátit změny“ zásah vrátit. */
const LS_CHAT = 'napady.chat';
const chat = { msgs: [], draft: '', busy: false, label: '' };
try { chat.msgs = JSON.parse(localStorage.getItem(LS_CHAT)) || []; } catch (e) { /* prázdná konverzace */ }
if (!Array.isArray(chat.msgs)) chat.msgs = [];
const saveChat = () => { try { localStorage.setItem(LS_CHAT, JSON.stringify(chat.msgs.slice(-40))); } catch (e) { /* plné úložiště */ } };

/* ---------- Nástroje pro AI ---------- */
const CHECK_ITEMS = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, done: { type: 'BOOLEAN' } }, required: ['text'] }
};
const CHAT_TOOLS = [{
  functionDeclarations: [
    {
      name: 'update_idea',
      description: 'Upraví existující nápad. Uvedená pole se přepíšou, neuvedená zůstanou. "checklist" nahradí CELÝ checklist (prázdné pole ho odstraní).',
      parameters: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          text: { type: 'STRING', description: 'Nový text nápadu' },
          summary: { type: 'STRING', description: 'Shrnutí jednou větou' },
          project_id: { type: 'STRING', description: 'id projektu, nebo prázdný řetězec pro Nezařazeno' },
          checklist: CHECK_ITEMS
        },
        required: ['id']
      }
    },
    {
      name: 'create_idea',
      description: 'Založí nový nápad (zápisek), volitelně s checklistem a projektem.',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' }, summary: { type: 'STRING' },
          project_id: { type: 'STRING', description: 'id existujícího projektu nebo prázdné' },
          checklist: CHECK_ITEMS
        },
        required: ['text']
      }
    },
    {
      name: 'delete_ideas',
      description: 'Smaže nápady podle id.',
      parameters: { type: 'OBJECT', properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['ids'] }
    },
    {
      name: 'merge_ideas',
      description: 'Sloučí zdrojové nápady do cílového: spojí jejich checklisty (bez duplicit) i texty a zdrojové nápady smaže. Pokud zadáš "text", použije se jako výsledný text.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target_id: { type: 'STRING' },
          source_ids: { type: 'ARRAY', items: { type: 'STRING' } },
          text: { type: 'STRING' }
        },
        required: ['target_id', 'source_ids']
      }
    },
    {
      name: 'create_project',
      description: 'Založí nový projekt a vrátí jeho id.',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, desc: { type: 'STRING' } }, required: ['name'] }
    },
    {
      name: 'update_project',
      description: 'Přejmenuje projekt nebo změní jeho popis.',
      parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' }, name: { type: 'STRING' }, desc: { type: 'STRING' } }, required: ['id'] }
    },
    {
      name: 'delete_project',
      description: 'Smaže projekt. Nápady v něm se standardně přesunou do Nezařazeno; s delete_ideas=true se smažou také.',
      parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' }, delete_ideas: { type: 'BOOLEAN' } }, required: ['id'] }
    }
  ]
}];

const shortT = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const findIdea = id => S.ideas.find(i => i.id === String(id));
const findProject = v => {
  const s = String(v ?? '').trim();
  return S.projects.find(p => p.id === s) || S.projects.find(p => p.name.toLowerCase() === s.toLowerCase());
};
// '' = Nezařazeno, undefined = projekt neexistuje
const projId = v => { if (v === '' || v == null) return ''; const p = findProject(v); return p ? p.id : undefined; };
const cleanList = arr => (Array.isArray(arr) ? arr : [])
  .map(c => typeof c === 'string' ? { t: c.trim(), done: false } : { t: String(c?.text ?? '').trim(), done: !!c?.done })
  .filter(c => c.t).slice(0, 60);
const mergeLists = (...lists) => {
  const out = [];
  for (const l of lists) for (const c of l || []) {
    const ex = out.find(o => o.t.toLowerCase() === c.t.toLowerCase());
    if (ex) ex.done = ex.done || c.done; else out.push({ t: c.t, done: c.done });
  }
  return out;
};
const noProject = v => ({ error: `Projekt „${v}“ neexistuje. Nejdřív ho založ nástrojem create_project.` });

const TOOL_RUN = {
  update_idea(a, log) {
    const i = findIdea(a.id); if (!i) return { error: `Nápad ${a.id} neexistuje.` };
    let pid;
    if ('project_id' in a) { pid = projId(a.project_id); if (pid === undefined) return noProject(a.project_id); }
    const ch = [];
    if (typeof a.text === 'string' && a.text.trim()) { if (!i.original) i.original = i.text; i.text = a.text.trim(); ch.push('text'); }
    if (typeof a.summary === 'string') { i.summary = a.summary.trim(); ch.push('shrnutí'); }
    if (pid !== undefined) { i.projectId = pid; i.suggest = ''; ch.push('projekt'); }
    if (Array.isArray(a.checklist)) {
      const cl = cleanList(a.checklist);
      if (cl.length) i.checklist = cl; else delete i.checklist;
      ch.push('checklist');
    }
    if (!ch.length) return { ok: true, note: 'Nic se nezměnilo.' };
    log.push({ k: 'edit', t: `Upraveno (${ch.join(', ')}): ${shortT(i.text)}` });
    return { ok: true };
  },

  create_idea(a, log) {
    const text = String(a.text || '').trim(); if (!text) return { error: 'Chybí text.' };
    let pid = '';
    if (a.project_id) { pid = projId(a.project_id); if (pid === undefined) return noProject(a.project_id); }
    const i = { id: uid(), text, original: text, projectId: pid, summary: String(a.summary || '').trim(), created: Date.now(), status: 'done' };
    const cl = cleanList(a.checklist); if (cl.length) i.checklist = cl;
    S.ideas.unshift(i);
    log.push({ k: 'plus', t: `Nový nápad: ${shortT(text)}` });
    return { ok: true, id: i.id };
  },

  delete_ideas(a, log) {
    const ids = (Array.isArray(a.ids) ? a.ids : []).map(String);
    const gone = S.ideas.filter(i => ids.includes(i.id));
    if (!gone.length) return { error: 'Žádný z těchto nápadů neexistuje.' };
    S.ideas = S.ideas.filter(i => !ids.includes(i.id));
    gone.forEach(i => { audioStore.delete(i.id); showOrig.delete(i.id); });
    log.push({ k: 'trash', t: gone.length === 1 ? `Smazáno: ${shortT(gone[0].text)}` : `Smazáno nápadů: ${gone.length}` });
    return { ok: true, deleted: gone.length, missing: ids.length - gone.length };
  },

  merge_ideas(a, log) {
    const t = findIdea(a.target_id); if (!t) return { error: `Cílový nápad ${a.target_id} neexistuje.` };
    const srcIds = (Array.isArray(a.source_ids) ? a.source_ids : []).map(String).filter(id => id !== t.id);
    const src = S.ideas.filter(i => srcIds.includes(i.id));
    if (!src.length) return { error: 'Zdrojové nápady neexistují.' };
    const cl = mergeLists(t.checklist, ...src.map(s => s.checklist));
    if (cl.length) t.checklist = cl;
    if (!t.original) t.original = t.text;
    const txt = String(a.text || '').trim();
    t.text = txt || [t.text, ...src.map(s => s.text)].filter(Boolean).join('\n\n');
    S.ideas = S.ideas.filter(i => !srcIds.includes(i.id));
    src.forEach(i => { audioStore.delete(i.id); showOrig.delete(i.id); });
    log.push({ k: 'list', t: `Sloučeno ${src.length + 1} nápadů: ${shortT(t.text)}` });
    return { ok: true, checklist_items: (t.checklist || []).length };
  },

  create_project(a, log) {
    const name = String(a.name || '').trim(); if (!name) return { error: 'Chybí název.' };
    const ex = S.projects.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (ex) return { ok: true, id: ex.id, note: 'Projekt už existuje.' };
    const p = { id: uid(), name, desc: String(a.desc || '').trim() };
    S.projects.push(p);
    log.push({ k: 'plus', t: `Nový projekt: ${name}` });
    return { ok: true, id: p.id };
  },

  update_project(a, log) {
    const p = findProject(a.id); if (!p) return { error: `Projekt ${a.id} neexistuje.` };
    if (typeof a.name === 'string' && a.name.trim()) p.name = a.name.trim();
    if (typeof a.desc === 'string') p.desc = a.desc.trim();
    log.push({ k: 'edit', t: `Upraven projekt: ${p.name}` });
    return { ok: true };
  },

  delete_project(a, log) {
    const p = findProject(a.id); if (!p) return { error: `Projekt ${a.id} neexistuje.` };
    const mine = S.ideas.filter(i => i.projectId === p.id);
    if (a.delete_ideas) S.ideas = S.ideas.filter(i => i.projectId !== p.id);
    else mine.forEach(i => { i.projectId = ''; });
    S.projects = S.projects.filter(x => x.id !== p.id);
    log.push({ k: 'trash', t: `Smazán projekt ${p.name}` + (a.delete_ideas ? ` i ${mine.length} nápadů` : '') });
    return { ok: true, ideas_affected: mine.length };
  }
};

/* ---------- Konverzace ---------- */
function chatSystem() {
  const projects = S.projects.length
    ? S.projects.map(p => `- [${p.id}] ${p.name}${p.desc ? ' – ' + p.desc : ''}`).join('\n') : '(žádné)';
  const ideas = S.ideas.slice(0, 200).map(i => {
    const cl = (i.checklist || []).map((c, n) => `${n}:[${c.done ? 'x' : ' '}] ${c.t}`).join('; ');
    return `- [${i.id}] (${projName(i.projectId) || 'Nezařazeno'}, ${fmt(i.created)}) ${String(i.text || '').replace(/\n/g, ' / ').slice(0, 700)}${cl ? '\n    checklist: ' + cl : ''}`;
  }).join('\n') || '(žádné)';
  return `Jsi AI asistent v osobní appce na zápis nápadů pro člověka s krátkou pamětí. Uživatel s tebou mluví česky, píše nebo diktuje.
Můžeš odpovídat na cokoli a povídat si o čemkoli (nejen o jeho zápiscích). Navíc můžeš PŘÍMO UPRAVOVAT data v appce pomocí nástrojů: nápady (zápisky), projekty a checklisty. Když uživatel chce něco změnit, odstranit, přepsat, sloučit, přesunout, přejmenovat, přidat nebo roztřídit, PROVEĎ to nástroji a potom stručně řekni, co jsi udělal. Neříkej, že něco umíš udělat, aniž bys to skutečně provedl nástrojem.
Pravidla:
- Používej přesná id z dat níže. Nikdy si id nevymýšlej. Nový projekt nejdřív založ (create_project) a jeho id použij.
- Neptej se zbytečně. Zeptej se jen tehdy, když je zadání opravdu nejednoznačné nebo by hrozilo smazání něčeho jiného, než uživatel myslel. Smaž to, co uživatel jasně chce smazat; má tlačítko Vrátit změny.
- Při úpravě checklistu posílej vždy CELÝ nový checklist (včetně stavu done u položek, které zůstávají).
- Nic nevymýšlej, vycházej z dat. Když v datech odpověď není, řekni to.
- Odpovídej česky, stručně a jednoduše, prostým textem bez markdownu (žádné hvězdičky ani #). Dnes je ${new Date().toLocaleDateString('cs-CZ')}.

DATA APPKY
Projekty:
${projects}
Nápady (nejnovější první):
${ideas}`;
}

async function runChat(log) {
  // Do historie jdou jen texty zpráv (bez chyb); volání nástrojů se v rámci jednoho kola přidávají za běhu.
  const contents = [];
  for (const m of chat.msgs.filter(m => !m.err).slice(-14)) {
    const role = m.r === 'u' ? 'user' : 'model';
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts[0].text += '\n' + m.t;
    else contents.push({ role, parts: [{ text: m.t }] });
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();

  for (let step = 0; step < 8; step++) {
    const j = await geminiCall({
      systemInstruction: { parts: [{ text: chatSystem() }] },
      contents, tools: CHAT_TOOLS, generationConfig: { temperature: 0.3 }
    });
    const parts = j.candidates[0].content.parts;
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) return textOf(j).trim();
    contents.push({ role: 'model', parts });
    contents.push({
      role: 'user',
      parts: calls.map(p => {
        const run = TOOL_RUN[p.functionCall.name];
        let response;
        try { response = run ? run(p.functionCall.args || {}, log) : { error: 'Neznámý nástroj.' }; }
        catch (e) { response = { error: e.message }; }
        return { functionResponse: { name: p.functionCall.name, response } };
      })
    });
    save();
  }
  return 'To bylo najednou moc kroků. Zkuste zadání rozdělit.';
}

async function sendChat(text, blob) {
  if (chat.busy) return;
  if (!S.key) { toast('Nejdřív vložte API klíč v Nastavení.'); return; }
  let q = String(text || '').trim();
  if (!q && !blob) return;
  chat.busy = true;
  chat.label = blob ? 'Přepisuji hlas…' : 'Přemýšlím…';
  const before = JSON.stringify({ projects: S.projects, ideas: S.ideas });
  const log = [];
  render();
  try {
    if (blob) {
      q = (await gemini({
        system: 'Přepiš nahrávku doslova česky. Vrať pouze přepsaný text, nic dalšího.',
        parts: [{ inline_data: { mime_type: (blob.type || 'audio/mp4').split(';')[0], data: await blobToBase64(blob) } }]
      })).trim();
      if (!q) throw new Error('Nic jsem neslyšel, zkuste to znovu.');
    }
    chat.msgs.push({ r: 'u', t: q });
    chat.draft = ''; chat.label = 'Přemýšlím…';
    render();
    const reply = await runChat(log);
    chat.msgs.push({ r: 'm', t: reply || (log.length ? 'Hotovo.' : 'K tomu nemám co říct.'), log });
  } catch (e) {
    chat.msgs.push({ r: 'm', t: 'Chyba: ' + e.message, err: true, log });
  }
  if (log.length) {
    const last = chat.msgs[chat.msgs.length - 1];
    last.changed = true;
    last.undoId = checkpoint('Zásah AI chatu', before).id;
    save();
  }
  chat.busy = false;
  saveChat();
  render();
}

/* ---------- Vzhled a akce ---------- */
const CHAT_SAMPLES = [
  'Co jsem naposledy řešil?',
  'Spoj checklisty, které spolu souvisí',
  'Najdi a smaž duplicitní nápady',
  'Roztřiď nezařazené nápady do projektů'
];
const LOG_ICON = { edit: 'edit', trash: 'trash', plus: 'plus', list: 'list' };

views.chat = () => {
  const lastIdx = chat.msgs.length - 1;
  const bubbles = chat.msgs.map((m, n) => {
    if (m.r === 'u') return `<div class="b user">${esc(m.t)}</div>`;
    const log = (m.log || []).length
      ? `<div class="log">${m.log.map(l => `<div>${ic(LOG_ICON[l.k] || 'check')}<span>${esc(l.t)}</span></div>`).join('')}</div>` : '';
    const top = undoStack[undoStack.length - 1];
    const undo = n === lastIdx && m.changed && !m.undone && top && top.id === m.undoId
      ? `<button class="btn small ghost" data-act="undo">${ic('retry')}Vrátit změny</button>` : '';
    return `<div class="b ai ${m.err ? 'err' : ''}">${esc(m.t)}${log}${undo}</div>`;
  }).join('');
  const empty = chat.msgs.length ? '' : `<div class="empty">${ic('sparkles')}
      <p>Napište nebo řekněte cokoli. Odpovím na otázku a umím i upravovat vaše nápady, projekty a checklisty.</p></div>
    <div class="chips">${CHAT_SAMPLES.map(q => `<button class="chip" data-act="chatq" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  const typing = chat.busy ? `<div class="b ai typing">${ic('loader', 'spin')}<span>${esc(chat.label)}</span></div>` : '';
  return `<div class="chat-head"><h1>AI chat</h1>${chat.msgs.length
      ? `<button class="icon-btn" data-act="chatnew" aria-label="Nová konverzace">${ic('plus')}</button>` : ''}</div>
    <div class="chat-msgs">${empty}${bubbles}${typing}</div>
    <div class="chat-bar">
      <textarea id="chatq" rows="1" placeholder="Napište nebo řekněte cokoli…" ${chat.busy ? 'disabled' : ''}>${esc(chat.draft)}</textarea>
      <button class="icon-btn round mic ${recording ? 'rec' : ''}" id="chatmic" data-act="mic" aria-label="Nahrát hlas" ${chat.busy ? 'disabled' : ''}>${recording ? ic('stop', 'fill') : ic('mic')}</button>
      <button class="icon-btn round send" data-act="chatsend" aria-label="Odeslat" ${chat.busy ? 'disabled' : ''}>${ic('send')}</button>
    </div>`;
};

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

Object.assign(actions, {
  chatsend() {
    if (recording) { toast('Nejdřív zastavte nahrávání.'); return; }
    sendChat(($('#chatq') || {}).value);
  },
  chatq(el) { sendChat(el.dataset.q); },
  chatnew() {
    if (!confirm('Začít novou konverzaci? Změny, které AI provedla v nápadech, zůstanou.')) return;
    chat.msgs = []; chat.draft = '';
    saveChat(); render();
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'chatq') { chat.draft = e.target.value; autosize(e.target); }
});
document.addEventListener('keydown', e => {
  // Na počítači Enter odešle, Shift+Enter udělá nový řádek. Na telefonu Enter dělá nový řádek.
  if (e.target.id === 'chatq' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) {
    e.preventDefault(); actions.chatsend();
  }
});
