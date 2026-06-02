// Remote · expose this backend over a public tunnel URL so the same
// frontend can be loaded from a phone / another laptop / wherever.
// All API + WS calls are gated by a token the user sets here; the
// share URL embeds it (?token=…) so the remote browser captures it
// on first arrival and stashes it in localStorage.
//
// Layout mirrors ConfigurePage: .settings-scroll wrapper → Section →
// .config-grid → .field rows with label + content. No bespoke cards.

import { html } from '../html.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { setToast } from '../toast.js';
import { ccsmConfirm, ccsmPrompt } from '../dialog.js';
import { IconCopy, IconRecycle, IconExternal, IconInfo, IconPencil, IconClose, IconCloudflareColor, IconMicrosoftColor } from '../icons.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';

function genToken() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setToast('Copied', 'ok');
  } catch {
    setToast('Copy failed · select + Ctrl+C', 'error');
  }
}

function shareUrl(tunnelUrl, token) {
  if (!tunnelUrl || !token) return '';
  try {
    const u = new URL(tunnelUrl);
    u.searchParams.set('token', token);
    return u.toString();
  } catch { return ''; }
}

function Section({ title, meta, children }) {
  return html`
    <section class="settings-section">
      <header class="settings-section-head">
        <h2 class="settings-section-title">${title}</h2>
        ${meta ? html`<p class="settings-section-meta">${meta}</p>` : null}
      </header>
      <div class="settings-section-body">${children}</div>
    </section>`;
}

function DeviceRow({ d, kind, onApprove, onReject, onRevoke, onRename, onDelete }) {
  const lastSeen = d.lastSeen ? fmtAgo(d.lastSeen) : '—';
  const ipShort = d.ip ? d.ip.split(',')[0].trim() : null;
  return html`
    <div class=${`remote-device is-${kind}`}>
      <div class="remote-device-main">
        <div class="remote-device-label">
          ${d.code ? html`<code class="remote-device-code" title="Match this with the code shown on the requesting device">${d.code}</code>` : null}
          <span class="remote-device-name">${d.label || 'Unknown device'}</span>
          ${kind === 'approved' ? html`
            <button class="icon-btn" title="Rename" onClick=${onRename}><${IconPencil} /></button>
          ` : null}
        </div>
        <div class="remote-device-meta">
          ${ipShort ? html`<span class="mono">${ipShort}</span> · ` : null}
          <span>seen ${lastSeen}</span>
          ${d.userAgent ? html` · <span class="remote-device-ua" title=${d.userAgent}>${d.userAgent.slice(0, 60)}${d.userAgent.length > 60 ? '…' : ''}</span>` : null}
        </div>
      </div>
      <div class="remote-device-actions">
        ${kind === 'pending' ? html`
          <button class="action primary small" onClick=${onApprove}>Approve</button>
          <button class="action subtle small" onClick=${onReject}>Reject</button>
        ` : null}
        ${kind === 'approved' ? html`
          <button class="action subtle danger small" onClick=${onRevoke}><${IconClose} /> Revoke</button>
        ` : null}
        ${kind === 'rejected' ? html`
          <button class="action subtle small" onClick=${onApprove}>Re-approve</button>
          <button class="action subtle danger small" onClick=${onDelete}><${IconClose} /> Delete</button>
        ` : null}
      </div>
    </div>`;
}

