// "Load existing session" modal. Scans past claude / codex / copilot
// conversations found on disk and shows them as a table: each row is a
// discovered session on the left, with a CLI picker + folder picker + Load
// button on the right. Loading a row creates a ccsm record pre-filled with
// the upstream session id, so clicking it in the sidebar resumes the EXACT
// conversation (via cli.resumeIdArgs).
//
// The CLI picker for each row is seeded with the CLI whose `type` matches the
// detected session type (claude→claude, codex→codex, …) and lets the user
// switch to any other configured CLI — e.g. resume a codex session with the
// `cxp` wrapper instead of bare `codex`.

import { html } from '../html.js';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { Modal } from './Modal.js';
import { PickerPanel } from './Picker.js';
import { Popover } from './Popover.js';
import { config, folders, selectSession, selectTab, UNSORTED_KEY } from '../state.js';
import { listLocalCliSessions, adoptSession, createFolder } from '../api.js';
import { setToast } from '../toast.js';
import {
  IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor,
  IconSearch, IconClose, IconRefresh, IconChevronLeft, IconChevronRight, IconArrowRight,
  IconFolder, IconFolderOpen, IconChevronDown,
} from '../icons.js';

const PAGE_SIZE = 20;
const SCAN_LIMIT = 200;   // most-recent N across all CLIs; plenty for one box

const TYPE_TABS = [
  { type: 'all',     label: 'All' },
  { type: 'claude',  label: 'Claude',  Icon: IconClaudeColor },
  { type: 'codex',   label: 'Codex',   Icon: IconCodexColor },
  { type: 'copilot', label: 'Copilot', Icon: IconCopilotColor },
];

