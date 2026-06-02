// Fetch wrapper + every loader. Loaders push into signals from ./state.js.
// Cross-origin (hosted frontend → local backend) flows through httpBase().

import { signal } from '@preact/signals';
import * as S from './state.js';
import { httpBase, getToken, getDeviceId, getDeviceCode, isRemoteAccess } from './backend.js';

// Global pending-approval signal. Flipped to true whenever any /api
// call returns 403 {pending:true}; PendingApprovalOverlay watches this
// and shows the blocking screen. We also stash the server's record so
// the overlay can display "we recorded you at HH:MM" detail.
export const pendingDevice = signal(null);

export async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  // When a remote token is configured (Remote page set it OR the page
  // was loaded with ?token= and we stashed it in localStorage), attach
  // it to every API call. The server middleware lets loopback Hosts
  // through without the token; for tunnel-served pages this is the
  // only way past the 401.
  const tok = getToken();
  if (tok) opts.headers['Authorization'] = `Bearer ${tok}`;
  // Always send our device id when one exists in localStorage. The host
  // browser at localhost doesn't strictly need it (loopback bypass),
  // but harmless — the server simply records lastSeen for it. Required
  // for any tunnel-served page to clear the device-approval gate.
  const dev = getDeviceId();
  if (dev) opts.headers['X-Device-Id'] = dev;
  // 4-digit identification code (see getDeviceCode in backend.js).
  // Server stores it on first sight; the Remote page renders it
  // alongside each pending device so the operator can confirm "yes,
  // this is the request I just made on my phone" before approving.
  const code = getDeviceCode();
  if (code) opts.headers['X-Device-Code'] = code;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(httpBase() + url, opts);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) {
    // Surface device-approval pending state. Only matters on remote
    // tabs — host's loopback browser never gets a 401/403 from these
    // checks.
    if (isRemoteAccess()) {
      if (r.status === 403 && json && (json.pending || json.rejected)) {
        // Merge into the existing pendingDevice rather than overwriting
        // so the "we recorded you at HH:MM" detail (only present on the
        // initial /me hit, not subsequent gate 403s) survives. Without
        // this merge, the first failing /api/sessions tick after the
        // overlay mounts wipes the firstSeen timestamp and the copy
        // reverts to a generic "The host machine got your request".
        const prev = pendingDevice.value || {};
        pendingDevice.value = { ...prev, ...json, at: Date.now() };
      } else if (r.status === 401) {
        // Server doesn't recognise our device — either fresh page load
        // (no /api/devices/me hit yet) or our record got pruned (24h
        // pending TTL) AND our token no longer matches the host's
        // current one. PendingApprovalOverlay's /me poll will try to
        // re-register; on token mismatch /me itself 401s and the
        // overlay flips into "token expired" state. We just nudge the
        // overlay alive here.
        const prev = pendingDevice.value || {};
        pendingDevice.value = { ...prev, pending: true, at: Date.now() };
      }
    }
    throw new Error(json.error || `HTTP ${r.status}`);
  }
  // PendingApprovalOverlay clears pendingDevice itself based on the
  // /api/devices/me body (which can return 200 with status:'pending'
  // since that endpoint is gate-exempt). Doing an auto-clear here on
  // any 2xx would race the overlay's poll and dismiss it prematurely.
  return json;
}

export async function loadConfig() {
  const [cfg, caps] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/capabilities').catch(() => ({ webTerminal: false })),
  ]);
  S.config.value = cfg;
  S.capabilities.value = caps;
}

