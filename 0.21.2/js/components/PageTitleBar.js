// Thin page-title strip rendered at the top of every page's main panel.
// Matches the sidebar collapse-toggle height so the eye sees a single
// 28px-tall row spanning the top of the whole window.

import { html } from '../html.js';

export function PageTitleBar({ title, children }) {
  return html`
    <header class="page-title-bar">
      <div class="page-title-bar-title">${title}</div>
      ${children ? html`<div class="page-title-bar-actions">${children}</div>` : null}
    </header>`;
}
