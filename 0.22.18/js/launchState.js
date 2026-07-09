// Persisted Launch-page selections shared by LaunchPage and quick-launch
// affordances elsewhere in the app.

export const LAUNCH_STATE_KEY = 'ccsm.launch-state';

export function loadLaunchState() {
  try {
    const raw = localStorage.getItem(LAUNCH_STATE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch {}
  return null;
}

export function saveLaunchState(s) {
  try { localStorage.setItem(LAUNCH_STATE_KEY, JSON.stringify(s)); } catch {}
}

export function resolveLaunchCliId(cfg, saved = loadLaunchState()) {
  const clis = cfg?.clis || [];
  const savedCliId = typeof saved?.cliId === 'string' ? saved.cliId : '';
  if (clis.length === 0) return savedCliId || cfg?.defaultCliId || '';
  if (savedCliId && clis.some((c) => c.id === savedCliId)) return savedCliId;
  return cfg?.defaultCliId || clis[0]?.id || '';
}

export function selectedRepoNamesForLaunch(cfg, saved = loadLaunchState()) {
  const repos = cfg?.repos || [];
  const valid = new Set(repos.map((r) => r.name));
  const out = [];
  const add = (name) => {
    if (typeof name !== 'string' || !name) return;
    if ((valid.size === 0 || valid.has(name)) && !out.includes(name)) out.push(name);
  };

  if (saved && Array.isArray(saved.repos)) {
    for (const name of saved.repos) add(name);
    const knownDefaults = Array.isArray(saved.knownDefaults)
      ? new Set(saved.knownDefaults)
      : null;
    for (const repo of repos) {
      if (repo.defaultSelected && (knownDefaults === null || !knownDefaults.has(repo.name))) {
        add(repo.name);
      }
    }
    return out;
  }

  for (const repo of repos) {
    if (repo.defaultSelected) add(repo.name);
  }
  return out;
}

export function normalizeLaunchFolderId(folderId) {
  return folderId && folderId !== 'unsorted' ? folderId : null;
}

export function buildLaunchBodyFromState(cfg, opts = {}) {
  const { folderId, state = loadLaunchState() } = opts;
  const mode = state?.mode === 'cwd' ? 'cwd' : 'auto';
  const cliId = resolveLaunchCliId(cfg, state);
  const body = {};
  if (cliId) body.cliId = cliId;
  if (Object.prototype.hasOwnProperty.call(opts, 'folderId')) {
    body.folderId = normalizeLaunchFolderId(folderId);
  } else if (state?.folderId) {
    body.folderId = normalizeLaunchFolderId(state.folderId);
  }

  if (mode === 'cwd') {
    const cwd = typeof state?.cwd === 'string' ? state.cwd.trim() : '';
    if (!cwd) {
      return { error: 'Pick a working directory on Launch first.', body, mode };
    }
    body.cwd = cwd;
    return { body, mode, repos: [], cwd };
  }

  const repos = selectedRepoNamesForLaunch(cfg, state);
  body.repos = repos;
  return { body, mode, repos, cwd: '' };
}
