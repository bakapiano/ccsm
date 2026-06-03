// Directory browser used by Launch page. Windows-Explorer-style:
//   ┌───────────────────────────────────────────────┐
//   │ [←] [→] [↑]  Home > Users > Admin > foo  [✎]  │   nav + breadcrumb
//   ├──────────────┬────────────────────────────────┤
//   │ Quick access │  folder rows (large, hoverable)│
//   │   Home       │  ⌃  ..                          │
//   │   Work dir   │  📁 AppData                     │
//   │   C:\        │  📁 ccsm-workspaces             │
//   │   D:\        │                                 │
//   └──────────────┴────────────────────────────────┘
//
// The picker streams the currently-selected path back to the parent via
// `onPick(path)` on every selection change. Confirm/cancel UI lives in
// the parent (the workdir modal's shared footer) so auto + cwd modes
// share one CTA.
//
// Props: { initialPath, onPick }

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { setToast } from '../toast.js';
import { IconFolder, IconHome, IconChevronLeft, IconChevronRight, IconChevronUp, IconPencil } from '../icons.js';

export function DirectoryPicker({ initialPath, onPick }) {
  const [data, setData] = useState(null);
  const [path, setPath] = useState(initialPath || '');
  const [history, setHistory] = useState({ stack: [], cursor: -1 }); // back/forward
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // Push the current selection up on every change so the parent's
  // shared "Use folder" CTA can act on it.
  const select = (p) => { setPath(p); setInput(p); onPick?.(p); };

  const browse = async (p, { pushHistory = true } = {}) => {
    setLoading(true);
    try {
      const url = '/api/browse' + (p ? `?path=${encodeURIComponent(p)}` : '');
      const r = await api('GET', url);
      setData(r);
      select(r.path);
      if (pushHistory) {
        setHistory((h) => {
          const head = h.stack.slice(0, h.cursor + 1);
          head.push(r.path);
          return { stack: head, cursor: head.length - 1 };
        });
      }
    } catch (e) { setToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { browse(initialPath); }, []);

  const canBack = history.cursor > 0;
  const canForward = history.cursor >= 0 && history.cursor < history.stack.length - 1;

  const goBack = () => {
    if (!canBack) return;
    const idx = history.cursor - 1;
    setHistory({ ...history, cursor: idx });
    browse(history.stack[idx], { pushHistory: false });
  };
  const goForward = () => {
    if (!canForward) return;
    const idx = history.cursor + 1;
    setHistory({ ...history, cursor: idx });
    browse(history.stack[idx], { pushHistory: false });
  };
  const goUp = () => {
    if (!data?.parent) return;
    browse(data.parent);
  };
  const onAddressSubmit = (ev) => {
    ev?.preventDefault?.();
    const p = (input || '').trim();
    setEditing(false);
    if (p && p !== path) browse(p);
  };

  if (!data) {
    return html`<div class="filex"><div class="filex-loading">Loading…</div></div>`;
  }

  // Build breadcrumb segments. Windows-style: "C:\Users\Admin\foo" →
  // [C:, Users, Admin, foo] with each segment clickable.
  const segments = breadcrumbSegments(data.path);

  return html`
    <div class="filex">
      <div class="filex-toolbar">
        <div class="filex-navbtns">
          <button class="filex-navbtn" title="Back" disabled=${!canBack} onClick=${goBack}>
            <${IconChevronLeft} />
          </button>
          <button class="filex-navbtn" title="Forward" disabled=${!canForward} onClick=${goForward}>
            <${IconChevronRight} />
          </button>
          <button class="filex-navbtn" title="Up" disabled=${!data.parent} onClick=${goUp}>
            <${IconChevronUp} />
          </button>
        </div>

        ${editing ? html`
          <form class="filex-address-edit" onSubmit=${onAddressSubmit}>
            <input class="filex-address-input mono" value=${input}
                   autoFocus
                   onInput=${(e) => setInput(e.target.value)}
                   onBlur=${onAddressSubmit}
                   onKeyDown=${(e) => { if (e.key === 'Escape') { setInput(data.path); setEditing(false); } }}
                   spellcheck="false" />
          </form>
        ` : html`
          <div class="filex-breadcrumb"
               onClick=${(e) => { if (e.target === e.currentTarget) { setInput(data.path); setEditing(true); } }}>
            ${segments.map((seg, i) => html`
              <button key=${seg.path} class="filex-crumb"
                      title=${seg.path}
                      onClick=${() => browse(seg.path)}>
                ${i === 0 && seg.label.match(/^[a-z]:\\?$/i) ? null : null}
                ${seg.label}
              </button>
              ${i < segments.length - 1
                ? html`<span class="filex-crumb-sep" aria-hidden="true">›</span>`
                : null}
            `)}
            <button class="filex-address-edit-btn" title="Edit path"
                    onClick=${() => { setInput(data.path); setEditing(true); }}>
              <${IconPencil} />
            </button>
          </div>
        `}
      </div>

      <div class="filex-body">
        <aside class="filex-side">
          <div class="filex-side-label">Quick access</div>
          ${(data.starts || []).map((s) => html`
            <button key=${s.path} class=${`filex-side-item${path === s.path ? ' is-active' : ''}`}
                    onClick=${() => browse(s.path)}
                    title=${s.path}>
              <span class="filex-side-icon">
                ${s.label === 'Home' ? html`<${IconHome} />` : html`<${IconFolder} />`}
              </span>
              <span class="filex-side-name">${s.label}</span>
            </button>`)}
        </aside>

        <div class="filex-main">
          ${!data.exists ? html`
            <div class="filex-empty">Directory not found.</div>
          ` : html`
            <div class="filex-list">
              ${data.entries.length === 0 ? html`
                <div class="filex-empty">This folder is empty.</div>
              ` : data.entries.map((e) => html`
                <button key=${e.path} class="filex-row"
                        onDblClick=${() => browse(e.path)}
                        onClick=${() => select(e.path)}
                        data-active=${path === e.path}>
                  <span class="filex-row-icon"><${IconFolder} /></span>
                  <span class="filex-row-name">${e.name}</span>
                </button>`)}
            </div>`}
        </div>
      </div>

      <div class="filex-foot">
        <span class="filex-foot-current mono" title=${path}>${path || ' '}</span>
      </div>
    </div>`;
}

// "C:\Users\Admin\foo" → [{label:'C:', path:'C:\\'}, {label:'Users', path:'C:\\Users'}, …]
// "/home/me/foo"        → [{label:'/',  path:'/'},   {label:'home',  path:'/home'},      …]
function breadcrumbSegments(p) {
  if (!p) return [];
  // Windows: split on backslash. Posix: forward slash.
  const isWin = /^[a-zA-Z]:[\\/]/.test(p);
  const sep = isWin ? '\\' : '/';
  const norm = p.replace(/[\\\/]+/g, sep);
  const parts = norm.split(sep).filter(Boolean);
  const segs = [];
  if (isWin) {
    // first part is drive like "C:"
    let acc = parts[0] + sep;
    segs.push({ label: parts[0], path: acc });
    for (let i = 1; i < parts.length; i++) {
      acc = (acc.endsWith(sep) ? acc.slice(0, -1) : acc) + sep + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
  } else {
    let acc = '';
    segs.push({ label: '/', path: '/' });
    for (const part of parts) {
      acc = acc + sep + part;
      segs.push({ label: part, path: acc });
    }
  }
  return segs;
}