// Update an existing CLI by id. patch is shallow-merged into the record.
export async function updateCli(id, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  // Built-in CLIs lock down structural fields (id + builtin flag) but
  // allow command edits — users routinely need to point at an absolute
  // path (e.g. C:\Users\you\.local\bin\claude.exe) or a wrapper script
  // when the bare name isn't on the spawn-time PATH.
  if (target?.builtin) {
    delete patch.id;
    delete patch.builtin;
  }
  const toArr = (v, fallback) => Array.isArray(v) ? v :
    typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : fallback;
  const next = {
    ...cfg,
    clis: (cfg.clis || []).map((c) => c.id === id ? {
      ...c, ...patch,
      args: toArr(patch.args, c.args),
      shell: ['direct', 'pwsh', 'cmd'].includes(patch.shell ?? c.shell) ? (patch.shell ?? c.shell) : 'direct',
    } : c),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

// Probe a (possibly-unsaved) CLI config: spawn its command with
// `--version`, capture output, see if it looks like the claimed type.
// `args` is intentionally ignored server-side — runtime flags can
// disturb a quick probe.
export async function testCli({ command, shell, type }) {
  return api('POST', '/api/clis/test', { command, shell, type });
}

export async function deleteCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  if (target?.builtin) throw new Error(`"${target.name}" is built-in and can't be deleted`);
  const clis = (cfg.clis || []).filter((c) => c.id !== id);
  if (clis.length === 0) throw new Error('cannot delete the last CLI');
  const next = { ...cfg, clis };
  if (next.defaultCliId === id) next.defaultCliId = clis[0].id;
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function updateRepo(name, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = {
    ...cfg,
    repos: (cfg.repos || []).map((r) => r.name === name ? {
      ...r,
      name: (patch.name ?? r.name).trim(),
      url: (patch.url ?? r.url).trim(),
      defaultSelected: patch.defaultSelected ?? r.defaultSelected,
    } : r),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function deleteRepo(name) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = { ...cfg, repos: (cfg.repos || []).filter((r) => r.name !== name) };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function setDefaultCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const saved = await api('PUT', '/api/config', { ...cfg, defaultCliId: id });
  S.config.value = saved;
}

// Add a new CLI to config.clis and return its id. Generates a fresh id
// from the command name + an integer suffix when collisions exist.
export async function createCli({ name, command, args, shell, type }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const base = (name || command || 'cli').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cli';
  let id = base, n = 1;
  while ((cfg.clis || []).some((c) => c.id === id)) { id = `${base}-${++n}`; }
  const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);
  const next = {
    ...cfg,
    clis: [...(cfg.clis || []), {
      id,
      name: (name || command || id).trim(),
      command: (command || '').trim(),
      args: toArr(args),
      shell: ['direct', 'pwsh', 'cmd'].includes(shell) ? shell : 'direct',
      type: ['claude', 'codex', 'copilot', 'other'].includes(type) ? type : 'other',
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

// Add a new repo to config.repos. Repos are addressed by name (which must
// be unique). Returns the name on success, throws on duplicate.
export async function createRepo({ name, url, defaultSelected }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const cleanName = (name || '').trim();
  const cleanUrl = (url || '').trim();
  if (!cleanName) throw new Error('repo name required');
  if (!cleanUrl) throw new Error('repo url required');
  if ((cfg.repos || []).some((r) => r.name === cleanName)) {
    throw new Error(`repo "${cleanName}" already exists`);
  }
  const next = {
    ...cfg,
    repos: [...(cfg.repos || []), {
      name: cleanName,
      url: cleanUrl,
      defaultSelected: !!defaultSelected,
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return cleanName;
}

export async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  S.sessions.value = r.sessions || [];
  try { localStorage.setItem('ccsm.sessions-cache', JSON.stringify(S.sessions.value)); } catch {}
}

export async function loadFolders() {
  const r = await api('GET', '/api/folders');
  S.folders.value = (r.folders || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  try { localStorage.setItem('ccsm.folders-cache', JSON.stringify(S.folders.value)); } catch {}
}

export async function createFolder(name) {
  const r = await api('POST', '/api/folders', { name });
  await loadFolders();
  return r.folder;
}

export async function renameFolder(id, name) {
  const r = await api('PUT', `/api/folders/${id}`, { name });
  await loadFolders();
  return r.folder;
}

export async function deleteFolder(id) {
  await api('DELETE', `/api/folders/${id}`);
  await Promise.all([loadFolders(), loadSessions()]);
}

export async function reorderFolders(ids) {
  const r = await api('POST', '/api/folders/reorder', { ids });
  await loadFolders();
  return r.folders;
}

export async function setSessionFolder(sessionId, folderId) {
  await api('PUT', `/api/sessions/${sessionId}`, { folderId: folderId || null });
  await loadSessions();
}

export async function reorderSessions(folderId, ids) {
  await api('POST', '/api/sessions/reorder', { folderId: folderId || null, ids });
  await loadSessions();
}

export async function setSessionTitle(sessionId, title) {
  await api('PUT', `/api/sessions/${sessionId}`, { title });
  await loadSessions();
}

export async function deleteSession(sessionId) {
  await api('DELETE', `/api/sessions/${sessionId}`);
  await loadSessions();
}

// Per-session in-flight resume promise. Sidebar.onClick and the
// SessionsPage auto-resume effect can both fire for the same exited
// session in the same tick (clicking an exited row mounts SessionsPage
// which runs its effect AND awaits Sidebar's own POST). Without this
// dedup the backend gets two concurrent /resume requests and may spawn
// two PTYs against the same record. Cleared on resolve/reject.
const resumeInFlight = new Map(); // sessionId → Promise
// Sticky failure cache: once a resume fails, subsequent calls reject
// immediately with the cached error until clearResumeFailure(id) is
// called. Stops the SessionsPage auto-resume effect from looping on a
// session whose CLI keeps exiting (bad command, missing flag, etc.).
const resumeFailed = new Map(); // sessionId → Error

export function clearResumeFailure(sessionId) {
  resumeFailed.delete(sessionId);
}

export function resumeSession(sessionId) {
  const failed = resumeFailed.get(sessionId);
  if (failed) return Promise.reject(failed);
  const cached = resumeInFlight.get(sessionId);
  if (cached) return cached;
  const p = (async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/resume`);
    await loadSessions();
    return r.launched;
  })();
  resumeInFlight.set(sessionId, p);
  p.then(
    () => { resumeInFlight.delete(sessionId); },
    (e) => { resumeInFlight.delete(sessionId); resumeFailed.set(sessionId, e); },
  );
  return p;
}

export async function loadWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  S.workspaces.value = r.workspaces;
}

export async function deleteWorkspace(name) {
  await api('DELETE', `/api/workspaces/${encodeURIComponent(name)}`);
}

export async function refreshAll() {
  await Promise.all([
    loadSessions(),
    loadFolders(),
    loadWorkspaces(),
  ]);
  S.lastRefreshAt.value = Date.now();
}

// List existing CLI sessions discovered on disk for a given cli type.
// Paginated: page 0 returns all currently-active sessions + the first
// `limit` non-active (sorted mtime desc). Subsequent pages return the
// next slice of non-active sessions.
// Returns { sessions, totalActive, totalNonActive, total, offset, limit, hasMore }.
export async function listLocalCliSessions(cliType, { offset = 0, limit = 30 } = {}) {
  const qs = `offset=${offset}&limit=${limit}`;
  const r = await api('GET', `/api/cli-sessions/${cliType}?${qs}`);
  return {
    sessions: r.sessions || [],
    totalActive: r.totalActive ?? 0,
    totalNonActive: r.totalNonActive ?? 0,
    total: r.total ?? (r.sessions?.length || 0),
    offset: r.offset ?? offset,
    limit: r.limit ?? limit,
    hasMore: !!r.hasMore,
  };
}

// Adopt an existing upstream CLI session into ccsm. Returns the created
// (or existing) persistedSessions record.
export async function adoptSession({ cliId, cliSessionId, cwd, title, folderId }) {
  const r = await api('POST', '/api/sessions/adopt', { cliId, cliSessionId, cwd, title, folderId });
  return r;
}

export async function restartBackend() {
  return api('POST', '/api/restart');
}

let consecutiveOffline = 0;
export async function pollHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(httpBase() + '/api/health', { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    consecutiveOffline = 0;
    S.serverHealth.value = { state: 'online', version: j.version, pid: j.pid, failureCount: 0 };
    if (!S.hasBootedOnline.value) S.hasBootedOnline.value = true;
  } catch (e) {
    consecutiveOffline++;
    S.serverHealth.value = {
      state: 'offline',
      error: String(e.message || e),
      failureCount: consecutiveOffline,
    };
  } finally {
    clearTimeout(t);
  }
}
