import { html } from '../html.js';
import { serverHealth } from '../state.js';

export function ServerStatus() {
  const h = serverHealth.value;
  const view = {
    online:     { text: h.version ? `online · v${h.version}` : 'online',
                  title: `backend ok · pid ${h.pid} · v${h.version}` },
    offline:    { text: 'offline', title: `backend unreachable — ${h.error || ''}` },
    connecting: { text: 'connecting…', title: 'checking backend status' },
  }[h.state] || { text: h.state, title: h.state };

  return html`
    <span class="server-status" data-state=${h.state} title=${view.title}>
      <span class="status-pulse" aria-hidden="true"></span>
      <span class="server-status-label">${view.text}</span>
    </span>`;
}
