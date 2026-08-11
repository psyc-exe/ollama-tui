'use strict';
const $ = (s) => document.querySelector(s);
const chat = { messages: [] };
let model = '';
let busy = false;

const params = { ctx: 8192, temp: 0.7, top_p: 0.9 };
const P = {
  ctx: { step: 1024, min: 512, max: 131072, fmt: (v) => v },
  temp: { step: 0.1, min: 0, max: 2, fmt: (v) => +v.toFixed(1) },
  top_p: { step: 0.05, min: 0, max: 1, fmt: (v) => +v.toFixed(2) },
};

const SE = { engine: localStorage.getItem('tc.sengine') || 'librex', host: localStorage.getItem('tc.shost') || 'http://127.0.0.1:8081' };
try { const q = new URLSearchParams(location.search); if (q.get('engine')) SE.engine = q.get('engine'); if (q.get('host')) SE.host = q.get('host'); } catch {}

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1800); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---- header: params ----
function buildParams() {
  const box = $('#params');
  box.innerHTML = Object.keys(params).map((k) => `
    <span class="pfield"><abbr title="${P[k].step === 1024 ? 'context window (tokens)' : k === 'temp' ? 'temperature: randomness' : 'top_p: nucleus sampling'}">${k}</abbr>
      <span class="stepper"><button data-k="${k}" data-d="-1">−</button>
      <input id="p-${k}" type="number" step="${P[k].step}" value="${params[k]}"
        min="${P[k].min}" max="${P[k].max}" size="7">
      <button data-k="${k}" data-d="1">＋</button></span></span>`).join('');
  box.querySelectorAll('input').forEach((inp) => {
    inp.onchange = () => { params[inp.id.slice(2)] = clamp(inp.id.slice(2), parseFloat(inp.value)); inp.value = params[inp.id.slice(2)]; };
  });
  box.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => { const k = b.dataset.k; params[k] = clamp(k, params[k] + (P[k].step * +b.dataset.d)); $('#p-' + k).value = params[k]; };
  });
}
function clamp(k, v) {
  if (isNaN(v)) v = params[k];
  v = Math.max(P[k].min, Math.min(P[k].max, v));
  v = Math.round(v / P[k].step) * P[k].step;
  return +v.toFixed(3);
// ---- markdown-ish renderer ----
function inline(html) {
  // html already escaped; add inline code/bold/italic/links
  html = html.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/\*([^*\n]+)\*/g, '<i>$1</i>').replace(/_([^_\n]+)_/g, '<i>$1</i>');
  html = html.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--blue)">$1</a>');
  html = html.replace(/^#{1,6}\s+([^\n]+)/gm, '<b style="color:var(--fg-bright);font-size:1.05em">$1</b>');
  return html;
}

