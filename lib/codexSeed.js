'use strict';

// Seed a fake codex rollout file so `codex resume <uuid>` works from the
// VERY FIRST launch — the same trick claude/copilot's `--session-id` flag
// gives us natively. codex has no equivalent flag; its only "set the id"
// surface is `resume <SESSION_ID>` against a file that already exists on
// disk. We pre-write that file with one `session_meta` line carrying the
// id + cwd ccsm pre-assigned, then spawn `codex resume <id>`. Codex picks
// up our seed and appends its actual conversation events to it.
//
// Path layout (matches codex's own scheme):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl
//
// Filename timestamp uses dashes-only (codex's convention), but it's
// purely cosmetic — codex looks up sessions by UUID, not filename.
//
// CODEX_HOME resolution. Some wrappers relocate CODEX_HOME to a
// non-default dir (e.g. %LOCALAPPDATA%\<wrapper>\codex-home) so the seed has
// to land there or `resume <id>` won't find it. We probe by running
// `<cli.command> doctor` once per (command, shell) pair and parsing the
// "CODEX_HOME ... (dir)" line out of its output. Cached for the life of
// the process.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { spawnEnv } = require('./winPath');

function isoForFilename(d = new Date()) {
  // 2026-05-25T15:39:11 → 2026-05-25T15-39-11 (codex strips ms + colons)
  return d.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

// command+shell → CODEX_HOME (or null if probe failed / not detected).
// Module-scope so we probe at most once per (command, shell) per server.
const codexHomeCache = new Map();
function cacheKey(command, shell) { return `${shell || 'direct'}|${command}`; }

function execWithTimeout(exe, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      // Use the registry-merged user PATH so wrapper commands resolve
      // even when the long-running server inherited a stale PATH at boot.
      env: spawnEnv(),
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Pull CODEX_HOME out of a wrapper's `doctor` (or `--version`) output. Two
// shapes appear, and we must handle BOTH:
//   1. Diagnostic table:  `CODEX_HOME    <path> (dir)`  — only when `doctor`
//      fully succeeds. Variable whitespace; the `(dir)`/`(file)` suffix marks
//      the path end.
//   2. Wrapper banner:    `CODEX_HOME=<path>`  — printed on EVERY invocation.
//      Critical because in ccsm's non-interactive spawn `doctor` often exits
//      non-zero (skipping the table) yet still prints this banner line, so it's
//      the reliable source. Without it the probe returns null and the seed
//      lands in ~/.codex instead of the wrapper's relocated home, breaking
//      `resume <id>` ("No saved session found with ID …").
// Some wrappers colour the label (`\x1b[7mCODEX_HOME\x1b[0m`); strip ANSI first.
function parseCodexHomeFromDoctor(text) {
  if (!text) return null;
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  let m = clean.match(/\bCODEX_HOME\s+(.+?)\s*\((?:dir|file)\)/);   // table form
  if (!m) m = clean.match(/\bCODEX_HOME=(.+?)\s*$/m);               // banner form
  if (!m) return null;
  const p = m[1].trim();
  return p || null;
}

// Build the [exe, args] needed to run `<cli.command> doctor` honouring
// the same shell-wrapping rules webTerminal uses. Mirrors the relevant
// bits of server.js' resolveCommand — kept local so this module doesn't
// drag a dependency on server.js.
function buildDoctorInvocation(command, shell) {
  const cmd = String(command || '').replace(/^\.[\\/]/, '');
  if (!cmd) return null;
  if (shell === 'pwsh') {
    return {
      exe: 'pwsh.exe',
      args: ['-NoLogo', '-NonInteractive', '-Command', `& { ${cmd} doctor }`],
    };
  }
  if (shell === 'cmd') {
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `${cmd} doctor`],
    };
  }
  // direct
  if (path.isAbsolute(cmd)) {
    const ext = path.extname(cmd).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}" doctor`] };
    }
    if (ext === '.ps1') {
      return { exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd, 'doctor'] };
    }
    return { exe: cmd, args: ['doctor'] };
  }
  // bare name on direct → defer to cmd.exe so Windows resolves via PATH
  return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `${cmd} doctor`] };
}

async function probeCodexHome({ command, shell }) {
  const key = cacheKey(command, shell);
  if (codexHomeCache.has(key)) return codexHomeCache.get(key);
  const inv = buildDoctorInvocation(command, shell);
  if (!inv) { codexHomeCache.set(key, null); return null; }
  const { stdout, stderr } = await execWithTimeout(inv.exe, inv.args);
  // Some wrappers print their banner to stderr; doctor itself prints
  // the CODEX_HOME line to stdout. Search both to be safe.
  const home = parseCodexHomeFromDoctor(stdout) || parseCodexHomeFromDoctor(stderr);
  codexHomeCache.set(key, home);
  return home;
}

async function seedCodexSession({ id, cwd, cli }) {
  if (!id || !cwd) throw new Error('seedCodexSession: id and cwd required');
  // Resolution order:
  //   1. `<cli.command> doctor` probe (handles wrappers that
  //      relocate CODEX_HOME)
  //   2. process.env.CODEX_HOME (global override)
  //   3. ~/.codex (codex's own default)
  let home = null;
  if (cli?.command) {
    try { home = await probeCodexHome({ command: cli.command, shell: cli.shell }); }
    catch (_) { /* probe is best-effort */ }
  }
  if (!home) home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const dir = path.join(home, 'sessions', yyyy, mm, dd);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${isoForFilename(now)}-${id}.jsonl`);
  const meta = {
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: {
      id,
      timestamp: now.toISOString(),
      cwd,
      originator: 'ccsm',
      cli_version: '0.0.0',
      source: 'ccsm-seed',
    },
  };
  await fs.writeFile(file, JSON.stringify(meta) + '\n', 'utf8');
  return file;
}

// Copy ccsm's bundled light codex syntax theme into the codex home's themes/
// dir so `-c tui.theme=ccsm-light` resolves. This theme carries light
// markup.inserted/deleted backgrounds, which at true-color level override
// codex's diff palette — the only way to get a LIGHT diff on Windows, where
// codex's own background detection (default_bg()) is compiled out and always
// falls back to a dark diff. Idempotent (writes only when missing/changed).
async function ensureCodexLightTheme(home) {
  if (!home) return false;
  const src = path.join(__dirname, 'codexThemes', 'ccsm-light.tmTheme');
  const dstDir = path.join(home, 'themes');
  const dst = path.join(dstDir, 'ccsm-light.tmTheme');
  try {
    const content = await fs.readFile(src, 'utf8');
    await fs.mkdir(dstDir, { recursive: true });
    let existing = null;
    try { existing = await fs.readFile(dst, 'utf8'); } catch {}
    if (existing !== content) await fs.writeFile(dst, content, 'utf8');
    return true;
  } catch { return false; }
}

module.exports = { seedCodexSession, probeCodexHome, parseCodexHomeFromDoctor, ensureCodexLightTheme };

