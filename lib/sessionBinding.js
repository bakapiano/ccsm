'use strict';

// Bind a ccsm session to the upstream CLI's own session id.
//
// Background (see desktop note "AI-CLI-session-pid-binding"): none of the
// three CLIs put their session id on the command line, so we can't read it
// off the process we spawned. Each instead leaves a *runtime trace* keyed by
// the CLI process PID:
//
//   claude  → ~/.claude/sessions/<pid>.json    { sessionId, cwd, status }
//   copilot → ~/.copilot/logs/process-<ts>-<pid>.log   "Workspace initialized: <uuid>"
//   codex   → <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//             (no PID registry — codex holds a long-lived write handle and
//              keeps appending; the active rollout for a cwd is the freshest)
//
// The catch on Windows: ccsm spawns built-ins as `cmd.exe /d /s /c claude`,
// so the PTY's pid is cmd.exe, NOT the real claude/codex/copilot process —
// that runs one or two levels down (claude.cmd → node.exe). So we snapshot
// the whole process table once, walk the descendant set of the PTY pid, and
// match the CLI's per-pid trace against any descendant.
//
// The binding is NOT permanent: forking, /clear, or a fresh /resume all
// rotate the upstream id. server.js rescans running sessions on a timer and
// updates the persisted record whenever the detected id changes.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

// ---- process tree snapshot -------------------------------------------------

// Return a Map<pid:number, ppid:number> for every process on the box. One
// shell-out per call (the scanner calls this once per cycle, not per session).
// Windows: PowerShell + CIM (wmic is gone on recent Win11). POSIX: ps.
function snapshotProcessTree() {
  return process.platform === 'win32' ? snapshotWindows() : snapshotPosix();
}

function runCapture(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      finish('');
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(out); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

async function snapshotWindows() {
  // CSV avoids locale/whitespace parsing headaches. ProcessId/ParentProcessId
  // are the only fields we need to rebuild the tree.
  const csv = await runCapture('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
  ]);
  const tree = new Map();
  if (!csv) return tree;
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^"?(\d+)"?,"?(\d+)"?\s*$/);
    if (!m) continue;
    tree.set(Number(m[1]), Number(m[2]));
  }
  return tree;
}

async function snapshotPosix() {
  const out = await runCapture('ps', ['-eo', 'pid=,ppid=']);
  const tree = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/);
    if (m) tree.set(Number(m[1]), Number(m[2]));
  }
  return tree;
}

// All pids in the subtree rooted at `root` (inclusive). Defends against
// cycles with a visited set.
function descendantsOf(root, tree) {
  const result = new Set();
  if (!Number.isFinite(root)) return result;
  result.add(root);
  // Build child adjacency once from the parent map.
  const children = new Map();
  for (const [pid, ppid] of tree) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of children.get(cur) || []) {
      if (!result.has(child)) { result.add(child); stack.push(child); }
    }
  }
  return result;
}

// ---- small fs helpers ------------------------------------------------------

function sameCwd(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
}

// Read just the first line of a (potentially huge) file, reading in chunks
// until a newline. Codex's session_meta line embeds the full base_instructions
// system prompt, so it routinely exceeds 20 KB — a fixed-size read would
// truncate it mid-JSON. Cap defends against a pathological unterminated line.
async function readFirstLine(file, maxBytes = 512 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const chunk = Buffer.alloc(32 * 1024);
    let acc = '';
    let pos = 0;
    while (pos < maxBytes) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      acc += chunk.toString('utf8', 0, bytesRead);
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
      pos += bytesRead;
    }
    return acc;
  } catch {
    return '';
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
}

// ---- per-CLI detectors -----------------------------------------------------

// claude: ~/.claude/sessions/<pid>.json. Pick the descendant pid whose json
// is freshest; cwd match (when present) breaks ties and guards against a
// stale json lingering after a crash.
async function detectClaude(descSet, cwd) {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  const candidates = [];
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!descSet.has(pid)) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (j && j.sessionId) {
        candidates.push({ sessionId: j.sessionId, cwd: j.cwd, updatedAt: j.updatedAt || 0 });
      }
    } catch {}
  }
  if (!candidates.length) return null;
  const cwdMatches = candidates.filter((c) => sameCwd(c.cwd, cwd));
  const pool = cwdMatches.length ? cwdMatches : candidates;
  pool.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return pool[0].sessionId || null;
}