function ProviderTile({ id, label, hint, icon, selected, disabled, onSelect }) {
  return html`
    <button type="button"
            class=${`provider-tile${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
            aria-pressed=${selected ? 'true' : 'false'}
            disabled=${disabled}
            onClick=${() => !disabled && onSelect(id)}>
      <span class="provider-tile-icon">${icon}</span>
      <span class="provider-tile-body">
        <span class="provider-tile-label">${label}</span>
        ${hint ? html`<span class="provider-tile-hint">${hint}</span>` : null}
      </span>
    </button>`;
}

// Tiny inline row shown under the signed-in Microsoft Dev Tunnel
// status. Displays the persisted (named) tunnel id ccsm reuses across
// restarts so the public URL stays stable — and lets the user rotate
// it on demand. Reset requires the tunnel to be stopped first; the
// server-side route also enforces this.
function DevtunnelTunnelIdRow({ tunnelId, running, onReset }) {
  if (!tunnelId) {
    return html`
      <div class="tunnel-id-row is-empty">
        <span class="tunnel-id-label">Tunnel id</span>
        <span class="tunnel-id-value-empty">none yet · minted on next Start</span>
      </div>`;
  }
  return html`
    <div class="tunnel-id-row">
      <span class="tunnel-id-label">Tunnel id</span>
      <code class="tunnel-id-value" title="Stable public URL identifier · reused across restarts">${tunnelId}</code>
      <button type="button" class="action subtle small tunnel-id-reset"
              disabled=${running}
              title=${running ? 'Stop the tunnel first' : 'Mint a fresh tunnel id (public URL will change)'}
              onClick=${onReset}>
        <${IconRecycle} /> Reset
      </button>
    </div>`;
}

function ProviderStatus({ id, info, onInstall, onLogin, loggingIn }) {
  if (!info) return html`<span class="provider-status-muted">probing…</span>`;
  if (!info.installed) {
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-warn">
          <span class="provider-status-dot is-warn"></span> Not installed
        </span>
        <button type="button" class="action small" onClick=${onInstall}>
          Install via winget
        </button>
      </div>`;
  }
  if (id !== 'devtunnel') {
    // Cloudflare quick tunnel · no account state, just version.
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-ok">
          <span class="provider-status-dot is-ok"></span> Ready · anonymous
        </span>
        ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
      </div>`;
  }
  // devtunnel · signed-in / signed-out states each get their own row.
  if (!info.loggedIn) {
    // While a sign-in flow is in flight the signin-card below this
    // row carries its own header + spinner + cancel button. Showing
    // a second "Signing in…" CTA here is just noise — collapse the
    // whole signed-out block down to a thin status line until the
    // card resolves one way or the other.
    if (loggingIn) {
      return html`
        <div class="provider-status">
          <span class="provider-status-state">
            <span class="provider-status-dot"></span> Signing in…
          </span>
          ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
        </div>`;
    }
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-warn">
          <span class="provider-status-dot is-warn"></span> Not signed in
        </span>
        ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
        <button type="button" class="btn-signin-microsoft provider-status-signin" onClick=${onLogin}>
          <${IconMicrosoftColor} size=${18} />
          <span>Sign in with Microsoft</span>
        </button>
      </div>`;
  }
  return html`
    <div class="provider-status">
      <span class="provider-status-state is-ok">
        <span class="provider-status-dot is-ok"></span> Signed in
      </span>
      <span class="provider-status-user">${info.user}</span>
      ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
      <button type="button" class="action subtle small provider-status-switch" onClick=${onLogin}>
        Switch
      </button>
    </div>`;
}

// Device-code login panel. Shown when a `devtunnel user login -d` flow
// is in flight or just finished. The user clicks Open, signs in on
// microsoft.com, and we flip to "Signed in" automatically when the
// child exits 0 (the probe cache gets invalidated on exit).
function DevtunnelLoginPanel({ login, onCancel, onDismiss, onRetry }) {
  if (!login) return null;
  const { status, url, code, error, user, lines } = login;
  const running  = status === 'running';
  const done     = status === 'done';
  const failed   = status === 'error';
  const canceled = status === 'canceled';
  const host = (() => { try { return new URL(url).host; } catch { return url || ''; } })();
  return html`
    <div class=${`signin-card is-${status}`}>
      ${running ? html`
        <div class="signin-card-header">
          <span class="signin-card-spinner" aria-hidden="true"></span>
          <span class="signin-card-eyebrow">Signing in to Microsoft</span>
          <button type="button" class="signin-card-cancel" onClick=${onCancel} title="Cancel sign-in">
            <${IconClose} /> Cancel
          </button>
        </div>
        <div class="signin-card-code-block">
          <span class="signin-card-code-label">Device code</span>
          <div class="signin-card-code-row">
            ${code ? html`
              <code class="signin-card-code">${code}</code>
              <button type="button" class="action subtle small signin-card-code-copy"
                      title="Copy code" onClick=${() => copy(code)}>
                <${IconCopy} />
              </button>
            ` : html`<span class="signin-card-code-pending">generating…</span>`}
          </div>
        </div>
        <ol class="signin-card-steps">
          <li>
            ${url ? html`
              <a class="signin-card-open" href=${url} target="_blank" rel="noreferrer noopener">
                <${IconExternal} /> Open <span class="signin-card-host">${host}</span>
              </a>
            ` : html`<span class="signin-card-step-muted">Waiting for sign-in URL…</span>`}
          </li>
          <li>Paste the device code shown above.</li>
          <li>Pick an account and approve — this page flips automatically.</li>
        </ol>
      ` : null}
      ${done ? html`
        <div class="signin-card-result is-ok">
          <span class="signin-card-result-icon" aria-hidden="true">✓</span>
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">Signed in</div>
            <div class="signin-card-result-meta">
              ${user ? html`as <code>${user}</code> · ` : ''}you can start the tunnel now.
            </div>
          </div>
          <button type="button" class="action subtle small" onClick=${onDismiss}>Dismiss</button>
        </div>
      ` : null}
      ${failed ? html`
        <div class="signin-card-result is-error">
          <span class="signin-card-result-icon" aria-hidden="true">!</span>
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">Sign-in failed</div>
            <div class="signin-card-result-meta">${error || 'devtunnel exited with an error.'}</div>
          </div>
          <div class="signin-card-result-actions">
            <button type="button" class="action small" onClick=${onRetry}>Try again</button>
            <button type="button" class="action subtle small" onClick=${onDismiss}>Dismiss</button>
          </div>
        </div>
      ` : null}
      ${canceled ? html`
        <div class="signin-card-result is-muted">
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">Sign-in canceled</div>
          </div>
          <div class="signin-card-result-actions">
            <button type="button" class="action small" onClick=${onRetry}>Try again</button>
            <button type="button" class="action subtle small" onClick=${onDismiss}>Dismiss</button>
          </div>
        </div>
      ` : null}
      ${lines && lines.length ? html`
        <details class="signin-card-log">
          <summary>CLI output · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}</summary>
          <pre>${lines.join('\n')}</pre>
        </details>
      ` : null}
    </div>`;
}

