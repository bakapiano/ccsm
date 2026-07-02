// One repo per row — driven by the streaming.js progress signal.

import { html } from '../html.js';
import { progressByContext } from '../streaming.js';

export function ProgressList({ rootId }) {
  const map = progressByContext.value[rootId] || {};
  const items = Object.values(map);
  if (items.length === 0) return null;

  return html`
    <div class="progress-list">
      ${items.map((it) => html`<${Item} key=${it.name} item=${it} />`)}
    </div>`;
}

function Item({ item }) {
  const cls = `progress-item${item.state ? ' ' + item.state : ''}`;
  const fillCls = `fill${item.indeterminate ? ' indeterminate' : ''}`;
  const fillStyle = item.percent != null ? `width: ${item.percent}%` : '';
  const pct = item.percent != null ? `${item.percent}%` : '';
  return html`
    <div class=${cls}>
      <div class="head">
        <span class="name">${item.name}</span>
        <span class="phase">${item.phase}</span>
        <span class="pct">${pct}</span>
      </div>
      <div class="progress-bar"><div class=${fillCls} style=${fillStyle}></div></div>
      <div class="detail">${item.detail || ''}</div>
    </div>`;
}
