'use strict';

// Discover existing CLI sessions on this machine so ccsm can "load" (adopt)
// them — i.e. create a persistedSessions record that resumes the exact same
// upstream conversation later (via cli.resumeIdArgs + the captured
// cliSessionId).
//
// Per CLI:
//   claude  · ~/.claude/projects/<slug>/<uuid>.jsonl   (uuid = id)
//   codex   · <CODEX_HOME>/sessions/**/rollout-*-<uuid>.jsonl  (uuid = id)
//   copilot · ~/.copilot/session-state/<uuid>/          (uuid = dir name;
//              cwd + summary in workspace.yaml)
//
// Each session is reported as:
//   { cliType, cliSessionId, cwd, mtime, summary }
//
// `summary` heuristic: the first user message text (claude/codex) or the
// YAML `summary:` line (copilot), truncated to 120 chars.
//
// Performance: each jsonl's HEAD is read directly via fd.read (readline
// init dominates when scanning hundreds of small files); files parse in
// parallel with a small concurrency cap; an in-process cache keyed by
// (filepath, mtime) makes repeat scans of unchanged files O(1).

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SUMMARY_MAX = 120;
const HEAD_BYTES = 16 * 1024;       // enough to catch cwd + first user msg
const CONCURRENCY = 16;             // parallel parses per scan
const PARSE_CACHE_MAX = 5000;
const parseCache = new Map();       // `${path}|${mtimeMs}` → { cwd, summary }

function cacheGet(filepath, mtimeMs) {
  return parseCache.get(`${filepath}|${mtimeMs}`);
}
function cachePut(filepath, mtimeMs, value) {
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const firstKey = parseCache.keys().next().value;
    parseCache.delete(firstKey);
  }
  parseCache.set(`${filepath}|${mtimeMs}`, value);
}

// Run `tasks` with a max concurrency cap. Each task is a `() => Promise`.
async function pmap(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Discover phase · cheap, just stat the files ─────────────────────
// Returns [{ id, filepath, mtimeMs }] for all jsonls under ~/.claude/projects,
// sorted by mtime desc. No content read, no parsing.
async function discoverClaude() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let slugs;
  try { slugs = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const statTasks = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(root, slug.name);
    statTasks.push(async () => {
      let files;
      try { files = await fsp.readdir(slugDir, { withFileTypes: true }); }
      catch { return []; }
      const inDir = [];
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filepath = path.join(slugDir, f.name);
        let st; try { st = await fsp.stat(filepath); } catch { continue; }
        inDir.push({
          id: f.name.replace(/\.jsonl$/, ''),
          filepath,
          mtimeMs: st.mtimeMs,
        });
      }
      return inDir;
    });
  }
  const grouped = await pmap(statTasks, CONCURRENCY);
  return grouped.flat().filter(Boolean);
}

// Codex sessions can live under a RELOCATED CODEX_HOME. Wrappers like gc2cc
// point it at e.g. %LOCALAPPDATA%\gc2cc\codex-home, so `~/.codex` is empty of
// the sessions the user actually created. Gather every candidate
// `<home>/sessions` dir:
//   1. each configured codex CLI's detected home (probe `<cli> doctor`)
//   2. each configured codex CLI's command-adjacent `../codex-home` (covers
//      gc2cc-style bin/<cmd> + ../codex-home layouts even when the probe
//      fails to print a CODEX_HOME banner)
//   3. the CODEX_HOME env override
//   4. codex's own ~/.codex default
//   5. any `*/codex-home` directly under %LOCALAPPDATA% / %APPDATA%
async function codexSessionRoots() {
  const roots = new Set();
  const addHome = (home) => { if (home) roots.add(path.join(home, 'sessions')); };

  try {
    const { loadConfig } = require('./config');
    const { probeCodexHome } = require('./codexSeed');
    const cfg = await loadConfig();
    const codexClis = (cfg?.clis || []).filter((c) => c.type === 'codex' || c.id === 'codex');
    for (const c of codexClis) {
      if (!c.command) continue;
      try {
        const home = await probeCodexHome({ command: c.command, shell: c.shell });
        addHome(home);
      } catch { /* probe is best-effort */ }
      // command-adjacent ../codex-home (gc2cc: <root>/bin/cxp.cmd → <root>/codex-home)
      if (path.isAbsolute(c.command)) {
        addHome(path.resolve(path.dirname(c.command), '..', 'codex-home'));
      }
    }
  } catch { /* config/probe unavailable — fall through to defaults */ }

  if (process.env.CODEX_HOME) addHome(process.env.CODEX_HOME);
  addHome(path.join(os.homedir(), '.codex'));

  // Scan %LOCALAPPDATA% / %APPDATA% for any wrapper's <name>/codex-home.
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)) {
    let entries;
    try { entries = await fsp.readdir(base, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) addHome(path.join(base, e.name, 'codex-home'));
    }
  }

  return [...roots];
}

