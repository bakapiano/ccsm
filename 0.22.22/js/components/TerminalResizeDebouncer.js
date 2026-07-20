const START_DEBOUNCING_THRESHOLD = 200;
const DEBOUNCE_RESIZE_X_DELAY = 100;

export class TerminalResizeDebouncer {
  constructor({ isVisible, getXterm, resizeBoth, resizeX, resizeY }) {
    this.isVisible = isVisible;
    this.getXterm = getXterm;
    this.resizeBoth = resizeBoth;
    this.resizeX = resizeX;
    this.resizeY = resizeY;
    this.latestX = 0;
    this.latestY = 0;
    this.resizeXTimer = null;
    this.resizeXIdle = null;
    this.resizeYIdle = null;
    this.disposed = false;
  }

  resize(cols, rows, immediate = false) {
    if (this.disposed) return;
    this.latestX = cols;
    this.latestY = rows;

    const xterm = this.getXterm();
    const normalBufferLength = xterm?.normalBufferLength ?? 0;
    if (immediate || normalBufferLength < START_DEBOUNCING_THRESHOLD) {
      this._clearPending();
      this.resizeBoth(cols, rows);
      return;
    }

    if (!this.isVisible()) {
      this._scheduleIdleResizeX();
      this._scheduleIdleResizeY();
      return;
    }

    this._cancelIdleResizeY();
    this.resizeY(rows);
    this._scheduleDebouncedResizeX();
  }

  flush() {
    if (this.disposed) return;
    if (!this._hasPending()) return;
    this._clearPending();
    this.resizeBoth(this.latestX, this.latestY);
  }

  dispose() {
    this.disposed = true;
    this._clearPending();
  }

  _hasPending() {
    return this.resizeXTimer !== null || this.resizeXIdle !== null || this.resizeYIdle !== null;
  }

  _clearPending() {
    this._cancelDebouncedResizeX();
    this._cancelIdleResizeX();
    this._cancelIdleResizeY();
  }

  _scheduleDebouncedResizeX() {
    this._cancelIdleResizeX();
    if (this.resizeXTimer !== null) clearTimeout(this.resizeXTimer);
    this.resizeXTimer = setTimeout(() => {
      this.resizeXTimer = null;
      if (!this.disposed) this.resizeX(this.latestX);
    }, DEBOUNCE_RESIZE_X_DELAY);
  }

  _cancelDebouncedResizeX() {
    if (this.resizeXTimer !== null) {
      clearTimeout(this.resizeXTimer);
      this.resizeXTimer = null;
    }
  }

  _scheduleIdleResizeX() {
    this._cancelDebouncedResizeX();
    if (this.resizeXIdle !== null) return;
    this.resizeXIdle = this._requestIdle(() => {
      this.resizeXIdle = null;
      if (!this.disposed) this.resizeX(this.latestX);
    });
  }

  _scheduleIdleResizeY() {
    if (this.resizeYIdle !== null) return;
    this.resizeYIdle = this._requestIdle(() => {
      this.resizeYIdle = null;
      if (!this.disposed) this.resizeY(this.latestY);
    });
  }

  _cancelIdleResizeX() {
    if (this.resizeXIdle !== null) {
      this._cancelIdle(this.resizeXIdle);
      this.resizeXIdle = null;
    }
  }

  _cancelIdleResizeY() {
    if (this.resizeYIdle !== null) {
      this._cancelIdle(this.resizeYIdle);
      this.resizeYIdle = null;
    }
  }

  _requestIdle(callback) {
    if (window.requestIdleCallback) {
      return { kind: 'idle', id: window.requestIdleCallback(callback) };
    }
    return { kind: 'timeout', id: setTimeout(callback, 50) };
  }

  _cancelIdle(handle) {
    if (handle.kind === 'idle') {
      window.cancelIdleCallback?.(handle.id);
    } else {
      clearTimeout(handle.id);
    }
  }
}
