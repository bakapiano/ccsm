#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');

const { loadConfig, saveConfig, DATA_DIR } = require('./lib/config');
const {
  listWorkspaces,
  findOrCreateWorkspace,
  ensureReposInWorkspace,
  isInside,
} = require('./lib/workspace');
const webTerminal = require('./lib/webTerminal');
const persistedSessions = require('./lib/persistedSessions');
const folders = require('./lib/folders');
const tunnel = require('./lib/tunnel');
const devices = require('./lib/devices');
// Upstream CLI session-id capture used to live in lib/cliSessionWatcher
// (poll the CLI's transcript dir, match by cwd). It's gone now — for
// CLIs that expose a "set the UUID for a new session" flag (claude +
// copilot both have --session-id <uuid>) we pre-generate the id in
// /api/sessions/new and pass it via cli.newSessionIdArgs. For CLIs
// without that flag (codex) we just don't capture an id; the user
// gets cli.resumeArgs (--continue / resume --last) on relaunch.
const localCliSessions = require('./lib/localCliSessions');

// One unified exit path: kill PTY children, then exit. v1.0 dropped the
// snapshot-on-exit behaviour because the new persistedSessions store is
// the source of truth (and is always on disk, not in memory).
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ccsm] shutting down · ${reason}`);
  // Mark all running sessions as exited (best-effort) so the next launch
  // doesn't show stale "running" rows.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') {
        await persistedSessions.markExited(s.id, null).catch(() => {});
      }
    }
  } catch {}
  try { webTerminal.killAll(); } catch {}
  try { tunnel.stop(); } catch {}
  process.exit(0);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS · allow the hosted-frontend (GH Pages) origin to call /api/* and
// open WebSockets. Listed explicitly — never reflect Origin or use '*' so
// random web pages can't reach the local backend. Localhost dev calls
// stay same-origin (browser doesn't add Origin header → middleware is a
// no-op for them).
const ALLOWED_ORIGINS = new Set([
  'https://bakapiano.github.io',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Device-Code');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Remote-access token guard. Once a token is set (via the Remote page
// → POST /api/tunnel/start), any /api/* request that wasn't direct
// loopback must present the token either as `Authorization: Bearer
// <token>` or `?token=<token>`.
// "Direct loopback" = the Host header is loopback-shaped AND no
// proxy injected an X-Forwarded-* header. devtunnel rewrites Host
// to `localhost:7788` (it's reverse-proxying via a local socket) but
// adds `x-forwarded-host` / `x-forwarded-for`; cloudflared does the
// same with `cf-connecting-ip` etc. Either header's mere presence
// flips us into "treat as remote" mode regardless of Host. Real
// browsers on the host machine set neither.
// /api/health is exempt so tunnel URL probes keep working without
// leaking the token.
function isDirectLoopback(req) {
  if (req.headers['x-forwarded-host']) return false;
  if (req.headers['x-forwarded-for']) return false;
  if (req.headers['cf-connecting-ip']) return false;
  const host = String(req.headers.host || '').toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}
// Device-approval gate.
//
// Two-stage trust model:
//   1. NEW device wants in → must hit /api/devices/me with a valid
//      token. That's the only place new pending records get created
//      (see the handler below). Without the token, a stranger can't
//      flood the host's pending queue with random device ids.
//   2. ALREADY-known device → its UUID is the credential. The host
//      Approved it once; subsequent calls go through with just the
//      X-Device-Id header (no token needed). Rotating the host token
//      doesn't break existing approved devices — they keep working
//      until the host explicitly Revokes them.
//
// This middleware reads-only: it never inserts. Unknown ids → 401 to
// nudge the caller to re-arrive via the share URL (which lands them
// on /api/devices/me with the embedded token and registers them).
const DEVICE_EXEMPT_PATHS = new Set(['/api/health', '/api/devices/me']);
async function deviceGate(req, res, next) {
  if (DEVICE_EXEMPT_PATHS.has(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (isDirectLoopback(req)) return next();
  const id = String(req.headers['x-device-id'] || (req.query && req.query.device) || '');
  if (!id) return res.status(400).json({ error: 'device id required' });
  const d = await devices.get(id);
  if (!d) return res.status(401).json({ error: 'unknown device · open the share URL to register' });
  // Bump lastSeen via record() — it short-circuits the write when the
  // last flush was recent (see MIN_FLUSH_MS in lib/devices.js).
  try { await devices.record(id, {
    userAgent: req.headers['user-agent'] || '',
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    code: req.headers['x-device-code'] || '',
  }); } catch { /* lastSeen bump is best-effort */ }
  if (d.status === 'approved') return next();
  return res.status(403).json({
    error: d.status === 'rejected' ? 'device rejected by host' : 'pending host approval',
    pending: d.status === 'pending',
    rejected: d.status === 'rejected',
    deviceId: d.id,
  });
}
app.use(deviceGate);

// Final admin lock — all device management + tunnel-mutating routes are
// loopback-only. The remote browser already only sees /api/health and
// /api/devices/me through the gates above; this stops a remote from
// trying to enumerate or manipulate the approval list even if they
// somehow got past everything.
const HOST_ONLY_PREFIXES = ['/api/devices', '/api/tunnel'];
app.use((req, res, next) => {
  if (!HOST_ONLY_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (req.path === '/api/devices/me') return next();
  if (isDirectLoopback(req)) return next();
  res.status(403).json({ error: 'host-only endpoint' });
});

// Dev mode = running from a checkout (not from an npm-install location).
// Used to gate two things: (a) serving static frontend from local public/
// so a contributor can iterate without pushing to GH Pages; (b) hot-reload
// SSE endpoint that watches public/ for changes. CCSM_NO_DEV=1 disables
// both explicitly. In production (npm-installed), backend is API-only —
// frontend lives at https://bakapiano.github.io/ccsm/ (router → per-version).
const IS_DEV = !__dirname.includes(`${path.sep}node_modules${path.sep}`) && process.env.CCSM_NO_DEV !== '1';

// Always serve public/ when it exists alongside server.js. In a
// checkout this is the live frontend used during dev. In an npm
// install this lets a tunneled session (Remote page) reach the
// frontend at the tunnel URL — the GH Pages hosted frontend is
// unreachable to a phone on cellular, but the locally-bundled
// public/ shipped in the package IS, via the tunnel. Same files
// either way; just no version router in front.
{
  const publicDir = path.join(__dirname, 'public');
  try {
    if (require('node:fs').statSync(publicDir).isDirectory()) {
      app.use(express.static(publicDir));
    }
  } catch { /* not bundled · API-only mode */ }
}

const reloadClients = new Set();
if (IS_DEV) {
  app.get('/api/dev/ping', (_req, res) => res.json({ dev: true }));
  app.get('/api/dev/reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    reloadClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); reloadClients.delete(res); });
  });
  const publicDir = path.join(__dirname, 'public');
  const fs = require('node:fs');
  let debounce = null;
  fs.watch(publicDir, { recursive: true }, (_event, filename) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (reloadClients.size === 0) return;
      console.log(`[dev] reload · ${filename || '?'} → ${reloadClients.size} client(s)`);
      for (const r of reloadClients) {
        try { r.write(`event: reload\ndata: ${Date.now()}\n\n`); } catch {}
      }
    }, 80);
  });
  console.log('[dev] hot-reload watching public/');
}

function asyncH(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api error]', err);
      res.status(500).json({ error: String(err && err.message || err) });
    });
  };
}

// ---- helpers ----

function pickCli(cfg, requestedId) {
  const wanted = requestedId || cfg.defaultCliId;
  return cfg.clis.find((c) => c.id === wanted) || cfg.clis[0];
}

function findCliById(cfg, id) {
  return (cfg.clis || []).find((c) => c.id === id) || null;
}

// Resolve how to spawn a CLI command. Windows quirks:
// v1.1 — spawn strategy is now caller-controlled via cli.shell:
//   'direct' — pty.spawn(command, args). Real .exe / absolute paths only.
//              Won't find pwsh aliases / functions.
//   'pwsh'   — wrap in `pwsh.exe -NoLogo -NoExit -Command "& { cmd args }"`.
//              Loads $PROFILE → pwsh aliases / functions work.
//              Falls back to powershell.exe (5.x) if pwsh.exe absent.
//   'cmd'    — wrap in `cmd.exe /d /s /c "cmd args"`. Resolves doskey aliases
//              and PATH-only names without pwsh dependency.
function resolveCommand(commandRaw, userArgs = [], shell = 'direct') {
  if (!commandRaw) throw new Error('cli.command is empty');
  const cmd = commandRaw.replace(/^\.[\\\/]/, '');

  if (shell === 'pwsh') {
    // Build a single -Command string so pwsh tokenizes args itself. The
    // `& { ... }` wrapper makes pwsh execute the line as a script block —
    // critical for functions (which aren't visible without invocation).
    const joined = [cmd, ...userArgs.map(quoteForPwsh)].join(' ');
    return {
      exe: 'pwsh.exe',
      prefixArgs: ['-NoLogo', '-NoExit', '-Command', `& { ${joined} }`],
      fallbackExe: 'powershell.exe',
      consumesUserArgs: true,
    };
  }

  if (shell === 'cmd') {
    // /d skips AutoRun, /s preserves quoting, /c runs and exits.
    const joined = [cmd, ...userArgs.map(quoteForCmd)].join(' ');
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', joined],
      consumesUserArgs: true,
    };
  }

  // shell === 'direct' — bare pty.spawn. Honour .cmd/.bat/.ps1 extensions
  // when an absolute path was provided so they still work without an
  // explicit shell choice.
  if (path.isAbsolute(cmd)) {
    const ext = path.extname(cmd).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { exe: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmd], consumesUserArgs: false };
    }
    if (ext === '.ps1') {
      return { exe: 'powershell.exe', prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd], consumesUserArgs: false };
    }
    return { exe: cmd, prefixArgs: [], consumesUserArgs: false };
  }
  // Bare name with shell=direct: defer to cmd.exe so Windows resolves
  // against PATH. Same behavior as before — preserves user expectations
  // for `claude` / `codex` configs that don't set shell.
  return { exe: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmd], consumesUserArgs: false };
}

