'use strict';

// Discover existing CLI sessions on this machine and surface them so
// ccsm can "adopt" them — i.e. create a persistedSessions record that
// resumes the same upstream conversation later.
//
// Per CLI:
//   claude  · ~/.claude/projects/<slug>/<uuid>.jsonl   (uuid = id)
//   codex   · ~/.codex/sessions/**/<uuid>.jsonl        (uuid = id)
//   copilot · ~/.copilot/session-state/<uuid>/         (uuid = dir name;
//              cwd + summary in workspace.yaml)
//
// Each session is reported as:
//   { cliType, cliSessionId, cwd, mtime, summary }
//
// Heuristic for `summary`: the first user message text (claude/codex)
// or the YAML `summary:` line (copilot). Truncated to 120 chars.
//
// Performance:
//   - We read each jsonl's HEAD (first 16KB) directly via fd.read instead
//     of going through readline+stream — readline init is the dominant
//     cost when scanning hundreds of small files.
//   - Files are parsed in parallel with a small concurrency cap (16) so
//     the OS scheduler stays useful but we don't fire 300+ syscalls at
//     once.
//   - An in-process LRU caches parse results keyed by (filepath, mtime).
//     Unchanged files on subsequent scans are O(1).

const fs = require('node:fs');
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
    // Drop oldest insertion (Map keeps insertion order).
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
// sorted by mtime desc. No content read, no parsing. Used both as the
// "list of candidates" for pagination AND as the source of truth for
// "what jsonl ids exist on disk".
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
  const all = grouped.flat().filter(Boolean);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

// Codex sessions can live under a RELOCATED CODEX_HOME. Some wrappers
// point it at e.g. %LOCALAPPDATA%\<wrapper>\codex-home, so `~/.codex` is empty
// of the sessions the user actually created. Seeding already honours this
// (codexSeed.probeCodexHome runs `<cli> doctor`); the import scan must too,
// or those relocated sessions are invisible in the adopt modal. Gather every
// candidate `<home>/sessions` dir: each configured codex CLI's detected
// home, the CODEX_HOME env override, and codex's own ~/.codex default.
async function codexSessionRoots() {
  const roots = new Set();
  try {
    const { loadConfig } = require('./config');
    const { probeCodexHome } = require('./codexSeed');
    const cfg = await loadConfig();
    const codexClis = (cfg?.clis || []).filter((c) => c.type === 'codex' || c.id === 'codex');
    for (const c of codexClis) {
      if (!c.command) continue;
      let home = null;
      try { home = await probeCodexHome({ command: c.command, shell: c.shell }); }
      catch { /* probe is best-effort */ }
      if (home) roots.add(path.join(home, 'sessions'));
    }
  } catch { /* config/probe unavailable — fall through to defaults */ }
  if (process.env.CODEX_HOME) roots.add(path.join(process.env.CODEX_HOME, 'sessions'));
  roots.add(path.join(os.homedir(), '.codex', 'sessions'));
  return [...roots];
}

async function discoverCodex() {
  const roots = await codexSessionRoots();
  const candidates = [];
  const seen = new Set();   // dedup by session id across homes
  for (const root of roots) {
    await walkFiles(root, async (filepath, st) => {
      if (!filepath.endsWith('.jsonl')) return;
      const base = path.basename(filepath);
      const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      candidates.push({ id: m[1], filepath, mtimeMs: st.mtimeMs });
    });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

// Hydrate a list of {id, filepath, mtimeMs} candidates into full session
// records by parsing each jsonl head. cliType is the discriminator in the
// returned record.
async function hydrateJsonl(candidates, cliType) {
  // codex prepends a big system preamble (<permissions instructions> +
  // <environment_context>, ~32KB) before the first user message, so 16KB
  // catches the cwd (line 1) but not the summary. Read a larger head for
  // codex; its dataset is tiny so the extra bytes are free. claude/copilot
  // keep the cheap 16KB.
  const headBytes = cliType === 'codex' ? 48 * 1024 : HEAD_BYTES;
  const parseTasks = candidates.map((c) => async () => {
    const { cwd, summary } = await parseJsonlHead(c.filepath, c.mtimeMs, headBytes);
    if (!cwd) return null;
    return {
      cliType,
      cliSessionId: c.id,
      cwd,
      mtime: c.mtimeMs,
      summary,
    };
  });
  const parsed = await pmap(parseTasks, CONCURRENCY);
  return parsed.filter(Boolean);
}

// Full-load variants (no pagination). Kept for back-compat callers /
// codex+copilot where the dataset is small.
async function listClaude() {
  return hydrateJsonl(await discoverClaude(), 'claude');
}
async function listCodex() {
  return hydrateJsonl(await discoverCodex(), 'codex');
}

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
      mtime: updated ? Date.parse(updated) || st.mtimeMs : st.mtimeMs,
      summary: truncate(summary, SUMMARY_MAX),
    });
  }
  return out;
}

