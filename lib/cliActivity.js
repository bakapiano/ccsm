'use strict';

// Detect whether a running CLI is actively producing terminal output.
// We keep this PTY-local instead of inferring activity from upstream
// transcript mtimes, because multiple ccsm sessions can share a cwd.

const WORKING_WINDOW_MS = 8000;

// sessionId -> { lastOutputAt }
const state = new Map();

async function probeActivity(record) {
  let s = state.get(record.id);
  if (!s) {
    s = { lastOutputAt: 0 };
    state.set(record.id, s);
  }
  const now = Date.now();
  return s.lastOutputAt && (now - s.lastOutputAt) < WORKING_WINDOW_MS
    ? 'working'
    : 'idle';
}

function noteOutput(sessionId) {
  let s = state.get(sessionId);
  if (!s) {
    s = { lastOutputAt: 0 };
    state.set(sessionId, s);
  }
  s.lastOutputAt = Date.now();
}

function releaseSession(sessionId) { state.delete(sessionId); }

module.exports = { probeActivity, noteOutput, releaseSession };
