'use strict';

// Windows user-PATH merge. A long-running ccsm server inherits whatever PATH
// it was launched with, which can be stale — e.g. a CLI (or a wrapper for one)
// installed or put on PATH AFTER the server started. We read the
// persisted user PATH from the registry and merge it in, then hand the
// deduped env to every child we spawn. server.js uses this for session
// launches; codexSeed uses it for the `<cli> doctor` home probe so the wrapper
// resolves regardless of the parent process's PATH.
//
// (server.js keeps its own equivalent inline for the hot spawn path; this
// module is the shared copy used by lib/ code that can't depend on server.js.)

const { spawnSync } = require('node:child_process');

let _merged = null; // cached for the process lifetime

function buildMergedUserPath() {
  if (process.platform !== 'win32') return process.env.PATH;
  try {
    const r = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'PATH'],
      { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return process.env.PATH;
    const line = r.stdout.split(/\r?\n/).find((l) => /\bPATH\b/i.test(l) && /REG_(EXPAND_)?SZ/i.test(l));
    if (!line) return process.env.PATH;
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (!m) return process.env.PATH;
    // REG_EXPAND_SZ keeps %VAR% literal — expand against the current env.
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

function mergedUserPath() {
  if (_merged === null) _merged = buildMergedUserPath();
  return _merged;
}

// Fresh env for a child spawn: process.env + extras, every case variant of
// PATH stripped and replaced by the merged user PATH. Windows resolves the
// FIRST path-case key in the env block, so a stale inherited `Path` would
// otherwise shadow our `PATH`.
function spawnEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (process.platform === 'win32') {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path') delete env[k];
    }
  }
  const mp = mergedUserPath();
  if (mp) env.PATH = mp;
  return env;
}

module.exports = { mergedUserPath, spawnEnv, buildMergedUserPath };