async function listForType(cliType) {
  if (cliType === 'claude')  return listClaude();
  if (cliType === 'codex')   return listCodex();
  if (cliType === 'copilot') return listCopilot();
  return [];
}

// ── Active-session detection ───────────────────────────────────────
// "Active" = a cli process is currently running with this session loaded.
// Claude: definitive — ~/.claude/sessions/<pid>.json has {pid, sessionId},
//         cross-check pid is alive via tasklist /FI "IMAGENAME eq claude.exe".
// Codex / Copilot: no per-process session manifest we can read, so we
//         fall back to mtime heuristic (jsonl/yaml touched in the last
//         RECENT_MS = a session being actively written to is "active").
const RECENT_MS = 5 * 60 * 1000;

// tasklist is the expensive one — ~500ms on Windows for "list every
// process named claude.exe". Strategy:
//
//   1. Module-level cache keyed by procName.
//   2. A background refresh loop runs every LIVE_PIDS_REFRESH_MS while
//      anyone has asked for the pids in the recent past. The foreground
//      call ALWAYS returns the cached value immediately — it never waits
//      for tasklist. Stale-while-revalidate, in other words.
//   3. First call ever (cache miss) blocks until tasklist returns once.
//
// Net effect: import-modal cold open shows the page in tens of ms, and
// the "active" markers are at most LIVE_PIDS_REFRESH_MS old.

const LIVE_PIDS_REFRESH_MS = 15_000;
const livePidsByProc = new Map(); // procName → { pids: Set<pid>, ts: number }
const livePidsRefresh = new Map(); // procName → setInterval handle
const livePidsInflight = new Map(); // procName → Promise<Set<pid>>

async function tasklistOnce(procName) {
  if (process.platform !== 'win32') return new Set();
  return new Promise((resolve) => {
    const { exec } = require('node:child_process');
    exec(`tasklist /FI "IMAGENAME eq ${procName}" /FO CSV /NH`,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const pids = new Set();
        if (!err && stdout) {
          for (const line of stdout.split(/\r?\n/)) {
            const m = line.match(/^"[^"]+","(\d+)"/);
            if (m) pids.add(Number(m[1]));
          }
        }
        resolve(pids);
      });
  });
}

function startRefreshLoop(procName) {
  if (livePidsRefresh.has(procName)) return;
  // unref so it doesn't keep the process alive.
  const handle = setInterval(async () => {
    try {
      const pids = await tasklistOnce(procName);
      livePidsByProc.set(procName, { pids, ts: Date.now() });
    } catch {}
  }, LIVE_PIDS_REFRESH_MS);
  if (typeof handle.unref === 'function') handle.unref();
  livePidsRefresh.set(procName, handle);
}

// Non-blocking lookup. Returns whatever the cache holds, even if empty.
// If there's no fresh data, kicks off a refresh in the background — the
// next request a few seconds later will see populated results. This is a
// deliberate tradeoff: tasklist on this machine sometimes spikes to
// 30+s, and we absolutely will not let import-modal cold-open inherit
// that latency. Worst case the first paint has `active: false` on every
// row and the second paint (after frontend re-fetches) has the correct
// markers — at most LIVE_PIDS_REFRESH_MS stale.
function getLivePids(procName) {
  startRefreshLoop(procName);  // idempotent — keeps cache fresh
  const cached = livePidsByProc.get(procName);
  if (cached) return cached.pids;

  // Cache miss — kick off a tasklist if no one already has, but DON'T
  // await it. Return empty for now; future calls will see the populated
  // cache once it lands.
  if (!livePidsInflight.has(procName)) {
    const inflight = tasklistOnce(procName).then((pids) => {
      livePidsByProc.set(procName, { pids, ts: Date.now() });
      livePidsInflight.delete(procName);
      return pids;
    }).catch(() => { livePidsInflight.delete(procName); return new Set(); });
    livePidsInflight.set(procName, inflight);
  }
  return new Set();  // immediate, empty
}

// Prewarm — called from server boot so the first user request to the
// import modal already hits the warm cache.
function prewarmLivePids(procNames = ['claude.exe']) {
  for (const p of procNames) {
    getLivePids(p).catch(() => {});
  }
}

