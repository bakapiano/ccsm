// SVG icon components. Each accepts {size, className} but most callers
// just take the default — sizing happens via CSS.

import { html } from './html.js';

const ic = (vb, body, defaultSize = 16) => ({ size = defaultSize, className = '', stroke = 1.6, fill = 'none' } = {}) =>
  html`<svg viewBox=${vb} width=${size} height=${size} fill=${fill} stroke="currentColor"
            stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" class=${className} aria-hidden="true">${body}</svg>`;

export const IconSessions = ic('0 0 24 24', html`
  <line x1="3" y1="6" x2="21" y2="6"/>
  <line x1="3" y1="12" x2="21" y2="12"/>
  <line x1="3" y1="18" x2="14" y2="18"/>
`, 18);

export const IconLaunch = ic('0 0 24 24', html`
  <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>
  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
`, 18);

export const IconConfigure = ic('0 0 24 24', html`
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
`, 18);

export const IconRefresh = ic('0 0 24 24', html`
  <polyline points="23 4 23 10 17 10"/>
  <polyline points="1 20 1 14 7 14"/>
  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
`, 16);

export const IconChevronLeft = ic('0 0 24 24', html`<polyline points="15 18 9 12 15 6"/>`, 14);
export const IconChevronRight = ic('0 0 24 24', html`<polyline points="9 18 15 12 9 6"/>`, 14);
export const IconChevronUp = ic('0 0 24 24', html`<polyline points="18 15 12 9 6 15"/>`, 14);
export const IconChevronDown = ic('0 0 24 24', html`<polyline points="6 9 12 15 18 9"/>`, 14);
export const IconArrowRight = ic('0 0 24 24', html`<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>`, 14);
export const IconHome = ic('0 0 24 24', html`
  <path d="M3 11l9-8 9 8"/>
  <path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>
`, 14);
export const IconSparkle = ic('0 0 24 24', html`
  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>
  <path d="M19 17l.8 1.6L21 20l-1.2.4L19 22l-.8-1.6L17 20l1.2-.4z"/>
`, 18);
// "Workspace" — stacked layers / cube. Used for the launch-page
// destination pill so it doesn't clash with the folder-tag pill that
// uses IconFolder.
export const IconWorkspace = ic('0 0 24 24', html`
  <path d="M12 2l9 5-9 5-9-5z"/>
  <path d="M3 12l9 5 9-5"/>
  <path d="M3 17l9 5 9-5"/>
`, 16);
// Sidebar-toggle icon (panel-left). A rectangle with a vertical divider
// near the left — universally recognised "show/hide sidebar" affordance
// (Notion, Codex, Linear all use this shape).
export const IconSidebarToggle = ic('0 0 24 24', html`
  <rect x="3" y="4" width="18" height="16" rx="2"/>
  <line x1="9" y1="4" x2="9" y2="20"/>
`, 14);

export const IconSearch = ic('0 0 24 24', html`
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
`, 14);

export const IconClose = ic('0 0 24 24', html`
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
`, 18);

export const IconPlus = ic('0 0 24 24', html`
  <line x1="12" y1="5" x2="12" y2="19"/>
  <line x1="5" y1="12" x2="19" y2="12"/>
`, 22);

// Folder + folder-open. Used in the sidebar session tree to mirror the
// icon-first style of the top nav items. Open variant for expanded
// folders so the chevron isn't doing double duty.
export const IconFolder = ic('0 0 24 24', html`
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
`, 16);
export const IconFolderOpen = ic('0 0 24 24', html`
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/>
  <path d="M3 10h18l-2 7a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 17V10z"/>
`, 16);

export const IconPencil = ic('0 0 24 24', html`
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
`, 13);

export const IconInfo = ic('0 0 24 24', html`
  <circle cx="12" cy="12" r="10"/>
  <line x1="12" y1="16" x2="12" y2="12"/>
  <line x1="12" y1="8" x2="12.01" y2="8"/>
`, 18);

export const IconGithub = ic('0 0 24 24', html`
  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
`, 16);

export const IconExternal = ic('0 0 24 24', html`
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  <polyline points="15 3 21 3 21 9"/>
  <line x1="10" y1="14" x2="21" y2="3"/>
`, 13);

// Monitor outline — used on "Focus" buttons since the action raises an
// existing terminal window. Reads as "go to that window".
export const IconMonitor = ic('0 0 24 24', html`
  <rect x="3" y="4" width="18" height="12" rx="2" ry="2"/>
  <line x1="8" y1="20" x2="16" y2="20"/>
  <line x1="12" y1="16" x2="12" y2="20"/>
`, 13);

