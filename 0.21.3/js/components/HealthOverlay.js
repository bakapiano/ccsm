// Full-screen modal shown while the backend is unreachable.
//
// Two phases:
//   - Early (failureCount < THRESHOLD): "Checking backend health…" with
//     a spinner. Most outages resolve in one or two ticks — no need to
//     scare the user.
//   - Persistent (failureCount >= THRESHOLD): "Backend not running.
//     Start backend" with a button that fires the ccsm:// protocol so
//     Windows' registered launcher.vbs spawns ccsm.
//
// We never auto-resume. The user has to click the button — protects
// against repeated wake attempts during an in-flight upgrade or a
// crash loop.
//
// While offline we drive a faster (1.5s) poll loop directly so the
// modal dismisses promptly when the backend comes back, without
// waiting for the main 5s refresh interval.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { serverHealth, hasBootedOnline } from '../state.js';
import { pollHealth, refreshAll } from '../api.js';
import { BrandMark } from '../icons.js';
import { isRemoteAccess } from '../backend.js';

const THRESHOLD = 3;     // failures before we switch from "checking" to "not running"
const FAST_POLL_MS = 1500;

export function HealthOverlay() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const count = h.failureCount || 0;
  const everSeen = hasBootedOnline.value;

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => { pollHealth(); }, FAST_POLL_MS);
    return () => clearInterval(id);
  }, [offline]);

  useEffect(() => {
    if (!offline && everSeen) {
      refreshAll().catch(() => {});
    }
  }, [offline]);

  if (!offline || !everSeen) return null;

  const showStart = count >= THRESHOLD;

  // Reuses the .offline-overlay / .offline-card classes so the card
  // layout (brand mark, big title, copy, primary action button,
  // collapsible npm-install fallback) matches what the OfflineBanner
  // used to render. HealthOverlay differs only in the two states:
  // early polls show a spinner + "Checking…" instead of the static
  // "Backend not running" card.
  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="offline-card">
        <div class="offline-brand">${
          showStart
            ? html`<${BrandMark} />`
            : html`<div class="health-spinner" aria-hidden="true"></div>`
        }</div>
        ${!showStart ? html`
          <h1 class="offline-title">Checking backend health…</h1>
          <p class="offline-copy">
            ${count === 0 ? 'Probing localhost:7777.' : `${count} attempt${count > 1 ? 's' : ''}. Hang tight.`}
          </p>
        ` : isRemoteAccess() ? html`
          <h1 class="offline-title">Host machine offline</h1>
          <p class="offline-copy">
            The ccsm backend you connected to over the tunnel isn't reachable.
            Only the operator at the host machine can restart it — the tunnel
            URL is dead until ccsm is running there again.
          </p>
          <p class="offline-copy" style="margin-top:8px;font-size:12px;color:var(--ink-muted)">
            We'll keep polling and reconnect automatically as soon as the
            backend comes back.
          </p>
        ` : html`
          <h1 class="offline-title">Backend not running</h1>
          <p class="offline-copy">
            ccsm's local backend isn't reachable. Wake it manually below — we won't
            auto-restart. Windows may ask once for permission; tick <em>Always allow</em>
            to silence future prompts.
          </p>
          <div class="offline-actions">
            <a class="action primary big" href="ccsm://start">Start backend</a>
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
        `}
      </div>
    </div>`;
}
