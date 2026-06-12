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
    resumeLatestArgs: ['--continue'],
    resumePickerArgs: ['--resume'],
    shell: 'direct',
    type: 'claude',
    builtin: true,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: [],
    resumeLatestArgs: ['resume', '--last'],
    resumePickerArgs: ['resume'],
    shell: 'direct',
    type: 'codex',
    builtin: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    args: [],
    resumeLatestArgs: ['--continue'],
    resumePickerArgs: ['--resume'],
    shell: 'direct',
    type: 'copilot',
    builtin: true,
  },
];

const DEFAULTS = {
  port: 7777,
  workDir: path.join(os.homedir(), 'ccsm-workspaces'),
  // How a stopped session is reattached for its cwd: latest asks the CLI
  // for the most recent session in that folder; picker opens the CLI's
  // interactive resume picker for that folder.
  resumeMode: 'latest',
  // Repos available for cloning into a fresh workspace at launch time.
  //   { name: 'foo', url: 'https://github.com/me/foo.git', defaultSelected: true }
  repos: [],
  // Pluggable CLIs. Add custom wrappers or self-hosted
  // proxies by appending an entry. defaultCliId picks one for the
  // Launch button when the user doesn't override.
  clis: DEFAULT_CLIS,
  defaultCliId: 'claude',
  // External editor command for the "Open in editor" session action.
  // Spawned as `<editor> "<cwd>"`; default `code` = VS Code (whose Source
  // Control panel doubles as the review-changes view once the folder's
  // open). Point it at `cursor`, `code-insiders`, `subl`, … as desired.
  editor: 'code',
  // Devtunnel state. tunnelId holds the persistent (named) tunnel
  // ccsm minted via `devtunnel create` on first Start. Reusing it
  // across host restarts keeps the public URL — and therefore the
  // remote browsers' approval records — stable. `devtunnel delete <id>`
  // is invoked when the user explicitly rotates via the Reset button.
  devtunnel: { tunnelId: null },
  // Provider-agnostic tunnel prefs. When autoStart is on, the backend
  // brings the tunnel up during its own startup (server.js boot hook) —
  // NOT an OS-level autostart. token is persisted so share URLs survive
  // a backend restart; it's written ONLY while autoStart is on and is
  // stripped from /api/config so remote devices can't read it. provider
  // is 'devtunnel' | 'cloudflared'.
  tunnel: { autoStart: false, provider: null, token: null },
};

function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function isArgArray(v) {
  return Array.isArray(v);
}

function cloneArgs(v) {
  return Array.isArray(v) ? [...v] : [];
}

function needsBackfill(v) {
  return !Array.isArray(v) || v.length === 0;
}

function migratePickerArgsFromLegacyResumeIdArgs(args) {
  if (!Array.isArray(args)) return [];
  const clean = args.map((a) => String(a));
  if (clean.length === 2 && clean[1].includes('<id>')) {
    if (clean[0] === '--resume' || clean[0] === 'resume') return [clean[0]];
  }
  return [];
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
  // Deep-merge devtunnel + tunnel so a partial save (just .tunnelId, or
  // just .autoStart) doesn't wipe sibling keys.
  out.devtunnel = { ...DEFAULTS.devtunnel, ...(partial?.devtunnel || {}) };
  out.tunnel = { ...DEFAULTS.tunnel, ...(partial?.tunnel || {}) };
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
  delete out.reserveWorkspacesForStoppedSessions;

  if (!Array.isArray(out.repos)) out.repos = DEFAULTS.repos;
  if (!Array.isArray(out.clis)) out.clis = [];
  if (typeof out.editor !== 'string') out.editor = DEFAULTS.editor;
  out.resumeMode = out.resumeMode === 'picker' ? 'picker' : 'latest';
  // Always inject builtin CLIs (claude, codex, copilot) if they're missing or were
  // deleted from a saved config — they're managed by ccsm, the user can
  // tweak args/shell but can't remove them. Preserves any user
  // customisation on existing builtin entries.
  for (const def of DEFAULT_CLIS) {
    const existing = out.clis.find((c) => c.id === def.id);
    if (existing) {
      existing.builtin = true;
      // Backfill the canonical folder-level resume templates for built-ins.
      // These are integration args, not regular user runtime args.
      if (needsBackfill(existing.resumeLatestArgs)) existing.resumeLatestArgs = cloneArgs(def.resumeLatestArgs);
      if (needsBackfill(existing.resumePickerArgs)) existing.resumePickerArgs = cloneArgs(def.resumePickerArgs);
      delete existing.newSessionIdArgs;
      delete existing.resumeIdArgs;
      delete existing.resumeArgs;
      if (!existing.type) existing.type = def.type;
    } else {
      out.clis.unshift({ ...def });
    }
  }
  // Normalize per-CLI fields.
  out.clis = out.clis.map((c) => {
    const {
      installed,
      installPath,
      resumeArgs,
      resumeIdArgs,
      newSessionIdArgs,
      ...rest
    } = c;  // strip computed probe fields + legacy session-id resume fields
    const normalized = {
      ...rest,
      args: isArgArray(rest.args) ? rest.args : [],
      resumeLatestArgs: isArgArray(rest.resumeLatestArgs)
        ? rest.resumeLatestArgs
        : (isArgArray(resumeArgs) ? resumeArgs : []),
      resumePickerArgs: isArgArray(rest.resumePickerArgs)
        ? rest.resumePickerArgs
        : migratePickerArgsFromLegacyResumeIdArgs(resumeIdArgs),
      shell: ['direct', 'pwsh', 'cmd'].includes(rest.shell) ? rest.shell : 'direct',
      type: ['claude', 'codex', 'copilot', 'other'].includes(rest.type) ? rest.type : 'other',
      builtin: !!rest.builtin,
    };
    // Type-based fallback for non-builtin CLIs (wrappers that just call
    // a known CLI under the hood). If the resume templates are blank, use
    // the same folder-level resume commands as the matching built-in.
    if (!normalized.builtin && normalized.type !== 'other') {
      const template = DEFAULT_CLIS.find((d) => d.type === normalized.type);
      if (template) {
        if (normalized.resumeLatestArgs.length === 0) {
          normalized.resumeLatestArgs = cloneArgs(template.resumeLatestArgs);
        }
        if (normalized.resumePickerArgs.length === 0) {
          normalized.resumePickerArgs = cloneArgs(template.resumePickerArgs);
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
    // mergeWithDefaults re-merges nested objects (devtunnel, tunnel)
    // against DEFAULTS only, so a partial save like
    // saveConfig({ tunnel: { autoStart: true } }) would reset the
    // sibling token/provider back to defaults. Pre-merge the nested
    // blocks against `current` so a partial update preserves siblings.
    const merged = { ...current, ...partial };
    if (partial && partial.devtunnel) {
      merged.devtunnel = { ...current.devtunnel, ...partial.devtunnel };
    }
    if (partial && partial.tunnel) {
      merged.tunnel = { ...current.tunnel, ...partial.tunnel };
    }
    const next = mergeWithDefaults(merged);
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
