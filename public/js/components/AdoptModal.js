// "Import existing session" modal. Browses sessions discovered on disk for
// claude / codex / copilot, lets the user pick one, choose which configured
// CLI it should be tied to, and adopts it — a ccsm persistedSessions record
// is created with the upstream session id pre-filled so clicking it later
// runs `<cli> --resume <id>` (via cli.resumeIdArgs).
//
// Layout (matches the app's modal pattern): pinned head (tabs + "import as"
// CLI pill + search), a scrolling list of session cards, and a pinned footer
// with ‹ Prev · X–Y of Z · Next › pagination. Each tab paginates server-side
// (PAGE_SIZE per page); typing a query loads the whole tab and filters it.

import { html } from '../html.js';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { Modal } from './Modal.js';
import { Popover } from './Popover.js';
import { PickerPanel } from './Picker.js';
import { config } from '../state.js';
import { listLocalCliSessions, adoptSession } from '../api.js';
import { setToast } from '../toast.js';
import {
  IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor,
  IconSearch, IconClose, IconChevronDown, IconChevronLeft, IconChevronRight, IconRefresh,
} from '../icons.js';

const TABS = [
  { type: 'claude',  label: 'Claude',  Icon: IconClaudeColor },
  { type: 'codex',   label: 'Codex',   Icon: IconCodexColor },
  { type: 'copilot', label: 'Copilot', Icon: IconCopilotColor },
];

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 1000;   // typing a query loads the whole tab to filter

