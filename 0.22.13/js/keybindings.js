// Global keyboard shortcuts.
//
// Stored in localStorage under `ccsm.keybindings` as `{ action: combo }`.
// Combos are strings like "Ctrl+Alt+ArrowDown" — order doesn't matter
// at parse time but we normalize when emitting so the UI shows a stable
// representation.
//
// The terminal grabs most keys for itself; we use Ctrl+Alt as the
// default modifier set because xterm.js / claude / pwsh basically
// never bind those combos.

import { signal } from '@preact/signals';
import { activeSessionId, sessions, folders, sessionsByFolder, selectSession, UNSORTED_KEY } from './state.js';
import { reorderSessions } from './api.js';
import { setToast } from './toast.js';

export const ACTIONS = {
  'session-next':      { label: 'Next session',          defaultCombo: 'Ctrl+Alt+ArrowDown' },
  'session-prev':      { label: 'Previous session',      defaultCombo: 'Ctrl+Alt+ArrowUp' },
  'session-move-down': { label: 'Move session down',     defaultCombo: 'Ctrl+Alt+Shift+ArrowDown' },
  'session-move-up':   { label: 'Move session up',       defaultCombo: 'Ctrl+Alt+Shift+ArrowUp' },
};

const LS_KEY = 'ccsm.keybindings';

function defaults() {
  const out = {};
  for (const [id, def] of Object.entries(ACTIONS)) out[id] = def.defaultCombo;
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);
    return { ...defaults(), ...saved };
  } catch { return defaults(); }
}

export const keybindings = signal(load());

export function setBinding(actionId, combo) {
  if (!ACTIONS[actionId]) return;
  const next = { ...keybindings.value, [actionId]: combo };
  keybindings.value = next;
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
}

export function resetBinding(actionId) {
  const def = ACTIONS[actionId]?.defaultCombo;
  if (!def) return;
  setBinding(actionId, def);
}

// Normalize a keydown event into a canonical combo string. Order:
// Ctrl, Alt, Shift, Meta — then the key. Letter keys are uppercased.
// Arrow keys retain "ArrowUp" / "ArrowDown" form.
export function comboFromEvent(ev) {
  if (!ev) return '';
  const parts = [];
  if (ev.ctrlKey) parts.push('Ctrl');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  if (ev.metaKey) parts.push('Meta');
  // Skip pure-modifier keydowns — those happen when the user presses
  // just Ctrl/Alt/Shift/Meta on its own and we'd record a useless
  // "Ctrl" combo. The recorder UI uses this; the matcher doesn't.
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) return '';
  let key = ev.key;
  if (/^[a-z]$/.test(key)) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

// Build a flat list of sessions in the order they appear in the
// sidebar — folder order first, then sessions within each folder,
// then the unsorted bucket. Mirrors Sidebar's render order so
// Next/Prev moves "down then up" visually.
function flatSidebarOrder() {
  const grouped = sessionsByFolder.value;
  const out = [];
  // folders.value now includes the synthetic Unsorted entry inline at
  // its own user-set order — no need to special-case the bucket here.
  for (const f of folders.value) {
    const list = grouped.get(f.id) || [];
    for (const s of list) out.push(s.id);
  }
  return out;
}

function moveSelection(delta) {
  const ids = flatSidebarOrder();
  if (ids.length === 0) return;
  const cur = activeSessionId.value;
  const idx = cur ? ids.indexOf(cur) : -1;
  let next;
  if (idx < 0) {
    next = delta > 0 ? ids[0] : ids[ids.length - 1];
  } else {
    next = ids[(idx + delta + ids.length) % ids.length];
  }
  if (next) selectSession(next);
}

// Move the active session one slot up/down within its current folder.
// Clamps at folder boundaries (doesn't cross folders — that's what
// drag-and-drop is for). No-op when there's no active session, or
// when the session is already at the folder edge.
function moveActiveSessionInFolder(delta) {
  const cur = activeSessionId.value;
  if (!cur) return;
  const s = sessions.value.find((x) => x.id === cur);
  if (!s) return;
  const folderId = s.folderId || null;
  const folderKey = folderId || UNSORTED_KEY;
  const siblings = sessionsByFolder.value.get(folderKey) || [];
  const ids = siblings.map((x) => x.id);
  const idx = ids.indexOf(cur);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= ids.length) return;
  const next = ids.slice();
  next.splice(idx, 1);
  next.splice(target, 0, cur);
  reorderSessions(folderId, next).catch((e) => setToast(e.message, 'error'));
}

const HANDLERS = {
  'session-next':      () => moveSelection(+1),
  'session-prev':      () => moveSelection(-1),
  'session-move-down': () => moveActiveSessionInFolder(+1),
  'session-move-up':   () => moveActiveSessionInFolder(-1),
};

// Should we suppress shortcut handling because the user is typing into
// an input / textarea? Terminal's xterm hidden textarea counts too,
// but we deliberately let our Ctrl+Alt combos through there because
// the terminal child process never uses them.
function shouldSuppress(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    // Exception: xterm's helper textarea is a hidden input — we want
    // shortcuts to fire there.
    if (target.classList?.contains('xterm-helper-textarea')) return false;
    return true;
  }
  if (target.isContentEditable) return true;
  return false;
}

let installed = false;
export function installGlobalKeybindings() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (ev) => {
    if (shouldSuppress(ev.target)) return;
    const combo = comboFromEvent(ev);
    if (!combo) return;
    const map = keybindings.value;
    for (const [action, expected] of Object.entries(map)) {
      if (expected === combo && HANDLERS[action]) {
        ev.preventDefault();
        ev.stopPropagation();
        HANDLERS[action]();
        return;
      }
    }
  }, true);
}

// Pretty-print a combo for display in Settings. Replace verbose key
// names with shorter symbols where it helps.
export function formatCombo(combo) {
  if (!combo) return '(unset)';
  return combo
    .replace(/ArrowUp/g, '↑')
    .replace(/ArrowDown/g, '↓')
    .replace(/ArrowLeft/g, '←')
    .replace(/ArrowRight/g, '→');
}
