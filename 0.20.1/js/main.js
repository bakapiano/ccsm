// Entry. Loads persisted ui state → boots data → mounts App → spins up
// the 5s auto-refresh + 1s clock tick. No imperative DOM access outside
// the mount root.

import { render } from 'preact';
import { effect } from '@preact/signals';
import { html } from './html.js';
import { loadPersisted, clockTick, lastRefreshAt, installPrompt, isInstalledPwa, sidebarForcedCollapsed, isMobile, mobileDrawerOpen, activeTab, activeSessionId, sessions, TAB_HEADINGS } from './state.js';
import { httpBase, setToken, getDeviceId, isRemoteAccess } from './backend.js';
import { api, loadConfig, refreshAll, loadSessions, loadFolders, loadWorkspaces, pollHealth, pendingDevice } from './api.js';
import { setToast } from './toast.js';
import { App } from './components/App.js';
import { installGlobalKeybindings } from './keybindings.js';

// First thing we do on boot: if the URL carries `?token=…` it's a fresh
// share link from the Remote page on the host machine. Stash it in
// localStorage so api.js / TerminalView pick it up, then strip the query
// string from the URL via history.replaceState — keeps the secret out
// of the address bar / browser history / clipboard sharing later.
// Also ensure a device id exists in localStorage right away — getDeviceId
// is a side-effecting getter (creates + persists on first call). Calling
// it here means api.js sees a stable id from the very first fetch.
(() => {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      setToken(t);
      u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search ? `?${u.searchParams.toString()}` : '') + u.hash);
    }
    getDeviceId();
  } catch {}
})();

loadPersisted();
installGlobalKeybindings();
// Window/tab title — reactive. In standalone PWA mode we hide our own
// .page-title-bar and the browser-drawn OS title bar takes its place,
// so document.title is what the user actually sees as the header. It
// mirrors what would have been in our hidden header: session title +
// cwd on the Sessions tab, the page heading elsewhere.
// MutationObserver guards against Chromium standalone builds that
// occasionally try to inject the URL into the title bar.
let desiredTitle = 'CCSM';
function lockTitle() { if (document.title !== desiredTitle) document.title = desiredTitle; }
function computeTitle() {
  const tab = activeTab.value;
  if (tab === 'sessions') {
    const id = activeSessionId.value;
    const s  = id ? sessions.value.find((x) => x.id === id) : null;
    if (s) {
      const name = s.title || s.workspace || s.id.slice(0, 12);
      return `${name} · ${s.cwd} · CCSM`;
    }
    return 'Sessions · CCSM';
  }
  return `${TAB_HEADINGS[tab]?.title || 'CCSM'} · CCSM`;
}
effect(() => { desiredTitle = computeTitle(); lockTitle(); });
new MutationObserver(lockTitle).observe(
  document.querySelector('title') || document.head,
  { childList: true, subtree: true, characterData: true }
);
render(html`<${App} />`, document.getElementById('app'));

// PWA install affordance — Chromium fires `beforeinstallprompt` when the
// manifest meets install criteria (served over localhost / https, has icon,
// not already installed). We stash the event so the About page can offer
// a one-click install button that triggers it.
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt.value = ev;
});
window.addEventListener('appinstalled', () => {
  installPrompt.value = null;
  isInstalledPwa.value = true;
});
// On boot, detect if we're already running as an installed PWA window
// (display-mode standalone covers both plain PWA + WCO). When true, the
// "install" affordance hides itself.
const mq = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)');
isInstalledPwa.value = mq.matches;
mq.addEventListener('change', () => { isInstalledPwa.value = mq.matches; });

