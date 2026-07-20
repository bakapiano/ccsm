#!/usr/bin/env node
'use strict';

// In-app upgrade helper · spawned detached by /api/upgrade.
//
// Why this exists: running `npm i -g` from inside the live server hits
// EBUSY on Windows (npm tries to rename the package directory while the
// server has files open inside it). We can't do the install in-process.
//
// What this script does:
//   1. Server validates the upgrade request, spawns this helper detached
//      with the target version + caller's port/pid, sends 200 OK back to
//      the frontend, then gracefulShutdowns.
//   2. Helper writes ~/.ccsm/.upgrade.lock (so a stray ccsm:// wake on
//      ccsm.cmd doesn't try to start a new server while we're installing).
//   3. Helper starts a tiny HTTP server on port 7779 that serves a
//      progress UI: inline HTML at /, JSON status at /api/upgrade/status,
//      SSE stream of npm output at /api/upgrade/stream. The original
//      frontend navigates to http://localhost:7779/ when it gets the
//      upgrade response, so the user watches install progress live.
//   4. Helper waits for the old port + pid to be gone (up to 30s).
//   5. Helper runs npm i -g against either @bakapiano/ccsm@<target> or
//      the exact GitHub Release .tgz asset selected by the server. It
//      captures stdout + stderr line by line and pushes it into SSE.
//   6. On success: spawn ccsm.cmd (which boots the new server on 7777),
//      push a `done` SSE event with redirectTo=7777 so the UI navigates
//      back. Keep the helper server alive for ~30s for late clients,
//      then exit + release the lock.
//   7. On failure: keep the helper server alive indefinitely so the user
//      can read the error + copy the log. Exits when the user clicks
//      Close in the UI (POST /api/upgrade/dismiss) OR after 10 min.
//
// Argv: node upgrade-helper.js <target> <port> <pid> [installPrefix]
//       [respawn=1|0] [redirectTo] [source=npm|github]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const target = process.argv[2] || 'latest';
const oldPort = Number(process.argv[3] || 7777);
const oldPid = Number(process.argv[4] || 0);
const installPrefix = process.argv[5] || '';
const doRespawn = process.argv[6] !== '0';
// redirectTo: where the updater UI sends the browser after success.
// Server passes the FRONTEND_URL it computed (GH Pages router in
// prod, local apiUrl in dev). Fallback to localhost:oldPort/ so old
// callers that don't pass anything still work.
const redirectTo = process.argv[7] || `http://localhost:${oldPort}/`;
const updateSource = process.argv[8] === 'github' ? 'github' : 'npm';
const githubAssetUrl = `https://github.com/bakapiano/ccsm/releases/download/v${target}/bakapiano-ccsm-${target}.tgz`;
const installSpec = updateSource === 'github' ? githubAssetUrl : `@bakapiano/ccsm@${target}`;

const HELPER_PORT = 7779;
const HOME = process.env.CCSM_HOME || path.join(os.homedir(), '.ccsm');
const LOG = path.join(HOME, 'upgrade.log');
const LOCK = path.join(HOME, '.upgrade.lock');
try { fs.mkdirSync(HOME, { recursive: true }); } catch {}

function fileLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portFree(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const finish = (free) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(free); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(false));
    s.once('timeout', () => finish(true));
    s.once('error', () => finish(true));
    s.connect(port, '127.0.0.1');
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// ── Lockfile so bin/ccsm.js refuses to spawn a new server mid-upgrade.
// bin reads .upgrade.lock at startup; if it exists with a live pid and
// startedAt < 10min ago it exits early. Stale locks are auto-cleared.
let phaseValue = 'starting';
function writeLock() {
  try {
    fs.writeFileSync(LOCK, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      target,
      source: updateSource,
      phase: phaseValue,
      helperPort: HELPER_PORT,
    }, null, 2));
  } catch {}
}
function removeLock() {
  try { fs.unlinkSync(LOCK); } catch {}
}
writeLock();
process.on('exit', removeLock);
process.on('SIGINT', () => { removeLock(); process.exit(0); });
process.on('SIGTERM', () => { removeLock(); process.exit(0); });
process.on('uncaughtException', (e) => { fileLog(`uncaught: ${e.stack || e.message}`); removeLock(); process.exit(1); });

