'use strict';

// ccsm in-process PTY pool. Used by the "web terminal" launch path:
// claude (or any cmd) runs as a child of ccsm and its stdio is bridged
// to one or more WebSocket clients via xterm.js in the browser.
//
// Lifecycle: a PTY entry is created by spawn(), broadcasts every output
// chunk to all attached sockets, keeps a rolling history ring so a fresh
// connection can replay recent output. attach() wires a websocket to an
// entry, kill() ends a PTY explicitly, list() returns metadata for UI.
//
// node-pty is optional (Windows native binary). If it failed to load,
// `available` is false and spawn() throws — server.js gates the
// /api/sessions/web route on this flag so install failures degrade
// gracefully to wt-only mode.

const path = require('node:path');

let pty = null;
let loadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  loadError = e;
}

const HISTORY_BYTES = 256 * 1024;

// Map<id, { id, pty, history, sockets:Set<ws>, meta }>
const sessions = new Map();

function genId() {
  return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}



// Spawn a new PTY. `command` and `args` are passed straight to node-pty.
// `meta` is whatever the caller wants surfaced to the UI (title, cwd, etc).
// `id` lets the caller dictate the session id (so persistedSessions can
// keep PTY id == record id); defaults to an auto-generated one.
// `onData` / `onExit` are optional callbacks fired alongside the built-in
// history-recording + socket-broadcast, so persistedSessions can mark
// status/lastActiveAt without us having to drill the dependency in here.
// Throws if node-pty isn't available.
function spawn({ command, args = [], cwd, env, cols = 120, rows = 30, meta = {}, id, onData, onExit }) {
  if (!pty) {
    const err = new Error('node-pty is not available · ' + (loadError && loadError.message || 'unknown'));
    err.code = 'PTY_UNAVAILABLE';
    throw err;
  }
  const entryId = id || genId();
  const ptyOpts = {
    name: 'xterm-256color',
    cols, rows,
    cwd: cwd ? path.resolve(cwd) : process.cwd(),
    // Advertise 24-bit colour. xterm.js renders truecolor, and CLIs like
    // claude paint their diffs with 24-bit DARK red/green backgrounds +
    // white text when COLORTERM says so. Without it they downgrade to the
    // bright ANSI-16 red/green backgrounds, which wash the white foreground
    // out (the "white text gets buried" report). VSCode sets the same on its
    // terminal PTYs; our ANSI-16 palette already matches VSCode's verbatim.
    env: { ...process.env, ...(env || {}), COLORTERM: 'truecolor' },
  };
  if (process.platform === 'win32') {
    ptyOpts.useConpty = true;
    ptyOpts.useConptyDll = true;
  }
  const proc = pty.spawn(command, args, ptyOpts);
  const entry = {
    id: entryId,
    pty: proc,
    history: '',
    sockets: new Set(),
    meta: { ...meta, startedAt: Date.now(), command, args, cwd: cwd || process.cwd(), pid: proc.pid },
    exitCode: null,
    exitedAt: null,
    onDataExtra: onData,
    onExitExtra: onExit,
  };
  proc.onData((data) => {
    entry.history = (entry.history + data);
    if (entry.history.length > HISTORY_BYTES) {
      entry.history = entry.history.slice(-HISTORY_BYTES);
    }
    const frame = JSON.stringify({ type: 'output', data });
    for (const ws of entry.sockets) {
      try { ws.send(frame); } catch {}
    }
    if (entry.onDataExtra) { try { entry.onDataExtra(data); } catch {} }
  });
  proc.onExit(({ exitCode, signal }) => {
    // If a respawn replaced us in the pool (same entryId, new entry
    // object), do not touch persistedSessions or schedule a delete —
    // those belong to the new entry now. Without this guard, a slow-
    // dying old PTY would fire markExited on the same sessionId and
    // clobber the new spawn's markRunning state.
    if (sessions.get(entryId) !== entry) return;
    entry.exitCode = exitCode;
    entry.exitedAt = Date.now();
    const frame = JSON.stringify({ type: 'exit', code: exitCode, signal });
    for (const ws of entry.sockets) {
      try { ws.send(frame); } catch {}
    }
    if (entry.onExitExtra) { try { entry.onExitExtra({ exitCode, signal }); } catch {} }
    setTimeout(() => {
      if (sessions.get(entryId) === entry) sessions.delete(entryId);
    }, 30_000);
  });
  // If a previous entry exists under the same id (respawn), kill its
  // pty so we don't have zombie claude.exe processes hanging on. The
  // onExit guard above ensures its callback no-ops once we've taken
  // over the slot.
  const prev = sessions.get(entryId);
  if (prev && !prev.exitedAt) {
    try { prev.pty.kill(); } catch {}
  }
  sessions.set(entryId, entry);
  return entry;
}

