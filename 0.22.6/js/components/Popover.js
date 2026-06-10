// Tiny popover primitive — positions a floating panel relative to an
// anchor element, closes on outside click + Escape. Used by the unified
// pickers (CLI / Folder / Repo) so they all share interaction behavior.
//
// Usage:
//   const [open, setOpen] = useState(false);
//   const anchor = useRef(null);
//   <button ref=${anchor} onClick=${() => setOpen(true)}>Trigger</button>
//   ${open ? html`<${Popover} anchor=${anchor} onClose=${() => setOpen(false)}>
//     ...panel contents...
//   </${Popover}>` : null}

import { html } from '../html.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';

export function Popover({ anchor, onClose, align = 'left', width, children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: width || 320 });

  useLayoutEffect(() => {
    const a = anchor && anchor.current;
    if (!a) return;
    const rect = a.getBoundingClientRect();
    const w = width || Math.max(rect.width, 320);
    let left = align === 'right' ? rect.right - w : rect.left;
    // Clamp to viewport with 8px margin.
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    const top = rect.bottom + 6;
    setPos({ top, left, width: w });
  }, [anchor, align, width]);

  useEffect(() => {
    const onDown = (ev) => {
      if (panelRef.current?.contains(ev.target)) return;
      if (anchor.current?.contains(ev.target)) return;
      onClose?.();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    html`<div ref=${panelRef} class="popover-panel"
              style=${`top:${pos.top}px;left:${pos.left}px;width:${pos.width}px;`}>
      ${children}
    </div>`,
    document.body
  );
}
