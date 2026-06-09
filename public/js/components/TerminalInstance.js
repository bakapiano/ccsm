// VS Code-style terminal instance lifecycle for a single ccsm session.
// Owns attach/detach, WebSocket transport, xterm input/output forwarding,
// resize propagation, paste handling, and browser/mobile lifecycle hooks.

import { wsBase, getToken, getDeviceId } from '../backend.js';
import { TerminalResizeDebouncer } from './TerminalResizeDebouncer.js';
import { XtermTerminal } from './XtermTerminal.js';

export class TerminalInstance {
  constructor({ terminalId, cliType, onDisplaced }) {
    this.terminalId = terminalId;
    this.cliType = cliType;
    this.onDisplaced = onDisplaced;
    this.xterm = new XtermTerminal();
    this.ws = null;
    this.host = null;
    this.closedByUs = false;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.everOpened = false;
    this.inReplay = false;
    this.replayDepth = 0;
    this.isVisible = false;
    this.lastLayoutDimensions = null;
    this.lastSentDimensions = null;
    this.pendingLayoutFrame = null;
    this.layoutRetryTimers = new Set();
    this.disposables = [];
    this.helperTextarea = null;
    this.resizeDebouncer = new TerminalResizeDebouncer({
      isVisible: () => this.isVisible,
      getXterm: () => this.xterm,
      resizeBoth: (cols, rows) => this._applyResize(cols, rows),
      resizeX: (cols) => this._applyResize(cols, this.xterm.rows),
      resizeY: (rows) => this._applyResize(this.xterm.cols, rows),
    });
    const refreshDisposable = this.xterm.onDidRequestRefreshDimensions(() => {
      this.scheduleLayout({ immediate: this.isVisible, retries: true });
    });
    this.disposables.push(() => refreshDisposable.dispose());
  }

  attachToElement(host) {
    this.host = host;
    this.xterm.attachToElement(host);
    this._registerColorOscHandlers();
    this._wireXtermEvents();
    this._wireDomLifecycle();
    this.setVisible(this._isHostVisible());
    this._connect();
    if (this.isVisible) this.xterm.focus();
  }

  sendInput(data) {
    this._sendFrame({ type: 'input', data });
  }

  setCliType(cliType) {
    this.cliType = cliType;
  }

  applyTheme() {
    this.xterm.applyResolvedTheme();
  }

  layout(width, height, immediate = false) {
    const layoutDimensions = this._resolveLayoutDimensions(width, height);
    if (!layoutDimensions) return null;

    this.lastLayoutDimensions = layoutDimensions;
    const proposed = this.xterm.proposeDimensions(layoutDimensions.width, layoutDimensions.height);
    if (!proposed) return null;

    this.resizeDebouncer.resize(proposed.cols, proposed.rows, immediate);
    return proposed;
  }

  scheduleLayout(options = {}) {
    const { immediate = false, retries = false, forceRedraw = false } =
      typeof options === 'boolean' ? { immediate: options } : options;
    if (this.closedByUs) return null;

    if (immediate) {
      this._cancelScheduledLayout();
      const result = this.layout(undefined, undefined, true);
      if (forceRedraw) this.xterm.forceRedraw();
      if (retries) this._scheduleLayoutRetries(forceRedraw);
      return result;
    }

    if (this.pendingLayoutFrame === null) {
      this.pendingLayoutFrame = requestAnimationFrame(() => {
        this.pendingLayoutFrame = null;
        this.layout();
        if (forceRedraw) this.xterm.forceRedraw();
      });
    }
    if (retries) this._scheduleLayoutRetries(forceRedraw);
    return null;
  }

  setVisible(visible) {
    const nextVisible = !!visible;
    const didChange = this.isVisible !== nextVisible;
    this.isVisible = nextVisible;
    this.host?.classList.toggle('active', nextVisible);

    if (nextVisible) {
      this.resizeDebouncer.flush();
      this.scheduleLayout({ immediate: true, retries: true, forceRedraw: true });
    }
    return didChange;
  }

