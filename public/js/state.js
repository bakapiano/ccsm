// All shared reactive state. Importing a signal anywhere subscribes the
// reading component, so we never need a store / context wrapper.

import { signal, computed } from '@preact/signals';

// ── server-driven data ──────────────────────────────────────────
export const config       = signal(null);
export const capabilities = signal({ webTerminal: false });
// `sessions` is the ccsm-persisted list (lib/persistedSessions). Every
// entry has { id, cliId, cwd, workspace, title, folderId, repos,
// createdAt, lastActiveAt, status, exitedAt, exitCode, pid }.
export const sessions     = signal([]);
export const deletedSessions = signal([]);
export const folders      = signal([]);   // [{id,name,order,createdAt}]
export const workspaces   = signal([]);
export const serverHealth = signal({ state: 'connecting' });
// Flips true the first time we successfully reach the backend in this
// frontend session. Gates UI (HealthOverlay) so it doesn't pop on the
// very first boot probe while the page is still wiring up.
export const hasBootedOnline = signal(false);
// Set true the moment the user clicks "Restart backend" — the
// RestartOverlay reads this signal and blocks the whole page until
// the next health poll returns a fresh PID. Cleared by the overlay
// itself on reconnect. Kept here (not in ConfigurePage local state)
// so a stale tab on another page can't miss the in-flight restart.
export const restartInFlight = signal(null);   // { startedAt, prevPid } | null

// ── ui state (persisted in localStorage where noted) ───────────
export const activeTab        = signal('sessions');
export const activeSessionId  = signal(null);    // the session currently rendered in the right pane
export const openSessionTabIds = signal([]);      // session tabs currently open in the Sessions pane
export const sidebarCollapsed = signal(false);
// True when viewport is narrow enough that the sidebar is force-collapsed
// by the responsive layout — the toggle button hides in that case so the
// user can't try (and fail) to expand it.
export const sidebarForcedCollapsed = signal(false);
// True on phone-sized viewports (≤ 640px). The sidebar then hides
// entirely; a FAB at bottom-left opens a full-screen drawer.
export const isMobile             = signal(false);
// Mobile drawer visibility — toggled by the FAB / nav-item taps.
export const mobileDrawerOpen     = signal(false);
export const sidebarWidth     = signal(232);     // px when expanded, persisted in localStorage
export const accentColor      = signal('#2f6fa3'); // user-chosen brand accent, persisted
export const themeMode        = signal('system');  // 'light' | 'dark' | 'system', persisted
// Per-folder collapse state in the sidebar tree. Stored as a plain object
// {folderId: true} (true = collapsed). Key 'unsorted' covers the implicit
// Unsorted bucket.
export const foldersCollapsed = signal({});
export const configDirty      = signal(false);
// Per-card fold state on pages that use the <Card> component. The card
// just toggles a key here; persistence is best-effort via localStorage
// under `ccsm.fold.<key>` (set by toggleCardFold).
export const cardFolded       = signal({});
export const clockTick        = signal(Date.now());      // re-ticked each second so fmtAgo refreshes
export const lastRefreshAt    = signal(0);               // ms timestamp of last successful refreshAll()
export const installPrompt    = signal(null);            // captured beforeinstallprompt event (PWA install)
export const isInstalledPwa   = signal(false);           // running inside an installed PWA window

