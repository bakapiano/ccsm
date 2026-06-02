// NDJSON clone-progress stream + per-repo progress state.
// Items live in a signal keyed by repo so progress rows are reactive.

import { signal } from '@preact/signals';
import { httpBase } from './backend.js';

// progressByContext[rootId] = { repoName: { phase, percent, detail, state, indeterminate, name } }
export const progressByContext = signal({});

export function resetProgress(repos, rootId = 'newSessionProgress') {
  const next = { ...progressByContext.value };
  next[rootId] = {};
  for (const r of repos) {
    next[rootId][r] = { name: r, phase: 'queued', percent: null, detail: '', state: null, indeterminate: false };
  }
  progressByContext.value = next;
}

function patchProgress(rootId, repo, patch) {
  const current = progressByContext.value[rootId] || {};
  const item = current[repo];
  if (!item) return;
  const updated = { ...item, ...patch };
  if (patch.state) {
    updated.state = (patch.state === 'ok' || patch.state === 'error') ? patch.state : null;
  }
  progressByContext.value = {
    ...progressByContext.value,
    [rootId]: { ...current, [repo]: updated },
  };
}

function applyEvent(ev, rootId) {
  switch (ev.type) {
    case 'clone-start':
      patchProgress(rootId, ev.repo, { phase: 'starting', indeterminate: true, percent: null });
      break;
    case 'clone-progress':
      patchProgress(rootId, ev.repo, {
        phase: ev.phase,
        percent: ev.percent,
        detail: ev.detail || (ev.current != null ? `${ev.current}/${ev.total}` : ''),
        indeterminate: false,
      });
      break;
    case 'clone-end':
      if (ev.ok) {
        patchProgress(rootId, ev.repo, {
          phase: ev.action || 'done', percent: 100, detail: ev.path || '', state: 'ok', indeterminate: false,
        });
      } else {
        patchProgress(rootId, ev.repo, {
          phase: 'error', detail: ev.error, state: 'error', indeterminate: false,
        });
      }
      break;
  }
}

// onMeta(event) is called for workspace/launched/done events so the caller can
// surface them in their own result text area.
export async function streamNewSession(body, { progressRootId = 'newSessionProgress', onMeta } = {}) {
  const res = await fetch(httpBase() + '/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.headers.get('content-type')?.startsWith('application/json')) {
    const j = await res.json();
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = null;
  const consume = (raw) => {
    if (!raw.trim()) return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    applyEvent(event, progressRootId);
    if (onMeta && (event.type === 'workspace' || event.type === 'launched' || event.type === 'done')) {
      onMeta(event);
    }
    if (event.type === 'done') final = event;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) consume(line);
  }
  if (buf) consume(buf);
  return final || { success: false, error: 'stream ended unexpectedly' };
}