function quoteForPwsh(s) {
  if (s === '' || /[\s'"`$]/.test(s)) return `'${String(s).replace(/'/g, "''")}'`;
  return s;
}
function quoteForCmd(s) {
  if (s === '' || /[\s"&|<>^]/.test(s)) return `"${String(s).replace(/"/g, '""')}"`;
  return s;
}

function spawnCliSession({ cli, cwd, sessionId, meta, extraArgs = [], theme, cols, rows }) {
  if (!webTerminal.available) {
    const e = new Error('node-pty unavailable · cannot spawn web terminal');
    e.code = 'PTY_UNAVAILABLE';
    throw e;
  }
  // For shell wrappers (pwsh/cmd) we need to bake BOTH cli.args and
  // extraArgs into the single quoted command string — otherwise extraArgs
  // would become args to the shell itself, not the wrapped command.
  // Re-resolve here when extraArgs is present so the quoting is correct.
  // Force a session-scoped theme=auto for claude so its syntax/diff colours
  // follow the ccsm terminal background (which we report via OSC 10/11 in
  // TerminalView). claude's DEFAULT theme is *dark*, whose near-white tokens
  // (comments, f-string interpolations, call names) vanish on our light
  // terminal — the "字体颜色和背景重复" bug. --settings is session-scoped, so
  // the user's global ~/.claude/settings.json is left untouched, and ccsm
  // sessions Just Work on a fresh machine without anyone running /theme auto.
  // (Injected here as an integration arg, like --session-id — not via the
  // user-editable cli.args, so it reaches existing configs too.)
  // Skip the injection entirely if the user already put their own --settings
  // in cli.args — claude deep-merges multiple --settings (verified: later ones
  // win per-key), so ours would silently override a theme they set on purpose.
  // Respect the user's explicit choice instead.
  const userHasSettings = (cli.args || []).some(
    (a) => a === '--settings' || String(a).startsWith('--settings='));
  const baseArgs = [...(cli.args || [])];
  if (cli.type === 'claude' && !userHasSettings) baseArgs.push('--settings', '{"theme":"auto"}');
  const resolved = resolveCommand(
    cli.command,
    [...baseArgs, ...extraArgs],
    cli.shell || 'direct',
  );
  const { exe, prefixArgs, fallbackExe, consumesUserArgs } = resolved;
  const args = consumesUserArgs
    ? prefixArgs
    : [...prefixArgs, ...baseArgs, ...extraArgs];
  // Merge user-scope PATH from registry into the env we hand the PTY.
  // spawnEnv() also strips duplicate path-case keys so our override
  // doesn't get shadowed by the inherited `Path` from process.env.
  const env = spawnEnv(cli.env);
  // Tell background-aware CLIs which way the ccsm terminal is painted, so
  // their light/dark auto-detection matches it. COLORFGBG (fg;bg ANSI indices)
  // is the de-facto signal that codex (its DiffTheme probes it), copilot, and
  // claude all read — bg 15 = light, 0 = dark. claude additionally gets OSC
  // 10/11 answers + --settings auto; this covers codex/copilot, which detect
  // via COLORFGBG, not OSC. The frontend passes its resolved theme on spawn;
  // a theme switch is picked up on the next resume.
  if (theme === 'light' || theme === 'dark') {
    env.COLORFGBG = theme === 'light' ? '0;15' : '15;0';
  }
  // Spawn the PTY at the size the frontend measured for its terminal pane
  // (clamped against junk), so alt-screen CLIs lay out at the right height
  // from the first frame instead of node-pty's 120×30 default. Omitted ⇒
  // webTerminal.spawn keeps its default; xterm's first resize corrects any
  // small estimate error on attach regardless.
  const sized = (Number(cols) > 0 && Number(rows) > 0)
    ? { cols: Math.min(400, Math.max(20, Math.floor(Number(cols)))),
        rows: Math.min(200, Math.max(8, Math.floor(Number(rows)))) }
    : {};
  const trySpawn = (executable) => webTerminal.spawn({
    id: sessionId,
    command: executable,
    args,
    cwd,
    env,
    ...sized,
    meta: { ...meta, cliId: cli.id, cliName: cli.name },
    onData: () => {
      persistedSessions.touch(sessionId).catch(() => {});
      try { require('./lib/cliActivity').noteOutput(sessionId); } catch {}
    },
    onExit: ({ exitCode }) => {
      persistedSessions.markExited(sessionId, exitCode).catch(() => {});
    },
  });
  try {
    const entry = trySpawn(exe);
    return entry;
  } catch (e) {
    if (fallbackExe && /ENOENT|cannot find|not recognized/i.test(String(e && e.message || e))) {
      const entry = trySpawn(fallbackExe);
      return entry;
    }
    throw e;
  }
}

// Read user PATH from registry once at boot, prepend to process PATH.
// On platforms other than Windows or if the read fails, fall back to
// process.env.PATH unchanged.
let mergedUserPath = null;
function buildMergedUserPath() {
  if (process.platform !== 'win32') return process.env.PATH;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'PATH'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return process.env.PATH;
    const line = r.stdout.split(/\r?\n/).find((l) => /\bPATH\b/i.test(l) && /REG_(EXPAND_)?SZ/i.test(l));
    if (!line) return process.env.PATH;
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (!m) return process.env.PATH;
    // Expand %VAR% references manually (REG_EXPAND_SZ keeps them literal).
    const userPath = m[1].replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
    const existing = (process.env.PATH || '').split(';').map((s) => s.trim()).filter(Boolean);
    const adds = userPath.split(';').map((s) => s.trim()).filter(Boolean);
    const merged = [];
    const seen = new Set();
    for (const p of [...adds, ...existing]) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(p);
    }
    return merged.join(';');
  } catch {
    return process.env.PATH;
  }
}
mergedUserPath = buildMergedUserPath();

// Hand back a fresh env for spawning a child, with PATH overridden by
// our merged user PATH and any duplicate case variants of "path"
// stripped first. Windows env lookup is case-insensitive but the env
// block we hand CreateProcess is an ordered byte buffer — if both
// `Path` (inherited from process.env, OS canonical case) and `PATH`
// (our override) are present, Windows resolves to whichever comes
// first in the block. Node's Object.keys preserves insertion order,
// so the inherited `Path` would win and our merged override silently
// disappear. Strip all path-shaped keys first, then add the merge.
function spawnEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (process.platform === 'win32') {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path') delete env[k];
    }
  }
  if (mergedUserPath) env.PATH = mergedUserPath;
  return env;
}

// ---- config ----

// Per-CLI install probe. Looks up the command on PATH using `where` (win)
// or `which` (posix). Result is cached forever — restart ccsm after
// installing/uninstalling a CLI to refresh. Cheap (10ms cold, 0ms cached).
const cliProbeCache = new Map();
function probeCli(command) {
  if (!command) return null;
  if (cliProbeCache.has(command)) return cliProbeCache.get(command);
  const { spawnSync } = require('node:child_process');
  let resolvedPath = null;
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where.exe' : 'which';
    const env = { ...process.env };
    if (mergedUserPath) env.PATH = mergedUserPath;
    const r = spawnSync(cmd, [command], { encoding: 'utf8', windowsHide: true, env });
    if (r.status === 0 && r.stdout) {
      resolvedPath = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    }
  } catch {}
  cliProbeCache.set(command, resolvedPath);
  return resolvedPath;
}

function decorateConfigWithProbes(cfg) {
  return {
    ...cfg,
    clis: (cfg.clis || []).map((c) => {
      const path = probeCli(c.command);
      return { ...c, installed: !!path, installPath: path };
    }),
  };
}