function renderBlocks(md, holder) {
  holder.innerHTML = '';
  const parts = md.split(/```([\w+-]*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === undefined || seg === '') continue;
    if (i % 3 === 1) {
      // code block
      const lang = seg || 'txt';
      const code = parts[i + 1] || '';
      const pre = document.createElement('pre');
      pre.className = 'code';
      const head = document.createElement('div');
      head.className = 'hdr';
      const lm = document.createElement('span'); lm.className = 'lang'; lm.textContent = lang;
      const cb = document.createElement('button'); cb.className = 'copy'; cb.textContent = '⧉ copy';
      cb.onclick = async () => { try { await navigator.clipboard.writeText(code); toast('copied'); cb.textContent = '✓'; setTimeout(() => cb.textContent = '⧉ copy', 1200); } catch (e) { toast('copy fail: ' + e.message); } };
      head.append(lm, cb);
      const c = document.createElement('code'); c.textContent = code;
      pre.append(head, c);
      holder.appendChild(pre);
      i++; // skip code content handled
    } else {
      const p = document.createElement('div');
      p.className = 'mark';
      p.innerHTML = inline(esc(seg));
      holder.appendChild(p);
    }
  }
}

function addMsg(role, content) {
  const wrap = $('#msgs');
  const m = document.createElement('div');
  m.className = 'msg ' + role;
  m.dataset.role = role;
  const av = document.createElement('div');
  av.className = 'avatar'; av.textContent = role === 'user' ? 'U' : 'AI';
  const body = document.createElement('div');
  body.className = 'body';
  const rl = document.createElement('div'); rl.className = 'role'; rl.textContent = role;
  const ct = document.createElement('div'); ct.className = 'content';
  body.append(rl, ct);
  m.append(av, body);
  wrap.appendChild(m);
  chat.messages.push({ role, content: '', el: m, contentEl: ct });
  scrollBottom();
  return m;
}
}
function scrollBottom() { const c = $('#chat'); c.scrollTop = c.scrollHeight; }
function curModel() { model = $('#model').value || model; return model; }
function save() { localStorage.setItem('tc.chat', JSON.stringify(chat.messages.map((m) => ({ role: m.role, content: m.content })))); }

async function loadModels() {
  try {
    const r = await fetch('/api/models'); const list = await r.json();
    const sel = $('#model');
    sel.innerHTML = list.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.running ? ' ●' : ''}</option>`).join('');
    const saved = localStorage.getItem('tc.model');
    if (saved && list.some((m) => m.name === saved)) sel.value = saved;
    model = sel.value;
    $('#ollamachip').textContent = list.length + ' models';
  } catch (e) { $('#ollamachip').textContent = 'Ollama ✖'; }
}
$('#model').addEventListener('change', () => { model = $('#model').value; localStorage.setItem('tc.model', model); toast('model: ' + model); });
$('#newbtn').onclick = () => { chat.messages = []; $('#msgs').innerHTML = ''; localStorage.removeItem('tc.chat'); $('#tokstatus').textContent = 'new chat'; };

async function send(regenerate) {
  if (busy) return;
  let text = $('#inp').value.trim();
  if (!text && !regenerate) return;
  busy = true;
  const sb = $('#sendbtn'); sb.disabled = true; sb.classList.add('busy'); sb.textContent = '…';

  if (regenerate) {
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') {
      chat.messages.pop().el.remove();
    }
  } else {
    $('#inp').value = '';
  }

  let searchResults = null;
  let note = null;
  if (text.startsWith('/search ')) {
    const q = text.slice(8).trim();
    text = q;
    note = document.createElement('div');
    note.className = 'searchnote';
    note.innerHTML = '<b>web search:</b> ' + esc(q) + ' <small>(' + esc(SE.engine) + ')</small>';
    try {
      const r = await doSearch(q);
      if (Array.isArray(r) && r.length && !r[0].error) searchResults = { query: q, results: r };
      else note.innerHTML += ' — <span style="color:var(--red)">no results</span>';
      if (r[0] && r[0].error) note.innerHTML += ' — <span style="color:var(--red)">' + esc(r[0].error) + '</span>';
    } catch (e) { note.innerHTML += ' — ' + esc(e.message); }
  }

  const userMsg = addMsg('user', text);
  userMsg.contentEl.textContent = text;
  userMsg.content = text;
  if (note) userMsg.body.prepend(note);

  const asst = addMsg('assistant', '');
  save();
  await streamChat(text, searchResults, asst);
}

async function streamChat(text, searchResults, asst) {
  let msgs = chat.messages.map((m) => ({ role: m.role, content: m.content }));
  const mem = loadMemory();
  if (mem) msgs = [{ role: 'system', content: mem }, ...msgs];
  const body = {
    model: curModel(),
    messages: msgs.filter((m) => !(m.role === 'assistant' && !m.content)),
    options: { ctx: params.ctx, temp: params.temp, top_p: params.top_p },
    search: searchResults,
  };
  let res;
  try { res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { finishStream(asst, 'network: ' + e.message, null, ''); return; }
  if (!res.ok) { const er = await res.json().catch(() => ({ error: res.status })); finishStream(asst, er.error || res.status, null, ''); return; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', reason = '', counts = null, lastComp = null;
  const apply = () => { asst.content = full; renderBlocks(full, asst.contentEl); asst.contentEl.classList.add('streaming'); scrollBottom(); };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.type === 'chunk') full += j.text;
        else if (j.type === 'reason') reason += j.text;
        else if (j.type === 'done') counts = j.counts;
        else if (j.type === 'ctx') lastComp = j.stats;
        else if (j.type === 'error') full += '\n\n⚠ ' + j.text;
      }
      apply();
    }
  } catch (e) { finishStream(asst, 'stream: ' + e.message, counts, reason); return; }
  asst.contentEl.classList.remove('streaming');
  finishStream(asst, null, counts, reason);
}