export function RemotePage() {
  clockTick.value; // re-tick fmtAgo "last seen" labels
  // Hydrate from a localStorage cache so the page renders the same
  // shape it had at the end of the previous visit — provider tiles,
  // signed-in state, tunnel id, share URL — instead of empty / placeholder
  // chrome that fills in after the slow /api/tunnel/status round-trip
  // (700ms+ on a cold probe). The cached snapshot is overwritten by
  // refresh() the moment the live response lands.
  const cachedStatus = (() => {
    try {
      const raw = localStorage.getItem('ccsm.remote-status-cache');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();
  const [status, setStatus] = useState(cachedStatus);
  const [provider, setProvider] = useState(() => {
    if (cachedStatus?.running && cachedStatus?.provider) return cachedStatus.provider;
    if (cachedStatus?.providers?.devtunnel?.installed) return 'devtunnel';
    if (cachedStatus?.providers?.cloudflared?.installed) return 'cloudflared';
    return 'devtunnel';
  });
  const [token, setTokenLocal] = useState(cachedStatus?.token || '');
  const [busy, setBusy] = useState(false);
  const [deviceList, setDeviceList] = useState([]);
  const pollRef = useRef(null);

  async function refresh() {
    try {
      const [s, devs] = await Promise.all([
        api('GET', '/api/tunnel/status'),
        api('GET', '/api/devices').catch(() => ({ devices: [] })),
      ]);
      setStatus(s);
      setDeviceList(devs.devices || []);
      setTokenLocal((cur) => cur || s.token || '');
      setProvider((cur) => {
        if (s.running && s.provider) return s.provider;
        if (cur) return cur;
        if (s.providers?.devtunnel?.installed) return 'devtunnel';
        if (s.providers?.cloudflared?.installed) return 'cloudflared';
        return cur || 'devtunnel';
      });
      // Snapshot for the next mount. Skip the per-call `log` so the
      // cache stays small.
      try {
        localStorage.setItem('ccsm.remote-status-cache', JSON.stringify({
          ...s, log: undefined,
        }));
      } catch {}
    } catch (e) { setToast(`status load failed · ${e.message}`, 'error'); }
  }

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 2500);
    return () => clearInterval(pollRef.current);
  }, []);

  async function onApproveDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/approve`); refresh(); setToast('Device approved', 'ok'); }
    catch (e) { setToast(`approve failed · ${e.message}`, 'error'); }
  }
  async function onRejectDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/reject`); refresh(); setToast('Device rejected', 'ok'); }
    catch (e) { setToast(`reject failed · ${e.message}`, 'error'); }
  }
  async function onDeleteDevice(d) {
    const ok = await ccsmConfirm(
      `Forget "${d.label || d.id}"? The device disappears from this list. If it ever tries again it'll come back as a fresh pending request.`,
      { title: 'Delete device record', okLabel: 'Delete', danger: true },
    );
    if (!ok) return;
    try { await api('DELETE', `/api/devices/${encodeURIComponent(d.id)}`); refresh(); setToast('Device deleted', 'ok'); }
    catch (e) { setToast(`delete failed · ${e.message}`, 'error'); }
  }
  async function onRevokeDevice(d) {
    const ok = await ccsmConfirm(`Revoke access for "${d.label || d.id}"? Any open tabs lose access immediately.`, {
      title: 'Revoke device', okLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    try { await api('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`); refresh(); setToast('Access revoked', 'ok'); }
    catch (e) { setToast(`revoke failed · ${e.message}`, 'error'); }
  }
  async function onRenameDevice(d) {
    const next = await ccsmPrompt('Rename device', d.label || '', { okLabel: 'Save' });
    if (next === null) return;
    try { await api('PUT', `/api/devices/${encodeURIComponent(d.id)}`, { label: next.trim() }); refresh(); }
    catch (e) { setToast(`rename failed · ${e.message}`, 'error'); }
  }

  async function onStart() {
    setBusy(true);
    try {
      // Auto-mint a token if the user hasn't generated one yet — the
      // registration token is now an implementation detail of starting
      // a tunnel rather than a separate setup step.
      let tok = token;
      if (!tok || tok.length < 8) {
        tok = genToken();
        setTokenLocal(tok);
        try { await api('POST', '/api/tunnel/token', { token: tok }); }
        catch (e) { /* the start call below will fail too — surface that */ }
      }
      const s = await api('POST', '/api/tunnel/start', { provider, token: tok });
      setStatus(s);
      setToast(s.url ? 'Tunnel up' : 'Tunnel starting · URL appearing shortly', 'ok');
    } catch (e) {
      setToast(`start failed · ${e.message}`, 'error');
    } finally { setBusy(false); }
  }
  async function onStop() {
    setBusy(true);
    try {
      const s = await api('POST', '/api/tunnel/stop');
      setStatus(s);
      setToast('Tunnel stopped', 'ok');
    } catch (e) { setToast(`stop failed · ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }
  // Generate is the only path that mutates the token now — local React
  // state and the server's stored token stay in lockstep, so the Share
  // URL preview always embeds a token the server will accept. (The
  // previous design had a separate Save step; users would Generate +
  // copy the URL without saving, then the remote would 401 because
  // its embedded token didn't match what the server still had.)
  async function onGenerateToken() {
    const fresh = genToken();
    setTokenLocal(fresh);
    try {
      const s = await api('POST', '/api/tunnel/token', { token: fresh });
      setStatus(s);
      setToast('New token in effect', 'ok');
    } catch (e) { setToast(`token save failed · ${e.message}`, 'error'); }
  }
  async function onInstall(p) {
    const ok = await ccsmConfirm(`Install ${p} via winget? Runs in the background — refresh after ~30s.`, {
      title: 'Install tunnel provider', okLabel: 'Install',
    });
    if (!ok) return;
    try {
      await api('POST', '/api/tunnel/install', { provider: p });
      setToast(`${p} install running in background · check back in a minute`, 'ok');
    } catch (e) { setToast(`install failed · ${e.message}`, 'error'); }
  }
  function onLogin(p) {
    if (p !== 'devtunnel') return;
    // Kick off `devtunnel user login -d` on the host and let the
    // panel below render the device code + URL. /status polling
    // (every 2.5s) picks up the eventual outcome.
    (async () => {
      try {
        const r = await api('POST', '/api/tunnel/devtunnel/login', { mode: 'microsoft' });
        if (r?.login) setStatus((cur) => cur ? { ...cur, login: r.login } : cur);
        refresh();
      } catch (e) { setToast(`sign-in failed · ${e.message}`, 'error'); }
    })();
  }
  async function onLoginCancel() {
    try { await api('POST', '/api/tunnel/devtunnel/login/cancel'); refresh(); }
    catch (e) { setToast(`cancel failed · ${e.message}`, 'error'); }
  }
  async function onLoginDismiss() {
    try { await api('POST', '/api/tunnel/devtunnel/login/dismiss'); refresh(); }
    catch (e) { setToast(`dismiss failed · ${e.message}`, 'error'); }
  }
  async function onResetDevtunnelId() {
    const ok = await ccsmConfirm(
      `Mint a fresh tunnel id? The public URL changes — every approved remote device will need to re-register on the new URL. Any existing share links stop working.`,
      { title: 'Reset Microsoft Dev Tunnel id', okLabel: 'Reset', danger: true },
    );
    if (!ok) return;
    try {
      await api('POST', '/api/tunnel/devtunnel/reset');
      refresh();
      setToast('Tunnel id reset · next Start mints a fresh one', 'ok');
    } catch (e) { setToast(`reset failed · ${e.message}`, 'error'); }
  }

  const running = status?.running;
  const url     = status?.url;
  const share   = shareUrl(url, token);
  const log     = status?.log || [];
  const cf      = status?.providers?.cloudflared;
  const dt      = status?.providers?.devtunnel;
  const dtLogin = status?.login || null;
  const dtLoggingIn = dtLogin?.status === 'running';
  // First /api/tunnel/status round-trip is the slow one — even with
  // the 30s server-side cache + parallel probe, a cold call shells
  // out and adds ~700ms. We render the full page immediately and let
  // individual fields show their own "probing…" state instead of
  // gating the whole panel behind a centered spinner.

  return html`
    <${PageTitleBar} title="Remote" />
    <div class="settings-scroll">

      <${Section}
        title="Connection"
        meta=${html`Pick which CLI ccsm spawns for the tunnel.`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">Provider</span>
            <div class="provider-tile-row">
              <${ProviderTile} id="devtunnel" label="Microsoft Dev Tunnel"
                hint="Requires sign-in"
                icon=${html`<${IconMicrosoftColor} size=${32} />`}
                selected=${provider === 'devtunnel'}
                disabled=${running}
                onSelect=${setProvider} />
              <${ProviderTile} id="cloudflared" label="Cloudflare Tunnel"
                hint="Anonymous · no login"
                icon=${html`<${IconCloudflareColor} size=${32} />`}
                selected=${provider === 'cloudflared'}
                disabled=${running}
                onSelect=${setProvider} />
            </div>
            ${running ? html`<span class="hint">Stop the tunnel to switch provider.</span>` : null}
          </div>
          ${provider === 'devtunnel' ? html`
            <div class="field">
              <span class="label">Microsoft Dev Tunnel</span>
              <div class="remote-status-line">
                <${ProviderStatus} id="devtunnel" info=${dt}
                  onInstall=${() => onInstall('devtunnel')}
                  onLogin=${() => onLogin('devtunnel')}
                  loggingIn=${dtLoggingIn} />
              </div>
              ${dtLogin ? html`
                <${DevtunnelLoginPanel}
                  login=${dtLogin}
                  onCancel=${onLoginCancel}
                  onDismiss=${onLoginDismiss}
                  onRetry=${() => onLogin('devtunnel')} />
              ` : null}
              ${dt?.loggedIn ? html`
                <${DevtunnelTunnelIdRow}
                  tunnelId=${status?.tunnelId}
                  running=${running && status?.provider === 'devtunnel'}
                  onReset=${onResetDevtunnelId} />
              ` : null}
            </div>
          ` : null}
          ${provider === 'cloudflared' ? html`
            <div class="field">
              <span class="label">Cloudflare Tunnel</span>
              <div class="remote-status-line">
                <${ProviderStatus} id="cloudflared" info=${cf}
                  onInstall=${() => onInstall('cloudflared')} />
              </div>
            </div>
          ` : null}
        </div>
      </${Section}>

      <${Section}
        title="Tunnel"
        meta=${running
          ? html`Provider <code>${status?.provider}</code> · started ${new Date(status.startedAt).toLocaleTimeString()}`
          : html`Not running.`}>
        ${!running ? html`
          <div class="tunnel-hero">
            <div class="tunnel-hero-body">
              <div class="tunnel-hero-title">Bring this backend online</div>
              <div class="tunnel-hero-meta">
                ccsm will spawn
                <code>${provider === 'devtunnel' ? 'devtunnel' : 'cloudflared'}</code>
                and wait for it to print a public URL.
              </div>
            </div>
            <button type="button" class="action tunnel-hero-cta"
                    disabled=${busy}
                    onClick=${onStart}>
              <${IconExternal} /> ${busy ? 'Starting…' : 'Start tunnel'}
            </button>
          </div>
        ` : html`
          <div class="tunnel-live">
            <div class="tunnel-live-head">
              <span class="tunnel-live-state">
                <span class="tunnel-live-dot"></span>
                Live
              </span>
              <span class="tunnel-live-divider">·</span>
              <span class="tunnel-live-provider">${status?.provider === 'devtunnel' ? 'Microsoft Dev Tunnel' : 'Cloudflare Tunnel'}</span>
              <span class="tunnel-live-divider">·</span>
              <span class="tunnel-live-meta">since ${new Date(status.startedAt).toLocaleTimeString()}</span>
              <button type="button" class="tunnel-stop-link"
                      disabled=${busy}
                      onClick=${onStop}>
                <${IconClose} /> ${busy ? 'Stopping…' : 'Stop tunnel'}
              </button>
            </div>
            ${url ? html`
              <div class="tunnel-share">
                <div class="tunnel-share-label">Share URL</div>
                <div class="tunnel-share-url">
                  <code class="tunnel-share-value">${share}</code>
                  <div class="tunnel-share-actions">
                    <button type="button" class="action small" onClick=${() => copy(share)}>
                      <${IconCopy} /> Copy
                    </button>
                    <a class="action small" href=${share} target="_blank" rel="noreferrer noopener">
                      <${IconExternal} /> Open
                    </a>
                  </div>
                </div>
                <div class="tunnel-share-hint">
                  Send this to the remote device · token embedded, stripped from the URL on first arrival.
                </div>
              </div>
            ` : html`
              <div class="tunnel-share is-waiting">
                <div class="signin-card-spinner" aria-hidden="true"></div>
                <span>Waiting for the CLI to print a public URL…</span>
              </div>
            `}
            ${log.length ? html`
              <details class="remote-log tunnel-log">
                <summary>CLI log · ${log.length} lines</summary>
                <pre>${log.join('\n')}</pre>
              </details>
            ` : null}
          </div>
        `}
      </${Section}>

      <${Section}
        title="Registration token"
        meta=${html`Auto-generated. Only used to register new devices — approved devices keep working after a rotate.`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">Token</span>
            <div class="remote-token-row">
              <input type="text" class="input remote-token-input"
                     readonly
                     placeholder="auto-generated on first Start tunnel"
                     value=${token} />
              <button type="button" class="action" title="Mint a fresh token (invalidates outstanding share URLs)"
                      onClick=${onGenerateToken}>
                <${IconRecycle} /> ${token ? 'Rotate' : 'Generate'}
              </button>
              <button type="button" class="action"
                      disabled=${!token}
                      onClick=${() => copy(token)}>
                <${IconCopy} /> Copy
              </button>
            </div>
            <span class="hint">
              ${(!status?.token && !token)
                ? html`No token yet — one is minted automatically the first time you start a tunnel.`
                : html`Active. Rotating it invalidates outstanding share URLs but doesn't kick out devices you've already approved.`}
            </span>
          </div>
        </div>
      </${Section}>

      <${Section}
        title="Devices"
        meta=${html`Approve each new device once.`}>
        ${(() => {
          const pending  = deviceList.filter((d) => d.status === 'pending');
          const approved = deviceList.filter((d) => d.status === 'approved');
          const rejected = deviceList.filter((d) => d.status === 'rejected');
          if (!deviceList.length) {
            return html`<p class="remote-empty">No devices yet. Send the share URL to a phone or another laptop to add the first one.</p>`;
          }
          return html`
            <div class="remote-devices">
              ${pending.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Pending approval</span>
                    <span class="remote-devices-group-count">${pending.length}</span>
                  </div>
                  ${pending.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="pending"
                    onApprove=${() => onApproveDevice(d.id)}
                    onReject=${() => onRejectDevice(d.id)} />`)}
                </div>
              ` : null}
              ${approved.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Approved</span>
                    <span class="remote-devices-group-count">${approved.length}</span>
                  </div>
                  ${approved.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="approved"
                    onRename=${() => onRenameDevice(d)}
                    onRevoke=${() => onRevokeDevice(d)} />`)}
                </div>
              ` : null}
              ${rejected.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Rejected</span>
                    <span class="remote-devices-group-count">${rejected.length}</span>
                    <span class="remote-devices-group-hint">auto-clears 1h after rejection</span>
                  </div>
                  ${rejected.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="rejected"
                    onApprove=${() => onApproveDevice(d.id)}
                    onDelete=${() => onDeleteDevice(d)} />`)}
                </div>
              ` : null}
            </div>`;
        })()}
      </${Section}>

    </div>`;
}
