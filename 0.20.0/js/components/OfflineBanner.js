// Fullscreen overlay shown when the backend is offline. Blocks
// interaction with the rest of the UI until backend comes back.
//
// The hosted frontend (https://bakapiano.github.io/ccsm/v1/) can't
// spawn processes directly, so we surface a ccsm://start link instead.
// Windows hands that off to the registered protocol handler
// (ccsm.cmd), which spawns the backend silently. Our health probe
// picks it up on the next tick and the overlay auto-hides.
//
// First click triggers a Windows confirmation dialog ("Open ccsm.cmd?").
// User can check "Always allow" to suppress future prompts.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { serverHealth } from '../state.js';
import { refreshAll } from '../api.js';
import { BrandMark } from '../icons.js';

export function OfflineBanner() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const [clicked, setClicked] = useState(false);

  // We used to silently fire ccsm://start via a hidden iframe the
  // moment the backend went offline. Even when the user had OK'd
  // "Always allow" once, some browsers still flashed a momentary
  // confirmation prompt — and first-time visitors got a "Open
  // ccsm.cmd?" dialog with no apparent trigger, which is a bad UX.
  // The Start button below is the only path that fires the protocol
  // now; the health poll picks the backend up automatically once
  // the user clicks it (or starts ccsm from a terminal / shortcut).

  useEffect(() => {
    if (h.state === 'online' && clicked) {
      refreshAll().catch(() => {});
      setClicked(false);
    }
  }, [h.state, clicked]);

  if (!offline) return null;

  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-labelledby="offline-title">
      <div class="offline-card">
        <div class="offline-brand"><${BrandMark} /></div>
        <h1 id="offline-title" class="offline-title">Backend not running</h1>
        <p class="offline-copy">
          ccsm's local backend isn't reachable. Click Start to launch it —
          Windows may ask for permission once. Tick <em>Always allow</em>
          to silence future prompts.
        </p>
        <div class="offline-actions">
          <a class="action primary big" href="ccsm://start"
             onClick=${() => setClicked(true)}>Start ccsm</a>
        </div>
        <details class="offline-fallback">
          <summary>Don't have ccsm installed?</summary>
          <div class="offline-fallback-body">
            <p>Install once via npm, then come back here:</p>
            <pre><code>npm i -g @bakapiano/ccsm</code></pre>
            <p>Or run a one-shot trial without installing:</p>
            <pre><code>npx @bakapiano/ccsm</code></pre>
          </div>
        </details>
      </div>
    </div>`;
}
