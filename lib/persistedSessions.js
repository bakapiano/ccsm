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
//     cwd: '...',              // absolute launch path (workspace or repo)
//     workspace: 'ws-3',       // workspace display name
//     title: '',               // user-edited label (Configure / sidebar tree)
//     folderId: null,          // nullable; null = "Unsorted" top-level
//     repos: ['foo','bar'],    // selected repo names cloned at launch
//     createdAt: 1234,
//     lastActiveAt: 1234,      // updated on attach/input; drives sort
//     status: 'running'|'exited',
//     exitedAt: null,
//     exitCode: null,
//     pid: null,               // current pid if running
//     deletedAt: null,         // soft-delete timestamp; hidden from the
//                              //   normal list while recoverable.
//     deletedFromFolderId: null,
//     deletedFromOrder: null,
//     cliSessionId: null,      // upstream CLI's own session id, discovered at
//                              //   runtime by lib/sessionBinding and rescanned
//                              //   on a timer (fork / clear / resume rotate it).
//                              //   Used to resume the EXACT conversation.
//     manualStopped: false,    // true only when the user explicitly stopped
//                              //   it from ccsm; prevents auto-resume until
//                              //   they press Resume.
//   }

const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./config');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

const FILE = path.join(DATA_DIR, 'sessions.json');
const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeEntry(entry) {
  // cliSessionId is now a first-class field (upstream CLI session id,
  // discovered at runtime). Older builds stripped it here when resume was
  // purely folder-level; keep it now so resume-by-id survives reloads.
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (!('deletedAt' in out)) out.deletedAt = null;
  if (!('deletedFromFolderId' in out)) out.deletedFromFolderId = null;
  if (!('deletedFromOrder' in out)) out.deletedFromOrder = null;
  return out;
}

function isDeleted(entry) {
  return !!(entry && typeof entry.deletedAt === 'number' && entry.deletedAt > 0);
}

function isExpiredDeleted(entry, now = Date.now()) {
  return isDeleted(entry) && entry.deletedAt < now - DELETED_RETENTION_MS;
}

function pruneExpiredDeleted(list, now = Date.now()) {
  return (list || []).filter((s) => !isExpiredDeleted(s, now));
}

async function readAllEntries() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.map(normalizeEntry) : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function loadAll() {
  const list = pruneExpiredDeleted(await readAllEntries());
  return list.filter((s) => !isDeleted(s));
}

async function loadDeleted() {
  const list = pruneExpiredDeleted(await readAllEntries());
  return list
    .filter((s) => isDeleted(s))
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

async function saveAll(list) {
  await atomicWriteJson(FILE, pruneExpiredDeleted((list || []).map(normalizeEntry)));
}

function genId() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function cwdKey(cwd) {
  return path.resolve(String(cwd || '')).toLowerCase();
}

function sameCliAndCwd(entry, cliId, cwd) {
  return entry && entry.cliId === cliId && entry.cwd && cwdKey(entry.cwd) === cwdKey(cwd);
}

function buildEntry(opts) {
  const { cliId, cwd, workspace, repos = [], folderId = null, title = '', status = 'running' } = opts;
  return {
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
    cliSessionId: null,
    manualStopped: false,
  };
}

async function create(opts) {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    const entry = buildEntry(opts);
    list.push(entry);
    await saveAll(list);
    return entry;
  });
}

async function findByCliAndCwd(cliId, cwd) {
  const list = await loadAll();
  return list.find((s) => sameCliAndCwd(s, cliId, cwd)) || null;
}

async function createOrGetByCliAndCwd(opts) {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    const existing = list.find((s) => !isDeleted(s) && sameCliAndCwd(s, opts.cliId, opts.cwd));
    if (existing) return { entry: existing, created: false };
    const entry = buildEntry(opts);
    list.push(entry);
    await saveAll(list);
    return { entry, created: true };
  });
}

async function get(id) {
  const list = await loadAll();
  return list.find((s) => s.id === id) || null;
}

async function update(id, patch) {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    const idx = list.findIndex((s) => s.id === id && !isDeleted(s));
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    await saveAll(list);
    return list[idx];
  });
}

async function remove(id) {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    const idx = list.findIndex((s) => s.id === id && !isDeleted(s));
    if (idx < 0) return false;
    const now = Date.now();
    const next = {
      ...list[idx],
      deletedAt: now,
      deletedFromFolderId: list[idx].folderId || null,
      deletedFromOrder: typeof list[idx].order === 'number' ? list[idx].order : null,
      folderId: null,
      status: 'exited',
      exitedAt: now,
      exitCode: null,
      pid: null,
      manualStopped: true,
      lastActiveAt: now,
    };
    delete next.order;
    list[idx] = next;
    await saveAll(list);
    return true;
  });
}

async function restore(id, { folderId = null } = {}) {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0 || !isDeleted(list[idx])) return null;
    const entry = list[idx];
    const conflict = list.find((s, i) =>
      i !== idx && !isDeleted(s) && sameCliAndCwd(s, entry.cliId, entry.cwd));
    if (conflict) {
      const err = new Error('a session already exists for the same CLI and cwd');
      err.code = 'ESESSION_CONFLICT';
      err.conflictId = conflict.id;
      throw err;
    }
    const restored = {
      ...entry,
      folderId: folderId || null,
      deletedAt: null,
      deletedFromFolderId: null,
      deletedFromOrder: null,
      status: 'exited',
      exitedAt: Date.now(),
      exitCode: null,
      pid: null,
      manualStopped: true,
      lastActiveAt: Date.now(),
    };
    if (typeof entry.deletedFromOrder === 'number'
        && (folderId || null) === (entry.deletedFromFolderId || null)) {
      restored.order = entry.deletedFromOrder;
    } else {
      delete restored.order;
    }
    list[idx] = restored;
    await saveAll(list);
    return restored;
  });
}

// Convenience helpers used at runtime so callers don't have to do
// load/find/update/save themselves.
async function markRunning(id, pid) {
  return update(id, { status: 'running', pid, exitedAt: null, exitCode: null, manualStopped: false, lastActiveAt: Date.now() });
}

async function normalizeStore() {
  return withFileLock(FILE, async () => {
    const list = pruneExpiredDeleted(await readAllEntries());
    await saveAll(list);
    return list.filter((s) => !isDeleted(s));
  });
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

// Persist the upstream CLI session id discovered by lib/sessionBinding.
// Preserved across markRunning/markExited so an exited session can still be
// resumed back into its exact conversation.
async function setCliSessionId(id, cliSessionId) {
  return update(id, { cliSessionId: cliSessionId || null });
}

module.exports = {
  loadAll,
  loadDeleted,
  create,
  findByCliAndCwd,
  createOrGetByCliAndCwd,
  get,
  update,
  remove,
  restore,
  markRunning,
  markExited,
  touch,
  setFolder,
  setTitle,
  setCliSessionId,
  normalizeStore,
  FILE,
  DELETED_RETENTION_MS,
};