  dispose() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._cancelScheduledLayout();
    this.resizeDebouncer.dispose();
    for (const dispose of this.disposables.splice(0)) {
      try { dispose(); } catch {}
    }
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.helperTextarea = null;
    this.xterm.dispose();
  }

  _connect() {
    const ws = new WebSocket(this._wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.everOpened) {
        this.xterm.reset();
      }
      this.everOpened = true;
      this.attempts = 0;
      this.scheduleLayout({ immediate: true, retries: true });
      this._sendResize(this.xterm.cols, this.xterm.rows, true);
    };
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'output') {
        this._writeProcessData(frame.data, !!frame.replay);
      } else if (frame.type === 'exit') {
        this.xterm.write(`\r\n\x1b[2m[process exited · code ${frame.code}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = (ev) => this._handleClose(ev);
  }

  _handleClose(ev) {
    if (this.closedByUs) return;
    if (ev && ev.code === 4001) {
      this.onDisplaced?.();
      return;
    }
    if (ev && ev.code === 4404) {
      this.xterm.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      return;
    }
    this.attempts++;
    const delay = Math.min(8000, 500 * 2 ** Math.min(this.attempts - 1, 4));
    this.xterm.write('\r\n\x1b[2m[disconnected · reconnecting…]\x1b[0m\r\n');
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByUs) this._connect();
    }, delay);
  }

  _wireXtermEvents() {
    const dataDisposable = this.xterm.onData((data) => {
      if (this.inReplay) return;
      this._sendFrame({ type: 'input', data });
    });
    const resizeDisposable = this.xterm.onResize(({ cols, rows }) => {
      this._sendResize(cols, rows);
    });
    this.disposables.push(
      () => dataDisposable.dispose(),
      () => resizeDisposable.dispose(),
    );
  }

  _wireDomLifecycle() {
    const host = this.host;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        this.layout(box.width, box.height);
      } else {
        this.layout();
      }
    });
    ro.observe(host);
    this.disposables.push(() => ro.disconnect());

    const vv = window.visualViewport;
    const onVisualResize = () => this.scheduleLayout({ retries: true });
    vv?.addEventListener?.('resize', onVisualResize);
    vv?.addEventListener?.('scroll', onVisualResize);
    this.disposables.push(() => {
      vv?.removeEventListener?.('resize', onVisualResize);
      vv?.removeEventListener?.('scroll', onVisualResize);
    });

    const onHostClick = () => this.xterm.focus();
    if (this.xterm.isMobile) {
      host.addEventListener('click', onHostClick);
      this.disposables.push(() => host.removeEventListener('click', onHostClick));
    }

    this._wireTabVisibilityRefresh(host);
    this._wireDocumentVisibilityRefresh();
    this._wirePasteHandlers(host);
    this._wireModifiedEnterHandler(host);
    this._wireCompositionHandlers();
  }

  _wireTabVisibilityRefresh(host) {
    const panel = host.closest('.tab-panel');
    if (!panel) return;
    const panelMo = new MutationObserver(() => {
      this.setVisible(this._isHostVisible());
    });
    panelMo.observe(panel, { attributes: true, attributeFilter: ['data-active'] });
    this.disposables.push(() => panelMo.disconnect());
  }

  _wireDocumentVisibilityRefresh() {
    const onVisibilityChange = () => {
      this.setVisible(!document.hidden && this._isHostVisible());
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onVisibilityChange);
    this.disposables.push(
      () => document.removeEventListener('visibilitychange', onVisibilityChange),
      () => window.removeEventListener('focus', onVisibilityChange),
    );
  }

  _wirePasteHandlers(host) {
    const isOurs = () => {
      const ae = document.activeElement;
      return ae && host.contains(ae);
    };
    const doPaste = (text) => {
      if (!text) return;
      const normalized = text.replace(/\r?\n/g, '\r');
      this.sendInput(`\x1b[200~${normalized}\x1b[201~`);
    };
    const onPaste = async (ev) => {
      if (!isOurs()) return;
      let text = '';
      if (ev.clipboardData) text = ev.clipboardData.getData('text');
      if (!text && navigator.clipboard) {
        try { text = await navigator.clipboard.readText(); } catch {}
      }
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      doPaste(text);
    };
    const onKey = (ev) => {
      const meta = ev.ctrlKey || ev.metaKey;
      if (!meta || ev.key.toLowerCase() !== 'v') return;
      if (ev.shiftKey || ev.altKey) return;
      if (!isOurs()) return;
      if (!navigator.clipboard?.readText) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      navigator.clipboard.readText().then((text) => {
        if (text) doPaste(text);
      }).catch(() => {});
    };
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKey, true);
    this.disposables.push(
      () => document.removeEventListener('paste', onPaste, true),
      () => document.removeEventListener('keydown', onKey, true),
    );
  }

  _wireModifiedEnterHandler(host) {
    const isOurs = () => {
      const ae = document.activeElement;
      return ae && host.contains(ae);
    };
    const onShiftEnter = (ev) => {
      if (ev.key !== 'Enter') return;
      if (!(ev.shiftKey || ev.ctrlKey)) return;
      if (ev.metaKey || ev.altKey) return;
      if (!isOurs()) return;
      const data = this.cliType === 'claude' ? '\n' : '\x1b\r';
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      this.sendInput(data);
    };
    document.addEventListener('keydown', onShiftEnter, true);
    this.disposables.push(() => document.removeEventListener('keydown', onShiftEnter, true));
  }

  _wireCompositionHandlers() {
    const helper = this.xterm.helperTextarea;
    this.helperTextarea = helper;
    if (!helper) return;
    const onCompStart = () => this.xterm.setCursorVisible(false);
    const onCompEnd = () => this.xterm.setCursorVisible(true);
    helper.addEventListener('compositionstart', onCompStart);
    helper.addEventListener('compositionend', onCompEnd);
    this.disposables.push(() => {
      helper.removeEventListener('compositionstart', onCompStart);
      helper.removeEventListener('compositionend', onCompEnd);
    });
  }

  _registerColorOscHandlers() {
    const answerColorOsc = (code, getHex) => (data) => {
      if (data !== '?') return false;
      if (this.inReplay) return true;
      const hex = getHex();
      const ch = (i) => parseInt(hex.slice(i, i + 2), 16);
      const w = (v) => (v * 257).toString(16).padStart(4, '0');
      const reply = `\x1b]${code};rgb:${w(ch(1))}/${w(ch(3))}/${w(ch(5))}\x07`;
      this.sendInput(reply);
      return true;
    };
    try {
      this.xterm.parser.registerOscHandler(11, answerColorOsc(11, () => this.xterm.theme.background));
      this.xterm.parser.registerOscHandler(10, answerColorOsc(10, () => this.xterm.theme.foreground));
    } catch {}
  }

  _sendFrame(frame) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  _sendResize(cols, rows, force = false) {
    if (!(cols > 0 && rows > 0)) return;
    if (!force
        && this.lastSentDimensions
        && this.lastSentDimensions.cols === cols
        && this.lastSentDimensions.rows === rows) {
      return;
    }
    this.lastSentDimensions = { cols, rows };
    this._sendFrame({ type: 'resize', cols, rows });
  }

  _writeProcessData(data, replay) {
    if (!replay) {
      this.xterm.write(data);
      return;
    }
    this._beginReplay();
    this.xterm.write(data, () => {
      this._endReplay();
    });
  }

  _beginReplay() {
    this.replayDepth++;
    this.inReplay = true;
  }

  _endReplay() {
    this.replayDepth = Math.max(0, this.replayDepth - 1);
    this.inReplay = this.replayDepth > 0;
  }

  _applyResize(cols, rows) {
    if (this.closedByUs) return;
    if (!(cols > 0 && rows > 0)) return;
    this.xterm.resize(cols, rows);
    this._sendResize(this.xterm.cols, this.xterm.rows);
  }

  _resolveLayoutDimensions(width, height) {
    if (width > 0 && height > 0) {
      return { width, height };
    }
    if (!this.host) return null;
    const rect = this.host.getBoundingClientRect();
    const resolvedWidth = rect.width || this.host.clientWidth;
    const resolvedHeight = rect.height || this.host.clientHeight;
    if (!(resolvedWidth > 0 && resolvedHeight > 0)) return null;
    return { width: resolvedWidth, height: resolvedHeight };
  }

  _scheduleLayoutRetries(forceRedraw = false) {
    this._clearLayoutRetryTimers();
    for (const delay of [60, 200]) {
      const timer = setTimeout(() => {
        this.layoutRetryTimers.delete(timer);
        this.layout(undefined, undefined, true);
        if (forceRedraw) this.xterm.forceRedraw();
      }, delay);
      this.layoutRetryTimers.add(timer);
    }
  }

  _cancelScheduledLayout() {
    if (this.pendingLayoutFrame !== null) {
      cancelAnimationFrame(this.pendingLayoutFrame);
      this.pendingLayoutFrame = null;
    }
    this._clearLayoutRetryTimers();
  }

  _clearLayoutRetryTimers() {
    for (const timer of this.layoutRetryTimers) clearTimeout(timer);
    this.layoutRetryTimers.clear();
  }

  _isHostVisible() {
    if (!this.host || !this.host.isConnected || document.hidden) return false;
    const panel = this.host.closest('.tab-panel');
    if (panel && !panel.hasAttribute('data-active')) return false;
    const style = window.getComputedStyle(this.host);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  _wsUrl() {
    const tok = getToken();
    const dev = getDeviceId();
    const params = new URLSearchParams();
    if (tok) params.set('token', tok);
    if (dev) params.set('device', dev);
    const qs = params.toString();
    return `${wsBase()}/ws/terminal/${encodeURIComponent(this.terminalId)}${qs ? `?${qs}` : ''}`;
  }
}
