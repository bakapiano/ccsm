// Phone-only navigation affordance.
//
// On viewports ≤ 640px the sidebar is hidden via CSS (.is-mobile body
// class). Instead, a circular floating button sits bottom-left; tapping
// it sets mobileDrawerOpen, which the sidebar reads to flip into a
// full-screen overlay. A backdrop captures taps outside the sidebar
// and dismisses.
//
// The FAB is draggable — long-press-and-move lets the user reposition
// it (the default bottom-left can cover page content). A short tap with
// no drag still toggles the drawer. Position persists in localStorage
// so the user doesn't have to re-place it each session.

import { html } from '../html.js';
import { useRef, useState, useEffect } from 'preact/hooks';
import { isMobile, mobileDrawerOpen } from '../state.js';
import { IconSidebarToggle, IconClose } from '../icons.js';

const LS_POS = 'ccsm.fab.pos';
const FAB_SIZE = 52;
const SAFE_MARGIN = 8;
// Movement threshold (px) before pointermove counts as a drag instead
// of a tap. Below this, pointerup fires the toggle and the FAB stays
// put — matches what a user expects when they meant to "press" the
// button, not move it.
const DRAG_HYST_PX = 6;

function loadPos() {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.left === 'number' && typeof p.bottom === 'number') return p;
  } catch {}
  return null;
}
function savePos(p) {
  try { localStorage.setItem(LS_POS, JSON.stringify(p)); } catch {}
}
function clampPos(p) {
  // Re-clamp on every render so a position saved at one viewport size
  // doesn't trap the FAB off-screen at a smaller size (rotation,
  // resize, etc.).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left:   Math.max(SAFE_MARGIN, Math.min(vw - FAB_SIZE - SAFE_MARGIN, p.left)),
    bottom: Math.max(SAFE_MARGIN, Math.min(vh - FAB_SIZE - SAFE_MARGIN, p.bottom)),
  };
}

export function MobileNavFab() {
  if (!isMobile.value) return null;
  const open = mobileDrawerOpen.value;
  const [pos, setPos] = useState(() => loadPos() || { left: 16, bottom: 24 });
  const dragRef = useRef({ start: null, moved: false });

  // Re-clamp on viewport changes so a rotation doesn't strand the FAB
  // beyond the new edge.
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (ev) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragRef.current = {
      start: { x: ev.clientX, y: ev.clientY, fromPos: pos },
      moved: false,
    };
  };
  const onPointerMove = (ev) => {
    const d = dragRef.current;
    if (!d.start) return;
    const dx = ev.clientX - d.start.x;
    const dy = ev.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_HYST_PX) return;
    d.moved = true;
    // Stop the page from also scrolling while we drag.
    ev.preventDefault();
    setPos(clampPos({
      // bottom = distance from bottom edge to the FAB's bottom edge.
      // Pointer moved DOWN (+dy) → FAB moves down → bottom decreases.
      left:   d.start.fromPos.left + dx,
      bottom: d.start.fromPos.bottom - dy,
    }));
  };
  const onPointerUp = (ev) => {
    const d = dragRef.current;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch {}
    dragRef.current = { start: null, moved: false };
    if (d.moved) {
      // Drag finished — persist the new resting spot.
      savePos(pos);
      return;
    }
    // No appreciable movement → treat as tap.
    mobileDrawerOpen.value = !open;
  };

  return html`
    ${open ? html`
      <div class="mobile-nav-backdrop"
           onClick=${() => { mobileDrawerOpen.value = false; }} />
    ` : null}
    <button class=${`mobile-nav-fab${open ? ' is-open' : ''}`}
            style=${`left: ${pos.left}px; bottom: ${pos.bottom}px;`}
            aria-label=${open ? 'close navigation' : 'open navigation'}
            onPointerDown=${onPointerDown}
            onPointerMove=${onPointerMove}
            onPointerUp=${onPointerUp}
            onPointerCancel=${onPointerUp}>
      ${open ? html`<${IconClose} />` : html`<${IconSidebarToggle} />`}
    </button>`;
}
