'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

// Data dir lives under ~/.ccsm by default so config survives across upgrades
// (incl. running from a new npx checkout). Override with CCSM_HOME if you
// want a different location.
const DATA_DIR = process.env.CCSM_HOME || path.join(os.homedir(), '.ccsm');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const LEGACY_DATA_DIR = path.join(__dirname, '..', 'data');

// v1.0 — wt / system-terminal launch path removed. Sessions are always
// in-page web terminals managed by ccsm. CLI is pluggable: configure one
// or more entries under `clis` (claude, codex, custom wrappers), pick a
// default. Old config keys (`terminal`, `commandShell`, `claudeCommand`,
// `defaultTerminalMode`, `autoFocusOnLaunch`, `focusMovesToCenter`,
// `snapshot*`) are silently dropped on load.
const DEFAULT_CLIS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    // Pre-assign the upstream session UUID when starting a NEW session.
    // ccsm picks the UUID, passes it via these args, and stores it on
    // the record immediately — no need to poll the transcript dir later.
    newSessionIdArgs: ['--session-id', '<id>'],
    resumeIdArgs: ['--resume', '<id>'],
    shell: 'direct',
    type: 'claude',
    builtin: true,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: [],
    // codex has no "use this UUID for a new session" flag, but we work
    // around it: ccsm seeds a fake rollout file at the right path with
    // our chosen UUID (lib/codexSeed.js), then spawns `codex resume <id>`
    // so the first launch *is* a resume against our seed. From then on
    // codex appends to the same file and resume-by-id keeps working.
    newSessionIdArgs: ['resume', '<id>'],
    resumeIdArgs: ['resume', '<id>'],
    shell: 'direct',
    type: 'codex',
    builtin: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    args: [],
    newSessionIdArgs: ['--session-id', '<id>'],
    resumeIdArgs: ['--resume', '<id>'],
    shell: 'direct',
    type: 'copilot',
    builtin: true,
  },
];

const DEFAULTS = {
  port: 7777,
  workDir: path.join(os.homedir(), 'ccsm-workspaces'),
  // Repos available for cloning into a fresh workspace at launch time.
  //   { name: 'foo', url: 'https://github.com/me/foo.git', defaultSelected: true }
  repos: [],
  // Pluggable CLIs. Add custom wrappers or self-hosted
  // proxies by appending an entry. defaultCliId picks one for the
  // Launch button when the user doesn't override.
  clis: DEFAULT_CLIS,
  defaultCliId: 'claude',
  // Devtunnel state. tunnelId holds the persistent (named) tunnel
  // ccsm minted via `devtunnel create` on first Start. Reusing it
  // across host restarts keeps the public URL — and therefore the
  // remote browsers' approval records — stable. `devtunnel delete <id>`
  // is invoked when the user explicitly rotates via the Reset button.
  devtunnel: { tunnelId: null },
};

function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// If we find a legacy <repo>/data dir from before the home-dir move AND
// no ~/.ccsm yet, copy across. Idempotent — only fires when DATA_DIR is
// empty so existing users with both dirs aren't clobbered.
function migrateLegacyDataIfNeeded() {
  if (!fsSync.existsSync(LEGACY_DATA_DIR)) return;
  if (LEGACY_DATA_DIR === DATA_DIR) return;
  ensureDataDir();
  const dataEmpty = fsSync.readdirSync(DATA_DIR).length === 0;
  if (!dataEmpty) return;
  try {
    fsSync.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true });
    console.log(`[ccsm] migrated legacy data: ${LEGACY_DATA_DIR} → ${DATA_DIR}`);
  } catch (e) {
    console.error('[ccsm] legacy migration failed:', e.message);
  }
}

migrateLegacyDataIfNeeded();