// The tunnel + devtunnel config blocks are managed exclusively through
// /api/tunnel/* (host-only) — they hold the persisted remote-access
// token and the named tunnelId. Strip them from /api/config so (a) the
// plaintext token never reaches an approved remote device reading config
// and (b) the frontend's whole-object config round-trip on save can't
// clobber tunnelId/token with a stale snapshot.
function stripTunnelKeys(cfg) {
  const rest = { ...cfg };
  delete rest.tunnel;
  delete rest.devtunnel;
  return rest;
}

function workspaceOccupancySessions(sessions, cfg) {
  const includeStopped = cfg?.reserveWorkspacesForStoppedSessions === true;
  return (sessions || []).filter((s) =>
    s && s.cwd && (includeStopped || s.status === 'running')
  );
}

function workspaceOccupancyLabel(cfg) {
  return cfg?.reserveWorkspacesForStoppedSessions === true ? 'session' : 'running session';
}

app.get('/api/config', asyncH(async (_req, res) => {
  res.json(decorateConfigWithProbes(stripTunnelKeys(await loadConfig())));
}));

app.put('/api/config', asyncH(async (req, res) => {
  const body = { ...(req.body || {}) };
  delete body.tunnel;
  delete body.devtunnel;
  res.json(decorateConfigWithProbes(stripTunnelKeys(await saveConfig(body))));
}));

// ---- CLI probe / test ----
//
// Run the user's configured command with `--version` and report back
// stdout/stderr + whether the output looks like the claimed CLI type.
// Used by the Configure page "Test" button so the user can verify the
// command resolves + actually launches the right tool BEFORE saving.
// Body: { command, args?, shell?, type? }. args is ignored for the
// version probe — we always append `--version` directly so the user's
// runtime args (e.g. --dangerously-skip-permissions) don't perturb the
// quick probe.
app.post('/api/clis/test', asyncH(async (req, res) => {
  const { spawn } = require('node:child_process');
  const body = req.body || {};
  const command = String(body.command || '').trim();
  const shell = ['direct', 'pwsh', 'cmd'].includes(body.shell) ? body.shell : 'direct';
  const type = ['claude', 'codex', 'copilot', 'other'].includes(body.type) ? body.type : 'other';
  if (!command) return res.status(400).json({ error: 'command required' });

  // Build the test exec. Same shell-wrapping rules as resolveCommand,
  // but we force `--version` as the only arg and we DROP `-NoExit`
  // from the pwsh wrapper so pwsh terminates after printing.
  let exe, args;
  const cmd = command.replace(/^\.[\\\/]/, '');
  const versionArg = '--version';
  if (shell === 'pwsh') {
    const joined = `& ${/[\s'"\`$]/.test(cmd) ? `'${cmd.replace(/'/g, "''")}'` : cmd} ${versionArg}`;
    exe = 'pwsh.exe';
    args = ['-NoLogo', '-Command', joined];
  } else if (shell === 'cmd') {
    exe = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `${cmd} ${versionArg}`];
  } else if (path.isAbsolute(cmd)) {
    const ext = path.extname(cmd).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', cmd, versionArg];
    } else if (ext === '.ps1') {
      exe = 'powershell.exe';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd, versionArg];
    } else {
      exe = cmd;
      args = [versionArg];
    }
  } else {
    exe = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', cmd, versionArg];
  }

  const t0 = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let timedOut = false;
  let spawnError = null;
  try {
    const child = spawn(exe, args, { env: spawnEnv(), windowsHide: true });
    const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, 5000);
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 8192) stdout = stdout.slice(0, 8192); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(0, 8192); });
    exitCode = await new Promise((resolve, reject) => {
      child.on('exit', (code) => { clearTimeout(killer); resolve(code); });
      child.on('error', (err) => { clearTimeout(killer); reject(err); });
    });
  } catch (e) {
    spawnError = String(e && e.message || e);
  }
  const durationMs = Date.now() - t0;

  const out = (stdout + '\n' + stderr).toLowerCase();
  const PATTERNS = {
    claude:  /claude/,
    codex:   /codex|openai/,
    copilot: /copilot/,
  };
  const matchedType = type === 'other' ? null : (PATTERNS[type] ? PATTERNS[type].test(out) : null);
  const ok = !spawnError && !timedOut && exitCode === 0;
  res.json({
    ok, exitCode, durationMs, timedOut, spawnError,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    matchedType,
    expectedType: type,
    spawned: { exe, args },
  });
}));

// ---- folders ----

app.get('/api/folders', asyncH(async (_req, res) => {
  const list = await folders.loadAll();
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json({ folders: list });
}));

app.post('/api/folders', asyncH(async (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json({ folder: await folders.create({ name }) });
}));

app.put('/api/folders/:id', asyncH(async (req, res) => {
  const updated = await folders.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ folder: updated });
}));

app.delete('/api/folders/:id', asyncH(async (req, res) => {
  // Move all sessions in this folder to Unsorted before delete.
  const all = await persistedSessions.loadAll();
  for (const s of all) {
    if (s.folderId === req.params.id) {
      await persistedSessions.setFolder(s.id, null);
    }
  }
  const removed = await folders.remove(req.params.id);
  res.json({ removed });
}));

app.post('/api/folders/reorder', asyncH(async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const next = await folders.reorder(ids);
  res.json({ folders: next });
}));

// ---- sessions (persisted, ccsm-owned) ----

app.get('/api/sessions', asyncH(async (_req, res) => {
  const list = await persistedSessions.loadAll();
  // Cross-check status against live PTY pool so a stale "running" record
  // doesn't survive a server restart.
  const live = new Set(webTerminal.list().filter((t) => !t.exitedAt).map((t) => t.id));
  for (const s of list) {
    if (s.status === 'running' && !live.has(s.id)) {
      s.status = 'exited';
    }
  }
  // Per-session activity probe (transcript mtime → working/idle). Cheap
  // when cached — most calls are a single fs.stat(). Only runs for
  // running sessions; exited ones get 'unknown'.
  const cfg = await loadConfig();
  const cliById = new Map((cfg.clis || []).map((c) => [c.id, c]));
  const { probeActivity } = require('./lib/cliActivity');
  await Promise.all(list.map(async (s) => {
    if (s.status !== 'running') { s.activity = 'unknown'; return; }
    try { s.activity = await probeActivity(s, cliById.get(s.cliId)); }
    catch { s.activity = 'unknown'; }
  }));
  res.json({ sessions: list, takenAt: Date.now() });
}));

app.put('/api/sessions/:id', asyncH(async (req, res) => {
  const patch = {};
  if (typeof req.body.title === 'string') patch.title = req.body.title;
  if ('folderId' in (req.body || {})) patch.folderId = req.body.folderId || null;
  const updated = await persistedSessions.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ session: updated });
}));

// Switch the CLI config used to resume an existing session. This is
// intentionally narrower than the generic PUT route: a session can only
// move between configured CLIs of the same type (e.g. one claude wrapper
// to another) so its captured upstream cliSessionId stays meaningful.
app.post('/api/sessions/:id/switch-cli', asyncH(async (req, res) => {
  const targetCliId = typeof req.body?.cliId === 'string' ? req.body.cliId.trim() : '';
  if (!targetCliId) return res.status(400).json({ error: 'cliId required' });

  const record = await persistedSessions.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'session not found' });

  const cfg = await loadConfig();
  const currentCli = findCliById(cfg, record.cliId);
  const targetCli = findCliById(cfg, targetCliId);
  if (!currentCli) return res.status(400).json({ error: `current CLI ${record.cliId} no longer configured` });
  if (!targetCli) return res.status(400).json({ error: `target CLI ${targetCliId} not configured` });
  if (currentCli.type !== targetCli.type) {
    return res.status(400).json({
      error: `cannot switch ${currentCli.type} session to ${targetCli.type} CLI`,
    });
  }

  if (record.cliId === targetCli.id) {
    const live = webTerminal.get(record.id);
    return res.json({ session: record, changed: false, running: !!(live && !live.exitedAt) });
  }

  const updated = await persistedSessions.update(record.id, { cliId: targetCli.id });
  const live = webTerminal.get(record.id);
  res.json({
    session: updated,
    changed: true,
    running: !!(live && !live.exitedAt),
    fromCliId: currentCli.id,
    toCliId: targetCli.id,
    cliType: targetCli.type,
  });
}));

// Stop the live PTY for a session without deleting its persisted record.
// Unlike a natural CLI exit, this is a user intent signal: the frontend
// should not auto-resume it again until the user explicitly presses Resume.
app.post('/api/sessions/:id/stop', asyncH(async (req, res) => {
  const record = await persistedSessions.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'session not found' });
  const stopped = webTerminal.kill(record.id);
  const updated = await persistedSessions.update(record.id, {
    status: 'exited',
    pid: null,
    exitCode: null,
    exitedAt: Date.now(),
    manualStopped: true,
    lastActiveAt: Date.now(),
  });
  try { require('./lib/cliActivity').releaseSession(record.id); } catch {}
  res.json({ stopped, session: updated });
}));

app.delete('/api/sessions/:id', asyncH(async (req, res) => {
  // Kill PTY first if it's still alive, then drop the record.
  try { webTerminal.kill(req.params.id); } catch {}
  const removed = await persistedSessions.remove(req.params.id);
  try { require('./lib/cliActivity').releaseSession(req.params.id); } catch {}
  res.json({ removed });
}));