export function AdoptModal({ onClose, onAdopted }) {
  const [tab, setTab] = useState('claude');
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [view, setView] = useState({ loading: true, error: null, sessions: [], total: 0 });
  const [totals, setTotals] = useState({});       // per-tab total → tab badges
  const [adopting, setAdopting] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cliOverride, setCliOverride] = useState({});
  const [reloadTick, setReloadTick] = useState(0); // Rescan bumps this
  const cliAnchorRef = useRef(null);

  const searching = !!query.trim();

  // Fetch the active view (tab × page × query). When searching we pull the
  // whole tab and filter client-side; otherwise just the requested page.
  useEffect(() => {
    let cancelled = false;
    setView((v) => ({ ...v, loading: true, error: null }));
    (async () => {
      try {
        const offset = searching ? 0 : page * PAGE_SIZE;
        const limit  = searching ? SEARCH_LIMIT : PAGE_SIZE;
        const r = await listLocalCliSessions(tab, { offset, limit });
        if (cancelled) return;
        const total = r.total ?? ((r.totalActive || 0) + (r.totalNonActive || 0));
        setView({ loading: false, error: null, sessions: r.sessions || [], total });
        setTotals((t) => (t[tab] === total ? t : { ...t, [tab]: total }));
      } catch (e) {
        if (!cancelled) setView({ loading: false, error: e.message, sessions: [], total: 0 });
      }
    })();
    return () => { cancelled = true; };
  }, [tab, page, searching, reloadTick]);

  // Snap back to page 0 when the tab changes or search toggles on/off.
  useEffect(() => { setPage(0); }, [tab]);
  useEffect(() => { setPage(0); }, [searching]);

  const cfg = config.value || {};
  const clis = cfg.clis || [];
  // CLIs of the same upstream type as the active tab — the ones whose
  // `--resume <id>` template will actually work with these sessions.
  const matchingClis = useMemo(() => clis.filter((c) => c.type === tab), [clis, tab]);
  const effectiveCliId =
    cliOverride[tab] || matchingClis[0]?.id || cfg.defaultCliId || clis[0]?.id || '';
  const effectiveCli = clis.find((c) => c.id === effectiveCliId) || null;

  const pickerItems = useMemo(() => {
    const Icon = IconForCliType(tab);
    const top = matchingClis.map((c) => ({ id: c.id, icon: html`<${Icon} />`, label: c.name, meta: c.command }));
    const others = clis.filter((c) => c.type !== tab).map((c) => {
      const I = IconForCliType(c.type);
      return { id: c.id, icon: html`<${I} />`, label: c.name, meta: `(non-${tab})` };
    });
    return [...top, ...others];
  }, [clis, matchingClis, tab]);

  // Search filters the loaded set (the whole tab while searching, else the page).
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return view.sessions;
    return view.sessions.filter((it) =>
      `${it.summary || ''} ${it.cwd || ''} ${it.cliSessionId}`.toLowerCase().includes(q));
  }, [view.sessions, query]);

  const adopt = async (item) => {
    if (!effectiveCliId) { setToast('configure a CLI first', 'error'); return; }
    setAdopting(item.cliSessionId);
    try {
      const r = await adoptSession({
        cliId: effectiveCliId,
        cliSessionId: item.cliSessionId,
        cwd: item.cwd,
        title: item.summary || '',
      });
      if (r.alreadyAdopted) setToast('already in ccsm — opened existing record');
      else setToast(`imported · ${item.cliSessionId.slice(0, 8)}…`);
      setView((v) => ({
        ...v,
        sessions: v.sessions.map((x) => x.cliSessionId === item.cliSessionId ? { ...x, adopted: true } : x),
      }));
      onAdopted?.(r.session?.id);
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setAdopting(null);
    }
  };

  // ── pagination footer ──
  const pageCount = Math.max(1, Math.ceil(view.total / PAGE_SIZE));
  const from = view.total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(view.total, page * PAGE_SIZE + view.sessions.length);
  const footer = searching
    ? html`<span class="adopt-pager-info">
        ${rows.length} match${rows.length === 1 ? '' : 'es'} · clear search to browse all
      </span>`
    : html`
      <button type="button" class="action subtle small adopt-pager-btn"
              disabled=${page === 0 || view.loading}
              onClick=${() => setPage((p) => Math.max(0, p - 1))}>
        <${IconChevronLeft} /> Prev
      </button>
      <span class="adopt-pager-info">
        ${view.total === 0 ? 'No sessions' : `${from}–${to} of ${view.total}`}
      </span>
      <button type="button" class="action subtle small adopt-pager-btn"
              disabled=${(page + 1) >= pageCount || view.loading}
              onClick=${() => setPage((p) => p + 1)}>
        Next <${IconChevronRight} />
      </button>`;

  return html`
    <${Modal} title="Import existing session" onClose=${onClose} width=${680} footer=${footer}>
      <div class="adopt">
        <div class="adopt-head">
          <div class="adopt-tabs">
            ${TABS.map((t) => html`
              <button type="button" key=${t.type}
                      class=${`adopt-tab${tab === t.type ? ' is-active' : ''}`}
                      onClick=${() => setTab(t.type)}>
                <span class="adopt-tab-icon"><${t.Icon} /></span>
                <span class="adopt-tab-label">${t.label}</span>
                ${typeof totals[t.type] === 'number' && totals[t.type] > 0 ? html`
                  <span class="adopt-tab-count">${totals[t.type]}</span>` : null}
              </button>`)}
            <button type="button" class="adopt-rescan" title="Rescan disk"
                    onClick=${() => setReloadTick((n) => n + 1)}>
              <${IconRefresh} />
            </button>
          </div>

          <div class="adopt-tools">
            <button type="button" ref=${cliAnchorRef}
                    class=${`adopt-cli-pill${pickerOpen ? ' is-open' : ''}`}
                    onClick=${() => setPickerOpen((v) => !v)}>
              <span class="adopt-cli-pill-prefix">Import as</span>
              <span class="adopt-cli-pill-icon">
                ${effectiveCli ? html`${(() => { const I = IconForCliType(effectiveCli.type); return html`<${I} />`; })()}` : null}
              </span>
              <span class="adopt-cli-pill-name">${effectiveCli?.name || 'choose CLI'}</span>
              <${IconChevronDown} />
            </button>
            ${pickerOpen ? html`
              <${Popover} anchor=${cliAnchorRef} onClose=${() => setPickerOpen(false)} width=${300}>
                <${PickerPanel}
                  title=${`CLI for ${tab} sessions`}
                  items=${pickerItems}
                  selectedId=${effectiveCliId}
                  showSearch=${pickerItems.length > 6}
                  emptyHint=${`No configured CLIs match ${tab}.`}
                  onSelect=${(id) => { setCliOverride((m) => ({ ...m, [tab]: id })); }}
                  onClose=${() => setPickerOpen(false)} />
              </${Popover}>` : null}

            <div class="adopt-search">
              <span class="adopt-search-icon"><${IconSearch} /></span>
              <input class="adopt-search-input"
                     placeholder=${`Search ${tab} sessions…`}
                     value=${query}
                     onInput=${(e) => setQuery(e.target.value)} />
              ${query ? html`
                <button class="adopt-search-clear" type="button" title="Clear"
                        onClick=${() => setQuery('')}><${IconClose} /></button>` : null}
            </div>
          </div>
        </div>

        <div class="adopt-list">
          ${view.loading ? html`
            <div class="adopt-empty"><span class="adopt-empty-spinner"></span> Scanning…</div>
          ` : view.error ? html`
            <div class="adopt-empty adopt-error">${view.error}</div>
          ` : rows.length === 0 ? html`
            <div class="adopt-empty">
              <div class="adopt-empty-mark">∅</div>
              ${searching ? html`No matches for "${query}".` : html`No ${tab} sessions found on this machine.`}
            </div>
          ` : html`
            <ul class="adopt-rows">
              ${rows.map((it) => {
                const Icon = IconForCliType(tab);
                return html`
                  <li class=${`adopt-row${it.adopted ? ' is-adopted' : ''}${it.active ? ' is-active' : ''}`}
                      key=${it.cliSessionId}>
                    <span class="adopt-row-icon"><${Icon} /></span>
                    <div class="adopt-row-main">
                      <div class="adopt-row-title">
                        ${it.active ? html`<span class="adopt-row-live" title="A CLI process has this session open right now">live</span>` : null}
                        ${it.summary || html`<span class="adopt-row-untitled">untitled session</span>`}
                      </div>
                      <div class="adopt-row-meta">
                        <span class="adopt-row-path mono" title=${it.cwd || ''}>${it.cwd || '—'}</span>
                        <span class="adopt-row-dot">·</span>
                        <span>${relTime(it.mtime)}</span>
                        <span class="adopt-row-dot">·</span>
                        <span class="adopt-row-id mono">${it.cliSessionId.slice(0, 8)}</span>
                      </div>
                    </div>
                    <div class="adopt-row-actions">
                      ${it.adopted ? html`
                        <span class="adopt-row-badge">Imported</span>
                      ` : html`
                        <button type="button" class="action primary small adopt-row-btn"
                                disabled=${adopting === it.cliSessionId || !effectiveCliId}
                                onClick=${() => adopt(it)}>
                          ${adopting === it.cliSessionId ? 'Importing…' : 'Import'}
                        </button>`}
                    </div>
                  </li>`;
              })}
            </ul>`}
        </div>
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
