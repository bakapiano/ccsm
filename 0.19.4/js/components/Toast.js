import { html } from '../html.js';
import { toastState } from '../toast.js';

export function Toast() {
  const t = toastState.value;
  const cls = `toast ${t.visible ? 'show' : ''} ${t.kind}`;
  return html`<div class=${cls} role="status" aria-live="polite">${t.msg}</div>`;
}