function finishStream(asst, err, counts, reason) {
  busy = false;
  const sb = $('#sendbtn'); sb.disabled = false; sb.classList.remove('busy'); sb.textContent = 'Send';
  if (reason.trim()) {
    const d = document.createElement('details'); d.className = 'reason';
    const s = document.createElement('summary'); s.textContent = 'reasoning';
    const p = document.createElement('pre'); p.textContent = reason.trim();
    d.append(s, p); asst.contentEl.prepend(d);
  }
  if (err) { const p = document.createElement('div'); p.style.color = 'var(--red)'; p.textContent = err; asst.contentEl.appendChild(p); }
  if (counts) {
    const cd = document.createElement('div'); cd.className = 'meta';
    cd.innerHTML = `<span class="ok">✓</span> prompt <span class="tokens">${counts.prompt}</span> · gen <span class="tokens">${counts.eval}</span>${counts.tps ? ' · <span class="tokens">' + counts.tps + '</span> t/s' : ''}&nbsp;&nbsp;<button class="copy" data-reg>↻ regen</button>`;
    asst.contentEl.appendChild(cd);
  }
  $('#tokstatus').textContent = counts ? `▲${counts.prompt} / ▼${counts.eval}${counts.tps ? ' · ' + counts.tps + ' t/s' : ''}` : '';
  save();
  scrollBottom();
}
$('#sendbtn').onclick = () => send(false);
$('#inp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !busy) { e.preventDefault(); send(false); }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '/') { e.preventDefault(); $('#model').focus(); }
  else if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('#newbtn').click(); }
});
async function doSearch(q) {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&engine=${encodeURIComponent(SE.engine)}&host=${encodeURIComponent(SE.host)}`);
  return r.json();
}
function loadChat() {
  try {
    const arr = JSON.parse(localStorage.getItem('tc.chat') || '[]');
    (arr).forEach((m) => { const el = addMsg(m.role, m.content); el.content = m.content; renderBlocks(m.content, el.contentEl); });
  } catch {}
}

// ---- regenerate button on assistant meta ----
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-reg]')) { e.preventDefault(); send(true); }
});

// ---- exports ----
const FNAME = { json: 'chat.json', md: 'chat.md', compact: 'memory.json' };
async function exportChat(fmt) {
  const res = await fetch('/api/export/' + fmt, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: chat.messages.map((m) => ({ role: m.role, content: m.content })), model: curModel() }),
  });
  const ct = res.headers.get('content-type') || '';
  let data = ct.includes('json') ? await res.json() : await res.text();
  let blob = ct.includes('json') ? new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }) : new Blob([data], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (ct.includes('json') && fmt === 'compact' ? 'memory-' : fmt === 'md' ? 'chat-' : 'chat-') + Date.now() + (ct.includes('json') ? '.json' : '.md');
  a.click(); URL.revokeObjectURL(a.href);
  toast('exported');
}
$('#exjson').onclick = () => exportChat('json');
$('#exmd').onclick = () => exportChat('md');
$('#excompact').onclick = () => exportChat('compact');

// ---- sessions (local persistence as named tabs) ----
function saveSession() {
  const list = JSON.parse(localStorage.getItem('tc.sessions') || '[]');
  const cur = chat.messages.length ? chat.messages[0].content.slice(0, 30) : 'untitled';
  const last = list[0];
  if (last && last.messages === chat.messages) return list;
  list.unshift({ id: Date.now(), name: cur, model: curModel(), messages: [...chat.messages] });
  localStorage.setItem('tc.sessions', JSON.stringify(list.slice(0, 20)));
  renderSessions(list);
  return list;
}
function renderSessions(list) {
  const ul = $('#sessions'); ul.innerHTML = '';
  (list || JSON.parse(localStorage.getItem('tc.sessions') || '[]')).forEach((s) => {
    const li = document.createElement('li');
    const n = document.createElement('div'); n.textContent = s.name;
    const m = document.createElement('span'); m.className = 'n'; m.textContent = ' · ' + s.messages.length + ' msgs';
    li.append(n, m);
    li.onclick = () => { chat.messages = s.messages.map((mm) => ({ ...mm })); $('#msgs').innerHTML = '';
      chat.messages.forEach((mm) => addMsg(mm.role, mm.content)); save(); toast('loaded session'); };
    ul.appendChild(li);
  });
}
$('#sidebtn').onclick = () => { $('#side').classList.toggle('open'); renderSessions(); };

// ---- context menu (right-click / long-press) ----
let ctxTarget = null;
document.addEventListener('contextmenu', (e) => {
  const msg = e.target.closest('.msg');
  if (!msg) return;
  e.preventDefault();
  ctxTarget = msg;
  const menu = $('#ctx');
  menu.style.left = e.pageX + 'px'; menu.style.top = e.pageY + 'px';
  menu.style.display = 'block';
});
document.addEventListener('click', (e) => { if (!e.target.closest('#ctx')) $('#ctx').style.display = 'none'; });
$('#ctx').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const doAction = b.dataset.a;
  if (doAction === 'copy') { const c = ctxTarget.querySelector('.content').innerText; navigator.clipboard.writeText(c).then(() => toast('copied')).catch(() => {}); }
  else if (doAction === 'reg') { ctxTarget.remove(); chat.messages = chat.messages.filter((m) => m.el !== ctxTarget); send(true); }
  else if (doAction.slice(0, 6) === 'export') exportChat(doAction.slice(7));
  else if (doAction === 'summ') saveMemoryFromChat();
  $('#ctx').style.display = 'none';
});

// ---- performance / resource tier (Pi min-RAM vs tab) ----
(function () {
  const dm = navigator.deviceMemory || 4, hw = navigator.hardwareConcurrency || 4;
  const d = document.documentElement;
  if (dm <= 2 || hw <= 2) d.dataset.perf = 'low';
  else if (dm >= 8) d.dataset.perf = 'high';
  else d.dataset.perf = 'med';
})();

// ---- memory (reversible compact summary, injected as system context) ----
function loadMemory() { return localStorage.getItem('tc.memory') || ''; }
async function saveMemoryFromChat() {
  if (!chat.messages.length) { toast('nothing to compress'); return; }
  try {
    const res = await fetch('/api/export/compact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat: chat.messages.map((m) => ({ role: m.role, content: m.content })), model: curModel() }),
    });
    const j = await res.json();
    localStorage.setItem('tc.memory', j.text || '');
    const saved = j.meta && j.meta.tokens;
    toast('memory saved' + (saved ? ' (' + saved + ' tok)' : ''));
  } catch (e) { toast('memory fail: ' + e.message); }
}

// ---- Telegram bridge settings (optional, lazy) ----
async function tgRefresh() {
  const st = $('#tgst'), box = $('#tgstatus');
  try {
    const r = await fetch('/api/tg/status'); const j = await r.json();
    $('#tg-uuid').value = j.uuid || '';
    st.textContent = j.enabled ? 'ON' : 'OFF';
    st.className = 'tgst ' + (j.enabled ? 'on' : 'off');
    box.textContent =
      (j.enabled ? '● enabled · running\n' : '○ disabled\n') +
      'deps: ' + (j.installed ? 'installed' : 'not installed') + '\n' +
      'token: ' + (j.botTokenSet ? 'set' : 'not set') + ' · allowed users: ' + (j.allowed || 0) +
      (j.error ? '\n⚠ ' + j.error : '');
  } catch (e) { box.textContent = 'status fail: ' + e.message; }
}
async function tgInstall() {
  const box = $('#tgstatus'); box.textContent = 'installing deps into deps/ … (may take a while)';
  try {
    const r = await fetch('/api/tg/install', { method: 'POST' }); const j = await r.json();
    box.textContent = (j.message || '') + (j.installed ? ' ✓ ready' : ' ✗ failed');
  } catch (e) { box.textContent = 'install fail: ' + e.message; }
  tgRefresh();
}
async function tgDeploy() {
  const box = $('#tgstatus'); const token = $('#tg-token').value.trim();
  if (!token) { box.textContent = 'enter a bot token first'; return; }
  box.textContent = 'deploying bridge…';
  try {
    const r = await fetch('/api/tg/deploy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: token, uuid: $('#tg-uuid').value.trim() }),
    });
    const j = await r.json();
    box.textContent = j.ok ? ('deployed ✓ ' + (j.status && j.status.allowed ? '· ' + j.status.allowed + ' allowed' : '')) : ('deploy failed: ' + (j.error || ''));
  } catch (e) { box.textContent = 'deploy fail: ' + e.message; }
  tgRefresh();
}
async function tgDisable() {
  const box = $('#tgstatus');
  try {
    const r = await fetch('/api/tg/disable', { method: 'POST' }); const j = await r.json();
    box.textContent = j.ok ? 'disabled ✓' : 'disable failed: ' + (j.error || '');
  } catch (e) { box.textContent = 'disable fail: ' + e.message; }
  tgRefresh();
}
$('#tgbtn').onclick = () => { const m = $('#tgmodal'); m.hidden = !m.hidden; if (!m.hidden) tgRefresh(); };
$('#tg-close').onclick = () => { $('#tgmodal').hidden = true; };
$('#tg-install').onclick = tgInstall;
$('#tg-deploy').onclick = tgDeploy;
$('#tg-disable').onclick = tgDisable;

// ---- Ollama update UI ----
async function updRefresh() {
  const box = $('#updstatus');
  try {
    const r = await fetch('/api/ollama/status');
    const j = await r.json();
    if (!j.ok) { box.textContent = 'error: ' + (j.error || 'unknown'); return; }
    const arch = j.arch || '?';
    const cur = j.current || '?';
    const lat = j.latest || '?';
    const need = j.updatable ? 'update available' : 'up to date';
    box.textContent = `arch: ${arch}\ncurrent: ${cur}\nlatest: ${lat}\n${need}`;
  } catch (e) { box.textContent = 'status fail: ' + e.message; }
}
async function updRun() {
  const box = $('#updstatus');
  box.textContent = 'dry-run update…';
  try {
    const r = await fetch('/api/ollama/update', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ dryRun: true }) });
    const j = await r.json();
    if (j.ok) {
      const p = j.plan || {};
      box.textContent = `dry-run ok\narch ${p.arch}\ncurrent ${p.current}\nlatest ${p.latest}\nneedsUpdate ${p.needsUpdate}\nwouldDownload ${p.wouldDownload}`;
    } else {
      box.textContent = 'update error: ' + (j.error || j.message || 'unknown');
    }
  } catch (e) { box.textContent = 'update fail: ' + e.message; }
}
$('#updbtn').onclick = () => { const m = $('#updmodal'); m.hidden = !m.hidden; if (!m.hidden) updRefresh(); };
$('#upd-close').onclick = () => { $('#updmodal').hidden = true; };
$('#upd-check').onclick = updRefresh;
$('#upd-run').onclick = updRun;

// ---- init ----
buildParams();
loadModels();
loadChat();
setInterval(() => { if (!busy) loadModels(); }, 15000);
$('#inp').focus();