#!/usr/bin/env node
// TokyoChat — optional, lazy Ollama self-update manager.
// Zero import cost when unused: server.js only requires() this file when an
// /api/ollama/* endpoint is hit, and every top-level call is error-guarded so a
// missing binary / no network / GitHub outage can never crash the main server.
//
// SAFETY: update() defaults to dryRun = true. It returns a plan and touches
// nothing. A real (destructive) update runs ONLY when dryRun is explicitly
// false AND env OLLAMA_UPDATER_ALLOW_REAL is set to '1' — belt-and-braces so an
// accidental POST can never replace/restart a live ollama in this sandbox.
'use strict';
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GH_LATEST = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const GH_DL = 'https://github.com/ollama/ollama/releases/download';
const UA = 'tokyochat-ollama-updater/0.1';
const COMMON_BINS = ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama'];

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, out, errOut) => {
      if (err) resolve({ ok: false, out: String(out || ''), err: String(errOut || err.message || '') });
      else resolve({ ok: true, out: String(out || ''), err: String(errOut || '') });
    });
  });
}

// ---- arch detection (amd64 / arm64) ----
function detectArch() {
  const map = { x64: 'amd64', amd64: 'amd64', arm64: 'arm64', aarch64: 'arm64' };
  const fromProc = map[String(process.arch || '').toLowerCase()];
  if (fromProc) return fromProc;
  try {
    const u = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim().toLowerCase();
    if (u === 'x86_64' || u === 'amd64') return 'amd64';
    if (u === 'aarch64' || u === 'arm64') return 'arm64';
  } catch {}
  return 'amd64'; // safest common default; callers see arch in the plan
}

// ---- binary location ----
function findBinary() {
  if (process.env.OLLAMA_BIN && fs.existsSync(process.env.OLLAMA_BIN)) return process.env.OLLAMA_BIN;
  try {
    const w = execFileSync('which', ['ollama'], { encoding: 'utf8' }).trim();
    if (w && fs.existsSync(w)) return w;
  } catch {}
  for (const b of COMMON_BINS) if (fs.existsSync(b)) return b;
  return null;
}

// ---- current version from the installed binary ----
async function currentVersion(bin) {
  const r = await sh(bin, ['--version']);
  if (!r.ok) throw new Error(r.err || 'failed to run ' + bin);
  const m = r.out.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error('unparseable version output: ' + r.out.trim().slice(0, 80));
  return m[1];
}

// ---- latest official version via GitHub API ----
async function latestVersion() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(GH_LATEST, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
    const j = await r.json();
    const tag = String(j.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(tag)) throw new Error('bad tag: ' + j.tag_name);
    return tag;
  } finally { clearTimeout(t); }
}

// ---- build a dry-run plan (never mutates anything) ----
async function buildPlan() {
  const arch = detectArch();
  const bin = findBinary();
  let current = null, currentErr = null;
  let latest = null, latestErr = null;
  if (bin) { try { current = await currentVersion(bin); } catch (e) { currentErr = e.message; } }
  try { latest = await latestVersion(); } catch (e) { latestErr = e.message; }

  const downloadUrl = latest ? `${GH_DL}/v${latest}/ollama-linux-${arch}` : null;
  const backupPath = bin ? `${bin}.bak.v${current || 'old'}` : null;
  const updatable = !!(bin && current && latest && current !== latest && !currentErr && !latestErr);

  const steps = [];
  if (!bin) steps.push('locate ollama binary — NOT FOUND (set OLLAMA_BIN or install ollama)');
  else if (currentErr) steps.push(`read current version — fail: ${currentErr}`);
  else steps.push(`current: ollama ${current} @ ${bin} (${arch})`);
  if (latestErr) steps.push(`fetch latest — fail: ${latestErr}`);
  else steps.push(`latest: ollama ${latest} (official GitHub release)`);
  if (!updatable) steps.push('NO UPDATE — already current or info incomplete');
  else {
    steps.push(`download ${downloadUrl}`);
    steps.push(`backup ${bin} -> ${backupPath}`);
    steps.push(`replace ${bin} with new binary (chmod +x)`);
    steps.push('restart ollama service');
  }

  return {
    dryRun: true,
    present: !!bin,
    arch,
    bin,
    current,
    currentErr,
    latest,
    latestErr,
    updatable,
    downloadUrl,
    backupPath,
    steps,
  };
}

// ---- real (destructive) update: download + backup + replace + restart ----
async function runUpdate(plan) {
  const out = { ...plan, dryRun: false };
  const { bin, downloadUrl, backupPath, arch, latest } = plan;
  if (!bin) { out.error = 'ollama binary not found'; return out; }
  if (!downloadUrl) { out.error = 'no download URL (latest unknown)'; return out; }

  const tmp = path.join(os.tmpdir(), `ollama-new-${Date.now()}-${arch}`);
  out.downloaded = tmp;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 300000); // big binary, allow 5 min
    let resp;
    try {
      resp = await fetch(downloadUrl, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    } finally { clearTimeout(t); }
    if (!resp.ok) { out.error = 'download HTTP ' + resp.status; return out; }
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmp, buf);
    fs.chmodSync(tmp, 0o755);

    // backup
    fs.copyFileSync(bin, backupPath);
    out.backedUp = backupPath;

    // replace
    fs.renameSync(tmp, bin);
    fs.chmodSync(bin, 0o755);
    out.replaced = true;

    // restart (best-effort; never throws)
    out.restart = await restartOllama();
    out.ok = true;
    return out;
  } catch (e) {
    // roll back if we replaced but couldn't finish
    if (out.replaced && fs.existsSync(backupPath)) {
      try { fs.copyFileSync(backupPath, bin); } catch {}
    }
    out.error = e.message;
    return out;
  }
}

async function restartOllama() {
  const s = await sh('systemctl', ['is-active', 'ollama']);
  if (s.ok && String(s.out).trim() === 'active') {
    const r = await sh('systemctl', ['restart', 'ollama']);
    return r.ok ? 'systemctl restart ollama' : 'systemctl restart FAILED: ' + r.err;
  }
  const child = spawn(findBinary(), ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();
  return 'spawned detached `ollama serve` (pid ' + (child.pid || '?') + ')';
}

// ---- public: status (always resolves, never throws) ----
async function status() {
  try {
    const p = await buildPlan();
    return {
      ok: true,
      present: p.present,
      arch: p.arch,
      bin: p.bin,
      current: p.current,
      currentErr: p.currentErr,
      latest: p.latest,
      latestErr: p.latestErr,
      updatable: p.updatable,
      realUpdaterAllowed: (process.env.OLLAMA_UPDATER_ALLOW_REAL === '1'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- public: update. dryRun defaults to true (SAFE). ----
async function update(opts) {
  const dryRun = !(opts && opts.dryRun === false);
  try {
    const plan = await buildPlan();
    if (dryRun) return { ...plan, ok: true, message: 'dry-run only — nothing modified' };
    if (process.env.OLLAMA_UPDATER_ALLOW_REAL !== '1') {
      return { ...plan, ok: false, message: 'refusing real update: set OLLAMA_UPDATER_ALLOW_REAL=1 to enable' };
    }
    return await runUpdate(plan);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { status, update, detectArch, findBinary, currentVersion, latestVersion, buildPlan };