// Strip dropped v0.x keys + clamp shape of survivors. Returns a fresh
// object so callers don't mutate DEFAULTS.
function mergeWithDefaults(partial) {
  const out = { ...DEFAULTS, ...partial };
  // Deep-merge devtunnel so a partial save (just .tunnelId) doesn't
  // wipe sibling keys we may add later.
  out.devtunnel = { ...DEFAULTS.devtunnel, ...(partial?.devtunnel || {}) };
  // Drop v0.x keys that the new architecture doesn't use.
  delete out.terminal;
  delete out.commandShell;
  delete out.claudeCommand;
  delete out.defaultTerminalMode;
  delete out.autoFocusOnLaunch;
  delete out.focusMovesToCenter;
  delete out.snapshotIntervalMs;
  delete out.snapshotHistoryKeep;
  delete out.autoOpenBrowser;
  delete out.browserMode;
  delete out.finderPrompt;

  if (!Array.isArray(out.repos)) out.repos = DEFAULTS.repos;
  if (!Array.isArray(out.clis)) out.clis = [];
  // Always inject builtin CLIs (claude, codex) if they're missing or were
  // deleted from a saved config — they're managed by ccsm, the user can
  // tweak args/shell but can't remove them. Preserves any user
  // customisation on existing builtin entries.
  for (const def of DEFAULT_CLIS) {
    const existing = out.clis.find((c) => c.id === def.id);
    if (existing) {
      existing.builtin = true;
      // Backfill defaults from the built-in template for any field the
      // user's saved copy is missing OR has as an empty array. Empty
      // arrays matter because users upgrading from a pre-0.15 config
      // never wrote `newSessionIdArgs` (didn't exist), AND a partial
      // 0.14→0.15 dev iteration shipped codex with `[]`. Treat both
      // the same: a builtin with no template means "use the canonical
      // one ccsm now knows about", since these fields are the
      // integration contract with the upstream CLI — not user knobs.
      const needsBackfill = (v) => v == null || (Array.isArray(v) && v.length === 0);
      if (needsBackfill(existing.resumeIdArgs)) existing.resumeIdArgs = def.resumeIdArgs;
      if (needsBackfill(existing.newSessionIdArgs)) existing.newSessionIdArgs = def.newSessionIdArgs;
      // Drop the v0.x `resumeArgs` fallback — every builtin now has a
      // pre-assigned UUID (claude/copilot via flag, codex via seed) so
      // resumeIdArgs always applies on resume; the field is dead weight.
      delete existing.resumeArgs;
      if (!existing.type) existing.type = def.type;
    } else {
      out.clis.unshift({ ...def });
    }
  }
  // Normalize per-CLI fields.
  out.clis = out.clis.map((c) => {
    const { installed, installPath, resumeArgs, ...rest } = c;  // strip computed probe fields + v0.x resumeArgs
    const normalized = {
      ...rest,
      args: Array.isArray(rest.args) ? rest.args : [],
      resumeIdArgs: Array.isArray(rest.resumeIdArgs) ? rest.resumeIdArgs : [],
      newSessionIdArgs: Array.isArray(rest.newSessionIdArgs) ? rest.newSessionIdArgs : [],
      shell: ['direct', 'pwsh', 'cmd'].includes(rest.shell) ? rest.shell : 'direct',
      type: ['claude', 'codex', 'copilot', 'other'].includes(rest.type) ? rest.type : 'other',
      builtin: !!rest.builtin,
    };
    // Type-based fallback for non-builtin CLIs (wrappers that
    // just call claude under the hood). If user picked
    // type='claude' but left newSessionIdArgs / resumeIdArgs blank,
    // assume they want the same args claude / copilot / codex use
    // canonically — without this the wrapped CLI gets spawned with
    // no UUID and ccsm can never recapture the upstream session.
    // Builtins are already handled by the loop above with `def`.
    if (!normalized.builtin && normalized.type !== 'other') {
      const template = DEFAULT_CLIS.find((d) => d.type === normalized.type);
      if (template) {
        if (normalized.newSessionIdArgs.length === 0) {
          normalized.newSessionIdArgs = [...template.newSessionIdArgs];
        }
        if (normalized.resumeIdArgs.length === 0) {
          normalized.resumeIdArgs = [...template.resumeIdArgs];
        }
      }
    }
    return normalized;
  });
  // Make sure defaultCliId points at an actual CLI; fall back to first.
  if (!out.clis.find((c) => c.id === out.defaultCliId)) {
    out.defaultCliId = out.clis[0].id;
  }
  return out;
}

async function loadConfig() {
  ensureDataDir();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return mergeWithDefaults(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') {
      const cfg = { ...DEFAULTS };
      await atomicWriteJson(CONFIG_PATH, cfg);
      return cfg;
    }
    throw e;
  }
}

async function saveConfig(partial) {
  ensureDataDir();
  return withFileLock(CONFIG_PATH, async () => {
    const current = await loadConfig();
    const next = mergeWithDefaults({ ...current, ...partial });
    await atomicWriteJson(CONFIG_PATH, next);
    return next;
  });
}

module.exports = {
  loadConfig,
  saveConfig,
  DATA_DIR,
  CONFIG_PATH,
  LEGACY_DATA_DIR,
  DEFAULTS,
  DEFAULT_CLIS,
};
