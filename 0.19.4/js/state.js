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
const LS_FOLDERS_COLLAPSED = 'ccsm.folders-collapsed';
// Last-known sidebar tree, rehydrated on boot to keep the first paint
// stable. The next refreshAll() overwrites these from the server, so
// stale entries self-heal within ~5s without any explicit invalidation.
const LS_FOLDERS_CACHE = 'ccsm.folders-cache';
const LS_SESSIONS_CACHE = 'ccsm.sessions-cache';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 232;
export const ACCENT_DEFAULT = '#2f6fa3';

export function loadPersisted() {
  sidebarCollapsed.value = localStorage.getItem(LS_SIDEBAR) === 'true';
  const w = Number(localStorage.getItem(LS_SIDEBAR_W));
  if (Number.isFinite(w) && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
    sidebarWidth.value = w;
  }
  applySidebarWidthCssVar();
  const a = localStorage.getItem(LS_ACCENT);
  if (isHexColor(a)) accentColor.value = a;
  applyAccentCssVars();
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

// ── theme accent ────────────────────────────────────────────────
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
function darken({ r, g, b }, amount) {
  return { r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) };
}
function mixWithWhite({ r, g, b }, t) {
  return { r: r * t + 255 * (1 - t), g: g * t + 255 * (1 - t), b: b * t + 255 * (1 - t) };
}
function applyAccentCssVars() {
  const base = accentColor.value;
  const rgb = hexToRgb(base);
  const deep = rgbToHex(darken(rgb, 0.2));
  const soft = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`;
  const softer = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.04)`;
  const bg           = rgbToHex(mixWithWhite(rgb, 0.04));
  const sidebarHover = rgbToHex(mixWithWhite(rgb, 0.10));
  const sidebarActive= rgbToHex(mixWithWhite(rgb, 0.15));
  const border       = rgbToHex(mixWithWhite(rgb, 0.15));
  const borderSoft   = rgbToHex(mixWithWhite(rgb, 0.12));
  const borderStrong = rgbToHex(mixWithWhite(rgb, 0.25));
  // UI chrome (sidebar bg, dividers, footer strip) — themed too but
  // visibly darker than the main bg so sidebar/main read as distinct.
  // Border colors stay deliberately desaturated so dividers don't shout
  // the brand color back at the user.
  const uiBg         = rgbToHex(mixWithWhite(rgb, 0.10));
  const uiBorder     = '#d8d4c6';     // theme-independent neutral
  const uiBorderSoft = '#e6e2d4';     // theme-independent neutral
  const root = document.documentElement.style;
  root.setProperty('--accent', base);
  root.setProperty('--accent-deep', deep);
  root.setProperty('--accent-soft', soft);
  root.setProperty('--accent-softer', softer);
  root.setProperty('--bg', bg);
  root.setProperty('--sidebar-bg', bg);
  root.setProperty('--sidebar-hover', sidebarHover);
  root.setProperty('--sidebar-active', sidebarActive);
  root.setProperty('--border', border);
  root.setProperty('--border-soft', borderSoft);
  root.setProperty('--border-strong', borderStrong);
  root.setProperty('--ui-bg', uiBg);
  root.setProperty('--ui-border', uiBorder);
  root.setProperty('--ui-border-soft', uiBorderSoft);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
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

export function selectSession(id) {
  activeSessionId.value = id;
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