async function activeClaudeIds() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files;
  try { files = await fsp.readdir(dir); }
  catch { return new Set(); }
  // Non-blocking — if tasklist cache is cold, returns empty Set and
  // schedules a background refresh. First-paint may miss live markers;
  // subsequent re-fetches pick them up.
  const livePids = getLivePids('claude.exe');
  const ids = new Set();
  await pmap(
    files.filter((f) => f.endsWith('.json')).map((f) => async () => {
      let raw; try { raw = await fsp.readFile(path.join(dir, f), 'utf8'); }
      catch { return; }
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.sessionId && livePids.has(Number(obj.pid))) {
          ids.add(obj.sessionId);
        }
      } catch {}
    }),
    CONCURRENCY,
  );
  return ids;
}

// Compute per-type active set. Returns Set<cliSessionId>.
async function getActiveIds(cliType) {
  if (cliType === 'claude') return activeClaudeIds();
  // codex / copilot: no manifest. Returning empty here; the caller falls
  // back to mtime-recency in listForTypeWithActive below.
  return new Set();
}

// Annotate listForType output with `active: bool`. Centralises the logic
// so server.js doesn't have to know about per-CLI quirks.
async function listForTypeWithActive(cliType) {
  const [items, activeIds] = await Promise.all([
    listForType(cliType),
    getActiveIds(cliType),
  ]);
  const now = Date.now();
  return items.map((it) => ({
    ...it,
    active: activeIds.has(it.cliSessionId)
      // Fallback: any session touched within RECENT_MS is treated as
      // active. Catches codex/copilot which don't expose a pid mapping.
      || (now - it.mtime) < RECENT_MS,
  }));
}

// Page-based list for the import modal. offset/limit is a window into the
// full candidate set, ordered active-first then newest-first. Each call
// returns exactly that page — the modal renders ‹ Prev · X–Y of Z · Next ›.
//
// Returns: { sessions, total, totalActive, totalNonActive, offset, limit, hasMore }
async function listPaginated(cliType, { offset = 0, limit = 20 } = {}) {
  const now = Date.now();

  // copilot's "discover" is also the parse (no cheap jsonl head), so we
  // already have the full hydrated list — just slice the requested page.
  if (cliType === 'copilot') {
    const all = await listForTypeWithActive('copilot');
    all.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : b.mtime - a.mtime));
    const totalActive = all.filter((x) => x.active).length;
    return {
      sessions: all.slice(offset, offset + limit),
      total: all.length,
      totalActive,
      totalNonActive: all.length - totalActive,
      offset, limit,
      hasMore: offset + limit < all.length,
    };
  }

  // claude / codex: two-phase — cheap discover (stat only), hydrate just the
  // page's slice.
  const discover = cliType === 'codex' ? discoverCodex : discoverClaude;
  const [candidates, activeIds] = await Promise.all([discover(), getActiveIds(cliType)]);
  const isActive = (c) => activeIds.has(c.id) || (now - c.mtimeMs) < RECENT_MS;
  // Active-first; discover already sorted mtime-desc so a stable partition
  // keeps newest-first within each group.
  const ordered = [...candidates.filter(isActive), ...candidates.filter((c) => !isActive(c))];
  const totalActive = ordered.length - candidates.filter((c) => !isActive(c)).length;

  const slice = ordered.slice(offset, offset + limit);
  const hydrated = await hydrateJsonl(slice, cliType);
  for (const s of hydrated) {
    s.active = activeIds.has(s.cliSessionId) || (now - s.mtime) < RECENT_MS;
  }

  return {
    sessions: hydrated,
    total: candidates.length,
    totalActive,
    totalNonActive: candidates.length - totalActive,
    offset, limit,
    hasMore: offset + limit < candidates.length,
  };
}

module.exports = {
  listForType,
  listForTypeWithActive,
  listPaginated,
  listClaude,
  listCodex,
  listCopilot,
  getActiveIds,
  prewarmLivePids,
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
// first 16KB directly. Way faster than readline+stream when scanning
// hundreds of files. Cached by (filepath, mtimeMs) so a repeat scan of
// unchanged files is O(1).
//
// cwd lives in the head of every jsonl (it's part of the per-message
// envelope), so 16KB is more than enough. First user text usually too;
// if it's beyond the head we just don't preview, that's fine.
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
    // cwd —
    //   claude · top-level { cwd: "..." } on every message envelope
    //   codex  · session_meta line { payload: { cwd: "..." } }
    if (!cwd) {
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      else if (obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
    }
    // first user message (preview) —
    //   claude · { type:'user', message:{ content:'...' } }
    //   codex  · { type:'event_msg', payload:{ type:'user_message', message:'...' } }
    if (!summary) {
      if (obj.type === 'user' && typeof obj.message?.content === 'string') {
        summary = truncate(obj.message.content, SUMMARY_MAX);
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