// ── derived ─────────────────────────────────────────────────────
// Group sessions by folder, with a synthetic "unsorted" bucket for those
// without a folderId. Folders define the rendering order; sessions
// inside each are sorted by createdAt desc (stable — using lastActiveAt
// would make rows jump on resume).
//
// We pre-create a bucket per declared session.folderId even if the
// matching folder hasn't loaded yet — that way on first paint sessions
// don't all collapse into Unsorted and then snap back into their real
// folder a few ms later when /api/folders resolves.
// "Unsorted" is keyed as 'unsorted' (not null) so it can be looked up
// alongside real folders by Sidebar/keybindings iterating folders.value
// — backend exposes a synthetic folder with id='unsorted' that's always
// present, drag-reorderable like real folders.
export const UNSORTED_KEY = 'unsorted';
export const sessionsByFolder = computed(() => {
  const groups = new Map();
  groups.set(UNSORTED_KEY, []);
  for (const f of folders.value) groups.set(f.id, []);
  for (const s of sessions.value) {
    const key = s.folderId || UNSORTED_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const list of groups.values()) {
    // Stable sort: explicit `order` field first (set by user drag), then
    // createdAt desc as fallback. Sessions without `order` fall to the
    // top (newer-first) which is the legacy behavior.
    list.sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : null;
      const ob = typeof b.order === 'number' ? b.order : null;
      if (oa !== null && ob !== null) return oa - ob;
      if (oa !== null) return -1;
      if (ob !== null) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }
  return groups;
});

export const TAB_HEADINGS = {
  sessions:  { title: 'Sessions',  subtitle: 'Sessions you started in ccsm.' },
  launch:    { title: 'Launch',    subtitle: 'Spin up a new session in a fresh workspace.' },
  configure: { title: 'Configure', subtitle: 'Persisted to ~/.ccsm/config.json.' },
  remote:    { title: 'Remote',    subtitle: 'Expose this backend to another device via tunnel + token.' },
  about:     { title: 'About',     subtitle: 'ccsm — Claude CLI Sessions Manager.' },
};

// ── persistence helpers (localStorage) ──────────────────────────
const LS_SIDEBAR = 'ccsm.sidebar-collapsed';
const LS_SIDEBAR_W = 'ccsm.sidebar-width';
const LS_ACCENT = 'ccsm.accent';
const LS_THEME = 'ccsm.theme';
const LS_FOLDERS_COLLAPSED = 'ccsm.folders-collapsed';
const LS_ACTIVE_SESSION = 'ccsm.active-session-id';
const LS_OPEN_SESSION_TABS = 'ccsm.open-session-tabs';
// Last-known sidebar tree, rehydrated on boot to keep the first paint
// stable. The next refreshAll() overwrites these from the server, so
// stale entries self-heal within ~5s without any explicit invalidation.
const LS_FOLDERS_CACHE = 'ccsm.folders-cache';
const LS_SESSIONS_CACHE = 'ccsm.sessions-cache';
const LS_DELETED_SESSIONS_CACHE = 'ccsm.deleted-sessions-cache';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 232;
export const ACCENT_DEFAULT = '#2f6fa3';

function uniqueStringList(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== 'string' || !item) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function persistActiveSession(id) {
  try {
    if (id) localStorage.setItem(LS_ACTIVE_SESSION, id);
    else localStorage.removeItem(LS_ACTIVE_SESSION);
  } catch {}
}

function persistOpenSessionTabs(ids) {
  try { localStorage.setItem(LS_OPEN_SESSION_TABS, JSON.stringify(ids)); } catch {}
}

export function loadPersisted() {
  sidebarCollapsed.value = localStorage.getItem(LS_SIDEBAR) === 'true';
  const w = Number(localStorage.getItem(LS_SIDEBAR_W));
  if (Number.isFinite(w) && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
    sidebarWidth.value = w;
  }
  applySidebarWidthCssVar();
  const a = localStorage.getItem(LS_ACCENT);
  if (isHexColor(a)) accentColor.value = a;
  const t = localStorage.getItem(LS_THEME);
  if (t === 'light' || t === 'dark' || t === 'system') themeMode.value = t;
  applyTheme();
  try {
    const raw = localStorage.getItem(LS_FOLDERS_COLLAPSED);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') foldersCollapsed.value = parsed;
    }
  } catch {}
  // Rehydrate the sidebar tree from the last seen server state so
  // the first paint matches the user's last view. refreshAll() arrives
  // ~50–500ms later and overwrites with fresh data.
  try {
    const raw = localStorage.getItem(LS_FOLDERS_CACHE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) folders.value = parsed;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_SESSIONS_CACHE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) sessions.value = parsed;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_DELETED_SESSIONS_CACHE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) deletedSessions.value = parsed;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_OPEN_SESSION_TABS);
    if (raw) {
      const parsed = JSON.parse(raw);
      openSessionTabIds.value = uniqueStringList(parsed);
    }
  } catch {}
  try {
    const remembered = localStorage.getItem(LS_ACTIVE_SESSION);
    if (remembered) activeSessionId.value = remembered;
    else if (openSessionTabIds.value.length) activeSessionId.value = openSessionTabIds.value[0];
  } catch {}
  const hash = location.hash.slice(1);
  if (TAB_HEADINGS[hash]) activeTab.value = hash;
}