// "is-app" body class · everything that isn't a regular browser tab
// (display-mode: browser) gets it. Used by wco.css to gate user-select
// on drag regions so chromeless --app= windows can be dragged by
// clicking the page title, while normal tabs still allow text select.
//
// "is-wco" is the stricter case: window-controls-overlay mode where the
// browser hides its title bar entirely and only floats OS controls in
// the top-right. In that mode our .page-title-bar IS the title bar and
// needs the 34px height + padding-right reservation. In plain standalone
// PWA (browser still paints its own title bar above our content), we
// don't need any of that — page-title-bar can behave like a regular tab.
function applyIsAppClass() {
  const isApp = !matchMedia('(display-mode: browser)').matches;
  const isWco = matchMedia('(display-mode: window-controls-overlay)').matches;
  document.body.classList.toggle('is-app', isApp);
  document.body.classList.toggle('is-wco', isWco);
}
applyIsAppClass();
matchMedia('(display-mode: browser)').addEventListener('change', applyIsAppClass);
matchMedia('(display-mode: window-controls-overlay)').addEventListener('change', applyIsAppClass);
matchMedia('(display-mode: standalone)').addEventListener('change', applyIsAppClass);

// The old 640–900px "force-collapse" mode is gone — narrow desktops
// keep the full sidebar, phone viewports get the FAB drawer below.
// `sidebarForcedCollapsed` is left at its default `false` so any
// remaining readers (Sidebar resize handle gate, etc.) behave like
// desktop. Removing the signal entirely would mean touching every
// consumer; leaving it inert is a smaller blast radius.

// Phone-sized viewports get a different nav model: sidebar hidden,
// floating bottom-left button opens a full-screen drawer.
const mobileMq = matchMedia('(max-width: 640px)');
function applyMobile() {
  isMobile.value = mobileMq.matches;
  // Always close the drawer on a breakpoint flip so the user doesn't
  // resize from desktop into mobile with a phantom open drawer.
  if (mobileDrawerOpen.value) mobileDrawerOpen.value = false;
}
applyMobile();
mobileMq.addEventListener('change', applyMobile);

// Counter-zoom for the page-title-bar. Browser page zoom (Ctrl+wheel) scales every CSS px including our header heights;
// without this, the header gets visually taller at 150%+ which the user
// usually doesn't want. We detect zoom via outerWidth/innerWidth and write
// 1/zoom into --anti-zoom so the CSS can `calc(40px * var(--anti-zoom))`
// each bar back to a constant on-screen height.
function syncAntiZoom() {
  const z = window.outerWidth / window.innerWidth || 1;
  const inv = Math.max(0.4, Math.min(1, 1 / z));   // clamp: never grow > 100%
  document.documentElement.style.setProperty('--anti-zoom', String(inv));
}
syncAntiZoom();
window.addEventListener('resize', syncAntiZoom);

// WCO title-bar height — read the actual OS strip height via
// navigator.windowControlsOverlay.getTitlebarAreaRect() and publish it
// as --titlebar-h. CSS env(titlebar-area-height) is the analogous value
// but Chromium occasionally lies (under-reports by a couple px on Edge),
// and we don't get a JS handle to drive other measurements from. The
// JS API is the source of truth here; the rect's height is exactly the
// strip the OS leaves us. Fires on geometrychange so window-move-across-
// monitors / DPI-flip / restore-from-maximize re-sync.
function syncTitlebarHeight() {
  try {
    const r = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    if (r && r.height > 0) {
      document.documentElement.style.setProperty('--titlebar-h', `${r.height}px`);
    }
  } catch { /* unsupported · CSS falls back to env() then 32px */ }
}
syncTitlebarHeight();
navigator.windowControlsOverlay?.addEventListener?.('geometrychange', syncTitlebarHeight);

