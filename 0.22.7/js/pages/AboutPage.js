import { html } from '../html.js';
import { serverHealth, installPrompt, isInstalledPwa } from '../state.js';
import { setToast } from '../toast.js';
import { Card } from '../components/Card.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { BrandMark, IconGithub, IconExternal } from '../icons.js';

const REPO_URL = 'https://github.com/bakapiano/ccsm';
const NPM_URL  = 'https://www.npmjs.com/package/@bakapiano/ccsm';

async function onInstall() {
  const ev = installPrompt.value;
  if (!ev) return setToast('install prompt not available right now · try opening this URL in a regular Edge tab', 'error');
  ev.prompt();
  const { outcome } = await ev.userChoice;
  installPrompt.value = null;
  if (outcome === 'accepted') {
    setToast('installed · close + relaunch via npx ccsm to enable Window Controls Overlay');
  }
}

function InstallCard() {
  if (isInstalledPwa.value) return null;
  const canPrompt = !!installPrompt.value;
  return html`
    <${Card} title="Install as app">
      <p class="about-copy" style="margin-bottom: var(--s-3);">
        ccsm runs best as a Chromium PWA — title bar collapses into the page (Window Controls Overlay),
        and the launch shortcut becomes a standalone app. One-click install on supported browsers below.
      </p>
      <div class="about-links">
        <button class="action ${canPrompt ? 'primary' : 'subtle'}" onClick=${onInstall} disabled=${!canPrompt}>
          ${canPrompt ? 'Install ccsm' : 'Install not available'}
        </button>
      </div>
      ${!canPrompt ? html`
        <p class="muted-text" style="margin-top: var(--s-3);">
          If the button stays disabled: open <code>http://localhost:7777</code> in a regular Edge tab,
          click the address-bar install icon (⊕), then re-launch via <code>npx ccsm</code>.
        </p>` : null}
    </${Card}>`;
}

export function AboutPage() {
  const version = serverHealth.value.version;

  return html`
    <${PageTitleBar} title="About" />
    <${InstallCard} />
    <${Card} title="ccsm">
      <div class="about-block">
        <div class="about-hero">
          <span class="about-mark"><${BrandMark} /></span>
          <div>
            <div class="about-name">ccsm <span class="about-version">${version ? `v${version}` : ''}</span></div>
            <div class="about-tagline">Claude Code Session Manager · a single pane over every live <code>claude</code> session on this box.</div>
          </div>
        </div>

        <p class="about-copy">
          Lists live and recently-closed sessions, snapshots them every minute, restores them through Windows Terminal,
          and launches fresh sessions inside isolated workspaces. Designed for running 8–10 concurrent sessions across
          ad-hoc repo clones.
        </p>

        <div class="about-links">
          <a class="action" href=${REPO_URL} target="_blank" rel="noopener">
            <${IconGithub} /> GitHub <${IconExternal} />
          </a>
          <a class="action subtle" href=${NPM_URL} target="_blank" rel="noopener">
            npm <${IconExternal} />
          </a>
        </div>

        <dl class="about-meta">
          <dt>Install</dt>
          <dd><code>npx @bakapiano/ccsm</code></dd>
          <dt>Data directory</dt>
          <dd><code>~/.ccsm/</code> (override with <code>CCSM_HOME</code>)</dd>
          <dt>Platform</dt>
          <dd>Windows · Node 18+</dd>
          <dt>License</dt>
          <dd>MIT</dd>
        </dl>
      </div>
    </${Card}>
    <p class="muted-text" style="margin-top: var(--s-3); text-align:center;">
      Looking for upgrade controls? They moved to <strong>Settings → General → Version</strong>.
    </p>`;
}
