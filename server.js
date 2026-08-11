#!/usr/bin/env node
// TokyoChat — Ollama TUI (self-hosted, zero native deps). Node >= 18.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { compressMessages, retrieveCCR } = require('./compressor');

const PORT = process.env.PORT || 8080;
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TG_CFG = path.join(DATA_DIR, 'tg.json');

// Telegram bridge is OPTIONAL and lazy: never require('./telegram') unless an /api/tg/*
// endpoint is hit or auto-start fires for an already-enabled config. Zero import cost when off.
let _tg = null;
function getTg() {
  if (!_tg) { try { _tg = require('./telegram'); } catch (e) { _tg = { err: e }; } }
  return _tg;
}

let _upd = null;
function getUpd() {
  if (!_upd) { try { _upd = require('./ollama-update'); } catch (e) { _upd = { err: e }; } }
  return _upd;
}



const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});
const mime = (p) => ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}[path.extname(p)] || 'text/plain');
const sse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
};

async function listModels() {
  const r = await fetch(OLLAMA + '/api/tags');
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({ models: [] }));
  return (j.models || []).map((m) => ({
    name: m.name,
    family: (m.details && m.details.family) || '',
    quant: (m.details && m.details.quantization_level) || '',
  }));
}
async function runningModels() {
  try { const r = await fetch(OLLAMA + '/api/ps'); const j = await r.json();
    return new Set((j.models || []).map((m) => m.name)); } catch { return new Set(); }
}

