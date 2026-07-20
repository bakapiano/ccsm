// Unified picker used inside a Popover. Renders:
//   - optional search box (filters items by `label` + `meta`)
//   - scrollable item list (single or multi select)
//   - footer "+ New <thing>" that expands an inline form
//
// items: [{ id, label, meta?, disabled? }]
// onSelect(id) — single select. Closes popover.
// onToggle(id, on) — multi select. Doesn't close.
// selectedIds: Set<string> — for multi select highlight
// selectedId: string — for single select highlight
// onCreate(values) — async; returns the newly-created id (selected immediately
//                    in single mode; added to selection in multi mode)
// createFields: [{ key, label, type?, placeholder?, required? }]

import { html } from '../html.js';
import { useState, useRef, useEffect } from 'preact/hooks';
import { IconSearch, IconPlus, IconClose } from '../icons.js';

export function PickerPanel({
  title,
  items,
  selectedId,
  selectedIds,
  multi = false,
  showSearch = true,
  emptyHint = 'Nothing yet.',
  createLabel = '+ New',
  createFields = [],
  onSelect,
  onToggle,
  onCreate,
  onClose,
  dnd,
}) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(() => initialDraft(createFields));
  const [saving, setSaving] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    if (showSearch) searchRef.current?.focus();
  }, [showSearch]);

  const filtered = items.filter((it) => {
    if (!q.trim()) return true;
    const hay = (it.label + ' ' + (it.meta || '')).toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  const submitCreate = async (ev) => {
    ev?.preventDefault?.();
    for (const f of createFields) {
      if (f.required && !String(draft[f.key] || '').trim()) return;
    }
    setSaving(true);
    try {
      const id = await onCreate?.(draft);
      setDraft(initialDraft(createFields));
      setCreating(false);
      if (id != null) {
        if (multi) onToggle?.(id, true);
        else { onSelect?.(id); onClose?.(); }
      }
    } catch (e) {
      // Caller is expected to toast; we just stay open with the form
      console.warn(e);
    } finally {
      setSaving(false);
    }
  };

  return html`
    <div class="picker">
      ${title ? html`<div class="picker-title">${title}</div>` : null}

      ${showSearch ? html`
        <div class="picker-search">
          <span class="picker-search-icon"><${IconSearch} /></span>
          <input ref=${searchRef} class="picker-search-input"
                 placeholder="Search…" value=${q}
                 onInput=${(e) => setQ(e.target.value)} />
          ${q ? html`<button class="picker-search-clear" onClick=${() => setQ('')}>
            <${IconClose} />
          </button>` : null}
        </div>` : null}

      <div class="picker-list">
        ${filtered.length === 0 ? html`
          <div class="picker-empty">${q ? 'No matches.' : emptyHint}</div>
        ` : filtered.map((it) => {
          const isSel = multi ? selectedIds?.has(it.id) : selectedId === it.id;
          const enableDnd = dnd && !it.disabled && !it.undraggable && !q.trim();
          const rowProps = enableDnd ? dnd.rowProps(it.id) : {};
          const handleProps = enableDnd ? dnd.handleProps(it.id) : {};
          return html`
            <div key=${it.id} class=${`picker-item-wrap${enableDnd ? ' is-draggable' : ''}`} ...${rowProps} ...${handleProps}>
              ${enableDnd ? html`<span class="picker-item-grip" aria-hidden="true">⋮⋮</span>` : null}
              <button type="button"
                      class=${`picker-item${isSel ? ' is-selected' : ''}`}
                      disabled=${it.disabled}
                      onClick=${() => {
                        if (multi) onToggle?.(it.id, !isSel);
                        else { onSelect?.(it.id); onClose?.(); }
                      }}>
                ${it.icon ? html`<span class="picker-item-icon">${it.icon}</span>` : null}
                <span class="picker-item-label">${it.label}</span>
                ${it.meta ? html`<span class="picker-item-meta">${it.meta}</span>` : null}
                ${isSel ? html`<span class="picker-item-check">✓</span>` : null}
              </button>
            </div>`;
        })}
      </div>

      ${onCreate ? html`
        <div class="picker-create">
          ${!creating ? html`
            <button class="picker-create-toggle" type="button"
                    onClick=${() => setCreating(true)}>
              <${IconPlus} />
              <span>${createLabel}</span>
            </button>
          ` : html`
            <form class="picker-create-form" onSubmit=${submitCreate}>
              ${createFields.map((f) => html`
                <label class="picker-field" key=${f.key}>
                  <span class="picker-field-label">${f.label}</span>
                  ${f.type === 'select' ? html`
                    <select class="input" value=${draft[f.key] || ''}
                            onChange=${(e) => {
                              const next = { ...draft, [f.key]: e.target.value };
                              const side = f.onChange?.(e.target.value, next);
                              setDraft(side ? { ...next, ...side } : next);
                            }}>
                      ${(f.options || []).map((opt) => html`
                        <option value=${opt.value}>${opt.label}</option>`)}
                    </select>
                  ` : f.type === 'iconRadio' ? html`
                    <div class="icon-radio">
                      ${(f.options || []).map((opt) => html`
                        <button type="button" key=${opt.value}
                                class=${`icon-radio-opt${draft[f.key] === opt.value ? ' is-active' : ''}`}
                                onClick=${() => {
                                  const next = { ...draft, [f.key]: opt.value };
                                  const side = f.onChange?.(opt.value, next);
                                  setDraft(side ? { ...next, ...side } : next);
                                }}>
                          ${opt.icon ? html`<span class="icon-radio-icon">${opt.icon}</span>` : null}
                          <span>${opt.label}</span>
                        </button>`)}
                    </div>
                  ` : html`
                    <input type=${f.type || 'text'}
                           class=${`input${f.mono ? ' mono' : ''}`}
                           placeholder=${f.placeholder || ''}
                           value=${draft[f.key] || ''}
                           onInput=${(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                           autoFocus=${f.autoFocus} />`}
                  ${f.hint ? html`<span class="picker-field-hint">${f.hint}</span>` : null}
                </label>`)}
              <div class="picker-create-actions">
                <button type="button" class="action small subtle"
                        onClick=${() => { setCreating(false); setDraft(initialDraft(createFields)); }}>
                  Cancel
                </button>
                <button type="submit" class="action small primary" disabled=${saving}>
                  ${saving ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>`}
        </div>` : null}
    </div>`;
}

function initialDraft(fields) {
  const out = {};
  for (const f of fields) out[f.key] = f.default ?? '';
  return out;
}
