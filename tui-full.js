#!/usr/bin/env node
// Full-screen terminal UI for Ollama. Uses blessed (panels, scroll, log).
const blessed = require('blessed');
const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
let model = process.env.OLLAMA_MODEL || 'llama3.2';
const messages = [];

const MOUSE_DEFAULT = !process.env.TERMUX; // off on Termux
const screen = blessed.screen({
  smartCSR: true,
  title: 'Ollama TUI',
  fullUnicode: false,
  forceUnicode: false,
  mouse: MOUSE_DEFAULT,
  sendFocus: false,
  warnings: false
});

const header = blessed.box({
  parent: screen, top: 0, left: 0, right: 0, height: 1,
  tags: true, style: { fg: 'black', bg: 'cyan', bold: true },
  content: ' Ollama TUI  model=' + model + '  host=' + OLLAMA + '  mouse=off '
});

const status = blessed.box({
  parent: screen, bottom: 0, left: 0, right: 0, height: 1,
  tags: true, style: { fg: 'white', bg: 'blue' },
  content: ' ESC quit  HOME top  END bot  PGUP/PGDN page  UP/DN line  TAB focus  CTRL+ALT+C clear  CTRL+ALT+M models  CTRL+ALT+T mouse '
});

const log = blessed.log({
  parent: screen, top: 1, bottom: 2, left: 0, right: 0,
  tags: true, mouse: false, keys: false,
  scrollable: true, alwaysScroll: true,
  scrollbar: { ch: ' ', style: { bg: 'cyan' } },
  style: { fg: 'white', bg: 'black' },
  bufferLength: 5000
});

const input = blessed.textbox({
  parent: screen, bottom: 1, left: 0, right: 0, height: 1,
  inputOnFocus: true, keys: true, mouse: false,
  style: { fg: 'white', bg: 'black', focus: { bg: 'gray' } }
});

let mouseOn = !!MOUSE_DEFAULT;
function mouseEnable() {
  try { screen.program.write('\x1b[?1000h'); } catch (_) {} // click
  try { screen.program.write('\x1b[?1002h'); } catch (_) {} // drag
  try { screen.program.write('\x1b[?1006h'); } catch (_) {} // sgr
}
function mouseDisable() {
  try { screen.program.write('\x1b[?1006l'); } catch (_) {}
  try { screen.program.write('\x1b[?1002l'); } catch (_) {}
  try { screen.program.write('\x1b[?1000l'); } catch (_) {}
}
function applyMouse() {
  if (mouseOn) mouseEnable(); else mouseDisable();
  header.setContent(' Ollama TUI  model=' + model + '  host=' + OLLAMA + '  mouse=' + (mouseOn ? 'on' : 'off') + ' ');
  screen.render();
}
applyMouse();

function logLine(role, text) {
  if (role === 'user') log.add('{cyan-fg}you{/}: ' + text);
  else if (role === 'assistant') log.add('{green-fg}assistant{/}: ' + text);
  else if (role === 'sys') log.add('{yellow-fg}sys{/}: ' + text);
  else log.add(text);
  screen.render();
}

async function listModels() {
  const r = await fetch(OLLAMA + '/api/tags');
  const j = await r.json();
  return (j.models || []).map(m => m.name);
}

async function chatStream(prompt) {
  messages.push({ role: 'user', content: prompt });
  logLine('user', prompt);
  logLine('assistant', '');
  let out = '';
  try {
    const res = await fetch(OLLAMA + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const tail = log.getScrollPerc() >= 99;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.message && j.message.content) {
              out += j.message.content;
              log.add(j.message.content);
              if (tail) log.setScrollPerc(100);
              screen.render();
            }
            if (j.done) {
              log.add('\n');
              messages.push({ role: 'assistant', content: out });
              screen.render();
              return;
            }
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    logLine('sys', 'Error: ' + e.message);
  }
}

input.on('submit', async (text) => {
  text = (text || '').trim();
  if (!text) { input.focus(); return; }
  input.clearValue();
  screen.render();
  if (text === '/clear') { messages.length = 0; log.setContent(''); screen.render(); input.focus(); return; }
  if (text === '/exit' || text === '/quit') { return screen.destroy(); }
  if (text.startsWith('/model ')) {
    model = text.slice(7).trim();
    header.setContent(' {bold}Ollama TUI{/}  model=' + model + '  host=' + OLLAMA + ' ');
    screen.render();
    input.focus();
    return;
  }
  if (text === '/models') {
    try {
      const ms = await listModels();
      logLine('sys', 'models:\n' + ms.join('\n'));
    } catch (e) { logLine('sys', 'list error: ' + e.message); }
    input.focus();
    return;
  }
  await chatStream(text);
  input.focus();
});

function focusInput() { input.focus(); screen.render(); }
function scrollTop() { log.setScrollPerc(0); screen.render(); }
function scrollBottom() { log.setScrollPerc(100); screen.render(); }
function pageUp() { log.scroll(-Math.max(1, Math.floor((screen.height - 3) / 2))); screen.render(); }
function pageDown() { log.scroll(Math.max(1, Math.floor((screen.height - 3) / 2))); screen.render(); }
function lineUp() { log.scroll(-1); screen.render(); }
function lineDown() { log.scroll(1); screen.render(); }

screen.on('keypress', (ch, key) => {
  if (!key) return;
  if (screen.focused === input) return;
  const k = key.name || '';
  if (k === 'escape') return screen.destroy();
  if (k === 'home') return scrollTop();
  if (k === 'end') return scrollBottom();
  if (k === 'pageup') return pageUp();
  if (k === 'pagedown') return pageDown();
  if (k === 'up') return lineUp();
  if (k === 'down') return lineDown();
  if (k === 'tab') return focusInput();
});

screen.key('C-M-c', () => { messages.length = 0; log.setContent(''); screen.render(); });
screen.key('C-M-m', async () => {
  try {
    const ms = await listModels();
    logLine('sys', 'models:\n' + ms.join('\n'));
  } catch (e) { logLine('sys', 'models error: ' + e.message); }
  input.focus();
});
screen.key('C-M-t', () => { mouseOn = !mouseOn; applyMouse(); input.focus(); });

input.key('escape', () => { input.cancel(); screen.render(); });

function cleanExit() {
  try { mouseDisable(); } catch (_) {}
  try { screen.destroy(); } catch (_) {}
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('exit', () => { try { process.stdin.setRawMode(false); } catch (_) {} });

input.focus();
logLine('sys', 'Ollama TUI ready. ESC quit, HOME/END scroll, PGUP/PGDN page, TAB focus. CTRL+ALT+T toggles mouse.');
screen.render();