// Strip ANSI sequences from history that would cause spurious
// terminal-to-host responses if a fresh xterm.js re-parses the replay.
// Specifically: device-attribute / device-status queries (CSI c, CSI 0c,
// CSI >0c, CSI 5n, CSI 6n, …) — the original xterm already answered
// them, but on attach we replay everything; without scrubbing, the new
// xterm answers them too, the reply goes through our onData→PTY pipe,
// the CLI sees garbage bytes in its stdin, and echoes them back as
// visible junk like `[?12;2c`.
function scrubReplayResponses(history) {
  return history
    // CSI [ ? Ps c   (primary DA query)
    .replace(/\x1b\[[?>0-9]*c/g, '')
    // CSI [ Ps n     (device status / cursor position queries)
    .replace(/\x1b\[[?>0-9;]*n/g, '');
}

// Wire a websocket to a session. Replays history immediately so the
// client sees recent context; then forwards input/resize messages from
// the client to the PTY and broadcast outputs back via onData above.
function attach(id, ws) {
  const entry = sessions.get(id);
  if (!entry) {
    try { ws.close(4404, 'no such terminal'); } catch {}
    return;
  }
  // Latest-wins: a session has at most one live WebSocket at any
  // moment. The new attach displaces any existing ones — keeps PTY
  // resize semantics unambiguous (each client sends its own dimensions
  // for its own viewport; with two clients fighting, claude's TUI
  // re-renders for whichever sent last and the other side sees a
  // mis-sized layout). Close code 4001 + reason lets the displaced
  // client show a clearer message than the generic "[disconnected]".
  for (const other of entry.sockets) {
    try { other.close(4001, 'displaced by another client'); } catch {}
  }
  entry.sockets.clear();
  entry.sockets.add(ws);
  if (entry.history) {
    try { ws.send(JSON.stringify({ type: 'output', data: scrubReplayResponses(entry.history) })); } catch {}
  }
  if (entry.exitedAt) {
    try { ws.send(JSON.stringify({ type: 'exit', code: entry.exitCode })); } catch {}
  } else {
    try { ws.send(JSON.stringify({ type: 'attached', meta: entry.meta })); } catch {}
  }

  ws.on('message', (msg) => {
    let event;
    try { event = JSON.parse(msg.toString()); } catch { return; }
    if (entry.exitedAt) return;  // PTY is dead, ignore further input
    switch (event.type) {
      case 'input':
        if (typeof event.data === 'string') {
          if (process.env.CCSM_DEBUG_PASTE === '1') {
            const d = event.data;
            const hex = Buffer.from(d, 'utf8').toString('hex').match(/.{1,2}/g).join(' ');
            console.log(`[pty.write id=${id}] len=${d.length} hex=${hex.slice(0, 400)}${hex.length > 400 ? '...' : ''}`);
          }
          entry.pty.write(event.data);
        }
        break;
      case 'resize':
        if (Number(event.cols) > 0 && Number(event.rows) > 0) {
          try { entry.pty.resize(Number(event.cols), Number(event.rows)); } catch {}
        }
        break;
      case 'kill':
        kill(id);
        break;
    }
  });

  ws.on('close', () => {
    entry.sockets.delete(ws);
  });
}

function kill(id) {
  const entry = sessions.get(id);
  if (!entry || entry.exitedAt) return false;
  try { entry.pty.kill(); } catch {}
  return true;
}

// Public summary for the frontend. Don't leak the pty / sockets objects.
function describe(entry) {
  return {
    id: entry.id,
    meta: entry.meta,
    attached: entry.sockets.size,
    exitedAt: entry.exitedAt,
    exitCode: entry.exitCode,
  };
}

function list() {
  return Array.from(sessions.values()).map(describe);
}

function get(id) {
  const e = sessions.get(id);
  return e ? describe(e) : null;
}

function killAll() {
  for (const e of sessions.values()) {
    try { e.pty.kill(); } catch {}
  }
}

module.exports = {
  available: !!pty,
  loadError,
  spawn,
  attach,
  kill,
  list,
  get,
  killAll,
};