(async () => {
  // Version-mismatch guard runs FIRST. If the user's backend has been
  // upgraded since this per-version frontend was loaded, bounce back to
  // the router immediately — no point loading config from a server that
  // speaks a different API revision. Runs in dev too (it no-ops without
  // the build-time <meta>).
  await bootVersionGuard();

  // On a remote browser we MUST register at /api/devices/me before any
  // other /api/* call — the device gate 401s with "unknown device"
  // otherwise. The /me handler accepts the token from the share URL,
  // creates a pending record, and (post-approval) keeps returning the
  // existing record without a token. Setting pendingDevice from the
  // response wakes PendingApprovalOverlay; on approval the signal
  // clears in there.
  if (isRemoteAccess()) {
    try {
      const me = await api('GET', '/api/devices/me');
      if (me && me.status !== 'approved') {
        pendingDevice.value = {
          pending: me.status === 'pending',
          rejected: me.status === 'rejected',
          deviceId: me.id,
          firstSeen: me.firstSeen,
          at: Date.now(),
        };
      }
    } catch (e) { /* token bad / network blip — surfaces via other calls */ }
  }

  try {
    await loadConfig();
    await refreshAll();
    pollHealth();
  } catch (e) {
    setToast('initial load failed · ' + e.message, 'error');
  }

  // 5s data refresh + clock tick (same cadence so fmtAgo "Ns ago" relative
  // labels naturally track the data refresh; bumping clockTick more
  // frequently would just cause needless re-renders since fmtAgo's
  // resolution is coarse — 5s buckets under a minute, then m/h/d).
  // loadWorkspaces is included because the workspace "in use" flag is
  // derived from live session cwds server-side — without it, sessions
  // move in/out of a workspace silently and the grid stays stale.
  // Skipped while a remote tab is sitting in the pending-approval
  // overlay — every call would 403, fill the console with red, and the
  // user can't see anything anyway. PendingApprovalOverlay handles its
  // own re-hydrate the moment we get approved.
  setInterval(async () => {
    if (pendingDevice.value) {
      // Skip the data fetches (every one would 403) but still poll
      // health so the OfflineBanner can show if the host goes down
      // while we're sitting on the approval screen.
      pollHealth();
      clockTick.value = Date.now();
      return;
    }
    try {
      await Promise.all([loadSessions(), loadFolders(), loadWorkspaces()]);
      lastRefreshAt.value = Date.now();
    } catch { /* swallow — next tick retries */ }
    pollHealth();
    clockTick.value = Date.now();
  }, 5000);

  // Heartbeat · the server uses this to (a) decide whether to shut down
  // when its own spawned browser closes (multi-client check), and (b) as
  // a 90s watchdog backup if the browser-exit signal is missed entirely.
  // 10s cadence is short enough that any tab open for one full cycle gets
  // caught by the post-close decision in server.js; long enough not to be
  // chatty.
  const ping = () => {
    // While we're stuck on the pending-approval overlay, /api/heartbeat
    // would 403 every 10s. Pointless noise — the host's watchdog is
    // gated on real user activity anyway. Resumes automatically once
    // pendingDevice clears.
    if (pendingDevice.value) return Promise.resolve();
    const headers = {};
    // Heartbeat doesn't go through api.js' wrapper but still needs the
    // bearer token + device id when called via tunnel (the middleware
    // blocks it otherwise and the server thinks the session went idle).
    const t = (typeof localStorage !== 'undefined') ? localStorage.getItem('ccsm.token') : null;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const d = getDeviceId();
    if (d) headers['X-Device-Id'] = d;
    return fetch(httpBase() + '/api/heartbeat', { method: 'POST', headers, keepalive: true }).catch(() => {});
  };
  ping();
  setInterval(ping, 10_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
})();

// ─── version routing guard ───────────────────────────────────────────
// Each deployed frontend is pinned to one backend version. The GH-Pages
// workflow bakes the version into <meta name="ccsm-frontend-version">
// so we can detect "backend has been upgraded since this frontend was
// loaded" and bounce back through the router at /ccsm/ for a fresh
// match. In dev (no meta tag, same-origin served-by-backend), the check
// no-ops — we're always running the frontend that ships with this
// backend by definition.
async function bootVersionGuard() {
  const meta = document.querySelector('meta[name="ccsm-frontend-version"]');
  if (!meta) return;                          // dev mode
  const myVer = meta.getAttribute('content');
  if (!myVer) return;
  let backendVer = null;
  try {
    const r = await fetch(httpBase() + '/api/health', { cache: 'no-store' });
    if (!r.ok) return;
    backendVer = (await r.json()).version;
  } catch { return; }                          // offline → OfflineBanner takes over
  if (!backendVer || backendVer === myVer) return;
  // Mismatch. Bounce up one level to the router. The router will
  // probe /api/health again and redirect to ./<backendVer>/.
  console.warn(`[ccsm] frontend ${myVer} ≠ backend ${backendVer} — re-routing`);
  location.replace('../');
}
