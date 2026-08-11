// TokyoChat optional Telegram bridge — zero import cost when DISABLED.
// node-telegram-bot-api is NOT auto-installed: call POST /api/tg/install (installs into
// ./deps, leaves the main package.json untouched) then POST /api/tg/deploy {botToken, uuid}.
// Config lives in ./data/tg.json: { enabled, botToken, uuid, allowedUsers }.
// The dep is required lazily only inside startBot(), so merely requiring this module costs
// nothing (node builtins + local compressor.js only).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { compressMessages } = require('./compressor');

const DEPS = path.join(__dirname, 'deps');
const DATA_DIR = path.join(__dirname, 'data');
const CFG_PATH = path.join(DATA_DIR, 'tg.json');
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

let bot = null;
let modelsCache = null;
const history = new Map();     // userId -> [{role,content}]
const modelSel = new Map();    // userId -> model name

// ------------------------------------------------------------------ config
function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}
function writeCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}
function hasDeps() {
  try { require.resolve('node-telegram-bot-api', { paths: [DEPS] }); return true; }
  catch { return false; }
}
function newUuid() {
  try {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  } catch { return (Math.random().toString(36).slice(2) + Date.now().toString(36)); }
}

// lazily load the installed dep from ./deps/node_modules
function loadBot() {
  if (!hasDeps()) throw new Error('node-telegram-bot-api not installed — run Install deps first');
  const createRequire = require('module').createRequire(path.join(DEPS, 'package.json'));
  const mod = createRequire('node-telegram-bot-api');
  return mod.TelegramBot || mod.default || mod;
}

// ------------------------------------------------------------------ status
function status() {
  const c = readCfg();
  if (!c.uuid) { c.uuid = newUuid(); writeCfg(c); } // persist uuid on first settings view
  const depOk = hasDeps();
  return {
    enabled: !!(c.enabled && depOk),
    installed: depOk,
    configured: !!(c.botToken && depOk),
    uuid: c.uuid,
    botTokenSet: !!c.botToken,
    allowed: (c.allowedUsers || []).length,
    running: !!bot,
  };
}