async function chatStream(req, res) {
  const send = sse(res);
  const { model, messages, options = {}, search = null } = req.body || {};
  if (!model || !Array.isArray(messages)) { send({ type: 'error', text: 'bad request' }); res.end(); return; }

  const finalMsgs = [...messages];
  if (search && search.results && search.results.length) {
    finalMsgs.push({
      role: 'user',
      content: '[WEB SEARCH RESULTS (verify accuracy)]\n' + search.query + '\n\n' +
        search.results.slice(0, 6).map((r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 300)}`).join('\n\n'),
    });
  }

  // context compression (headroom-principle, local, reversible). Keep last turn raw.
  if (finalMsgs.length > 1) {
    const last = finalMsgs[finalMsgs.length - 1];
    const history = finalMsgs.slice(0, -1);
    const { messages: comp, stats } = compressMessages(history, {
      keepLastTurns: options.compressTurns || 6,
      tokenBudget: options.tokenBudget || 12000,
    });
    if (stats.applied) {
      send({ type: 'ctx', stats });
      finalMsgs.length = 0;
      finalMsgs.push(...comp, last);
    }
  }

  let body;
  try {
    const o = await fetch(OLLAMA + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: finalMsgs, stream: true,
        options: { num_ctx: options.ctx || 8192, temperature: options.temp == null ? 0.7 : options.temp, top_p: options.top_p == null ? 0.9 : options.top_p },
        keep_alive: '30m',
      }),
    });
    if (!o.ok) { const t = await o.text(); send({ type: 'error', text: `ollama HTTP ${o.status}: ${t.slice(0, 200)}` }); res.end(); return; }
    body = o.body;
  } catch (e) { send({ type: 'error', text: e.message }); res.end(); return; }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '', doneMeta = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.message) {
          if (j.message.reasoning) send({ type: 'reason', text: j.message.reasoning });
          if (j.message.content) send({ type: 'chunk', text: j.message.content });
        }
        if (j.done) doneMeta = {
          prompt: j.prompt_eval_count || 0, eval: j.eval_count || 0,
          tps: j.eval_duration ? ((j.eval_count || 0) / (j.eval_duration / 1e9)).toFixed(1) : null,
        };
      }
    }
  } catch (e) { send({ type: 'error', text: 'stream: ' + e.message }); }
  send({ type: 'done', counts: doneMeta });
  res.end();
}
function clean(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function de(s) { return (s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' '); }
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 tokyochat' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function doSearch(q, conf) {
  const engine = conf.engine || 'librex';
  const host = conf.host || 'http://127.0.0.1:8081';
  let results = [];
  try {
    let url, html;
    if (engine === 'whoogle') {
      url = `${host}/search?q=${encodeURIComponent(q)}`;
      html = await fetchText(url);
      const re = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g; let m; const seen = new Set();
      while ((m = re.exec(html)) && results.length < 8) {
        const href = m[1].startsWith('/') ? host + m[1] : m[1];
        const txt = de(clean(m[2]));
        if (!txt || href.startsWith(host + '/search') || seen.has(href)) continue;
        seen.add(href); results.push({ title: txt, url: href, snippet: '' });
      }
    } else if (engine === 'librex') {
      url = `${host}/search?q=${encodeURIComponent(q)}&category=general`;
      html = await fetchText(url);
      const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*"[^>]*>(.*?)<\/a>/g)];
      for (const m of hrefs) {
        const href = m[1].startsWith('/') ? host + m[1] : m[1];
        const txt = de(clean(m[2]));
        if (txt && href.startsWith('http')) results.push({ title: txt, url: href, snippet: '' });
        if (results.length >= 8) break;
      }
    } else {
      url = `${host}/search?q=${encodeURIComponent(q)}`;
      html = await fetchText(url);
      const blocks = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
      for (const m of blocks) {
        const href = m[1], txt = de(clean(m[2]));
        if (txt && href.startsWith('http') && results.length < 8) results.push({ title: txt, url: href, snippet: '' });
      }
    }
  } catch (e) { results = [{ error: e.message }]; }
  return results;
}

async function crawlPage(conf, url) {
  if (!conf || !conf.endpoint) return { error: 'no crawler endpoint configured' };
  try {
    const r = await fetch(conf.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(conf.key ? { Authorization: 'Bearer ' + conf.key } : {}) },
      body: JSON.stringify({ url }),
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { text: t }; }
  } catch (e) { return { error: e.message }; }
}

function exportHandler(fmt, req, res) {
  const { chat = [], model } = req.body || {};
  if (fmt === 'compact') {
    const keep = chat.slice(-30).map((m) => `[${m.role}] ${(m.content || '').slice(0, 2000)}`).join('\n');
    const meta = { model, messages: chat.length, chars: chat.reduce((a, m) => a + (m.content || '').length, 0), tokens: Math.round(chat.reduce((a, m) => a + (m.content || '').length, 0) / 4) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ts: new Date().toISOString(), meta, text: keep }, null, 2)); return;
  }
  if (fmt === 'md') {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(chat.map((m) => (m.role === 'user' ? '## User\n\n' : '## Assistant\n\n') + (m.content || '')).join('\n\n')); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ts: new Date().toISOString(), model, messages: chat }, null, 2));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname;
  try {
    if (route === '/' || route === '/index.html') {
      res.writeHead(200, mime('.html')); res.end(fs.readFileSync(path.join(PUBLIC, 'index.html'))); return;
    }
    if (route === '/static') {
      const f = path.resolve(PUBLIC, u.searchParams.get('f') || '');
      if (!f.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, mime(path.extname(f))); res.end(fs.readFileSync(f)); return;
    }
    if (route === '/api/models') {
      const [models, running] = await Promise.all([listModels(), runningModels()]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models.map((m) => ({ ...m, running: running.has(m.name) ? 1 : 0 })))); return;
    }
    if (route === '/api/chat') { req.body = await readBody(req); return chatStream(req, res); }
    if (route === '/api/search') {
      const conf = { engine: u.searchParams.get('engine'), host: u.searchParams.get('host') };
      const r = await doSearch(u.searchParams.get('q') || '', conf);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    if (route === '/api/crawl') { req.body = await readBody(req); const r = await crawlPage(req.body.crawler, req.body.url);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return; }
    if (route === '/api/retrieve') {
      const orig = retrieveCCR(u.searchParams.get('h') || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(orig ? { found: true, text: orig } : { found: false })); return;
    }
    if (route.startsWith('/api/export/')) { req.body = await readBody(req); return exportHandler(route.slice(12), req, res); }
// ---- optional Ollama self-update manager (lazy) ----
if (route === '/api/ollama/status') {
  const up = getUpd();
  if (up.err) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: up.err.message})); return; }
  const s = await up.status();
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(s)); return;
}
if (route === '/api/ollama/update') {
  const up = getUpd();
  if (up.err) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: up.err.message})); return; }
  const body = await readBody(req);
  const dryRun = body && body.dryRun !== false;
  const r = await up.update({ dryRun });
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(r)); return;
}

    // ---- optional Telegram bridge (lazy; disabled by default) ----
    if (route === '/api/tg/status') {
      const tg = getTg();
      if (tg.err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: tg.err.message, enabled: false })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(tg.status())); return;
    }
    if (route === '/api/tg/install') {
      const tg = getTg();
      if (tg.err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: tg.err.message })); return; }
      const r = await tg.install();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    if (route === '/api/tg/deploy') {
      const tg = getTg(); req.body = await readBody(req);
      if (tg.err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: tg.err.message })); return; }
      const r = await tg.deploy({ botToken: req.body.botToken, uuid: req.body.uuid });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    if (route === '/api/tg/disable') {
      const tg = getTg();
      if (tg.err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: tg.err.message })); return; }
      const r = await tg.disable();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
  }
});
server.listen(PORT, async () => {
  console.log(`TokyoChat up  http://0.0.0.0:${PORT}`);
  console.log(`Ollama: ${OLLAMA}`);
  // Optional Telegram bridge: only touch ./telegram when config already enables it.
  if (fs.existsSync(TG_CFG)) {
    let c = {}; try { c = JSON.parse(fs.readFileSync(TG_CFG, 'utf8')); } catch {}
    if (c.enabled && c.botToken) {
      try { const r = await getTg().maybeAutoStart(); if (r && r.started) console.log('Telegram bridge active'); }
      catch (e) { console.error('tg auto-start failed:', e && e.message); }
    }
  }
});