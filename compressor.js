// TokyoChat context compressor — zero-dep, local, reversible.
'use strict';
const crypto = require('crypto');

// ---------------------------------------------------------------- tokens
function estTokens(s) {
  if (s == null) return 0;
  if (Array.isArray(s)) return s.reduce((a, x) => a + estTokens(x), 0);
  const str = typeof s === 'object' ? JSON.stringify(s) : String(s);
  // rough: ~4 chars/token for mixed text, plus each word boundary token.
  const words = str.trim() ? str.trim().split(/\s+/).length : 0;
  return Math.ceil(str.length / 4) + Math.ceil(words / 3);
}

// ---------------------------------------------------------------- classify
const RE = {
  json: /^\s*[{\[]/,
  html: /<[a-zA-Z][^>]*>/,
  diff: /^[+-].*|^diff --git|^@@/m,
  logs: /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^[A-Z]{2,6}:\s/,
  search: /^\[WEB SEARCH RESULTS\]/,
  code: /[{};]=|function\s|=>|class\s|import |from ['"]|console\./,
};
function classify(text) {
  const s = String(text || '');
  if (RE.search.test(s)) return 'search';
  if (RE.json.test(s)) return 'json';
  if (RE.html.test(s)) return 'html';
  if (RE.diff.test(s)) return 'diff';
  if (RE.logs.test(s)) return 'logs';
  if (RE.code.test(s)) return 'code';
  return 'text';
}

// ---------------------------------------------------------------- ccr store (reversible)
const map = new Map();
const MAX = 200;
function storeCCR(text) {
  const hash = crypto.createHash('sha256').update(String(text || '')).digest('hex');
  map.set(hash, String(text));
  if (map.size > MAX) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  return hash;
}
function retrieveCCR(hash) {
  return typeof hash === 'string' ? (map.get(hash) || '') : '';
}

// ---------------------------------------------------------------- content-aware compression
const CCR = 'ccr::';
function compressContent(text, budget) {
  const orig = String(text || '');
  if (!orig) return '';
  if (orig.length < 200) return orig;
  const b = budget || 600;
  const type = classify(orig);
  let comp = orig;

  if (type === 'json') {
    try {
      const slice = (v, depth) => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) { if (v.length > b) return v.slice(0, Math.ceil(b / 4)); return v.map((x) => slice(x, depth + 1)); }
        const o = {};
        for (const k of Object.keys(v)) { o[k] = slice(v[k], depth + 1); if (JSON.stringify(o).length > b) { o[k] = '…[' + estTokens(JSON.stringify(v[k])) + ' tok]'; break; } }
        return o;
      };
      const j = JSON.parse(orig);
      const slim = JSON.stringify(slice(j, 0));
      if (slim.length < orig.length) comp = slim;
    } catch {} // non-strict json → fall through
  } else if (type === 'code' || type === 'diff') {
    const lines = orig.split('\n');
    const keep = Math.max(4, Math.floor(b / 40));
    if (lines.length > keep * 2) {
      const head = lines.slice(0, keep).join('\n');
      const tail = lines.slice(-keep).join('\n');
      comp = head + '\n// …[' + (lines.length - keep * 2) + ' lines collapsed]…\n' + tail;
    }
  } else if (type === 'html') {
    comp = orig.replace(/<script\b[\s\S]*?<\/script>/gi, '\n<script>…</script>\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+\n\s*/g, '\n');
  }

  // ccr: make reversible, keep a readable prefix + summary + hash
  const h = storeCCR(orig);
  let summary = comp;
  if (summary.length > b * 1.2) {
    const keep = Math.max(40, Math.floor(b / 2));
    summary = summary.slice(0, keep) + ' …';
  }
  return CCR + h + '\n[' + type + ' · original ' + estTokens(orig) + '→' + estTokens(summary) + ' tok]\n' + summary;
}

// ---------------------------------------------------------------- compressMessages
function compressMessages(messages, opts) {
  const o = opts || {};
  const keepRaw = o.keepLastTurns == null ? 6 : o.keepLastTurns;
  const budget = o.tokenBudget || 12000;
  const before = estTokens(messages);
  const arr = Array.isArray(messages) ? messages : [];

  const prefix = arr.slice(0, Math.max(0, arr.length - keepRaw));
  const kept = arr.slice(Math.max(0, arr.length - keepRaw));

  const out = [];
  let removed = 0;
  for (const m of prefix) {
    const txt = (m && m.content) || '';
    if (!txt || txt.length < 240) { out.push(m); continue; }
    const key = m && m.role;
    out.push({ role: key || 'user', content: compressContent(txt, Math.min(400, Math.max(80, budget / 30))) });
    removed += estTokens(m);
  }
  const messagesOut = out.concat(kept);
  const after = estTokens(messagesOut);
  const applied = after < before && removed > 0;
  return {
    messages: applied ? messagesOut : (Array.isArray(messages) ? messages.slice() : []),
    stats: { applied, before, after, kept: out.length, removed, ratio: before > 0 ? +(1 - (after / before)).toFixed(3) : 0 },
  };
}

module.exports = { compressContent, compressMessages, estTokens, classify, storeCCR, retrieveCCR };