async function discoverCodex() {
  const roots = await codexSessionRoots();
  const candidates = [];
  const seen = new Set();   // dedup by session id across homes
  const idRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  for (const root of roots) {
    await walkFiles(root, async (filepath, st) => {
      if (!filepath.endsWith('.jsonl')) return;
      const m = path.basename(filepath).match(idRe);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      candidates.push({ id: m[1], filepath, mtimeMs: st.mtimeMs });
    });
  }
  return candidates;
}

// copilot's "discover" is also the parse (cwd + summary live in a small
// workspace.yaml, no jsonl head to stat cheaply). Returns fully-hydrated
// records tagged `_hydrated` so the pagination layer skips re-parsing them.
async function listCopilot() {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const id = d.name;
    if (!/^[0-9a-f-]+$/i.test(id)) continue;
    const dirpath = path.join(root, id);
    let st; try { st = await fsp.stat(dirpath); } catch { continue; }
    const yaml = path.join(dirpath, 'workspace.yaml');
    let txt;
    try { txt = await fsp.readFile(yaml, 'utf8'); }
    catch { continue; }
    const cwd = (txt.match(/^\s*cwd\s*:\s*(.+?)\s*$/m) || [])[1] || null;
    const summary = (txt.match(/^\s*summary\s*:\s*(.+?)\s*$/m) || [])[1] || '';
    const updated = (txt.match(/^\s*updated_at\s*:\s*(.+?)\s*$/m) || [])[1];
    if (!cwd) continue;
    out.push({
      cliType: 'copilot',
      cliSessionId: id,
      cwd: cwd.trim(),
      mtimeMs: updated ? Date.parse(updated) || st.mtimeMs : st.mtimeMs,
      summary: truncate(summary, SUMMARY_MAX),
      _hydrated: true,
    });
  }
  return out;
}

// ── Unified pagination · merge all requested types, newest-first ────
// type: 'all' | 'claude' | 'codex' | 'copilot'. Cheap discover (stat only for
// claude/codex; full parse for copilot), sort by mtime, then hydrate ONLY the
// requested page's slice. Returns { sessions, total, offset, limit, hasMore }.
async function gatherCandidates(type) {
  const tasks = [];
  if (type === 'all' || type === 'claude') {
    tasks.push(discoverClaude().then((a) => a.map((c) => ({ ...c, cliType: 'claude' }))));
  }
  if (type === 'all' || type === 'codex') {
    tasks.push(discoverCodex().then((a) => a.map((c) => ({ ...c, cliType: 'codex' }))));
  }
  if (type === 'all' || type === 'copilot') {
    tasks.push(listCopilot());
  }
  const groups = await Promise.all(tasks);
  const all = groups.flat().filter(Boolean);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

async function hydrateSlice(slice) {
  const tasks = slice.map((c) => async () => {
    if (c._hydrated) {
      return {
        cliType: c.cliType, cliSessionId: c.cliSessionId,
        cwd: c.cwd, mtime: c.mtimeMs, summary: c.summary || '',
      };
    }
    // codex buries the first real user message AFTER a ~55KB
    // `<permissions instructions>` preamble, so a fixed head read can miss
    // it. Stream chunk-by-chunk until we've found both cwd + summary.
    const { cwd, summary } = c.cliType === 'codex'
      ? await parseCodexHead(c.filepath, c.mtimeMs)
      : await parseJsonlHead(c.filepath, c.mtimeMs, HEAD_BYTES);
    if (!cwd) return null;
    return {
      cliType: c.cliType, cliSessionId: c.id,
      cwd, mtime: c.mtimeMs, summary,
    };
  });
  const parsed = await pmap(tasks, CONCURRENCY);
  return parsed.filter(Boolean);
}

async function listPaginated({ type = 'all', offset = 0, limit = 30 } = {}) {
  const t = ['all', 'claude', 'codex', 'copilot'].includes(type) ? type : 'all';
  const candidates = await gatherCandidates(t);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(200, Math.max(1, Number(limit) || 30));
  const slice = candidates.slice(off, off + lim);
  const sessions = await hydrateSlice(slice);
  return {
    sessions,
    total: candidates.length,
    offset: off,
    limit: lim,
    hasMore: off + lim < candidates.length,
  };
}

module.exports = {
  listPaginated,
  discoverClaude,
  discoverCodex,
  listCopilot,
  codexSessionRoots,
};

// ── helpers ─────────────────────────────────────────────────────────

async function walkFiles(root, visit) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return; }
  const tasks = entries.map((e) => async () => {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(p, visit);
    } else {
      let st; try { st = await fsp.stat(p); } catch { return; }
      await visit(p, st);
    }
  });
  await pmap(tasks, CONCURRENCY);
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Returns { cwd, summary } from a claude/codex jsonl by reading just the
// head directly. Cached by (filepath, mtimeMs) so a repeat scan of unchanged
// files is O(1).
//
//   cwd —
//     claude · top-level { cwd: "..." } on every message envelope
//     codex  · session_meta line { payload: { cwd: "..." } }
//   first user message (preview) —
//     claude · { type:'user', message:{ content:'...' } }
//     codex  · { type:'event_msg', payload:{ type:'user_message', message:'...' } }
async function parseJsonlHead(filepath, mtimeMs, headBytes = HEAD_BYTES) {
  const cached = cacheGet(filepath, mtimeMs);
  if (cached) return cached;

  let fh;
  try { fh = await fsp.open(filepath, 'r'); }
  catch { return { cwd: null, summary: '' }; }
  const buf = Buffer.allocUnsafe(headBytes);
  let bytesRead = 0;
  try {
    const r = await fh.read(buf, 0, headBytes, 0);
    bytesRead = r.bytesRead || 0;
  } catch {
    /* leave bytesRead = 0 */
  } finally {
    try { await fh.close(); } catch {}
  }
  if (bytesRead === 0) {
    const v = { cwd: null, summary: '' };
    cachePut(filepath, mtimeMs, v);
    return v;
  }

  const text = buf.slice(0, bytesRead).toString('utf8');
  // Drop the trailing partial line — JSON.parse on it will fail anyway.
  const lines = text.split('\n');
  if (bytesRead === headBytes) lines.pop();

  let cwd = null;
  let summary = '';
  for (const line of lines) {
    if (cwd && summary) break;
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj) continue;
    if (!cwd) {
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      else if (obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
    }
    if (!summary) {
      if (obj.type === 'user' && typeof obj.message?.content === 'string') {
        summary = truncate(obj.message.content, SUMMARY_MAX);
      } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        // Some claude builds store content as an array of blocks; grab the
        // first text block for the preview.
        const textBlock = obj.message.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
        if (textBlock) summary = truncate(textBlock.text, SUMMARY_MAX);
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'user_message'
                 && typeof obj.payload.message === 'string') {
        summary = truncate(obj.payload.message, SUMMARY_MAX);
      }
    }
  }
  const v = { cwd, summary };
  cachePut(filepath, mtimeMs, v);
  return v;
}

