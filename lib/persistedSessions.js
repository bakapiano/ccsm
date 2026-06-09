'use strict';

// ccsm-owned session records. Replaces the old "scan ~/.claude/sessions/
// + tasklist" path entirely: we no longer try to enumerate every claude
// process on the machine. Instead, every session ccsm starts (via the
// web terminal) gets recorded here, and the user organises them in
// folders.
//
// Each entry:
//   {
//     id: 'sess-...',          // ccsm's session id (matches webTerminal id)
//     cliId: 'claude',         // which CLI from config.clis
//     cwd: '...',              // absolute workspace path
//     workspace: 'ws-3',       // basename of cwd (display)
//     title: '',               // user-edited label (Configure / sidebar tree)
//     folderId: null,          // nullable; null = "Unsorted" top-level
//     repos: ['foo','bar'],    // names of repos cloned into cwd at launch
//     createdAt: 1234,
//     lastActiveAt: 1234,      // updated on attach/input; drives sort
//     status: 'running'|'exited',
//     exitedAt: null,
//     exitCode: null,
//     pid: null,               // current pid if running
//     cliSessionId: null,      // upstream CLI's session UUID. Pre-assigned
//                              //   at spawn time for CLIs with
//                              //   newSessionIdArgs (claude, copilot); set
//                              //   from disk for adopted sessions. Used
//                              //   for precise --resume <id>.
//     manualStopped: false,    // true only when the user explicitly stopped
//                              //   it from ccsm; prevents auto-resume until
//                              //   they press Resume.
//   }

const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./config');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

const FILE = path.join(DATA_DIR, 'sessions.json');

async function loadAll() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function saveAll(list) {
  await atomicWriteJson(FILE, list);
}

function genId() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function create(opts) {
  return withFileLock(FILE, async () => {
    const { cliId, cwd, workspace, repos = [], folderId = null, title = '', status = 'running', cliSessionId = null } = opts;
    const list = await loadAll();
    const entry = {
      id: genId(),
      cliId,
      cwd,
      workspace,
      title,
      folderId,
      repos,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status,
      exitedAt: status === 'exited' ? Date.now() : null,
      exitCode: null,
      pid: null,
      cliSessionId,
      manualStopped: false,
    };
    list.push(entry);
    await saveAll(list);
    return entry;
  });
}

async function get(id) {
  const list = await loadAll();
  return list.find((s) => s.id === id) || null;
}

async function update(id, patch) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    await saveAll(list);
    return list[idx];
  });
}

async function remove(id) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    await saveAll(list);
    return true;
  });
}

// Convenience helpers used at runtime so callers don't have to do
// load/find/update/save themselves.
async function markRunning(id, pid) {
  return update(id, { status: 'running', pid, exitedAt: null, exitCode: null, manualStopped: false, lastActiveAt: Date.now() });
}

async function markExited(id, exitCode) {
  return update(id, { status: 'exited', exitCode: exitCode ?? null, exitedAt: Date.now(), pid: null });
}

async function touch(id) {
  return update(id, { lastActiveAt: Date.now() });
}

async function setFolder(id, folderId) {
  return update(id, { folderId: folderId || null });
}

async function setTitle(id, title) {
  return update(id, { title: title || '' });
}

module.exports = {
  loadAll,
  create,
  get,
  update,
  remove,
  markRunning,
  markExited,
  touch,
  setFolder,
  setTitle,
  FILE,
};
