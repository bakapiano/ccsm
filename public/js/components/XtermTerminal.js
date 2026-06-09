// VS Code-style xterm wrapper. Owns the raw xterm.js terminal, renderer
// addons, theme application, and fit/refresh behavior. It intentionally does
// not know about ccsm sessions or WebSockets.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { isDarkTheme } from '../state.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBAR_WIDTH_FALLBACK = 14;

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

let lastKnownGridDimensions = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };

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
      cols: lastKnownGridDimensions.cols,
      rows: lastKnownGridDimensions.rows,
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
    this.scheduleLayout();
    try {
      document.fonts?.ready?.then(() => {
        if (this.host === host) this.scheduleLayout();
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

  scheduleLayout() {
    this.layoutFromElement();
    requestAnimationFrame(() => {
      this.layoutFromElement();
      setTimeout(() => this.layoutFromElement(), 60);
      setTimeout(() => this.layoutFromElement(), 200);
    });
  }

  layoutFromElement() {
    if (!this.host) return null;
    const rect = this.host.getBoundingClientRect();
    return this.layout(rect.width, rect.height);
  }

  layout(width, height) {
    if (!(width > 0 && height > 0)) return null;

    const proposed = this._proposeDimensions(width, height);
    if (!proposed) return null;

    if (proposed.cols !== this.raw.cols || proposed.rows !== this.raw.rows) {
      try { this.raw.resize(proposed.cols, proposed.rows); } catch {}
    }
    lastKnownGridDimensions = proposed;
    return proposed;
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
    try { this.raw.write(data, callback); } catch { callback?.(); }
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

  _proposeDimensions(width, height) {
    const cell = this._cellDimensions();
    if (!cell) return null;

    const elementStyle = this.raw.element
      ? window.getComputedStyle(this.raw.element)
      : null;
    const px = (v) => Number.parseFloat(v || '0') || 0;
    const horizontalPadding = elementStyle
      ? px(elementStyle.paddingLeft) + px(elementStyle.paddingRight)
      : 0;
    const verticalPadding = elementStyle
      ? px(elementStyle.paddingTop) + px(elementStyle.paddingBottom)
      : 0;
    const scrollbarWidth = this._scrollbarWidth();

    const availableWidth = Math.max(0, width - horizontalPadding - scrollbarWidth);
    const availableHeight = Math.max(0, height - verticalPadding);
    if (!(availableWidth > 0 && availableHeight > 0)) return null;

    const dpr = window.devicePixelRatio || 1;
    const scaledWidth = availableWidth * dpr;
    const scaledCellWidth = cell.width * dpr;
    const scaledHeight = availableHeight * dpr;
    const scaledCellHeight = Math.ceil(cell.height * dpr);

    return {
      cols: Math.max(1, Math.floor(scaledWidth / scaledCellWidth)),
      rows: Math.max(1, Math.floor(scaledHeight / scaledCellHeight)),
    };
  }

  _cellDimensions() {
    const cell = this.raw?._core?._renderService?.dimensions?.css?.cell;
    if (cell?.width > 0 && cell?.height > 0) {
      return { width: cell.width, height: cell.height };
    }

    const proposed = (() => {
      try { return this.fitAddon.proposeDimensions?.(); } catch { return null; }
    })();
    if (proposed?.cols > 0 && proposed?.rows > 0 && this.host) {
      const rect = this.host.getBoundingClientRect();
      return {
        width: rect.width / proposed.cols,
        height: rect.height / proposed.rows,
      };
    }
    return null;
  }

  _scrollbarWidth() {
    const core = this.raw?._core;
    const width =
      core?._viewport?.scrollBarWidth ??
      core?.viewport?.scrollBarWidth ??
      0;
    return width > 0 ? width : SCROLLBAR_WIDTH_FALLBACK;
  }
}
