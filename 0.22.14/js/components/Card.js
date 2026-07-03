// Foldable card. Pass foldKey for fold-state persistence across reloads;
// omit it for non-foldable cards (Launch tab, etc).

import { html } from '../html.js';
import { cardFolded, toggleCardFold } from '../state.js';
import { IconChevronDown } from '../icons.js';

export function Card({ foldKey, title, titleAfter, meta, children, flush }) {
  const collapsed = foldKey ? !!cardFolded.value[foldKey] : false;
  const bodyClass = flush ? 'card-body card-body-flush' : 'card-body';
  const onHeadClick = foldKey ? () => toggleCardFold(foldKey) : undefined;

  return html`
    <article class="card" data-fold-key=${foldKey || null} data-collapsed=${collapsed || null}>
      <header class="card-head" onClick=${onHeadClick}>
        <div class="card-titles">
          <h2 class="card-title">${title}${titleAfter || null}</h2>
          ${meta ? html`<p class="card-meta">${meta}</p>` : null}
        </div>
        ${foldKey ? html`<button class="card-fold" aria-label="collapse"><${IconChevronDown} /></button>` : null}
      </header>
      <div class=${bodyClass}>${children}</div>
    </article>`;
}
