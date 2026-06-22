import { html } from '../html.js';
import { activeTab, selectTab } from '../state.js';
import { useEffect } from 'preact/hooks';
import { isRemoteAccess } from '../backend.js';
import { PageTitleBar } from './PageTitleBar.js';
import { Sidebar } from './Sidebar.js';
import { Toast } from './Toast.js';
import { DialogHost } from './DialogHost.js';
import { HealthOverlay } from './HealthOverlay.js';
import { PendingApprovalOverlay } from './PendingApprovalOverlay.js';
import { RestartOverlay } from './RestartOverlay.js';
import { MobileNavFab } from './MobileNavFab.js';
import { isMobile, mobileDrawerOpen } from '../state.js';
import { SessionsPage } from '../pages/SessionsPage.js';
import { LaunchPage } from '../pages/LaunchPage.js';
import { ConfigurePage } from '../pages/ConfigurePage.js';
import { RemotePage } from '../pages/RemotePage.js';
import { AboutPage } from '../pages/AboutPage.js';

function Panel({ name, children }) {
  const active = activeTab.value === name;
  return html`<section class="tab-panel" data-panel=${name} data-active=${active || null}>${children}</section>`;
}

// Static placeholder for #remote on tunnel-served pages. Remote / device
// / tunnel management is loopback-only — the server returns 403 on
// every relevant endpoint — so even if a user navigates here via URL
// hash we render a clear "host machine only" message instead of a
// broken RemotePage spamming the console.
function RemoteHostOnlyPanel() {
  useEffect(() => {
    // Bounce back to whatever tab they were on before, after a brief
    // moment so the message is readable.
    const t = setTimeout(() => selectTab('sessions'), 2500);
    return () => clearTimeout(t);
  }, []);
  return html`
    <${PageTitleBar} title="Remote" />
    <div class="settings-scroll">
      <p class="remote-empty" style="margin-top:var(--s-6)">
        Remote management is only available on the host machine.
        Bouncing back to Sessions…
      </p>
    </div>`;
}

export function App() {
  const tab = activeTab.value;
  const remoteLocked = tab === 'remote' && isRemoteAccess();
  const mobile = isMobile.value;
  const drawer = mobileDrawerOpen.value;

  return html`
    <div class=${`app${mobile ? ' is-mobile' : ''}${mobile && drawer ? ' drawer-open' : ''}`}>
      <${Sidebar} />
      <main class="main">
        <div class="content">
          ${tab === 'sessions'  ? html`<${Panel} name="sessions"><${SessionsPage}   /></${Panel}>` : null}
          ${tab === 'launch'    ? html`<${Panel} name="launch"><${LaunchPage}     /></${Panel}>` : null}
          ${tab === 'configure' ? html`<${Panel} name="configure"><${ConfigurePage} /></${Panel}>` : null}
          ${tab === 'remote' && !remoteLocked ? html`<${Panel} name="remote"><${RemotePage} /></${Panel}>` : null}
          ${remoteLocked        ? html`<${Panel} name="remote"><${RemoteHostOnlyPanel} /></${Panel}>` : null}
          ${tab === 'about'     ? html`<${Panel} name="about"><${AboutPage}     /></${Panel}>` : null}
        </div>
      </main>
      <${Toast} />
      <${DialogHost} />
      <${HealthOverlay} />
      <${RestartOverlay} />
      <${PendingApprovalOverlay} />
      <${MobileNavFab} />
    </div>`;
}