function install() {
  return new Promise((resolve) => {
    fs.mkdirSync(DEPS, { recursive: true });
    execFile('npm',
      ['install', '--prefix', DEPS, 'node-telegram-bot-api', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'],
      { timeout: 180000 },
      (err, _out, errOut) => {
        resolve({ ok: !err, installed: hasDeps(), message: err ? (errOut || err.message).slice(0, 400) : 'deps installed' });
      });
  });
}

// ------------------------------------------------------------------ bot
async function startBot(cfg) {
  if (bot) { try { await bot.stopPolling(); } catch {} bot = null; }
  const TelegramBot = loadBot();
  bot = new TelegramBot(cfg.botToken, { polling: true });
  bot.on('polling_error', (e) => { if (e && /401/i.test(e.message || '')) console.error('tg: bad bot token'); });
  bot.on('message', (msg) => { onMessage(cfg, msg).catch((e) => console.error('tg onMessage:', e)); });
}

async function deploy(opts) {
  const token = ((opts && opts.botToken) || '').trim();
  if (!token) return { ok: false, error: 'bot token required' };
  if (!hasDeps()) return { ok: false, error: 'node-telegram-bot-api not installed — run Install deps first' };
  const c = readCfg();
  c.enabled = true;
  c.botToken = token;
  c.uuid = ((opts && opts.uuid && opts.uuid.trim()) || c.uuid || newUuid());
  c.allowedUsers = c.allowedUsers || [];
  writeCfg(c);
  try { await startBot(c); return { ok: true, status: status() }; }
  catch (e) { c.enabled = false; writeCfg(c); return { ok: false, error: e.message, status: status() }; }
}

async function disable() {
  if (bot) { try { await bot.stopPolling(); } catch {} bot = null; }
  const c = readCfg();
  c.enabled = false;
  writeCfg(c);
  return { ok: true, status: status() };
}

// restart bridge after reboot if config says enabled (still lazy: only requires ./telegram)
async function maybeAutoStart() {
  if (bot) return { ok: true, started: true };
  if (!fs.existsSync(CFG_PATH)) return { ok: false, started: false };
  const c = readCfg();
  if (c.enabled && c.botToken && hasDeps()) {
    await startBot(c);
    return { ok: true, started: true };
  }
  return { ok: false, started: false };
}

// ------------------------------------------------------------------ helpers
async function safeSend(chatId, text) {
  const plain = String(text || '');
  try { await bot.sendMessage(chatId, plain, { parse_mode: 'Markdown' }); }
  catch {
    try { await bot.sendMessage(chatId, plain.replace(/[_*`[\]<>]/g, '')); }
    catch (e) { console.error('tg send fail:', e && e.message); }
  }
}
async function sendMulti(chatId, text) {
  const MAX = 4000;
  if (!text) { await safeSend(chatId, '*(empty response)*'); return; }
  if (text.length <= MAX) { await safeSend(chatId, text); return; }
  let left = text;
  while (left.length > MAX) {
    let cut = left.lastIndexOf('\n', MAX);
    if (cut <= 0) cut = MAX;
    await safeSend(chatId, left.slice(0, cut));
    left = left.slice(cut).replace(/^\n+/, '');
  }
  if (left) await safeSend(chatId, left);
}

async function fetchModels() {
  const r = await fetch(OLLAMA + '/api/tags');
  const j = await r.json().catch(() => ({ models: [] }));
  return (j.models || []).map((m) => m.name);
}
async function resolveModel() {
  if (modelsCache && modelsCache.length) return modelsCache;
  modelsCache = await fetchModels();
  if (!modelsCache.length) throw new Error('no Ollama models at ' + OLLAMA);
  return modelsCache;
}

async function ollamaChat(model, messages) {
  const res = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, keep_alive: '30m',
      options: { num_ctx: 8192, temperature: 0.7, top_p: 0.9 } }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error('ollama HTTP ' + res.status + ': ' + t.slice(0, 200)); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.done) return out;
      if (j.message && j.message.content) out += j.message.content;
    }
  }
  return out;
}

const HELP =
  '/start · /help — this help\n' +
  '/models — list available Ollama models\n' +
  '/model <name> — switch model for this chat\n' +
  '/clear — reset this chat history\n' +
  'Anything else → answered by your local Ollama.';

async function onMessage(cfg, msg) {
  const chatId = msg.chat && msg.chat.id;
  const userId = msg.from && msg.from.id;
  const text = (msg.text || '').trim();
  if (chatId == null || userId == null) return;

  const allowed = cfg.allowedUsers || [];
  if (!allowed.includes(userId)) {
    if (text && text === cfg.uuid) {
      allowed.push(userId); cfg.allowedUsers = allowed; writeCfg(cfg);
      await safeSend(chatId, '✅ Paired. You can now chat with the local Ollama.');
      return;
    }
    await safeSend(chatId, 'Not authorized. Send the pairing UUID (shown in *TokyoChat → 📡 Telegram* settings) to this bot.');
    return;
  }

  if (text === '/start' || text === '/help') { await safeSend(chatId, HELP); return; }
  if (text === '/clear') { history.delete(userId); await safeSend(chatId, '✅ history cleared'); return; }
  if (text === '/models') {
    try { const m = await resolveModel(); await safeSend(chatId, 'Models:\n' + m.join('\n')); }
    catch (e) { await safeSend(chatId, '⚠ ' + e.message); }
    return;
  }
  if (text.startsWith('/model ')) {
    const name = text.slice(7).trim(); const m = await resolveModel();
    if (m.includes(name)) { modelSel.set(userId, name); await safeSend(chatId, '✅ model: ' + name); }
    else await safeSend(chatId, 'No such model — try /models');
    return;
  }
  if (text.startsWith('/')) { await safeSend(chatId, HELP); return; }

  // ---- normal chat ----
  const hist = history.get(userId) || [];
  hist.push({ role: 'user', content: text });

  let model;
  try {
    const m = await resolveModel();
    model = modelSel.get(userId) || m[0];
  } catch (e) { hist.pop(); await safeSend(chatId, '⚠ ' + e.message); return; }

  // context compression (mirrors server: last turn kept raw)
  const last = hist[hist.length - 1];
  const { messages: comp } = compressMessages(hist.slice(0, -1), { keepLastTurns: 6, tokenBudget: 12000 });
  const toSend = comp.concat(last);

  const typing = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(() => {}); }, 4000);
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  let reply;
  try { reply = await ollamaChat(model, toSend); }
  catch (e) { clearInterval(typing); hist.pop(); history.set(userId, hist); await safeSend(chatId, '⚠ ' + e.message); return; }
  clearInterval(typing);

  hist.push({ role: 'assistant', content: reply || '' });
  history.set(userId, hist.slice(-40));
  await sendMulti(chatId, reply);
}

module.exports = { status, install, deploy, disable, maybeAutoStart, newUuid };
