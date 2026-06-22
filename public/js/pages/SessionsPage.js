// Sessions page · the main pane. Shows the terminal for the currently
// selected session (activeSessionId), with a thin header providing
// session metadata + a session-tabs strip (future multi-tab support)
// and a kebab menu top-right for per-session actions. When a session is
// selected but not running we auto-resume it — no manual button.

import { html } from '../html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  activeSessionId,
  openSessionTabIds,
  sessions,
  config,
  selectTab,
  selectSession,
  setOpenSessionTabs,
  closeOpenSessionTab,
  clearActiveSession,
  clockTick,
} from '../state.js';
import { resumeSession, clearResumeFailure, deleteSession, setSessionTitle, switchSessionCli, stopSession, openSessionInEditor } from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm, ccsmPrompt } from '../dialog.js';
import { TerminalView } from '../components/TerminalView.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { Popover } from '../components/Popover.js';
import { useDragSort } from '../components/useDragSort.js';
import { IconMoreVert, IconPencil, IconClose, IconPlus, IconForCliType, IconTerminal, IconExternal, IconPlay, IconStop } from '../icons.js';
import { fmtAgo } from '../util.js';

function SessionTabs({ activeId, openSessions, onActivate, onClose, onReorder, onNew, kebab }) {
  const active = activeId ? sessions.value.find((s) => s.id === activeId) : null;
  const base = Array.isArray(openSessions) ? openSessions : [];
  const open = active && !base.some((s) => s.id === active.id)
    ? [...base, active]
    : base;
  const dnd = useDragSort(open.map((s) => s.id), onReorder);
  if (!open.length) return null;
  return html`
    <div class="session-tabs" role="tablist">
      <div class="session-tabs-list">
        ${open.map((s) => {
          const cli = (config.value?.clis || []).find((c) => c.id === s.cliId);
          const Icon = IconForCliType(cli?.type) || IconTerminal;
          const t = s.title || s.workspace || s.id.slice(0, 12);
          const isActive = s.id === activeId;
          const running = s.status === 'running';
          const working = running && s.activity === 'working';
          const statusText = running ? (working ? 'running, working' : 'running') : 'stopped';
          const statusClass = `${running ? ' is-running' : ' is-stopped'}${working ? ' is-working' : ''}`;
          const onKeyDown = (ev) => {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            ev.preventDefault();
            onActivate(s.id);
          };
          return html`
            <div key=${s.id}
                 role="tab"
                 aria-selected=${isActive}
                 aria-label=${`${t}, ${statusText}`}
                 tabIndex=${0}
                 class=${`session-tab${isActive ? ' is-active' : ''}${statusClass}`}
                 data-session-id=${s.id}
                 title=${`${t} · ${statusText} · ${s.cwd}`}
                 onKeyDown=${onKeyDown}
                 ...${dnd.rowProps(s.id)}>
              <div class="session-tab-main"
                   onClick=${() => onActivate(s.id)}
                   ...${dnd.handleProps(s.id)}>
                <span class="session-tab-icon"><${Icon} /></span>
                <span class="session-tab-label">${t}</span>
              </div>
              <button class="session-tab-close"
                      type="button"
                      title="Close tab"
                      aria-label=${`Close ${t}`}
                      onPointerDown=${(ev) => ev.stopPropagation()}
                      onClick=${(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        onClose(s.id);
                      }}>
                <${IconClose} />
              </button>
            </div>`;
        })}
        ${/* <button class="session-tab session-tab-add" onClick=${onNew} title="New session">
          <${IconPlus} />
        </button> */ null}
      </div>
      ${kebab ? html`<div class="session-tabs-right">${kebab}</div>` : null}
    </div>`;
}

function SessionMenu({ session, switchableClis, onRename, onDelete, onOpenEditor, onSwitchCli }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  return html`
    <button class="session-menu-btn" ref=${anchor}
            aria-label="Session actions" title="Session actions"
            onClick=${() => setOpen((v) => !v)}>
      <${IconMoreVert} />
    </button>
    ${open ? html`
      <${Popover} anchor=${anchor} align="right" width=${200}
                  onClose=${() => setOpen(false)}>
        <div class="session-menu">
          <button class="session-menu-item" onClick=${() => { setOpen(false); onOpenEditor(); }}>
            <${IconExternal} /> Open in editor
          </button>
          ${switchableClis.length ? html`
            <div class="session-menu-separator"></div>
            <div class="session-menu-label">Switch CLI</div>
            ${switchableClis.map((target) => {
              const TargetIcon = IconForCliType(target.type) || IconTerminal;
              return html`
                <button class="session-menu-item" key=${target.id}
                        onClick=${() => { setOpen(false); onSwitchCli(target); }}>
                  <${TargetIcon} /> Switch to ${target.name}
                </button>`;
            })}
          ` : null}
          <button class="session-menu-item" onClick=${() => { setOpen(false); onRename(); }}>
            <${IconPencil} /> Rename
          </button>
          <button class="session-menu-item danger" onClick=${() => { setOpen(false); onDelete(); }}>
            <${IconClose} /> Delete
          </button>
        </div>
      </${Popover}>` : null}`;
}

