// Centered modal dialog with backdrop. Closes via Esc, the corner X,
// or a click on the backdrop.
//
//   <${Modal} onClose=${close} title="Choose CLI" width=${440}>
//     ...body...
//   </${Modal}>

import { html } from '../html.js';
import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';

export function Modal({ title, width = 440, onClose, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const onBackdrop = (ev) => {
    if (ev.target === ev.currentTarget) onClose?.();
  };

  return createPortal(
    html`<div class="modal-backdrop" onMouseDown=${onBackdrop}>
      <div ref=${panelRef} class="modal modal-picker"
           style=${`width:${width}px;max-width:calc(100vw - 32px);`}
           role="dialog" aria-modal="true">
        ${title ? html`
          <div class="modal-head">
            <h2>${title}</h2>
            <button class="modal-close" type="button"
                    aria-label="Close" onClick=${onClose}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="3" y1="3" x2="13" y2="13"/>
                <line x1="13" y1="3" x2="3" y2="13"/>
              </svg>
            </button>
          </div>` : null}
        <div class="modal-body">${children}</div>
      </div>
    </div>`,
    document.body
  );
}
