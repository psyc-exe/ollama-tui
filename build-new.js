// TokyoChat single-file generator.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const compSrc = fs.readFileSync(path.join(ROOT, 'compressor.js'), 'utf8');
const updSrc = fs.readFileSync(path.join(ROOT, 'ollama-update.js'), 'utf8');
const tgSrc = fs.readFileSync(path.join(ROOT, 'telegram.js'), 'utf8')
  .replace(/const \{ compressMessages \} = require\('\.\/compressor'\);\n/, 'const { compressMessages } = __COMPRESSOR__;\n');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function stripModule(src) {
  return src
    .replace(/^\/\/[^\n]*\n/, '')
    .replace(/^'use strict';\n/, '')
    .replace(/^#!\/usr\/bin\/env node\n/, '')
    .replace(/module\.exports\s*=\s*\{[^]*?\}\s*;\s*$/, '');
}
function wrap(src, innerName, fields) {
  const body = stripModule(src).split('\n').map(l => '  ' + l).join('\n');
  return [
    'const ' + innerName + ' = (() => {',
    "  'use strict';",
    body,
    '  return { ' + fields.join(', ') + ' };',
    '})();',
  ].join('\n');
}

const inlineCompressor = wrap(compSrc, '__COMPRESSOR__', ['compressContent','compressMessages','estTokens','classify','storeCCR','retrieveCCR']);
const inlineUpdater = wrap(updSrc, '__UPDATER__', ['status','update','detectArch','findBinary','currentVersion','latestVersion','buildPlan']);
const inlineTelegram = wrap(tgSrc, '__TELEGRAM__', ['status','install','deploy','disable','maybeAutoStart','newUuid']);

let serverBody = serverSrc
  .replace(/^#!\/usr\/bin\/env node\n/, '')
  .replace(/^'use strict';\n/, '')
  .replace(
    /const http = require\('http'\);\nconst fs = require\('fs'\);\nconst path = require\('path'\);\nconst \{ URL \} = require\('url'\);\n/,
    ''
  )
  .replace(
    /const \{ compressMessages, retrieveCCR \} = require\('\.\/compressor'\);\n/,
    "const { compressMessages, retrieveCCR } = __COMPRESSOR__;\n"
  );

serverBody = serverBody.replace(
  /function getUpd\(\) \{[\s\S]*?return _upd;\n\}/,
  "function getUpd() { return __UPDATER__; }"
);
serverBody = serverBody.replace(
  /function getTg\(\) \{[\s\S]*?return _tg;\n\}/,
  "function getTg() { return __TELEGRAM__; }"
);

const idxOld = "res.writeHead(200, mime('.html')); res.end(fs.readFileSync(path.join(PUBLIC, 'index.html'))); return;";
const idxNew = "res.writeHead(200, mime('.html')); res.end(__TOKYO_ASSETS__['index.html']); return;";
if (!serverBody.includes(idxOld)) throw new Error('index route pattern not found');
serverBody = serverBody.replace(idxOld, idxNew);

const staticOpen = "    if (route === '/static') {";
if (!serverBody.includes(staticOpen)) throw new Error('/static route not found');
serverBody = serverBody.replace(
  staticOpen,
  "    if (route === '/app.js' || route === '/app.js/') {\n" +
  "      res.writeHead(200, mime('.js')); res.end(__TOKYO_ASSETS__['app.js']); return;\n" +
  "    }\n" +
  staticOpen
);

const stOld =
  "      const f = path.resolve(PUBLIC, u.searchParams.get('f') || '');\n" +
  "      if (!f.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }\n" +
  "      res.writeHead(200, mime(path.extname(f))); res.end(fs.readFileSync(f)); return;";
const stNew =
  "      const n = (u.searchParams.get('f') || '').split(String.fromCharCode(92)).pop().split('/').pop();\n" +
  "      if (!(n in __TOKYO_ASSETS__)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }\n" +
  "      res.writeHead(200, mime('.' + (n.split('.').pop()))); res.end(__TOKYO_ASSETS__[n]); return;";
if (!serverBody.includes(stOld)) throw new Error('/static block pattern not found');
serverBody = serverBody.replace(stOld, stNew);

const assets = [
  'const __TOKYO_ASSETS__ = {',
  "  'index.html': " + JSON.stringify(indexHtml) + ',',
  "  'app.js': " + JSON.stringify(appJs) + ',',
  '};',
].join('\n');

const out = [
  '#!/usr/bin/env node',
  '// ollama-tui web bundle — generated. No external deps.',
  "'use strict';",
  "const http = require('http');",
  "const fs = require('fs');",
  "const path = require('path');",
  "const { URL } = require('url');",
  '', assets, '',
  inlineCompressor, '',
  inlineUpdater, '',
  inlineTelegram, '',
  '// ----- server.js -----',
  serverBody.trim(),
  '',
].join('\n');

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'ollama-tui-web.js'), out, 'utf8');
fs.writeFileSync(path.join(DIST, 'tokyochat.js'), out, 'utf8');
fs.writeFileSync(path.join(DIST, 'ollama-tui.js'), out, 'utf8');
console.log('wrote dist/ollama-tui-web.js (' + Buffer.byteLength(out) + ' bytes)');
