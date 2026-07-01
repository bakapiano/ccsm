// Small top-of-viewport banner shown while a user-initiated backend
// restart is in flight. Used to be a full-screen blocking modal;
// turned out the user just wanted visible "we're working" feedback,
// not a giant card-and-button covering the page. Self-dismisses when
// /api/health reports a fresh PID (different from the one we captured
// at click time), or after 30s as a safety net.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { restartInFlight, serverHealth } from '../state.js';
import { refreshAll } from '../api.js';

export function RestartOverlay() {
  const info = restartInFlight.value;
  const h = serverHealth.value;

  useEffect(() => {
    if (!info) return;
    if (h.state === 'online' && h.pid && h.pid !== info.prevPid) {
      restartInFlight.value = null;
      refreshAll().catch(() => {});
    }
    const id = setTimeout(() => {
      if (restartInFlight.value === info) restartInFlight.value = null;
    }, 30_000);
    return () => clearTimeout(id);
  }, [info, h.state, h.pid]);

  if (!info) return null;

  return html`
    <div class="restart-banner" role="status" aria-live="polite">
      <span class="restart-banner-spinner" aria-hidden="true"></span>
      <span class="restart-banner-text">Restarting backend…</span>
    </div>`;
}