// Codex-specific streaming parser. Unlike claude, codex writes a large
// `<permissions instructions>` developer message (~55KB) BEFORE the first
// real user turn, so a fixed-size head read routinely misses the summary.
// We instead read the file in 64KB chunks, splitting on newline BYTES (not
// decoded chars, so multi-byte UTF-8 never gets sliced mid-character), and
// stop as soon as we've captured both the cwd and the first user message —
// or hit a 1MB safety cap. cwd lands in the session_meta line (byte 0), so
// in practice we read ~55KB and bail at the user_message line.
async function parseCodexHead(filepath, mtimeMs) {
  const cached = cacheGet(filepath, mtimeMs);
  if (cached) return cached;

  let fh;
  try { fh = await fsp.open(filepath, 'r'); }
  catch { return { cwd: null, summary: '' }; }

  const CHUNK = 64 * 1024;
  const MAX_BYTES = 1024 * 1024;
  const readBuf = Buffer.allocUnsafe(CHUNK);
  let leftover = Buffer.alloc(0);
  let pos = 0;
  let cwd = null;
  let summary = '';

  const consumeLine = (lineBuf) => {
    if (!lineBuf.length) return;
    let obj;
    try { obj = JSON.parse(lineBuf.toString('utf8')); } catch { return; }
    if (!obj) return;
    if (!cwd) {
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      else if (obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
    }
    if (!summary && obj.type === 'event_msg' && obj.payload?.type === 'user_message'
        && typeof obj.payload.message === 'string') {
      summary = truncate(obj.payload.message, SUMMARY_MAX);
    }
  };

  try {
    while (pos < MAX_BYTES && !(cwd && summary)) {
      const { bytesRead } = await fh.read(readBuf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = Buffer.concat([leftover, readBuf.subarray(0, bytesRead)]);
      let start = 0;
      let nl;
      while ((nl = data.indexOf(0x0a, start)) >= 0) {
        consumeLine(data.subarray(start, nl));
        start = nl + 1;
        if (cwd && summary) break;
      }
      leftover = data.subarray(start);
    }
  } catch {
    /* partial results are fine */
  } finally {
    try { await fh.close(); } catch {}
  }

  const v = { cwd, summary };
  cachePut(filepath, mtimeMs, v);
  return v;
}