// ── Progress state shared with the HTTP server. ─────────────────────
const startedAt = Date.now();
const linesBuffer = [];       // ring of {ts, stream, text}
const LINES_CAP = 2000;
const sseClients = new Set(); // res objects we push events to
let errorMsg = null;
let finishedAt = null;

function pushLine(stream, text) {
  if (!text) return;
  const entry = { ts: Date.now(), stream, text };
  linesBuffer.push(entry);
  if (linesBuffer.length > LINES_CAP) linesBuffer.shift();
  const payload = JSON.stringify(entry);
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
  fileLog(`[${stream}] ${text}`);
}

function setPhase(p) {
  phaseValue = p;
  writeLock();
  const payload = JSON.stringify({ phase: p, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`event: phase\ndata: ${payload}\n\n`); } catch {}
  }
  fileLog(`[phase] ${p}`);
}

function notifyDone(redirectTo) {
  finishedAt = Date.now();
  const payload = JSON.stringify({ redirectTo, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`event: done\ndata: ${payload}\n\n`); } catch {}
  }
}

function notifyFailed() {
  finishedAt = Date.now();
  const payload = JSON.stringify({ error: errorMsg, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`event: failed\ndata: ${payload}\n\n`); } catch {}
  }
}

// ── Inline updater UI ────────────────────────────────────────────────
const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ccsm · upgrade</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" />
<style>
:root {
  --bg: #faf9f5;
  --bg-elev: #ffffff;
  --ink: #1a1815;
  --ink-mid: #6b665d;
  --ink-muted: #9a9489;
  --border: #e8e3d5;
  --accent: #4a73a5;
  --green: #4a8a4a;
  --red: #b73f3f;
  --warn: #c79544;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 14px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px;
}
.card {
  width: 100%;
  max-width: 720px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px 28px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
h1 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.subtitle {
  color: var(--ink-mid);
  margin: 0 0 20px;
  font-size: 13px;
}
.subtitle .mono { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
.phase-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
}
.phase-row:last-of-type { border-bottom: 0; }
.phase-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
}
.phase-row.active .phase-dot {
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}
.phase-row.done .phase-dot { background: var(--green); }
.phase-row.failed .phase-dot { background: var(--red); }
.phase-row.pending .phase-dot { background: var(--border); }
.phase-label {
  flex: 1;
  font-size: 13px;
  color: var(--ink);
}
.phase-row.pending .phase-label { color: var(--ink-muted); }
.phase-row.done .phase-label { color: var(--ink-mid); }
.phase-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  color: var(--ink-muted);
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(1.3); }
}
.log {
  margin-top: 16px;
  background: #1a1815;
  color: #e8e3d5;
  border-radius: 6px;
  padding: 12px 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  line-height: 1.5;
  max-height: 320px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.log .line.err { color: #e07b6e; }
.log .line.info { color: #9bb8d8; }
.log .ts { color: #534e44; margin-right: 8px; }
.banner {
  margin-top: 16px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
}
.banner.success {
  background: rgba(74, 138, 74, 0.08);
  color: var(--green);
  border: 1px solid rgba(74, 138, 74, 0.3);
}
.banner.error {
  background: rgba(183, 63, 63, 0.08);
  color: var(--red);
  border: 1px solid rgba(183, 63, 63, 0.3);
}
.actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.btn {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--ink);
  padding: 7px 14px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.btn.primary {
  background: var(--ink);
  color: var(--bg-elev);
  border-color: var(--ink);
}
.btn:hover { background: rgba(0,0,0,0.04); }
.btn.primary:hover { background: #000; }
</style>
</head>
<body>
<div class="card">
  <h1>Upgrading ccsm</h1>
  <p class="subtitle">source: <span class="mono" id="source"></span> · target: <span class="mono">v<span id="target"></span></span></p>

  <div id="phases">
    <div class="phase-row pending" data-phase="waiting-port">
      <span class="phase-dot"></span>
      <span class="phase-label">Wait for old backend to exit</span>
      <span class="phase-meta" data-meta-for="waiting-port"></span>
    </div>
    <div class="phase-row pending" data-phase="installing">
      <span class="phase-dot"></span>
      <span class="phase-label">Run <span class="phase-meta">npm i -g</span></span>
      <span class="phase-meta" data-meta-for="installing"></span>
    </div>
    <div class="phase-row pending" data-phase="spawning">
      <span class="phase-dot"></span>
      <span class="phase-label">Start new backend</span>
      <span class="phase-meta" data-meta-for="spawning"></span>
    </div>
  </div>

  <div id="banner"></div>
  <div class="log" id="log"></div>

  <div class="actions">
    <button class="btn" id="copyLog">Copy log</button>
    <button class="btn primary" id="close" style="display:none">Close</button>
  </div>
</div>

<script>
(function () {
  const targetEl = document.getElementById('target');
  const sourceEl = document.getElementById('source');
  const logEl = document.getElementById('log');
  const bannerEl = document.getElementById('banner');
  const closeBtn = document.getElementById('close');
  const copyBtn = document.getElementById('copyLog');

  const PHASE_ORDER = ['waiting-port', 'installing', 'spawning', 'done'];
  let lastPhaseTs = Date.now();

  function setPhase(phase) {
    const idx = PHASE_ORDER.indexOf(phase);
    document.querySelectorAll('.phase-row').forEach((row) => {
      const p = row.getAttribute('data-phase');
      const pi = PHASE_ORDER.indexOf(p);
      row.classList.remove('pending', 'active', 'done', 'failed');
      if (phase === 'failed') {
        if (pi < idx || (pi === idx - 1)) row.classList.add('done');
        else if (pi === idx) row.classList.add('failed');
        else row.classList.add('pending');
      } else if (pi < idx) row.classList.add('done');
      else if (pi === idx) row.classList.add('active');
      else row.classList.add('pending');
    });
  }

  function appendLine(entry) {
    const div = document.createElement('div');
    div.className = 'line ' + (entry.stream === 'stderr' ? 'err' : entry.stream === 'info' ? 'info' : '');
    const t = new Date(entry.ts).toLocaleTimeString();
    div.innerHTML = '<span class="ts">' + t + '</span>' + escapeHtml(entry.text);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  copyBtn.addEventListener('click', () => {
    const text = Array.from(logEl.children).map((d) => d.innerText).join('\\n');
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerText = 'Copied';
      setTimeout(() => { copyBtn.innerText = 'Copy log'; }, 1500);
    });
  });

  closeBtn.addEventListener('click', () => {
    fetch('/api/upgrade/dismiss', { method: 'POST' }).catch(() => {});
    window.close();
  });

  // SSE stream — server replays the buffer first then streams new
  // events. EventSource auto-reconnects.
  const es = new EventSource('/api/upgrade/stream');

  // Status fetch up-front to fill target + initial phase quickly even
  // if SSE is slow to push.
  fetch('/api/upgrade/status').then((r) => r.json()).then((s) => {
    targetEl.innerText = s.target || '';
    sourceEl.innerText = s.source === 'github' ? 'GitHub Release' : 'npm';
    if (s.phase) setPhase(s.phase);
    if (s.errorMsg) showFailed(s.errorMsg);
    if (s.lines) s.lines.forEach(appendLine);
  }).catch(() => {});

  es.addEventListener('message', (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      if (entry.stream && entry.text != null) appendLine(entry);
    } catch {}
  });
  es.addEventListener('phase', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.phase) setPhase(data.phase);
    } catch {}
  });
  es.addEventListener('done', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      setPhase('done');
      document.querySelectorAll('.phase-row').forEach((r) => r.classList.add('done'));
      bannerEl.className = 'banner success';
      bannerEl.innerText = 'Upgrade complete. Redirecting to the new backend…';
      closeBtn.style.display = '';
      // Give the new backend a moment to bind 7777 before redirecting.
      setTimeout(() => {
        location.href = data.redirectTo || 'http://localhost:7777/';
      }, 1500);
    } catch {}
  });
  es.addEventListener('failed', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      showFailed(data.error);
    } catch {}
  });

  function showFailed(msg) {
    setPhase('failed');
    bannerEl.className = 'banner error';
    bannerEl.innerText = 'Upgrade failed: ' + (msg || 'unknown error');
    closeBtn.style.display = '';
    closeBtn.innerText = 'Close';
  }
})();
</script>
</body>
</html>`;

// ── HTTP server ──────────────────────────────────────────────────────
function buildStatus() {
  return {
    target,
    source: updateSource,
    phase: phaseValue,
    startedAt,
    finishedAt,
    errorMsg,
    redirectTo,
    helperPort: HELPER_PORT,
    lines: linesBuffer.slice(-500),
  };
}

const httpServer = http.createServer((req, res) => {
  // Permissive CORS — only listens on localhost anyway.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();

  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(UI_HTML);
  }
  if (req.url === '/api/upgrade/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(buildStatus()));
  }
  if (req.url === '/api/upgrade/stream') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    // Replay buffered lines so a late client catches up.
    for (const entry of linesBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    res.write(`event: phase\ndata: ${JSON.stringify({ phase: phaseValue, ts: Date.now() })}\n\n`);
    if (finishedAt && errorMsg) {
      res.write(`event: failed\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
    } else if (finishedAt) {
      res.write(`event: done\ndata: ${JSON.stringify({ redirectTo })}\n\n`);
    }
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }
  if (req.url === '/api/upgrade/dismiss' && req.method === 'POST') {
    res.end('{"ok":true}');
    // Schedule self-exit so the user closing the window also wraps up
    // the helper. Give SSE a chance to flush.
    setTimeout(() => {
      removeLock();
      process.exit(0);
    }, 300);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
httpServer.on('error', (e) => {
  fileLog(`http server error: ${e.message}`);
});
httpServer.listen(HELPER_PORT, '127.0.0.1', () => {
  fileLog(`updater UI at http://localhost:${HELPER_PORT}/`);
  pushLine('info', `Helper UI listening on http://localhost:${HELPER_PORT}/`);
});

// ── Main upgrade flow ────────────────────────────────────────────────
(async () => {
  fileLog(`start · source=${updateSource} target=${target} oldPort=${oldPort} oldPid=${oldPid}${installPrefix ? ` prefix=${installPrefix}` : ''}${!doRespawn ? ' (no respawn)' : ''}`);
  pushLine('info', `Upgrading ccsm to ${target} from ${updateSource === 'github' ? 'GitHub Release' : 'npm'}`);

  setPhase('waiting-port');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const free = await portFree(oldPort);
    const dead = !pidAlive(oldPid);
    if (free && dead) break;
    await sleep(250);
  }
  pushLine('info', `Old backend gone (port ${oldPort} free, pid ${oldPid} dead).`);

  setPhase('installing');
  pushLine('info', `Running: npm i -g ${installSpec}${installPrefix ? ` --prefix=${installPrefix}` : ''}`);

  // Extra settle: gracefulShutdown only waits for the server pid, but
  // node-pty grandchildren (winpty-agent / conpty) need a beat longer
  // to release file locks on node_modules/node-pty/build/Release/*.node.
  // Without this beat, npm hits EBUSY/EPERM renaming the package dir.
  await sleep(2000);

  const isWin = process.platform === 'win32';
  const npmArgs = ['i', '-g'];
  if (installPrefix) {
    try { fs.mkdirSync(installPrefix, { recursive: true }); } catch {}
    npmArgs.push(`--prefix=${installPrefix}`);
  }
  npmArgs.push(installSpec);

  let exe, exeArgs;
  if (isWin) {
    exe = process.env.ComSpec || 'cmd.exe';
    exeArgs = ['/d', '/s', '/c', 'npm', ...npmArgs];
  } else {
    exe = 'npm';
    exeArgs = npmArgs;
  }

  // Postinstall opens the hosted setup guide by default — fine on a
  // first npm i, but during an in-app upgrade the user is already in
  // the updater UI and a fresh tab to /setup/ is just noise.
  const npmEnv = { ...process.env, CCSM_NO_AUTOLAUNCH: '1' };

  const LOCK_PATTERN = /\b(EBUSY|EPERM|ENOTEMPTY|EEXIST|ELOCKED|locked|in use|cannot rename|operation not permitted)\b/i;

  async function runNpmOnce() {
    let sawLockError = false;
    const exit = await new Promise((resolve) => {
      const child = spawn(exe, exeArgs, { windowsHide: true, env: npmEnv });
      const pipe = (stream, label) => {
        let leftover = '';
        stream.on('data', (chunk) => {
          const text = leftover + chunk.toString();
          const lines = text.split(/\r?\n/);
          leftover = lines.pop() || '';
          for (const line of lines) {
            if (!line) continue;
            if (LOCK_PATTERN.test(line)) sawLockError = true;
            pushLine(label, line);
          }
        });
        stream.on('end', () => { if (leftover) pushLine(label, leftover); });
      };
      pipe(child.stdout, 'stdout');
      pipe(child.stderr, 'stderr');
      child.on('error', (e) => {
        pushLine('stderr', `spawn error: ${e.message}`);
        resolve(-1);
      });
      child.on('exit', (code) => resolve(code));
    });
    return { exit, sawLockError };
  }

  let npmExit = -1;
  // Up to 3 attempts: original + 2 retries with growing backoff. Only
  // retry when the failure looks like a file-lock issue from straggling
  // child handles, never on a clean nonzero exit (auth, 404, etc).
  const backoffs = [3000, 6000];
  let attempt = 0;
  while (true) {
    attempt++;
    const { exit, sawLockError } = await runNpmOnce();
    npmExit = exit;
    if (exit === 0) break;
    if (!sawLockError || attempt > backoffs.length) break;
    const wait = backoffs[attempt - 1];
    pushLine('info', `npm failed with what looks like a file lock; retrying in ${Math.round(wait/1000)}s (attempt ${attempt + 1})…`);
    await sleep(wait);
  }

  if (npmExit !== 0) {
    errorMsg = `npm exited with code ${npmExit}`;
    pushLine('stderr', errorMsg);
    notifyFailed();
    // Stay alive 10min so user can copy log + read error.
    setTimeout(() => { removeLock(); process.exit(1); }, 10 * 60_000);
    return;
  }
  pushLine('info', `npm install completed (exit ${npmExit}).`);

  if (!doRespawn) {
    pushLine('info', 'respawn skipped (respawn=0).');
    setPhase('done');
    notifyDone(redirectTo);
    setTimeout(() => { removeLock(); process.exit(0); }, 30_000);
    return;
  }

  setPhase('spawning');
  pushLine('info', 'Starting new backend…');

  const ccsmCmd = installPrefix
    ? (isWin ? path.join(installPrefix, 'ccsm.cmd') : path.join(installPrefix, 'bin', 'ccsm'))
    : (isWin ? 'ccsm.cmd' : 'ccsm');
  const childEnv = { ...process.env };
  delete childEnv.CCSM_NO_BROWSER;
  // Hint the new ccsm that it was spawned by the updater so it can
  // skip auto-opening a browser window — the user is already looking
  // at the updater UI which will redirect to the new server.
  childEnv.CCSM_FROM_UPGRADE = '1';
  let respawnExe, respawnArgs;
  if (isWin) {
    respawnExe = process.env.ComSpec || 'cmd.exe';
    respawnArgs = ['/d', '/s', '/c', ccsmCmd];
  } else {
    respawnExe = ccsmCmd;
    respawnArgs = [];
  }
  try {
    const child = spawn(respawnExe, respawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: childEnv,
    });
    child.unref();
    pushLine('info', `Spawned ${ccsmCmd} (via ${path.basename(respawnExe)}).`);
  } catch (e) {
    errorMsg = `respawn failed: ${e.message}`;
    pushLine('stderr', errorMsg);
    notifyFailed();
    setTimeout(() => { removeLock(); process.exit(1); }, 10 * 60_000);
    return;
  }

  setPhase('done');
  notifyDone(redirectTo);
  pushLine('info', 'Done. Redirecting frontend to the new backend.');

  // Stay alive briefly so late-arriving SSE clients still see the
  // success state. After that the helper exits and releases the lock;
  // the new ccsm at port 7777 takes over.
  setTimeout(() => { removeLock(); process.exit(0); }, 30_000);
})().catch((e) => {
  errorMsg = e?.message || String(e);
  fileLog(`fatal: ${errorMsg}`);
  pushLine('stderr', `fatal: ${errorMsg}`);
  notifyFailed();
  setTimeout(() => { removeLock(); process.exit(1); }, 10 * 60_000);
});