// copilot: ~/.copilot/logs/process-<ts>-<pid>.log. Filename gives the pid;
// the body's last "Workspace initialized: <uuid>" gives the session id.
async function detectCopilot(descSet) {
  const dir = path.join(os.homedir(), '.copilot', 'logs');
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  const matches = [];
  for (const name of names) {
    const m = name.match(/^process-(\d+)-(\d+)\.log$/);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!descSet.has(pid)) continue;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dir, name))).mtimeMs; } catch {}
    matches.push({ file: path.join(dir, name), mtime });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of matches) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const ids = text.match(/Workspace initialized:\s*([0-9a-f-]{36})/gi);
    if (ids && ids.length) {
      const last = ids[ids.length - 1].match(/([0-9a-f-]{36})/i);
      if (last) return last[1];
    }
  }
  return null;
}

// codex: no pid registry. The live session for a cwd is the rollout whose
// session_meta.cwd matches and which is being actively appended (freshest
// mtime). We bound by a recency window so a long-dead rollout for the same
// folder isn't mistaken for the running one.
const CODEX_RECENT_MS = 15 * 60 * 1000;

// Codex writes rollouts under <CODEX_HOME>/sessions. The catch: a wrapper CLI
// (proxy, alternate provider, …) commonly sets its OWN CODEX_HOME inside the
// child process — which the ccsm server process can't see. So we don't trust a
// single home; we search several candidates and match by cwd:
//   1. $CODEX_HOME (if the server itself has one)
//   2. ~/.codex                              (the default)
//   3. any  <appdata>/*/codex-home           (wrapper convention, name-agnostic)
// Discovery of (3) lists one level under the standard app-data roots, so it
// picks up a wrapper's isolated home without hardcoding its name. Cached
// briefly since the scanner calls this every 10s.
let _codexHomesCache = null;
let _codexHomesAt = 0;
function listChildDirsSync(base) {
  try { return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}
function codexSessionRoots() {
  const now = Date.now();
  if (_codexHomesCache && (now - _codexHomesAt) < 60_000) return _codexHomesCache;
  const homes = new Set();
  if (process.env.CODEX_HOME) homes.add(process.env.CODEX_HOME);
  homes.add(path.join(os.homedir(), '.codex'));
  const bases = [process.env.LOCALAPPDATA, process.env.APPDATA, os.homedir()].filter(Boolean);
  for (const base of bases) {
    for (const child of listChildDirsSync(base)) {
      const cand = path.join(base, child, 'codex-home');
      try { if (fs.existsSync(path.join(cand, 'sessions'))) homes.add(cand); } catch {}
    }
  }
  const roots = [...homes].map((h) => path.join(h, 'sessions'));
  _codexHomesCache = roots;
  _codexHomesAt = now;
  return roots;
}

async function* walkRollouts(root, sinceMs) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      yield* walkRollouts(full, sinceMs);
    } else if (/^rollout-.*\.jsonl$/.test(ent.name)) {
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.mtimeMs >= sinceMs) yield { file: full, mtime: stat.mtimeMs };
    }
  }
}

async function detectCodex(descSet, cwd) {
  const since = Date.now() - CODEX_RECENT_MS;
  const recent = [];
  for (const root of codexSessionRoots()) {
    for await (const r of walkRollouts(root, since)) recent.push(r);
  }
  if (!recent.length) return null;
  recent.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of recent) {
    const firstLine = await readFirstLine(file);
    if (!firstLine) continue;
    let meta;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    // session_meta payload may be the object itself or nested under a wrapper.
    const payload = meta && (meta.payload || meta);
    const metaCwd = payload && (payload.cwd || (payload.session_meta && payload.session_meta.cwd));
    const id = payload && (payload.id || (payload.session_meta && payload.session_meta.id));
    if (id && sameCwd(metaCwd, cwd)) return id;
  }
  return null;
}

// ---- public API ------------------------------------------------------------

// Resolve the live upstream session id for one ccsm session.
//   type    — 'claude' | 'codex' | 'copilot' (CLI .type)
//   ptyPid  — pid of the PTY ccsm spawned (cmd.exe wrapper, usually)
//   cwd     — record cwd, used as a sanity tiebreak / codex matcher
//   tree    — Map from snapshotProcessTree() (pass once for a whole scan)
// Returns the session id string or null.
async function detect(type, ptyPid, cwd, tree) {
  const desc = descendantsOf(Number(ptyPid), tree || new Map());
  switch (type) {
    case 'claude': return detectClaude(desc, cwd);
    case 'copilot': return detectCopilot(desc);
    case 'codex': return detectCodex(desc, cwd);
    default: return null;
  }
}

// Whether we have any binding strategy for a CLI type.
function supports(type) {
  return type === 'claude' || type === 'copilot' || type === 'codex';
}

module.exports = {
  snapshotProcessTree,
  descendantsOf,
  detect,
  supports,
};