// Open a session's working directory in the user's configured editor
// (config.editor, default `code` = VS Code, whose Source Control panel is
// also the review-changes view once the folder's open). Spawned detached
// so it outlives ccsm; shell:true so Windows resolves `code.cmd` via
// PATHEXT and a command like `code --reuse-window` parses, with the cwd
// quoted so paths with spaces survive the shell. spawnEnv() merges the
// user-scope PATH so `code`/`cursor` are found even when the inherited
// env lacks them.
app.post('/api/sessions/:id/open-editor', asyncH(async (req, res) => {
  const record = await persistedSessions.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'session not found' });
  const cfg = await loadConfig();
  const editor = (cfg.editor || '').trim() || 'code';
  const { spawn } = require('node:child_process');
  try {
    const child = spawn(editor, [`"${record.cwd}"`], {
      detached: true, stdio: 'ignore', shell: true,
      env: spawnEnv(), windowsHide: true,
    });
    // A bad editor command fails the shell async (after we've responded);
    // log it so it's diagnosable, but the happy path needs no await.
    child.on('error', (e) => console.warn(`[ccsm] open-editor "${editor}" failed:`, e.message));
    child.unref();
    res.json({ ok: true, editor, cwd: record.cwd });
  } catch (e) {
    res.status(500).json({ error: `failed to launch ${editor}: ${e.message}` });
  }
}));

// Reorder sessions within a folder. Body: { folderId, ids } where ids
// is the new sequence of session ids in their final display order
// inside that folder. Each session gets `folderId` + `order: 0..N-1`
// assigned. Setting folderId here (rather than requiring a separate
// PUT) lets the drag-and-drop UI move a session across folders AND
// drop it at a specific position in one shot — without the call, the
// move would either land at the end of the destination folder (just
// PUT folderId) or leave it in place (just reorder).
app.post('/api/sessions/reorder', asyncH(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids array required' });
  const folderId = req.body?.folderId ?? null;
  for (let i = 0; i < ids.length; i++) {
    try { await persistedSessions.update(ids[i], { folderId, order: i }); } catch {}
  }
  res.json({ ok: true, count: ids.length });
}));

// ---- workspaces ----

// ---- directory browser ----
// Lets the launch picker walk the filesystem so users can pick any
// existing directory as the session cwd. Returns the immediate child
// dirs of `path` (defaults to home), plus a few hardcoded "starts"
// (home, workDir, drive roots on Windows).
app.get('/api/browse', asyncH(async (req, res) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const target = req.query.path ? path.resolve(String(req.query.path)) : os.homedir();
  let entries = [];
  let exists = true;
  try {
    const list = await fs.readdir(target, { withFileTypes: true });
    entries = list
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    exists = false;
  }
  const parent = path.dirname(target);
  const cfg = await loadConfig();
  const starts = [
    { label: 'Home', path: os.homedir() },
    { label: 'Work dir', path: cfg.workDir },
  ];
  if (process.platform === 'win32') {
    // Best-effort drive enumeration so users on D:\ etc can hop roots.
    for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
      const root = `${letter}:\\`;
      try { await fs.access(root); starts.push({ label: `${letter}:\\`, path: root }); }
      catch {}
    }
  }
  res.json({
    path: target,
    parent: parent === target ? null : parent,
    exists,
    entries,
    starts,
  });
}));

app.get('/api/workspaces', asyncH(async (req, res) => {
  const cfg = await loadConfig();
  const allSess = await persistedSessions.loadAll();
  const occupying = workspaceOccupancySessions(allSess, cfg);
  const busyPaths = occupying.map((s) => s.cwd);
  const workspaces = await listWorkspaces({
    workDir: cfg.workDir,
    repos: cfg.repos,
    busyPaths,
  });
  for (const w of workspaces) {
    w.sessionsHere = occupying.filter((s) => isInside(s.cwd, w.path)).map((s) => s.id);
    w.inUse = w.sessionsHere.length > 0;
  }
  res.json({ workDir: cfg.workDir, repos: cfg.repos, workspaces });
}));