function SessionControls({ running, busy, onStop, onResume }) {
  return html`
    <div class="session-controls">
      ${running ? html`
        <button class="session-menu-btn session-control-btn danger" type="button"
                title="Stop session" aria-label="Stop session"
                disabled=${busy}
                onClick=${onStop}>
          <${IconStop} />
        </button>
      ` : html`
        <button class="session-menu-btn session-control-btn" type="button"
                title=${busy ? 'Resuming session' : 'Resume session'}
                aria-label=${busy ? 'Resuming session' : 'Resume session'}
                disabled=${busy}
                onClick=${onResume}>
          <${IconPlay} />
        </button>
      `}
    </div>`;
}

export function SessionsPage() {
  clockTick.value; // resubscribe fmtAgo
  const id = activeSessionId.value;
  const list = sessions.value;
  const session = id ? list.find((s) => s.id === id) : null;
  const [resumeError, setResumeError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const openTerminalIds = openSessionTabIds.value;
  // Bumps to force the auto-resume effect to re-run on Retry without
  // mutating any signal. Primitive in the dep array → identity changes.
  const [retryNonce, setRetryNonce] = useState(0);

  // No session selected → bounce to the Launch page. Done in an effect so
  // we don't mutate signals during render. Returning null while the bounce
  // is in flight avoids a flash of empty content.
  useEffect(() => {
    if (!session) {
      clearActiveSession();
      selectTab('launch');
    }
  }, [session]);

  // Auto-resume when the active session is exited. resumeSession() in
  // api.js dedups in-flight calls per session id, so simultaneous fires
  // from here and from Sidebar.onClick collapse into one request.
  useEffect(() => {
    if (!session) return;
    if (session.status === 'running') { setResumeError(null); return; }
    if (session.manualStopped) { setResumeError(null); return; }
    setResumeError(null);
    resumeSession(session.id)
      .then((launched) => { if (launched?.id) selectSession(launched.id); })
      .catch((e) => { setResumeError(e.message); setToast(e.message, 'error'); });
  }, [session?.id, session?.status, session?.cliId, session?.manualStopped, retryNonce]);

  useEffect(() => {
    const existingIds = new Set(list.map((s) => s.id));
    const next = [];
    for (const sid of openTerminalIds) {
      if (existingIds.has(sid) && !next.includes(sid)) {
        next.push(sid);
      }
    }
    if (session?.id && existingIds.has(session.id) && !next.includes(session.id)) {
      next.push(session.id);
    }
    const same = next.length === openTerminalIds.length
      && next.every((sid, i) => sid === openTerminalIds[i]);
    if (!same) setOpenSessionTabs(next);
  }, [list, session?.id, openTerminalIds]);

  if (!session) return null;

  const cli = (config.value?.clis || []).find((c) => c.id === session.cliId);
  const cliForSession = (s) => (config.value?.clis || []).find((c) => c.id === s.cliId);
  const switchableClis = cli
    ? (config.value?.clis || []).filter((c) => c.id !== cli.id)
    : [];
  const running = session.status === 'running';
  const openSessions = openTerminalIds
    .map((sid) => list.find((s) => s.id === sid))
    .filter(Boolean);
  const tabSessions = session && !openSessions.some((s) => s.id === session.id)
    ? [...openSessions, session]
    : openSessions;
  const terminalSessions = tabSessions.filter((s) => s.status === 'running');
  const title = session.title || session.workspace || session.id.slice(0, 12);

  const onCloseTab = (sid) => {
    closeOpenSessionTab(sid);

    if (sid !== session.id) return;
    const currentIndex = tabSessions.findIndex((s) => s.id === sid);
    const remaining = tabSessions.filter((s) => s.id !== sid);
    const replacement = currentIndex >= 0
      ? remaining[Math.min(currentIndex, remaining.length - 1)] || remaining[remaining.length - 1]
      : remaining[0];
    if (replacement) {
      selectSession(replacement.id);
    } else {
      clearActiveSession();
      selectTab('launch');
    }
  };

  const onReorderTabs = (orderedIds) => {
    const existingIds = new Set(list.map((s) => s.id));
    const nextIds = [];
    for (const sid of orderedIds) {
      if (existingIds.has(sid) && !nextIds.includes(sid)) nextIds.push(sid);
    }
    for (const sid of openTerminalIds) {
      if (existingIds.has(sid) && !nextIds.includes(sid)) nextIds.push(sid);
    }
    setOpenSessionTabs(nextIds);
  };

  const onResume = async () => {
    clearResumeFailure(session.id);
    setResumeError(null);
    setActionBusy(true);
    try {
      const launched = await resumeSession(session.id);
      if (launched?.id) selectSession(launched.id);
    } catch (e) {
      setResumeError(e.message);
      setToast(e.message, 'error');
    } finally {
      setActionBusy(false);
    }
  };
  const onRetry = () => {
    onResume();
  };
  const onStop = async () => {
    setActionBusy(true);
    try {
      await stopSession(session.id);
      setResumeError(null);
      setToast('Session stopped');
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setActionBusy(false);
    }
  };
  const onRename = async () => {
    const next = await ccsmPrompt('Rename session', title, { okLabel: 'Save' });
    if (next === null) return;
    try { await setSessionTitle(session.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };
  const onDelete = async () => {
    const ok = await ccsmConfirm(`Delete session ${title}? PTY will be killed if alive.`, {
      title: 'Delete session', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deleteSession(session.id);
      closeOpenSessionTab(session.id);
      clearActiveSession();
    } catch (e) { setToast(e.message, 'error'); }
  };
  const onOpenEditor = async () => {
    try {
      const r = await openSessionInEditor(session.id);
      setToast(`Opening in ${r?.editor || 'editor'}…`);
    } catch (e) { setToast(e.message, 'error'); }
  };
  const onSwitchCli = async (target) => {
    const fromName = cli?.name || session.cliId;
    if (running) {
      const ok = await ccsmConfirm(
        `Switch ${title} from ${fromName} to ${target.name}? The running terminal keeps its current process; ${target.name} is used next time this session resumes.`,
        { title: 'Switch CLI', okLabel: 'Switch' },
      );
      if (!ok) return;
    }
    try {
      const r = await switchSessionCli(session.id, target.id);
      setToast(r.running
        ? `CLI switched to ${target.name} for next resume`
        : `CLI switched to ${target.name}`);
      if (!running && !session.manualStopped) {
        clearResumeFailure(session.id);
        setRetryNonce((n) => n + 1);
      }
    } catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <${PageTitleBar} title=${html`
        <span class="session-title-text" title=${title}>${title}</span>
        <span class="session-title-cwd" title=${session.cwd}>${session.cwd}</span>
      `} />
    <${SessionTabs}
      activeId=${session.id}
      openSessions=${tabSessions}
      onActivate=${(sid) => selectSession(sid)}
      onClose=${onCloseTab}
      onReorder=${onReorderTabs}
      onNew=${() => selectTab('launch')}
      kebab=${html`
        <${SessionControls} running=${running}
                            busy=${actionBusy}
                            onStop=${onStop}
                            onResume=${onResume} />
        <${SessionMenu} session=${session}
                        switchableClis=${switchableClis}
                        onRename=${onRename}
                        onDelete=${onDelete}
                        onOpenEditor=${onOpenEditor}
                        onSwitchCli=${onSwitchCli} />`} />
    <div class="session-pane">
      <div class="session-pane-body">
        ${terminalSessions.length ? html`
          <div class="terminal-stack">
            ${terminalSessions.map((s) => {
              const sCli = cliForSession(s);
              const active = running && s.id === session.id;
              return html`
                <div key=${s.id}
                     class=${`terminal-layer${active ? ' is-active' : ''}`}
                     data-terminal-id=${s.id}
                     data-active=${active || null}
                     aria-hidden=${!active}>
                  <${TerminalView}
                    key=${s.id}
                    terminalId=${s.id}
                    cliType=${sCli?.type}
                    visible=${active}
                  />
                </div>`;
            })}
          </div>
        ` : null}
        ${!running
          ? html`
            <div class="terminal-empty">
              ${resumeError ? html`
                <div>Failed to resume: <span class="mono">${resumeError}</span></div>
                <button class="action primary" onClick=${onRetry}>Retry</button>
              ` : session.manualStopped ? html`
                <div>Session stopped</div>
                <button class="action primary" onClick=${onResume} disabled=${actionBusy}>
                  ${actionBusy ? 'Resuming…' : 'Resume'}
                </button>
              ` : html`
                <div>Resuming session…</div>
              `}
            </div>`
          : null}
      </div>
    </div>`;
}