export function LoadSessionModal({ onClose, defaultFolderId = '' }) {
  const [view, setView] = useState({ loading: true, error: null, sessions: [], total: 0 });
  const [typeFilter, setTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rowCli, setRowCli] = useState({});        // cliSessionId → chosen cliId
  const [rowFolder, setRowFolder] = useState({});  // cliSessionId → chosen folderId
  const [openFolderPicker, setOpenFolderPicker] = useState(null); // cliSessionId whose folder picker is open
  const [openLoadMenu, setOpenLoadMenu] = useState(null); // cliSessionId whose "Load ▾" split menu is open
  const [adopting, setAdopting] = useState(null);  // cliSessionId being loaded
  const loadMenuAnchor = useRef(null); // shared anchor element for the load-menu popover
  const [loadedRec, setLoadedRec] = useState({});  // cliSessionId → ccsm record id
  const [reloadTick, setReloadTick] = useState(0);

  const cfg = config.value || {};
  const clis = cfg.clis || [];

  // Scan once (and on Rescan). We pull the most-recent SCAN_LIMIT across all
  // CLIs and do type-filter / search / pagination client-side — instant, and
  // more than enough for a single machine's history.
  useEffect(() => {
    let cancelled = false;
    setView((v) => ({ ...v, loading: true, error: null }));
    (async () => {
      try {
        const r = await listLocalCliSessions({ type: 'all', offset: 0, limit: SCAN_LIMIT });
        if (cancelled) return;
        setView({ loading: false, error: null, sessions: r.sessions || [], total: r.total || 0 });
      } catch (e) {
        if (!cancelled) setView({ loading: false, error: e.message, sessions: [], total: 0 });
      }
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  // Snap back to page 0 whenever the filter or query changes.
  useEffect(() => { setPage(0); }, [typeFilter, query]);

  // Per-type counts for the filter chips.
  const counts = useMemo(() => {
    const c = { all: view.sessions.length, claude: 0, codex: 0, copilot: 0 };
    for (const s of view.sessions) if (c[s.cliType] != null) c[s.cliType]++;
    return c;
  }, [view.sessions]);

  // Folder picker items + create fields — same shape the New Session folder
  // picker uses, so the shared PickerPanel gives us inline "New folder" here too.
  const folderPickerItems = useMemo(() => ([
    { id: '', label: 'Unsorted', meta: 'no folder', icon: html`<${IconFolderOpen} />` },
    ...folders.value
      .filter((f) => f.id !== UNSORTED_KEY)
      .map((f) => ({ id: f.id, label: f.name, icon: html`<${IconFolder} />` })),
  ]), [folders.value]);
  const folderCreateFields = [
    { key: 'name', label: 'Folder name', placeholder: 'Work / Personal / …', autoFocus: true, required: true },
  ];

  // CLIs a row can resume with: only those whose `type` matches the detected
  // session type (claude → Claude Code + ccp; codex → OpenAI Codex + cxp; …).
  // Resuming a claude conversation with a codex/copilot CLI is meaningless, so
  // cross-type CLIs aren't offered. Falls back to all CLIs only in the
  // impossible case that no same-type CLI is configured.
  const clisForType = (type) => {
    const matching = clis.filter((c) => c.type === type);
    return matching.length ? matching : clis;
  };
  const defaultCliForType = (type) =>
    (clis.find((c) => c.type === type)
      || clis.find((c) => c.id === cfg.defaultCliId)
      || clis[0])?.id || '';

  const getRowCli = (s) => rowCli[s.cliSessionId] || defaultCliForType(s.cliType);
  const getRowFolder = (s) =>
    (s.cliSessionId in rowFolder) ? rowFolder[s.cliSessionId] : (defaultFolderId || '');
  const getRowFolderName = (s) => {
    const id = getRowFolder(s);
    if (!id || id === UNSORTED_KEY) return 'Unsorted';
    return folders.value.find((f) => f.id === id)?.name || 'Unsorted';
  };

  // Already-in-ccsm test — either a record we just created (loadedRec) or one
  // the backend reported as pre-existing (adoptedRecord).
  const isLoaded = (s) => !!(loadedRec[s.cliSessionId] || s.adoptedRecord);

  // Filter + search, then order: not-yet-loaded sessions on top, already-loaded
  // ones at the bottom, each group sorted newest-first (mtime desc).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = view.sessions.filter((s) => {
      if (typeFilter !== 'all' && s.cliType !== typeFilter) return false;
      if (!q) return true;
      return `${s.summary || ''} ${s.cwd || ''} ${s.cliSessionId}`.toLowerCase().includes(q);
    });
    return matched.slice().sort((a, b) => {
      const la = isLoaded(a) ? 1 : 0;
      const lb = isLoaded(b) ? 1 : 0;
      if (la !== lb) return la - lb;             // unloaded first
      return (b.mtime || 0) - (a.mtime || 0);    // newest-first within each group
    });
  }, [view.sessions, typeFilter, query, loadedRec]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const load = async (s, { open = false } = {}) => {
    setOpenLoadMenu(null);
    const cliId = getRowCli(s);
    if (!cliId) { setToast('configure a CLI first', 'error'); return; }
    setAdopting(s.cliSessionId);
    try {
      const r = await adoptSession({
        cliId,
        cliSessionId: s.cliSessionId,
        cwd: s.cwd,
        title: s.summary || '',
        folderId: getRowFolder(s) || null,
      });
      // Stash the full record so the row immediately reflects where it landed
      // in ccsm (name + folder + CLI), not the picker state it was loaded from.
      if (r.session) setLoadedRec((m) => ({ ...m, [s.cliSessionId]: r.session }));
      setToast(r.alreadyAdopted
        ? 'already in ccsm — opened existing record'
        : `loaded · ${s.cliSessionId.slice(0, 8)}…`);
      // "Load + open" jumps straight to the session window: it was added to the
      // list above (adoptSession refreshed the sidebar); selecting it + switching
      // to the Sessions tab mounts SessionsPage, whose auto-resume kicks the
      // exited record back into its exact upstream conversation. Plain "Load"
      // leaves the user in the modal to keep loading more.
      if (open && r.session?.id) openInSidebar(r.session.id);
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setAdopting(null);
    }
  };

  const openInSidebar = (recId) => {
    if (!recId) return;
    selectSession(recId);
    selectTab('sessions');
    onClose?.();
  };

  const from = filtered.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const to = Math.min(filtered.length, clampedPage * PAGE_SIZE + rows.length);
  const footer = html`
    <div class="loadsess-pager">
      <button type="button" class="action subtle small"
              disabled=${clampedPage === 0 || view.loading}
              onClick=${() => setPage((p) => Math.max(0, p - 1))}>
        <${IconChevronLeft} /> Prev
      </button>
      <span class="loadsess-pager-info">
        ${filtered.length === 0 ? 'No sessions' : `${from}–${to} of ${filtered.length}`}
      </span>
      <button type="button" class="action subtle small"
              disabled=${(clampedPage + 1) >= pageCount || view.loading}
              onClick=${() => setPage((p) => p + 1)}>
        Next <${IconChevronRight} />
      </button>
    </div>
    <button type="button" class="action primary small" onClick=${onClose}>Done</button>`;

  return html`
    <${Modal} title="Load existing session" onClose=${onClose} width=${860} footer=${footer}>
      <div class="loadsess">
        <div class="loadsess-head">
          <div class="loadsess-tabs">
            ${TYPE_TABS.map((t) => html`
              <button type="button" key=${t.type}
                      class=${`loadsess-chip${typeFilter === t.type ? ' is-active' : ''}`}
                      onClick=${() => setTypeFilter(t.type)}>
                ${t.Icon ? html`<span class="loadsess-chip-icon"><${t.Icon} /></span>` : null}
                <span>${t.label}</span>
                ${counts[t.type] > 0 ? html`<span class="loadsess-chip-count">${counts[t.type]}</span>` : null}
              </button>`)}
          </div>
          <div class="loadsess-tools">
            <div class="loadsess-search">
              <span class="loadsess-search-icon"><${IconSearch} /></span>
              <input class="loadsess-search-input"
                     placeholder="Search summary / path / id…"
                     value=${query}
                     onInput=${(e) => setQuery(e.target.value)} />
              ${query ? html`
                <button class="loadsess-search-clear" type="button" title="Clear"
                        onClick=${() => setQuery('')}><${IconClose} /></button>` : null}
            </div>
            <button type="button" class="loadsess-rescan" title="Rescan disk"
                    disabled=${view.loading}
                    onClick=${() => setReloadTick((n) => n + 1)}>
              <${IconRefresh} />
            </button>
          </div>
        </div>

        <div class="loadsess-list">
          ${view.loading ? html`
            <div class="loadsess-empty"><span class="loadsess-spinner"></span> Scanning disk…</div>
          ` : view.error ? html`
            <div class="loadsess-empty loadsess-error">${view.error}</div>
          ` : rows.length === 0 ? html`
            <div class="loadsess-empty">
              <div class="loadsess-empty-mark">∅</div>
              ${query || typeFilter !== 'all'
                ? html`No sessions match this filter.`
                : html`No past CLI sessions found on this machine.`}
            </div>
          ` : html`
            <table class="loadsess-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th class="loadsess-col-cli">Resume with</th>
                  <th class="loadsess-col-folder">Folder</th>
                  <th class="loadsess-col-act"></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((s) => {
                  const Icon = IconForCliType(s.cliType);
                  // An adopted row's truth comes from its ccsm record: either
                  // the one we just created (loadedRec) or one the backend
                  // reported as pre-existing (s.adoptedRecord).
                  const rec = loadedRec[s.cliSessionId] || s.adoptedRecord || null;
                  const done = !!rec;
                  const rowClis = clisForType(s.cliType);
                  const recCli = done ? clis.find((c) => c.id === rec.cliId) : null;
                  const RecCliIcon = recCli ? IconForCliType(recCli.type) : Icon;
                  const ccsmName = done
                    ? (rec.title || rec.workspace || rec.id.slice(0, 12))
                    : '';
                  const folderName = done
                    ? ((!rec.folderId || rec.folderId === UNSORTED_KEY)
                        ? 'Unsorted'
                        : (folders.value.find((f) => f.id === rec.folderId)?.name || 'Unsorted'))
                    : '';
                  return html`
                    <tr key=${s.cliSessionId} class=${done ? 'is-loaded' : ''}>
                      <td class="loadsess-sess">
                        <span class="loadsess-sess-icon" title=${s.cliType}><${Icon} /></span>
                        <div class="loadsess-sess-main">
                          ${done ? html`
                            <div class="loadsess-inccsm-badge" title="Already in ccsm">
                              <span class="loadsess-inccsm-dot"></span>
                              <span>In ccsm as <strong>${ccsmName}</strong></span>
                            </div>` : null}
                          <div class="loadsess-sess-title">
                            ${s.summary || html`<span class="loadsess-untitled">untitled session</span>`}
                          </div>
                          <div class="loadsess-sess-meta">
                            <span class="mono loadsess-sess-path" title=${s.cwd || ''}>${s.cwd || '—'}</span>
                            <span class="loadsess-dot">·</span>
                            <span>${relTime(s.mtime)}</span>
                            <span class="loadsess-dot">·</span>
                            <span class="mono">${(s.cliSessionId || '').slice(0, 8)}</span>
                          </div>
                        </div>
                      </td>
                      <td class="loadsess-col-cli">
                        ${done ? html`
                          <div class="loadsess-readonly" title=${recCli?.name || rec.cliId}>
                            <span class="loadsess-readonly-icon"><${RecCliIcon} /></span>
                            <span class="loadsess-readonly-text">${recCli?.name || rec.cliId}</span>
                          </div>
                        ` : html`
                          <select class="input loadsess-select"
                                  value=${getRowCli(s)}
                                  onChange=${(e) => setRowCli((m) => ({ ...m, [s.cliSessionId]: e.target.value }))}>
                            ${rowClis.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
                          </select>`}
                      </td>
                      <td class="loadsess-col-folder">
                        ${done ? html`
                          <div class="loadsess-readonly" title=${folderName}>
                            <span class="loadsess-readonly-icon"><${IconFolder} /></span>
                            <span class="loadsess-readonly-text">${folderName}</span>
                          </div>
                        ` : html`
                          <button type="button" class="loadsess-folder-pill"
                                  onClick=${() => setOpenFolderPicker(s.cliSessionId)}>
                            <span class="loadsess-folder-pill-icon"><${IconFolder} /></span>
                            <span class="loadsess-folder-pill-label">${getRowFolderName(s)}</span>
                            <span class="loadsess-folder-pill-chev"><${IconChevronDown} /></span>
                          </button>`}
                      </td>
                      <td class="loadsess-col-act">
                        ${done ? html`
                          <button type="button" class="action subtle small loadsess-open"
                                  onClick=${() => openInSidebar(rec.id)}>
                            Open <${IconArrowRight} />
                          </button>
                        ` : html`
                          <div class="loadsess-split">
                            <button type="button" class="action primary small loadsess-split-main"
                                    disabled=${adopting === s.cliSessionId || !getRowCli(s)}
                                    onClick=${() => load(s, { open: false })}>
                              ${adopting === s.cliSessionId ? 'Loading…' : 'Load'}
                            </button>
                            <button type="button" class="action primary small loadsess-split-toggle"
                                    title="More load options"
                                    disabled=${adopting === s.cliSessionId || !getRowCli(s)}
                                    onClick=${(e) => { loadMenuAnchor.current = e.currentTarget; setOpenLoadMenu(s.cliSessionId); }}>
                              <${IconChevronDown} stroke=${2.4} />
                            </button>
                          </div>`}
                      </td>
                    </tr>`;
                })}
              </tbody>
            </table>`}
        </div>

        ${openFolderPicker !== null ? (() => {
          const target = view.sessions.find((x) => x.cliSessionId === openFolderPicker);
          const sel = target ? getRowFolder(target) : '';
          return html`
            <${Modal} title="Choose folder" onClose=${() => setOpenFolderPicker(null)} width=${400}>
              <${PickerPanel} items=${folderPickerItems} selectedId=${sel}
                              showSearch=${false}
                              onSelect=${(id) => setRowFolder((m) => ({ ...m, [openFolderPicker]: id }))}
                              onCreate=${async (v) => {
                                try {
                                  const f = await createFolder(v.name);
                                  setToast(`created folder · ${v.name}`);
                                  return f?.id;
                                } catch (e) { setToast(e.message, 'error'); throw e; }
                              }}
                              createLabel="New folder" createFields=${folderCreateFields}
                              onClose=${() => setOpenFolderPicker(null)} />
            </${Modal}>`;
        })() : null}

        ${openLoadMenu !== null ? (() => {
          const target = view.sessions.find((x) => x.cliSessionId === openLoadMenu);
          if (!target) return null;
          return html`
            <${Popover} key=${openLoadMenu} anchor=${loadMenuAnchor} align="right" width=${210}
                        onClose=${() => setOpenLoadMenu(null)}>
              <div class="loadsess-menu">
                <button type="button" class="loadsess-menu-item"
                        onClick=${() => load(target, { open: true })}>
                  <span class="loadsess-menu-icon"><${IconArrowRight} /></span>
                  <span class="loadsess-menu-text">
                    <span class="loadsess-menu-title">Load + open</span>
                    <span class="loadsess-menu-sub">Adopt and jump to the session</span>
                  </span>
                </button>
              </div>
            </${Popover}>`;
        })() : null}
      </div>
    </${Modal}>`;
}

function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