// Delete a workspace directory. Refuses if a session currently reserves
// it, or if the resolved path escapes workDir. The name comes from the
// URL — we resolve it against workDir and verify containment.
app.delete('/api/workspaces/:name', asyncH(async (req, res) => {
  const fsp = require('node:fs/promises');
  const cfg = await loadConfig();
  const name = String(req.params.name || '');
  // Reject anything that tries to escape via separators / traversal.
  if (!name || /[\\/]|^\.\.$|^\.$/.test(name)) {
    return res.status(400).json({ error: 'invalid workspace name' });
  }
  const target = path.resolve(cfg.workDir, name);
  if (!isInside(target, cfg.workDir) || path.resolve(target) === path.resolve(cfg.workDir)) {
    return res.status(400).json({ error: 'workspace must live under workDir' });
  }
  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
  } catch {
    return res.status(404).json({ error: 'workspace not found' });
  }
  const allSess = await persistedSessions.loadAll();
  const occupying = workspaceOccupancySessions(allSess, cfg);
  const inUse = occupying.some((s) => isInside(s.cwd, target));
  if (inUse) {
    return res.status(409).json({ error: `workspace is in use by a ${workspaceOccupancyLabel(cfg)}` });
  }
  await fsp.rm(target, { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---- new session ----
// body: { cliId?, repos?, workspace?, folderId?, launch?: true }
// Streams NDJSON: workspace / clone-* / launched / done.
app.post('/api/sessions/new', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (obj) => { res.write(JSON.stringify(obj) + '\n'); };
  const fail = (msg, extra) => {
    emit({ type: 'done', success: false, error: msg, ...extra });
    res.end();
  };

  try {
    const cfg = await loadConfig();
    const cli = pickCli(cfg, req.body && req.body.cliId);
    if (!cli) return fail('No CLI configured. Add one in Configure → CLIs.');

    const explicitRepos = Array.isArray(req.body && req.body.repos);
    const wantedNames = explicitRepos
      ? req.body.repos
      : cfg.repos.filter((r) => r.defaultSelected).map((r) => r.name);
    const wantedRepos = cfg.repos.filter((r) => wantedNames.includes(r.name));
    if (wantedRepos.length === 0 && !explicitRepos && wantedNames.length > 0) {
      return fail('No matching repos found');
    }

    let workspace;
    let created = false;
    // Three cwd modes:
    //   1. body.cwd      — user picked an existing directory; skip clone.
    //   2. body.workspace — reuse a named workspace under workDir.
    //   3. (neither)     — auto-allocate a fresh ws-N.
    if (req.body && req.body.cwd) {
      const fsmod = require('node:fs/promises');
      const cwd = path.resolve(String(req.body.cwd));
      try {
        const st = await fsmod.stat(cwd);
        if (!st.isDirectory()) return fail(`${cwd} is not a directory`);
      } catch {
        return fail(`directory not found: ${cwd}`);
      }
      workspace = { name: path.basename(cwd) || cwd, path: cwd };
    } else if (req.body && req.body.workspace) {
      const allSess = await persistedSessions.loadAll();
      const busyPaths = workspaceOccupancySessions(allSess, cfg).map((s) => s.cwd);
      const all = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
      workspace = all.find((w) => w.name === req.body.workspace);
      if (!workspace) return fail(`workspace ${req.body.workspace} not found`);
      if (workspace.inUse) {
        return fail(`workspace ${req.body.workspace} is already used by a ${workspaceOccupancyLabel(cfg)}`);
      }
    } else {
      // Collect cwds of sessions that currently reserve workspaces so
      // findOrCreateWorkspace can flag them as in-use and skip past them.
      const allSess = await persistedSessions.loadAll();
      const busyPaths = workspaceOccupancySessions(allSess, cfg).map((s) => s.cwd);
      const r = await findOrCreateWorkspace({
        workDir: cfg.workDir,
        repos: cfg.repos,
        busyPaths,
        requireUnused: true,
      });
      workspace = r.workspace;
      created = r.created;
    }
    emit({ type: 'workspace', workspace, created });

    // Skip clone entirely when user picked an existing directory — we
    // don't want to dump random repos into someone's project.
    const cloneResults = (req.body && req.body.cwd) ? [] : await ensureReposInWorkspace({
      workspacePath: workspace.path,
      repos: wantedRepos,
      onRepoStart: (repo) =>
        emit({ type: 'clone-start', repo: repo.name, url: repo.url }),
      onProgress: (repo, p) =>
        emit({ type: 'clone-progress', repo: repo.name, ...p }),
      onLine: (repo, line) =>
        emit({ type: 'clone-line', repo: repo.name, line }),
      onRepoEnd: (repo, result) =>
        emit({ type: 'clone-end', repo: repo.name, ...result }),
    });
    const failed = cloneResults.filter((r) => !r.ok);
    if (failed.length > 0) return fail('Some repos failed to clone', { cloneResults });

    const shouldLaunch = req.body && req.body.launch !== false;
    let launched = null;
    if (shouldLaunch) {
      // Pre-assign the upstream CLI session UUID so we never have to
      // poll/scan the transcript dir to find out what id the CLI picked.
      //   - claude / copilot expose `--session-id <uuid>` natively.
      //   - codex has no flag, but accepts `resume <uuid>` against a
      //     pre-existing rollout file. We seed a fake file (see
      //     lib/codexSeed.js) so the first launch is a resume against
      //     our seed; codex then appends to the same file.
      const newIdTpl = Array.isArray(cli.newSessionIdArgs) ? cli.newSessionIdArgs : [];
      const preAssignedId = newIdTpl.length > 0 ? crypto.randomUUID() : null;
      const newSessionArgs = preAssignedId
        ? newIdTpl.map((a) => (typeof a === 'string' ? a.replace(/<id>/g, preAssignedId) : a))
        : [];

      if (preAssignedId && cli.type === 'codex') {
        try {
          const { seedCodexSession } = require('./lib/codexSeed');
          await seedCodexSession({ id: preAssignedId, cwd: workspace.path, cli });
        } catch (e) {
          return fail(`codex seed failed: ${e.message}`);
        }
      }

      // Create the persistedSessions record FIRST so spawnCliSession can
      // use its id as the PTY id (matching ids simplify resume/attach).
      const record = await persistedSessions.create({
        cliId: cli.id,
        cwd: workspace.path,
        workspace: workspace.name,
        repos: wantedRepos.map((r) => r.name),
        folderId: (req.body && req.body.folderId) || null,
        title: '',
        cliSessionId: preAssignedId || undefined,
      });
      try {
        const themeArgs = await codexThemeArgs(cli, req.body && req.body.theme);
        const entry = spawnCliSession({
          cli,
          cwd: workspace.path,
          sessionId: record.id,
          meta: { title: workspace.name, workspace: workspace.name, cwd: workspace.path },
          extraArgs: [...themeArgs, ...newSessionArgs],
          theme: req.body && req.body.theme,
          cols: req.body && req.body.cols,
          rows: req.body && req.body.rows,
        });
        await persistedSessions.markRunning(record.id, entry.meta.pid);
        launched = { id: record.id, pid: entry.meta.pid, cliId: cli.id };
        emit({ type: 'launched', launched });
      } catch (e) {
        await persistedSessions.markExited(record.id, null);
        return fail(`spawn failed: ${e.message}`);
      }
    }

    emit({ type: 'done', success: true, workspace, created, cloneResults, launched });
    res.end();
  } catch (e) {
    console.error('[/api/sessions/new]', e);
    fail(String(e && e.message || e));
  }
});

// ---- list local CLI sessions discovered on disk (for "adopt") ----
// Returns sessions found in ~/.claude / ~/.codex / ~/.copilot that
// aren't yet adopted by ccsm. Frontend uses this in the Import modal.
app.get('/api/cli-sessions/:cliType', asyncH(async (req, res) => {
  const type = String(req.params.cliType || '').toLowerCase();
  if (!['claude', 'codex', 'copilot'].includes(type)) {
    return res.status(400).json({ error: `unsupported cli type: ${type}` });
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 30));

  const [page, adopted] = await Promise.all([
    localCliSessions.listPaginated(type, { offset, limit }),
    persistedSessions.loadAll(),
  ]);

  const adoptedIds = new Set(adopted.map((s) => s.cliSessionId).filter(Boolean));
  const sessions = page.sessions.map((s) => ({
    ...s,
    adopted: adoptedIds.has(s.cliSessionId),
  }));
  res.json({
    sessions,
    totalActive: page.totalActive,
    totalNonActive: page.totalNonActive,
    total: page.totalActive + page.totalNonActive,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
  });
}));

// ---- adopt: create a ccsm record pointing at an existing CLI session ----
// Body: { cliId, cliSessionId, cwd, title?, folderId? }
// Doesn't spawn — the new entry shows up as "exited" in the sidebar;
// clicking it kicks off the regular resume flow which uses
// `cli.resumeIdArgs` ('--resume <id>') so the upstream session reattaches.
app.post('/api/sessions/adopt', asyncH(async (req, res) => {
  const { cliId, cliSessionId, cwd, title, folderId } = req.body || {};
  if (!cliId || !cliSessionId || !cwd) {
    return res.status(400).json({ error: 'cliId, cliSessionId and cwd required' });
  }
  const cfg = await loadConfig();
  const cli = pickCli(cfg, cliId);
  if (!cli) return res.status(400).json({ error: `CLI ${cliId} not configured` });

  // Normalize the cwd up front. /api/sessions/new also resolves cwd, and
  // the workspaces "in use" check (GET /api/workspaces) does
  // path.resolve(s.cwd).toLowerCase() — adopted records must match the
  // same shape, otherwise an adopted+running session leaves its
  // workspace falsely marked as free and a fresh launch could collide.
  const resolvedCwd = path.resolve(cwd);
  try {
    const fsmod = require('node:fs/promises');
    const st = await fsmod.stat(resolvedCwd);
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `cwd is not a directory: ${resolvedCwd}` });
    }
  } catch (e) {
    return res.status(400).json({ error: `cwd not found: ${resolvedCwd}` });
  }

  // Refuse duplicates: if any ccsm record already owns this upstream
  // session id, return it so the caller can jump to it.
  const all = await persistedSessions.loadAll();
  const dup = all.find((s) => s.cliSessionId === cliSessionId);
  if (dup) return res.json({ session: dup, alreadyAdopted: true });

  const workspace = path.basename(resolvedCwd) || resolvedCwd;
  // Create directly with status='exited' + cliSessionId set, so a
  // concurrent GET /api/sessions can never observe a "running but no
  // PTY" intermediate state.
  const record = await persistedSessions.create({
    cliId,
    cwd: resolvedCwd,
    workspace,
    folderId: folderId || null,
    title: title || '',
    repos: [],
    status: 'exited',
    cliSessionId,
  });
  res.json({ session: record, alreadyAdopted: false });
}));

// ---- resume a previous session in the same cwd / cli ----
app.post('/api/sessions/:id/resume', asyncH(async (req, res) => {
  const record = await persistedSessions.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'session not found' });
  // Already running and attached → no-op, just return its id.
  const live = webTerminal.get(record.id);
  if (live && !live.exitedAt) {
    // Pool says we're alive but the record may be stale (e.g. a prior
    // markRunning got clobbered by an OLD entry's onExit before the
    // respawn-guard landed, or boot mark-exited ran after a pool entry
    // was already wired). Reconcile the file to match the pool so the
    // frontend doesn't get stuck on "Resuming session…" forever.
    if (record.status !== 'running' || record.pid !== live.meta.pid) {
      try { await persistedSessions.markRunning(record.id, live.meta.pid); } catch {}
    }
    return res.json({ launched: { id: record.id, pid: live.meta.pid, cliId: record.cliId } });
  }
  const cfg = await loadConfig();
  const cli = pickCli(cfg, record.cliId);
  if (!cli) return res.status(400).json({ error: `CLI ${record.cliId} no longer configured` });
  try {
    // Resume always uses the captured upstream session UUID. With the
    // pre-assignment refactor every ccsm-launched session has one (via
    // newSessionIdArgs flag or the codex seed trick), and adopted
    // sessions inherit theirs from the disk scan.
    const themeArgs = await codexThemeArgs(cli, req.body && req.body.theme);
    const extraArgs = buildResumeArgs(cli, record);
    const entry = spawnCliSession({
      cli,
      cwd: record.cwd,
      sessionId: record.id,
      meta: { title: record.title || record.workspace, workspace: record.workspace, cwd: record.cwd },
      extraArgs: [...themeArgs, ...extraArgs],
      theme: req.body && req.body.theme,
      cols: req.body && req.body.cols,
      rows: req.body && req.body.rows,
    });
    await persistedSessions.markRunning(record.id, entry.meta.pid);
    res.json({ launched: { id: record.id, pid: entry.meta.pid, cliId: cli.id } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// codex-only: when the ccsm terminal is in LIGHT mode, inject a session-scoped
// `-c tui.theme=ccsm-light`. codex's diff theme detection (default_bg()) is
// compiled out on Windows and always falls back to a DARK diff palette, which
// reads poorly on a white terminal — and it ignores COLORFGBG/OSC. The only
// lever is a syntax theme whose markup.inserted/deleted scopes carry light
// backgrounds (they override the diff palette at true-color level). We ship
// that theme (ccsm-light.tmTheme), copy it into the codex home, and point
// tui.theme at it. Returns the args to prepend (before `resume <id>` so the
// global -c lands before the subcommand), or [] when not applicable. Skipped
// in dark mode (codex's dark default is already correct on a dark terminal)
// and when the user configured their own tui.theme in cli.args.
async function codexThemeArgs(cli, theme) {
  if (!cli || cli.type !== 'codex' || theme !== 'light') return [];
  const args = cli.args || [];
  const userSet = args.some((a, i) =>
    String(a).includes('tui.theme') || (a === '-c' && String(args[i + 1] || '').includes('tui.theme')));
  if (userSet) return [];
  try {
    const { probeCodexHome, ensureCodexLightTheme } = require('./lib/codexSeed');
    let home = null;
    try { home = await probeCodexHome({ command: cli.command, shell: cli.shell }); } catch {}
    home = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (!(await ensureCodexLightTheme(home))) return [];
    return ['-c', 'tui.theme="ccsm-light"'];
  } catch { return []; }
}

// Build the args appended on resume: substitute the captured upstream
// session UUID into cli.resumeIdArgs (e.g. ['--resume', '<id>'] →
// ['--resume', '7c28...']). Throws if either piece is missing — by
// design every ccsm session has a pre-assigned id, so missing one means
// something upstream is misconfigured (adopt without id, user-added CLI
// without resumeIdArgs, etc.) and we surface that instead of silently
// re-launching without the id.
function buildResumeArgs(cli, record) {
  const id = record.cliSessionId;
  const tpl = Array.isArray(cli.resumeIdArgs) ? cli.resumeIdArgs : [];
  if (!id) throw new Error(`session ${record.id} has no cliSessionId — cannot resume`);
  if (tpl.length === 0) throw new Error(`CLI ${cli.id} has no resumeIdArgs configured`);
  return tpl.map((a) => (typeof a === 'string' ? a.replace(/<id>/g, id) : a));
}

// ---- capabilities probe ----
app.get('/api/capabilities', (_req, res) => res.json({
  webTerminal: webTerminal.available,
  webTerminalError: webTerminal.available ? null : String(webTerminal.loadError?.message || 'unavailable'),
}));

// ---- health ----
const pkg = require('./package.json');
app.get('/api/health', (_req, res) => res.json({ ok: true, pid: process.pid, version: pkg.version, name: pkg.name }));

// ---- lifecycle ----
let currentPort = 0;
let frontendUrl = '';
let lastHeartbeat = Date.now();
let heartbeatSeen = false;
const HEARTBEAT_TIMEOUT_MS = 90_000;

app.post('/api/heartbeat', (_req, res) => {
  lastHeartbeat = Date.now();
  heartbeatSeen = true;
  res.json({ ok: true });
});

app.post('/api/spawn-browser', asyncH(async (_req, res) => {
  const opened = openInBrowser(frontendUrl || `http://localhost:${currentPort}`);
  res.json({ ok: true, mode: opened.kind, url: frontendUrl });
}));

app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true, bye: 'shutting down' });
  setImmediate(() => gracefulShutdown('/api/shutdown'));
});