function applySidebarWidthCssVar() {
  document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth.value}px`);
}

export function setSidebarWidth(px) {
  const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
  sidebarWidth.value = clamped;
  applySidebarWidthCssVar();
  localStorage.setItem(LS_SIDEBAR_W, String(clamped));
}

// ── theme (accent + light/dark) ─────────────────────────────────
function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
// Linear blend c1→c2 by t∈[0,1]. t=0 yields c1, t=1 yields c2.
function lerp(c1, c2, t) {
  return { r: c1.r + (c2.r - c1.r) * t, g: c1.g + (c2.g - c1.g) * t, b: c1.b + (c2.b - c1.b) * t };
}

// Anchor colors the palette is derived from. Light mode mixes the accent
// toward WHITE for surfaces and keeps warm-dark ink; dark mode mixes the
// accent toward DARK for surfaces and uses warm-light ink — same accent,
// inverted ground. Keep these in sync with the pre-paint script in
// public/index.html (it re-derives the same values to avoid a FOUC).
const WHITE = { r: 255, g: 255, b: 255 };
const DARK_BASE = { r: 0x18, g: 0x16, b: 0x12 };   // #181612 warm near-black
const LIGHT_INK = { r: 0xec, g: 0xe7, b: 0xda };   // #ece7da warm light text

// True when the effective theme is dark. 'system' consults the OS.
function resolveDark(mode) {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyAccentCssVars() {
  const base = accentColor.value;
  const A = hexToRgb(base);
  const dark = resolveDark(themeMode.value);
  const root = document.documentElement.style;
  let vars;
  if (dark) {
    const bg = lerp(DARK_BASE, A, 0.06);          // dark ground, faint accent tint
    const lift = (t) => rgbToHex(lerp(bg, LIGHT_INK, t)); // raise toward light
    vars = {
      '--accent': base,
      '--accent-deep': rgbToHex(lerp(A, LIGHT_INK, 0.18)), // brighter on dark
      '--accent-soft': `rgba(${A.r}, ${A.g}, ${A.b}, 0.18)`,
      '--accent-softer': `rgba(${A.r}, ${A.g}, ${A.b}, 0.07)`,
      '--bg': rgbToHex(bg),
      '--bg-elev': lift(0.05),
      '--sidebar-bg': rgbToHex(bg),
      '--sidebar-hover': lift(0.09),
      '--sidebar-active': lift(0.15),
      '--border': lift(0.14),
      '--border-soft': lift(0.09),
      '--border-strong': lift(0.24),
      '--ui-bg': lift(0.05),
      '--ui-border': lift(0.16),
      '--ui-border-soft': lift(0.10),
      '--ink': rgbToHex(LIGHT_INK),
      '--ink-mid': rgbToHex(lerp(LIGHT_INK, DARK_BASE, 0.28)),
      '--ink-muted': rgbToHex(lerp(LIGHT_INK, DARK_BASE, 0.45)),
      '--ink-faint': rgbToHex(lerp(LIGHT_INK, DARK_BASE, 0.60)),
    };
  } else {
    const mix = (t) => rgbToHex(lerp(WHITE, A, t));  // light ground, accent tint
    vars = {
      '--accent': base,
      '--accent-deep': rgbToHex(lerp(A, { r: 0, g: 0, b: 0 }, 0.2)),
      '--accent-soft': `rgba(${A.r}, ${A.g}, ${A.b}, 0.10)`,
      '--accent-softer': `rgba(${A.r}, ${A.g}, ${A.b}, 0.04)`,
      '--bg': mix(0.04),
      '--bg-elev': '#ffffff',
      '--sidebar-bg': mix(0.04),
      '--sidebar-hover': mix(0.10),
      '--sidebar-active': mix(0.15),
      '--border': mix(0.15),
      '--border-soft': mix(0.12),
      '--border-strong': mix(0.25),
      '--ui-bg': mix(0.10),
      '--ui-border': '#d8d4c6',       // theme-independent neutral
      '--ui-border-soft': '#e6e2d4',  // theme-independent neutral
      '--ink': '#1a1815',
      '--ink-mid': '#534e44',
      '--ink-muted': '#8a8475',
      '--ink-faint': '#b5af9d',
    };
  }
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--bg']);
}

// Set data-theme on <html> (drives the [data-theme="dark"] CSS overrides)
// and re-derive the accent-tinted palette for the resolved theme.
function applyTheme() {
  const dark = resolveDark(themeMode.value);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  applyAccentCssVars();
}

// React to OS theme changes while in 'system' mode.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode.value === 'system') applyTheme();
  });
}

// Resolved theme for non-CSS consumers (e.g. the xterm canvas, which is
// painted from a JS color object, not CSS vars).
export function isDarkTheme() {
  return resolveDark(themeMode.value);
}

export function setThemeMode(mode) {
  if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
  themeMode.value = mode;
  applyTheme();
  localStorage.setItem(LS_THEME, mode);
}

export function setAccentColor(hex) {
  if (!isHexColor(hex)) return;
  accentColor.value = hex;
  applyAccentCssVars();
  localStorage.setItem(LS_ACCENT, hex);
}

// ── actions ─────────────────────────────────────────────────────
export function selectTab(name) {
  if (!TAB_HEADINGS[name]) name = 'sessions';
  activeTab.value = name;
  if (location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
  // Tapping a nav item on mobile is also a "close the drawer" gesture
  // — the user got what they came for, no need to keep the overlay up.
  if (mobileDrawerOpen.value) mobileDrawerOpen.value = false;
}

export function setOpenSessionTabs(ids) {
  const next = uniqueStringList(ids);
  openSessionTabIds.value = next;
  persistOpenSessionTabs(next);
}

export function ensureOpenSessionTab(id) {
  if (typeof id !== 'string' || !id) return;
  const current = openSessionTabIds.value;
  if (current.includes(id)) return;
  setOpenSessionTabs([...current, id]);
}

export function closeOpenSessionTab(id) {
  if (typeof id !== 'string' || !id) return;
  const current = openSessionTabIds.value;
  if (!current.includes(id)) return;
  setOpenSessionTabs(current.filter((sid) => sid !== id));
}

export function clearActiveSession() {
  activeSessionId.value = null;
  persistActiveSession(null);
}

export function selectSession(id) {
  ensureOpenSessionTab(id);
  activeSessionId.value = id;
  persistActiveSession(id);
  activeTab.value = 'sessions';
  if (location.hash !== '#sessions') window.history.replaceState(null, '', '#sessions');
  if (mobileDrawerOpen.value) mobileDrawerOpen.value = false;
}

export function toggleSidebar() {
  if (sidebarForcedCollapsed.value) return;
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(LS_SIDEBAR, String(sidebarCollapsed.value));
}

export function toggleFolder(folderId) {
  const key = folderId || 'unsorted';
  const next = { ...foldersCollapsed.value, [key]: !foldersCollapsed.value[key] };
  foldersCollapsed.value = next;
  localStorage.setItem(LS_FOLDERS_COLLAPSED, JSON.stringify(next));
}

export function toggleCardFold(key) {
  const next = { ...cardFolded.value, [key]: !cardFolded.value[key] };
  cardFolded.value = next;
  try { localStorage.setItem(`ccsm.fold.${key}`, next[key] ? '1' : '0'); } catch {}
}
