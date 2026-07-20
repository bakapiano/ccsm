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

export function Popover({ anchor, point, onClose, align = 'left', width, children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: width || 320 });

  useLayoutEffect(() => {
    const a = anchor && anchor.current;
    if (!a && !point) return;
    const rect = a?.getBoundingClientRect();
    const w = Math.min(width || Math.max(rect?.width || 0, 320), window.innerWidth - 16);
    let left = point?.x ?? (align === 'right' ? rect.right - w : rect.left);
    // Clamp to viewport with 8px margin.
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = point?.y ?? (rect.bottom + 6);
    const panelHeight = panelRef.current?.getBoundingClientRect().height || 0;
    if (top + panelHeight > window.innerHeight - 8) {
      top = point ? point.y - panelHeight : rect.top - panelHeight - 6;
    }
    top = Math.max(8, Math.min(window.innerHeight - panelHeight - 8, top));
    setPos({ top, left, width: w });
  }, [anchor, point?.x, point?.y, align, width]);

  useEffect(() => {
    const onDown = (ev) => {
      if (panelRef.current?.contains(ev.target)) return;
      if (anchor?.current?.contains?.(ev.target)) return;
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
