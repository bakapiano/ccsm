// Full-screen blocker shown on the remote browser while waiting for
// the host to approve this device. Triggered by api.js setting the
// pendingDevice signal in response to a 403 {pending:true}.
//
// While visible, polls /api/devices/me every 3s. When the server
// flips status to 'approved', the next polled api() call clears
// pendingDevice (api.js does that on any 2xx response), the overlay
// unmounts, and the rest of the app keeps loading.
//
// Reuses .offline-overlay / .offline-card classes so styling matches
// the existing HealthOverlay's blocking modal aesthetic.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { api, pendingDevice, loadConfig, refreshAll } from '../api.js';
import { getDeviceCode } from '../backend.js';
import { BrandMark } from '../icons.js';

const POLL_MS = 3000;

export function PendingApprovalOverlay() {
  const p = pendingDevice.value;

  useEffect(() => {
    if (!p) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        // /api/devices/me is gate-exempt: returns 200 with the current
        // device record regardless of approval state. We inspect the
        // body ourselves to decide whether to dismiss the overlay.
        const d = await api('GET', '/api/devices/me');
        if (d && d.status === 'approved') {
          pendingDevice.value = null;
          // First load failed because we weren't approved yet — main.js'
          // boot tried /api/config and got 401, no auto-retry. Now that
          // we're through the gate, kick a one-shot load so config +
          // sessions/folders/workspaces hydrate without waiting for the
          // 5s tick (and config without that ever happening, since the
          // periodic loop doesn't include loadConfig).
          loadConfig().catch(() => {});
          refreshAll().catch(() => {});
        } else if (d) {
          // Preserve any fields already set (firstSeen survives the
          // overlay's repeated polls; staleToken from a previous tick
          // gets cleared since we just got a 200).
          pendingDevice.value = {
            ...(pendingDevice.value || {}),
            pending: d.status === 'pending',
            rejected: d.status === 'rejected',
            deviceId: d.id,
            firstSeen: d.firstSeen,
            staleToken: false,
            at: Date.now(),
          };
        }
      } catch (e) {
        // /me 401s in exactly one situation: our device record was
        // pruned (24h pending TTL) AND the host's current token no
        // longer matches the one in our localStorage. We can't
        // self-recover from this — a fresh share URL is needed. Surface
        // it so the user gets honest feedback instead of an indefinite
        // "Waiting for approval" loop.
        const msg = String(e?.message || '');
        if (/401/.test(msg) || /token/i.test(msg)) {
          pendingDevice.value = {
            ...(pendingDevice.value || {}),
            staleToken: true,
            pending: false,
            rejected: false,
            at: Date.now(),
          };
        }
        /* anything else: network blip — try again next tick */
      }
    };
    const id = setInterval(tick, POLL_MS);
    tick();
    return () => { stopped = true; clearInterval(id); };
  }, [!!p]);

  if (!p) return null;

  const rejected = !!p.rejected;
  const staleToken = !!p.staleToken;
  const firstSeen = p.firstSeen ? new Date(p.firstSeen).toLocaleTimeString() : null;

  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="offline-card">
        <div class="offline-brand"><${BrandMark} /></div>
        ${staleToken ? html`
          <h1 class="offline-title">Link expired</h1>
          <p class="offline-copy">
            This share link no longer works — the host either rotated the
            registration token or this device was pruned after sitting
            unapproved for 24 hours.
          </p>
          <p class="offline-copy" style="margin-top:6px;font-size:12px;color:var(--ink-muted)">
            Ask the operator to send a fresh share URL from the Remote page.
          </p>
        ` : rejected ? html`
          <h1 class="offline-title">Access declined</h1>
          <p class="offline-copy">
            The host machine rejected this device. If you think this was a
            mistake, ask the operator to re-approve from the Remote page.
          </p>
        ` : html`
          <h1 class="offline-title">Waiting for host approval</h1>
          <p class="offline-copy">
            The host machine got your request${firstSeen ? ` at ${firstSeen}` : ''}.
            Approve this device from the Remote page over there to continue.
          </p>
          ${getDeviceCode() ? html`
            <div class="offline-code-block">
              <div class="offline-code-label">Your code</div>
              <div class="offline-code">${getDeviceCode()}</div>
              <div class="offline-code-hint">Match this against what the host sees before they Approve.</div>
            </div>
          ` : null}
          <p class="offline-copy" style="margin-top:6px;font-size:12px;color:var(--ink-muted)">
            We'll auto-unlock the moment the host clicks Approve.
          </p>
        `}
      </div>
    </div>`;
}
