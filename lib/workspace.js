'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function normWin(p) {
  return path.resolve(String(p)).toLowerCase();
}

function isInside(child, parent) {
  const c = normWin(child);
  const p = normWin(parent);
  if (c === p) return true;
  const pSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(pSep);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function isGitClone(p) {
  return dirExists(path.join(p, '.git'));
}

async function listSubdirs(p) {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function describeWorkspace(workspacePath, repos, busyPaths) {
  const repoStatus = await Promise.all(
    repos.map(async (r) => {
      const repoPath = path.join(workspacePath, r.name);
      const exists = await dirExists(repoPath);
      const cloned = exists ? await isGitClone(repoPath) : false;
      return {
        name: r.name,
        url: r.url,
        path: repoPath,
        exists,
        cloned,
      };
    })
  );
  const inUse = busyPaths.some((p) => isInside(p, workspacePath));
  const sessionsHere = busyPaths.filter((p) => isInside(p, workspacePath));
  return {
    name: path.basename(workspacePath),
    path: workspacePath,
    inUse,
    sessionsHere,
    repos: repoStatus,
  };
}

async function listWorkspaces({ workDir, repos, busyPaths = [] }) {
  await ensureDir(workDir);
  const subdirs = await listSubdirs(workDir);

  const workspaces = await Promise.all(
    subdirs.map((name) =>
      describeWorkspace(path.join(workDir, name), repos, busyPaths)
    )
  );
  workspaces.sort((a, b) => {
    if (a.inUse !== b.inUse) return a.inUse ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return workspaces;
}

function nextWorkspaceName(existing) {
  const used = new Set(existing.map((w) => w.name.toLowerCase()));
  for (let i = 1; i < 10000; i++) {
    const candidate = `ws-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate workspace name');
}

async function findOrCreateWorkspace({ workDir, repos, busyPaths = [], requireUnused = true }) {
  // Without busyPaths, every workspace looks free → find() always
  // returns ws-1 → every new session piles into ws-1. Callers must
  // pass the cwds of sessions that should reserve a workspace.
  const all = await listWorkspaces({ workDir, repos, busyPaths });
  if (requireUnused) {
    const free = all.find((w) => !w.inUse);
    if (free) return { workspace: free, created: false };
  }
  const name = nextWorkspaceName(all);
  const wsPath = path.join(workDir, name);
  await ensureDir(wsPath);
  const ws = await describeWorkspace(wsPath, repos, busyPaths);
  return { workspace: ws, created: true };
}

// Parse a single git --progress line. Git emits these on stderr, using \r
// to overwrite the same line in place, with the format:
//   "<phase>: <pct>% (<cur>/<total>), <detail>"
// Examples:
//   "Receiving objects:  45% (12345/27384), 23.4 MiB | 5.2 MiB/s"
//   "Resolving deltas: 100% (5847/5847), done."
function parseGitProgress(line) {
  if (!line) return null;
  const clean = line.replace(/^remote:\s*/, '').trim();
  const m = clean.match(/^([^:]+):\s+(\d+)%\s*(?:\((\d+)\/(\d+)\))?(?:,\s+(.+?))?$/);
  if (!m) return null;
  return {
    phase: m[1].trim(),
    percent: Number(m[2]),
    current: m[3] ? Number(m[3]) : null,
    total: m[4] ? Number(m[4]) : null,
    detail: m[5] ? m[5].trim() : null,
    raw: clean,
  };
}

function runGit(args, cwd, { onProgress, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => {
      const text = d.toString();
      err += text;
      if (onProgress || onLine) {
        stderrBuf += text;
        const parts = stderrBuf.split(/[\r\n]/);
        stderrBuf = parts.pop();
        for (const line of parts) {
          if (!line) continue;
          if (onLine) onLine(line);
          if (onProgress) {
            const p = parseGitProgress(line);
            if (p) onProgress(p);
          }
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stderrBuf && (onLine || onProgress)) {
        if (onLine) onLine(stderrBuf);
        if (onProgress) {
          const p = parseGitProgress(stderrBuf);
          if (p) onProgress(p);
        }
      }
      if (code === 0) resolve({ stdout: out, stderr: err });
      else
        reject(
          Object.assign(
            new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`),
            { code, stdout: out, stderr: err }
          )
        );
    });
  });
}

async function cloneRepoInto({ workspacePath, repo, onProgress, onLine }) {
  const target = path.join(workspacePath, repo.name);
  if (await dirExists(target)) {
    if (await isGitClone(target)) {
      return { repo: repo.name, action: 'already-cloned', path: target };
    }
    throw new Error(
      `Target ${target} exists but is not a git clone — refusing to overwrite`
    );
  }
  // -c core.longpaths=true defeats Windows' default 260-char MAX_PATH so deep
  // repo trees (e.g. nested doc / .github skill paths) can check out
  // successfully. The flag only applies to this single git invocation.
  await runGit(
    ['-c', 'core.longpaths=true', 'clone', '--progress', repo.url, repo.name],
    workspacePath,
    { onProgress, onLine }
  );
  return { repo: repo.name, action: 'cloned', path: target };
}

async function ensureReposInWorkspace({ workspacePath, repos, onProgress, onLine, onRepoStart, onRepoEnd }) {
  const results = [];
  for (const repo of repos) {
    if (onRepoStart) onRepoStart(repo);
    try {
      const r = await cloneRepoInto({
        workspacePath,
        repo,
        onProgress: onProgress ? (p) => onProgress(repo, p) : null,
        onLine: onLine ? (l) => onLine(repo, l) : null,
      });
      if (onRepoEnd) onRepoEnd(repo, { ok: true, ...r });
      results.push({ ok: true, ...r });
    } catch (e) {
      const err = { ok: false, repo: repo.name, error: String(e && e.message || e) };
      if (onRepoEnd) onRepoEnd(repo, err);
      results.push(err);
    }
  }
  return results;
}

module.exports = {
  listWorkspaces,
  findOrCreateWorkspace,
  ensureReposInWorkspace,
  isInside,
  nextWorkspaceName,
};
