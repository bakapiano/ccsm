// VS Code-style xterm wrapper. Owns the raw xterm.js terminal, renderer
// addons, theme application, and fit/refresh behavior. It intentionally does
// not know about ccsm sessions or WebSockets.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { isDarkTheme } from '../state.js';

// Dark xterm theme - VSCode's Dark+ terminal palette, verbatim (see
// microsoft/vscode src/.../terminal/common/terminalColorRegistry.ts).
const THEME_DARK = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor:     '#aeafad',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black:   '#000000', brightBlack:   '#666666',
  red:     '#cd3131', brightRed:     '#f14c4c',
  green:   '#0dbc79', brightGreen:   '#23d18b',
  yellow:  '#e5e510', brightYellow:  '#f5f543',
  blue:    '#2472c8', brightBlue:    '#3b8eea',
  magenta: '#bc3fbc', brightMagenta: '#d670d6',
  cyan:    '#11a8cd', brightCyan:    '#29b8db',
  white:   '#e5e5e5', brightWhite:   '#e5e5e5',
};

// Light xterm theme - VSCode's Light+ terminal palette, verbatim (see
// microsoft/vscode src/.../terminal/common/terminalColorRegistry.ts).
const THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#333333',
  cursor:     '#000000',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black:   '#000000', brightBlack:   '#666666',
  red:     '#cd3131', brightRed:     '#cd3131',
  green:   '#107c10', brightGreen:   '#14ce14',
  yellow:  '#949800', brightYellow:  '#b5ba00',
  blue:    '#0451a5', brightBlue:    '#0451a5',
  magenta: '#bc05bc', brightMagenta: '#bc05bc',
  cyan:    '#0598bc', brightCyan:    '#0598bc',
  white:   '#555555', brightWhite:   '#a5a5a5',
};

export const themeFor = (dark) => (dark ? THEME_DARK : THEME_LIGHT);

export class XtermTerminal {
  constructor() {
    this.isMobile = window.matchMedia('(max-width: 640px)').matches;
    this.currentTheme = themeFor(isDarkTheme());
    this.fitAddon = new FitAddon();
    this.webglAddon = null;
    this.host = null;

    this.raw = new Terminal({
      fontFamily: '"Cascadia Mono", "Geist Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: this.isMobile ? 11 : 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: this.currentTheme,
      // Same modern keyboard protocols VS Code enables when configured.
      vtExtensions: {
        kittyKeyboard: true,
        win32InputMode: true,
      },
    });

    this.raw.loadAddon(this.fitAddon);
    this.raw.loadAddon(new WebLinksAddon());
    this.raw.loadAddon(new ClipboardAddon());
    this._loadRendererAddon();
    this._installSelectionCopyGuard();
  }

  get cols() { return this.raw.cols; }
  get rows() { return this.raw.rows; }
  get theme() { return this.currentTheme; }
  get parser() { return this.raw.parser; }
  get helperTextarea() {
    return this.host?.querySelector('.xterm-helper-textarea') || null;
  }

  attachToElement(host) {
    this.host = host;
    this.raw.open(host);
    this.scheduleFit();
    try {
      document.fonts?.ready?.then(() => {
        if (this.host === host) this.scheduleFit();
      });
    } catch {}
  }

  applyResolvedTheme() {
    const theme = themeFor(isDarkTheme());
    this.currentTheme = theme;
    try { this.raw.options.theme = theme; } catch {}
    return theme;
  }

  setCursorVisible(visible) {
    if (visible) {
      try { this.raw.options.theme = this.currentTheme; } catch {}
      try { this.raw.write('\x1b[?25h'); } catch {}
      return;
    }
    try {
      this.raw.options.theme = {
        ...this.currentTheme,
        cursor: 'transparent',
        cursorAccent: 'transparent',
      };
    } catch {}
    try { this.raw.write('\x1b[?25l'); } catch {}
  }

  scheduleFit() {
    this.fit();
    requestAnimationFrame(() => {
      this.fit();
      setTimeout(() => this.fit(), 60);
      setTimeout(() => this.fit(), 200);
    });
  }

  fit() {
    try { this.fitAddon.fit(); } catch {}
  }

  refresh() {
    try { this.raw.refresh(0, this.raw.rows - 1); } catch {}
  }

  clearTextureAtlas() {
    try { this.raw.clearTextureAtlas?.(); } catch {}
  }

  write(data, callback) {
    try { this.raw.write(data, callback); } catch {}
  }

  reset() {
    try { this.raw.reset(); } catch {}
  }

  focus() {
    try { this.raw.focus(); } catch {}
  }

  onData(listener) {
    return this.raw.onData(listener);
  }

  onResize(listener) {
    return this.raw.onResize(listener);
  }

  hasSelection() {
    return this.raw.hasSelection();
  }

  dispose() {
    this.host = null;
    try { this.raw.dispose(); } catch {}
  }

  _loadRendererAddon() {
    // Keep the current mobile guard: @xterm/addon-webgl@0.18 can mis-measure
    // glyph atlases on fractional mobile DPRs.
    if (this.isMobile) return;
    try {
      const webgl = new WebglAddon();
      this.webglAddon = webgl;
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      this.raw.loadAddon(webgl);
    } catch (e) {
      console.warn('[ccsm] WebGL addon failed, using DOM renderer:', e);
    }
  }

  _installSelectionCopyGuard() {
    this.raw.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown'
          && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey
          && ev.key.toLowerCase() === 'c'
          && this.raw.hasSelection()) {
        return false;
      }
      return true;
    });
  }
}
