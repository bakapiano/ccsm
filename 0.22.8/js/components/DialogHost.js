// Renders the dialog stack at the end of the App tree. Each entry handles
// its own keyboard + click dismissal lifecycle.

import { html } from '../html.js';
import { useEffect, useRef } from 'preact/hooks';
import { dialogs } from '../dialog.js';

export function DialogHost() {
  const list = dialogs.value;
  if (list.length === 0) return null;
  return html`${list.map((d) => html`<${DialogShell} key=${d.id} dialog=${d} />`)}`;
}

function DialogShell({ dialog }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); dialog.close('escape', ref.current); }
      else if (ev.key === 'Enter') { ev.preventDefault(); dialog.close('enter', ref.current); }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // initial focus next tick — element must already be in DOM
    setTimeout(() => {
      if (dialog.initialFocus) dialog.initialFocus(ref.current);
      else ref.current?.querySelector('[data-action="ok"]')?.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [dialog.id]);

  const onClick = (ev) => {
    if (ev.target === ref.current) return dialog.close('cancel', ref.current);
    const btn = ev.target.closest('button[data-action]');
    if (btn) dialog.close(btn.dataset.action, ref.current);
  };

  return html`
    <div ref=${ref} class="modal-backdrop" role="dialog" aria-modal="true" onClick=${onClick}>
      ${dialog.render()}
    </div>`;
}