// ---- remote / tunnel ----
//
// Lifecycle: the Remote page POSTs /start with { provider, token } —
// we save the token (used by the middleware above for auth) and spawn
// the chosen tunnel CLI. URL appears asynchronously in the CLI's
// stdout; lib/tunnel parses it. /status returns the latest snapshot
// for the page to poll.
app.get('/api/tunnel/status', asyncH(async (_req, res) => {
  res.json(await tunnel.status());
}));
app.post('/api/tunnel/start', asyncH(async (req, res) => {
  const { provider, token } = req.body || {};
  if (!token || String(token).length < 8) {
    return res.status(400).json({ error: 'token required (≥ 8 chars)' });
  }
  tunnel.setToken(token);
  try {
    const result = await tunnel.start({ provider, port: currentPort });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message, providers: await tunnel.probe().catch(() => ({})) });
  }
}));
app.post('/api/tunnel/stop', asyncH(async (_req, res) => {
  const stopped = tunnel.stop();
  res.json({ stopped, ...(await tunnel.status()) });
}));
app.post('/api/tunnel/token', asyncH(async (req, res) => {
  // Bare token update without touching the running tunnel.
  // POST { token: '' } to clear and disable remote auth.
  const t = (req.body && req.body.token) || '';
  tunnel.setToken(t);
  res.json(await tunnel.status());
}));
// Persist auto-start prefs. When ON, the backend brings this tunnel up
// during its own startup (the boot hook in the listen IIFE below) using
// the persisted token, so share URLs survive a backend restart. The
// token is written to config ONLY while auto-start is on; turning it off
// wipes the persisted token from disk. setToken keeps the in-memory copy
// in lockstep so the share URL the page renders stays valid immediately.
app.post('/api/tunnel/autostart', asyncH(async (req, res) => {
  const { autoStart, provider, token } = req.body || {};
  if (autoStart) {
    if (!token || String(token).length < 8) {
      return res.status(400).json({ error: 'token required (≥ 8 chars)' });
    }
    if (!['devtunnel', 'cloudflared'].includes(provider)) {
      return res.status(400).json({ error: 'valid provider required' });
    }
    tunnel.setToken(token);
    await saveConfig({ tunnel: { autoStart: true, provider, token } });
  } else {
    await saveConfig({ tunnel: { autoStart: false, provider: null, token: null } });
  }
  res.json(await tunnel.status());
}));
app.post('/api/tunnel/install', asyncH(async (req, res) => {
  const { provider } = req.body || {};
  try {
    const r = tunnel.installViaWinget(provider);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
// Interactive `devtunnel user login -d` driver. The Remote page POSTs
// here to start a device-code flow, then polls /api/tunnel/status to
// learn the URL+code it should display and the eventual outcome —
// avoids the older "copy this command into a shell" UX.
app.post('/api/tunnel/devtunnel/login', asyncH(async (req, res) => {
  const { mode } = req.body || {};
  try {
    const snap = await tunnel.startDevtunnelLogin({ mode });
    res.json({ ok: true, login: snap });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/tunnel/devtunnel/login/cancel', asyncH(async (_req, res) => {
  res.json({ ok: true, login: tunnel.cancelDevtunnelLogin() });
}));
app.post('/api/tunnel/devtunnel/login/dismiss', asyncH(async (_req, res) => {
  tunnel.clearDevtunnelLogin();
  res.json({ ok: true });
}));
// Wipe the persisted devtunnel tunnel id (and the remote tunnel
// resource itself, best-effort) so the next /api/tunnel/start mints
// a fresh one. Used by the Reset button in the Remote page when the
// user wants to rotate the public URL. Tunnel must be stopped first
// — refuse otherwise so we don't yank state out from under a live
// `devtunnel host` child.
app.post('/api/tunnel/devtunnel/reset', asyncH(async (_req, res) => {
  const s = await tunnel.status();
  if (s.running && s.provider === 'devtunnel') {
    return res.status(409).json({ error: 'stop the tunnel before resetting its id' });
  }
  const r = await tunnel.resetDevtunnelTunnelId();
  res.json({ ok: true, ...r, ...(await tunnel.status()) });
}));

// ---- devices ----
//
// /api/devices/me is callable from the remote browser BEFORE approval —
// it's how the PendingApprovalOverlay polls for the host's decision.
// Everything else is locked to loopback by the gate above.
app.get('/api/devices/me', asyncH(async (req, res) => {
  const id = String(req.headers['x-device-id'] || (req.query && req.query.device) || '');
  if (!id) return res.status(400).json({ error: 'device id required' });
  // Token check applies HERE — this is the only endpoint where new
  // device records are created (record() inserts pending on first
  // sight). Demanding the token at registration time stops random
  // tunnel-URL scanners from filling the host's pending queue with
  // garbage entries. Already-known devices can re-poll without the
  // token (the existing record is returned as-is).
  const existing = await devices.get(id);
  if (!existing) {
    const tok = tunnel.getToken();
    if (tok && !isDirectLoopback(req)) {
      const auth = req.headers.authorization || '';
      const qTok = req.query && req.query.token;
      if (auth !== `Bearer ${tok}` && qTok !== tok) {
        return res.status(401).json({ error: 'token required to register a new device' });
      }
    }
  }
  const ua = req.headers['user-agent'] || '';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const code = String(req.headers['x-device-code'] || (req.query && req.query.code) || '').slice(0, 8);
  const d = await devices.record(id, { userAgent: ua, ip, code });
  res.json(d);
}));
app.get('/api/devices', asyncH(async (_req, res) => {
  res.json({ devices: await devices.list() });
}));
app.post('/api/devices/:id/approve', asyncH(async (req, res) => {
  const d = await devices.approve(req.params.id, req.body && req.body.label);
  if (!d) return res.status(404).json({ error: 'device not found' });
  res.json(d);
}));
app.post('/api/devices/:id/reject', asyncH(async (req, res) => {
  const d = await devices.reject(req.params.id);
  if (!d) return res.status(404).json({ error: 'device not found' });
  res.json(d);
}));
app.post('/api/devices/:id/revoke', asyncH(async (req, res) => {
  const d = await devices.revoke(req.params.id);
  if (!d) return res.status(404).json({ error: 'device not found' });
  res.json(d);
}));
app.put('/api/devices/:id', asyncH(async (req, res) => {
  const d = await devices.rename(req.params.id, (req.body && req.body.label) || '');
  if (!d) return res.status(404).json({ error: 'device not found' });
  res.json(d);
}));
app.delete('/api/devices/:id', asyncH(async (req, res) => {
  const removed = await devices.remove(req.params.id);
  res.json({ removed });
}));

// Restart: in production, spawn the restart-helper detached then
// gracefulShutdown — the helper waits for the port to free and respawns
// `ccsm.cmd` (with CCSM_NO_BROWSER so we don't pop a new window — the
// frontend bounces through OfflineBanner / version router back into the
// new backend). In dev (CCSM_DEV=1, set by scripts/dev.js), we skip the
// helper entirely: just gracefulShutdown. scripts/dev.js sees its child
// exit and respawns `node --watch server.js` from the checkout, picking
// up any code changes.
let restartInFlight = false;
app.post('/api/restart', asyncH(async (_req, res) => {
  if (restartInFlight) {
    return res.status(409).json({ error: 'restart already in progress' });
  }
  restartInFlight = true;

  if (process.env.CCSM_DEV === '1') {
    res.json({ ok: true, started: true, mode: 'dev', closeFrontend: false });
    setImmediate(() => gracefulShutdown('restart (dev)'));
    return;
  }

  const fsp = require('node:fs/promises');
  const helperSrc = path.join(__dirname, 'scripts', 'restart-helper.js');
  const helperTmp = path.join(os.tmpdir(), `ccsm-restart-${process.pid}-${Date.now()}.js`);
  try {
    await fsp.copyFile(helperSrc, helperTmp);
  } catch (e) {
    restartInFlight = false;
    return res.status(500).json({ error: `helper copy failed: ${e.message}` });
  }
  const args = [helperTmp, String(currentPort), String(process.pid)];
  // closeFrontend asks the calling tab to window.close() itself — the
  // helper will respawn ccsm WITHOUT CCSM_NO_BROWSER, so a fresh window
  // pops up once the new backend is listening. Net effect: the user
  // never sees the OfflineBanner during a restart.
  res.json({ ok: true, started: true, helper: helperTmp, closeFrontend: true });

  setImmediate(() => {
    const { spawn } = require('node:child_process');
    try {
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.unref();
      console.log(`[restart] helper pid=${child.pid}, shutting down`);
    } catch (e) {
      console.error('[restart] helper spawn failed:', e.message);
      restartInFlight = false;
      return;
    }
    setTimeout(() => gracefulShutdown('restart'), 500);
  });
}));

// ---- version / upgrade ----
// `/api/version` reports the installed version (= pkg.version) and, if
// reachable, the latest published on the npm registry. The result is
// cached for 30 minutes in memory so the AboutPage poll doesn't hit the
// registry on every render.
//
// `/api/upgrade` kicks off `npm i -g @bakapiano/ccsm@latest` as a
// detached child. When the install completes, the child re-spawns `ccsm`
// (also detached) so the launcher comes back up on the new version, and
// the current server gracefulShutdowns. The frontend's OfflineBanner
// covers the gap; the version router picks up the new version on the
// next probe.
const VERSION_CACHE_MS = 30 * 60_000;
let versionCache = null; // { latest, fetchedAt }
let upgradeInFlight = false;

async function fetchLatestFromNpm() {
  // Node 18+ has a global fetch. Time out the registry call to avoid
  // hanging the response when the user is offline / behind a captive
  // portal.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://registry.npmjs.org/@bakapiano%2Fccsm/latest', {
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
    const j = await r.json();
    return String(j.version || '');
  } finally {
    clearTimeout(t);
  }
}

function cmpSemver(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

app.get('/api/version', asyncH(async (req, res) => {
  const force = String(req.query.refresh || '') === '1';
  const now = Date.now();
  // devMode: set when the server was launched from scripts/dev.js
  // (CCSM_DEV=1). Lets the About page render a "test upgrade flow"
  // button that re-installs to a sandbox prefix without affecting the
  // user's global ccsm install.
  const devMode = process.env.CCSM_DEV === '1';
  if (!force && versionCache && (now - versionCache.fetchedAt) < VERSION_CACHE_MS) {
    return res.json({
      current: pkg.version,
      latest: versionCache.latest,
      updateAvailable: cmpSemver(versionCache.latest, pkg.version) > 0,
      fetchedAt: versionCache.fetchedAt,
      cached: true,
      devMode,
    });
  }
  try {
    const latest = await fetchLatestFromNpm();
    versionCache = { latest, fetchedAt: now };
    res.json({
      current: pkg.version,
      latest,
      updateAvailable: cmpSemver(latest, pkg.version) > 0,
      fetchedAt: now,
      cached: false,
      devMode,
    });
  } catch (e) {
    res.json({
      current: pkg.version,
      latest: null,
      updateAvailable: false,
      fetchedAt: now,
      error: String(e.message || e),
      devMode,
    });
  }
}));

app.post('/api/upgrade', asyncH(async (req, res) => {
  if (upgradeInFlight) {
    return res.status(409).json({ error: 'upgrade already in progress' });
  }
  const body = req.body || {};
  const target = String(body.target || 'latest');
  // Refuse anything that doesn't look like a semver dist-tag or version
  // — defends against `;` etc. winding up in the spawn argv even though
  // we don't shell out.
  if (!/^[a-z0-9.+\-^~]+$/i.test(target)) {
    return res.status(400).json({ error: `invalid target: ${target}` });
  }
  // Optional sandbox install prefix (for testing without disturbing the
  // user's real global ccsm). Validated as a plain absolute path so it
  // can't be a flag injection.
  const installPrefix = body.installPrefix ? String(body.installPrefix) : '';
  if (installPrefix && (installPrefix.startsWith('-') || !path.isAbsolute(installPrefix))) {
    return res.status(400).json({ error: 'installPrefix must be an absolute path' });
  }
  const respawn = body.respawn === false ? '0' : '1';
  upgradeInFlight = true;
  console.log(`[upgrade] target=${target}${installPrefix ? ` prefix=${installPrefix}` : ''}${respawn === '0' ? ' (no respawn)' : ''}`);

  // The helper runs OUTSIDE the package dir so npm can rename it
  // without fighting open file handles. Copy the script to os.tmpdir()
  // and spawn from there.
  const fsp = require('node:fs/promises');
  const helperSrc = path.join(__dirname, 'scripts', 'upgrade-helper.js');
  const helperTmp = path.join(os.tmpdir(), `ccsm-upgrade-${process.pid}-${Date.now()}.js`);
  try {
    await fsp.copyFile(helperSrc, helperTmp);
  } catch (e) {
    upgradeInFlight = false;
    return res.status(500).json({ error: `helper copy failed: ${e.message}` });
  }
  // Where to send the user back when the upgrade succeeds. In prod
  // that's the GH Pages router (it'll re-probe localhost:7777 and
  // redirect to the matching per-version frontend); in dev (CCSM_DEV=1)
  // that's our local server on whatever port we're listening on, so
  // the test sandbox flow returns to the dev instance instead of
  // hitting GH Pages (which doesn't know about port 7788).
  const redirectTo = frontendUrl || `http://localhost:${currentPort}/`;

  const args = [helperTmp, target, String(currentPort), String(process.pid), installPrefix, respawn, redirectTo];

  res.json({
    ok: true,
    started: true,
    target,
    helper: helperTmp,
    helperUrl: 'http://localhost:7779/',
    closeFrontend: false,
  });

  // Flush response, then spawn helper detached and gracefulShutdown so
  // the helper's npm install isn't fighting our open file handles.
  setImmediate(() => {
    const { spawn } = require('node:child_process');
    try {
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.unref();
      console.log(`[upgrade] helper pid=${child.pid}, shutting down`);
    } catch (e) {
      console.error('[upgrade] helper spawn failed:', e.message);
      upgradeInFlight = false;
      return;
    }
    setTimeout(() => gracefulShutdown('upgrade'), 500);
  });
}));


function listenWithFallback(preferred) {
  return new Promise((resolve, reject) => {
    const attempt = (port, tries) => {
      const server = app.listen(port);
      server.once('listening', () => resolve({ server, port: server.address().port }));
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (tries < 9) attempt(port + 1, tries + 1);
        else if (tries === 9) attempt(0, tries + 1);
        else reject(err);
      });
    };
    attempt(preferred, 0);
  });
}

function findAppModeBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const fs = require('node:fs');
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Look for a Chrome/Edge PWA that the user already installed locally
// pointing at the ccsm frontend. When found, we launch it via
// `chrome.exe --profile-directory=... --app-id=<id>` — same as the
// shortcut Start Menu creates at install time. That path opens the
// PWA fully chromeless (respects manifest display:standalone + WCO).
// Without this we'd fall back to `--app=<URL> --user-data-dir=<ours>`
// which uses an isolated profile that doesn't see the install, so
// Chrome shows a minimal-ui address bar.
function findInstalledCcsmPwa() {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const fs = require('node:fs');
  const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const dirs = [
    path.join(startMenu, 'Chrome Apps'),
    path.join(startMenu, 'Edge Apps'),
  ];
  const candidates = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      // Filter by filename — Chrome names PWA shortcuts after the
      // manifest's short_name/name. CCSM matches our manifest.
      if (!/ccsm/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        candidates.push({ name, path: full, mtime: fs.statSync(full).mtimeMs });
      } catch {}
    }
  }
  if (candidates.length === 0) return null;
  // Newest install wins (covers the case where the user re-installed
  // and accumulated CCSM, CCSM (1), etc.).
  candidates.sort((a, b) => b.mtime - a.mtime);
  // Resolve via WScript.Shell COM. Single PowerShell call enumerates
  // every candidate; we stop at the first one whose target looks like
  // a Chrome/Edge binary and whose args carry an --app-id.
  const { spawnSync } = require('node:child_process');
  const psPaths = candidates
    .map((c) => `'${c.path.replace(/'/g, "''")}'`).join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$wsh = New-Object -ComObject WScript.Shell
foreach ($p in @(${psPaths})) {
  $sc = $wsh.CreateShortcut($p)
  Write-Output ($sc.TargetPath + '|' + $sc.Arguments)
}`;
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sep = line.indexOf('|');
    if (sep < 0) continue;
    const target = line.slice(0, sep).trim();
    const args = line.slice(sep + 1).trim();
    if (!/chrome(_proxy)?\.exe$|msedge(_proxy)?\.exe$/i.test(target)) continue;
    const appId = (args.match(/--app-id=(\S+)/) || [])[1];
    if (!appId) continue;
    const profile = (args.match(/--profile-directory=(\S+)/) || [])[1] || 'Default';
    return { browserPath: target, appId, profile };
  }
  return null;
}

// Auto-open the frontend in a browser when ccsm boots. Strategy:
//   1. If the user already installed the CCSM PWA, launch THAT (fully
//      chromeless via --app-id, uses user's main browser profile).
//   2. Otherwise try a generic --app= window in an isolated profile —
//      this shows a thin minimal-ui address bar but at least it's
//      a dedicated window.
//   3. Fall back to the OS default browser as a regular tab.
// On non-Windows we skip — the bundled launcher isn't ported yet.
function openInBrowser(url) {
  if (process.platform !== 'win32') return { kind: 'none', child: null };
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');

  const installed = findInstalledCcsmPwa();
  if (installed) {
    console.log(`[ccsm] launching installed PWA · app-id=${installed.appId} profile=${installed.profile}`);
    const child = spawn(
      installed.browserPath,
      [
        `--profile-directory=${installed.profile}`,
        `--app-id=${installed.appId}`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    return { kind: 'pwa', child };
  }

  const exe = findAppModeBrowser();
  if (exe) {
    const profileDir = path.join(DATA_DIR, 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    console.log(`[ccsm] no installed PWA found · falling back to --app= window`);
    const child = spawn(
      exe,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1500,1100',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    return { kind: 'app', child };
  }
  console.log('[ccsm] no Edge/Chrome found, opening default browser');
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { kind: 'tab', child: null };
}

(async () => {
  const cfg = await loadConfig();
  const preferredPort = process.env.CCSM_PORT ? Number(process.env.CCSM_PORT) : cfg.port;
  const { server, port } = await listenWithFallback(preferredPort);
  currentPort = port;

  // On boot, mark any persisted "running" sessions as exited — they
  // belong to a previous server process whose PTYs are gone.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') {
        await persistedSessions.markExited(s.id, null);
      }
    }
  } catch (e) {
    console.error('[ccsm] could not reconcile persisted sessions:', e.message);
  }

  // Prewarm `tasklist` cache used by the import modal's "live" markers —
  // it takes ~500ms on Windows and is the single biggest contributor to
  // a slow Import dialog cold-open. Fire in the background; the lib also
  // starts its own 15s refresh loop.
  try { localCliSessions.prewarmLivePids(['claude.exe']); } catch {}
  // Prewarm tunnel provider probe. First /api/tunnel/status round-trip
  // shells out to where.exe / --version / devtunnel user show — ~700ms
  // of synchronous work that the user otherwise waits on the moment
  // they open the Remote tab. Fire in the background here so the cache
  // is warm by the time anyone clicks.
  try { tunnel.probe(true).catch(() => {}); } catch {}

  // Auto-start the tunnel if the user enabled it on the Remote page.
  // This is the BACKEND PROCESS bringing its own tunnel up on startup —
  // not an OS-level autostart (no registry / scheduled task). Reuses the
  // persisted token so share URLs stay valid across restarts. Strictly
  // fire-and-forget: a failure here (devtunnel not signed in, provider
  // uninstalled, etc.) must never crash boot — it just logs and the user
  // can start manually from the Remote page.
  if (cfg.tunnel?.autoStart && cfg.tunnel?.token && cfg.tunnel?.provider) {
    tunnel.setToken(cfg.tunnel.token);
    tunnel.start({ provider: cfg.tunnel.provider, port: currentPort })
      .then((s) => console.log(`[ccsm] tunnel auto-started · ${cfg.tunnel.provider} · ${s.url || 'URL pending'}`))
      .catch((e) => console.warn(`[ccsm] tunnel auto-start failed · ${e.message}`));
  }

  if (webTerminal.available) {
    let WebSocketServer;
    try { ({ WebSocketServer } = require('ws')); } catch {}
    if (WebSocketServer) {
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', async (req, socket, head) => {
        const direct = isDirectLoopback(req);
        // Non-loopback WS: device id alone gates entry. The host
        // explicitly Approved this device id earlier — that approval
        // IS the credential. No token check here (matches the device
        // gate above: token is only for /api/devices/me registration).
        if (!direct) {
          try {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const devId = u.searchParams.get('device');
            if (!devId) { socket.destroy(); return; }
            const d = await devices.get(devId);
            if (!d || d.status !== 'approved') { socket.destroy(); return; }
          } catch { socket.destroy(); return; }
        } else {
          const origin = req.headers.origin;
          if (origin && !ALLOWED_ORIGINS.has(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
            socket.destroy();
            return;
          }
        }
        const m = req.url && req.url.match(/^\/ws\/terminal\/([^\/?#]+)/);
        if (!m) { socket.destroy(); return; }
        const id = decodeURIComponent(m[1]);
        wss.handleUpgrade(req, socket, head, (ws) => webTerminal.attach(id, ws));
      });
      console.log('[ccsm] web terminal bridge active (WebSocket /ws/terminal/:id)');
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => gracefulShutdown(sig));
  }
  process.on('exit', () => { try { webTerminal.killAll(); } catch {} });

  const apiUrl = `http://localhost:${port}`;
  const FRONTEND_URL = IS_DEV
    ? apiUrl
    : 'https://bakapiano.github.io/ccsm/';
  frontendUrl = FRONTEND_URL;
  console.log(`ccsm listening on ${apiUrl}${port !== preferredPort ? `  (requested ${preferredPort}, was taken)` : ''}`);
  console.log(`frontend at      ${FRONTEND_URL}`);
  console.log(`data dir:        ${DATA_DIR}`);
  console.log(`work dir:        ${cfg.workDir}`);
  console.log(`clis:            ${cfg.clis.map((c) => c.id).join(', ')} (default: ${cfg.defaultCliId})`);

  // CCSM_NO_BROWSER=1 (set by the ccsm:// protocol launcher) suppresses
  // the auto-open entirely. CCSM_FROM_UPGRADE=1 (set by upgrade-helper
  // when it respawns ccsm post-install) does the same: the user is
  // already in the helper UI which redirects to this fresh backend, so
  // a second app-mode window would just shadow the first. Otherwise try
  // app-mode (chromeless Edge/Chrome window); if no such browser is
  // installed, openInBrowser falls back to the OS default browser on
  // its own.
  const suppressBrowser = process.env.CCSM_NO_BROWSER === '1'
                       || process.env.CCSM_FROM_UPGRADE === '1';
  const opened = suppressBrowser
    ? { kind: 'none', child: null }
    : openInBrowser(FRONTEND_URL);

  if (opened.kind === 'app' && opened.child && process.env.CCSM_KEEP_ALIVE !== '1') {
    const launchedAt = Date.now();
    opened.child.on('exit', () => {
      const alive = Date.now() - launchedAt;
      if (alive < 5000) {
        console.log(`[ccsm] spawned browser child exited in ${alive}ms · handed off to an existing Edge instance, staying alive`);
        return;
      }
      const closedAt = Date.now();
      setTimeout(() => {
        if (lastHeartbeat > closedAt + 100) {
          console.log('[ccsm] browser closed but another client is heartbeating · staying alive');
          return;
        }
        gracefulShutdown('browser window closed');
      }, 12_000);
    });
    console.log('[ccsm] tied to browser window — close it to stop ccsm');
  }

  if (process.env.CCSM_LAUNCHER === '1' && process.env.CCSM_KEEP_ALIVE !== '1') {
    setInterval(() => {
      if (!heartbeatSeen) return;
      if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        gracefulShutdown(`no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
      }
    }, 30_000);
    console.log('[ccsm] heartbeat watchdog active');
  }
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