// "> _" terminal prompt — for the Terminals nav tab
export const IconTerminal = ic('0 0 24 24', html`
  <polyline points="4 17 10 11 4 5"/>
  <line x1="12" y1="19" x2="20" y2="19"/>
`, 18);

// Git branch — for repo selection
export const IconBranch = ic('0 0 24 24', html`
  <line x1="6" y1="3" x2="6" y2="15"/>
  <circle cx="18" cy="6" r="3"/>
  <circle cx="6" cy="18" r="3"/>
  <path d="M18 9a9 9 0 0 1-9 9"/>
`, 18);
export const IconMoreVert = ic('0 0 24 24', html`
  <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>
`, 16);

// Broadcast / remote — radiating arcs over a centre dot. Used on the
// Remote nav tab; reads as "this machine is broadcasting" / "remote
// access available".
export const IconRemote = ic('0 0 24 24', html`
  <circle cx="18" cy="5" r="2.5"/>
  <circle cx="6" cy="12" r="2.5"/>
  <circle cx="18" cy="19" r="2.5"/>
  <line x1="8.2" y1="10.8" x2="15.8" y2="6.2"/>
  <line x1="8.2" y1="13.2" x2="15.8" y2="17.8"/>
`, 18);

// Copy — two stacked rectangles. For "copy to clipboard" affordance
// next to URLs / tokens in the Remote page.
export const IconCopy = ic('0 0 24 24', html`
  <rect x="9" y="9" width="11" height="11" rx="2"/>
  <path d="M5 15V6a2 2 0 0 1 2-2h9"/>
`, 13);

// Recycle / regenerate — for "regenerate token" button.
export const IconRecycle = ic('0 0 24 24', html`
  <polyline points="23 4 23 10 17 10"/>
  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
`, 14);

// Brand-colored CLI marks. These use external SVG assets (full color),
// rendered as <img> so the gradients / fills in the file are preserved.
export const IconClaudeColor = () => html`
  <img src="./assets/claude-color.svg" alt="" width="18" height="18" style="display:block" />`;
export const IconCodexColor = () => html`
  <img src="./assets/codex-color.svg" alt="" width="18" height="18" style="display:block" />`;
export const IconCopilotColor = () => html`
  <img src="./assets/copilot-color.svg" alt="" width="18" height="18" style="display:block" />`;
export const IconCloudflareColor = ({ size = 28 } = {}) => html`
  <img src="./assets/cloudflare-color.svg" alt="" width=${size} height=${size} style="display:block" />`;
export const IconMicrosoftColor = ({ size = 28 } = {}) => html`
  <img src="./assets/microsoft-color.svg" alt="" width=${size} height=${size} style="display:block" />`;

// Pick the right icon for a CLI based on its type field.
export const IconForCliType = (type) => {
  if (type === 'claude')  return IconClaudeColor;
  if (type === 'codex')   return IconCodexColor;
  if (type === 'copilot') return IconCopilotColor;
  return IconTerminal;
};

// Two variants used in the StarButton.
export const StarOutline = ({ size = 15 } = {}) => html`
  <svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

export const StarFilled = ({ size = 15 } = {}) => html`
  <svg viewBox="0 0 24 24" width=${size} height=${size} fill="currentColor" stroke="currentColor"
       stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

// Used as the favorites card title decoration
export const StarSmallFilled = ({ size = 14 } = {}) => html`
  <svg class="title-icon title-icon-after" viewBox="0 0 24 24" width=${size} height=${size} fill="currentColor" stroke="none" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

// brand mark (terminal window + ccsm text — matches /favicon.svg)
export const BrandMark = () => html`
  <svg viewBox="0 0 32 32" width="32" height="32">
    <rect x="2" y="4" width="28" height="24" rx="3" fill="#1a1815"/>
    <line x1="2" y1="10" x2="30" y2="10" stroke="#faf9f5" stroke-width="0.6" opacity="0.45"/>
    <!-- macOS traffic-light style: red / yellow / green -->
    <circle cx="6"   cy="7" r="1" fill="#ed6a5e"/>
    <circle cx="9.5" cy="7" r="1" fill="#f4be4f"/>
    <circle cx="13"  cy="7" r="1" fill="#62c554"/>
    <text x="16" y="19.5" text-anchor="middle" dominant-baseline="central"
          font-family="'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace"
          font-weight="700" font-size="10" fill="#faf9f5">ccsm</text>
  </svg>`;
