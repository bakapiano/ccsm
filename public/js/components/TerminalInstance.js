// VS Code-style terminal instance lifecycle for a single ccsm session.
// Owns attach/detach, WebSocket transport, xterm input/output forwarding,
// resize propagation, paste handling, and browser/mobile lifecycle hooks.

import { wsBase, getToken, getDeviceId } from '../backend.js';
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
    this.disposables = [];
    this.helperTextarea = null;
  }

  attachToElement(host) {
    this.host = host;
    this.xterm.attachToElement(host);
    this._registerColorOscHandlers();
    this._connect();
    this._wireXtermEvents();
    this._wireDomLifecycle();
    this.xterm.focus();
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

  dispose() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
      this.xterm.scheduleFit();
      this._sendFrame({ type: 'resize', cols: this.xterm.cols, rows: this.xterm.rows });
    };
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'output') {
        this.xterm.write(frame.data);
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
      this._sendFrame({ type: 'input', data });
    });
    const resizeDisposable = this.xterm.onResize(({ cols, rows }) => {
      this._sendFrame({ type: 'resize', cols, rows });
    });
    this.disposables.push(
      () => dataDisposable.dispose(),
      () => resizeDisposable.dispose(),
    );
  }

  _wireDomLifecycle() {
    const host = this.host;
    const ro = new ResizeObserver(() => this.xterm.fit());
    ro.observe(host);
    this.disposables.push(() => ro.disconnect());

    const vv = window.visualViewport;
    const onVisualResize = () => this.xterm.scheduleFit();
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
    this._wirePasteHandlers(host);
    this._wireModifiedEnterHandler(host);
    this._wireCompositionHandlers();
  }

  _wireTabVisibilityRefresh(host) {
    const panel = host.closest('.tab-panel');
    if (!panel) return;
    const panelMo = new MutationObserver(() => {
      if (panel.hasAttribute('data-active')) {
        requestAnimationFrame(() => {
          this.xterm.clearTextureAtlas();
          this.xterm.scheduleFit();
          this.xterm.refresh();
        });
      }
    });
    panelMo.observe(panel, { attributes: true, attributeFilter: ['data-active'] });
    this.disposables.push(() => panelMo.disconnect());
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
