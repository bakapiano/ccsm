// Generic create/edit form rendered inside a Modal. Field shape mirrors
// the createFields prop used by Picker.js so the same field-definition
// objects power both the inline-create-in-popover flow and the standalone
// edit flow used from Configure.
//
// Usage:
//   <${EntityFormModal}
//     title="Edit CLI"
//     fields=${cliFields}
//     initial=${currentValues}
//     onSubmit=${async (values) => { ... }}
//     onClose=${close} />

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { Modal } from './Modal.js';

export function EntityFormModal({
  title, fields, initial = {}, submitLabel = 'Save',
  readOnlyKeys = [],
  onSubmit, onClose, onTest, testLabel = 'Test',
  danger,
}) {
  const [draft, setDraft] = useState(() => ({ ...initialFrom(fields), ...initial }));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // A field is read-only if its key is in the static `readOnlyKeys`
  // prop OR its own `readOnly` predicate (called with the current
  // draft) returns true. The predicate lets a field react to other
  // fields' values — e.g. lock newSessionIdArgs once a known `type`
  // is picked, since those args are an integration contract with the
  // upstream CLI, not a user knob.
  const isReadOnly = (field) => {
    if (readOnlyKeys.includes(field.key)) return true;
    if (typeof field.readOnly === 'function') {
      try { return !!field.readOnly(draft); } catch { return false; }
    }
    return !!field.readOnly;
  };

  const submit = async (ev) => {
    ev?.preventDefault?.();
    for (const f of fields) {
      if (f.required && !String(draft[f.key] || '').trim()) return;
    }
    setSaving(true);
    try { await onSubmit?.(draft); onClose?.(); }
    catch { /* caller toasts; stay open */ }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest(draft);
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, spawnError: String(e?.message || e) });
    } finally {
      setTesting(false);
    }
  };

  return html`
    <${Modal} title=${title} onClose=${onClose} width=${440}>
      <form class="entity-form" onSubmit=${submit}>
        ${fields.map((f) => html`
          <label class="entity-field" key=${f.key}>
            <span class="entity-field-label">${f.label}</span>
            ${f.type === 'select' ? html`
              <select class="input" value=${draft[f.key] || ''}
                      disabled=${isReadOnly(f)}
                      onChange=${(e) => {
                        const next = { ...draft, [f.key]: e.target.value };
                        const sideEffects = f.onChange?.(e.target.value, next);
                        setDraft(sideEffects ? { ...next, ...sideEffects } : next);
                      }}>
                ${(f.options || []).map((opt) => html`
                  <option value=${opt.value}>${opt.label}</option>`)}
              </select>
            ` : f.type === 'iconRadio' ? html`
              <div class=${`icon-radio${isReadOnly(f) ? ' is-disabled' : ''}`}>
                ${(f.options || []).map((opt) => html`
                  <button type="button" key=${opt.value}
                          class=${`icon-radio-opt${draft[f.key] === opt.value ? ' is-active' : ''}`}
                          disabled=${isReadOnly(f)}
                          onClick=${() => {
                            if (isReadOnly(f)) return;
                            const next = { ...draft, [f.key]: opt.value };
                            const sideEffects = f.onChange?.(opt.value, next);
                            setDraft(sideEffects ? { ...next, ...sideEffects } : next);
                          }}>
                    ${opt.icon ? html`<span class="icon-radio-icon">${opt.icon}</span>` : null}
                    <span>${opt.label}</span>
                  </button>`)}
              </div>
            ` : f.type === 'checkbox' ? html`
              <span class="entity-checkbox-row">
                <input type="checkbox" checked=${!!draft[f.key]}
                       disabled=${isReadOnly(f)}
                       onChange=${(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
                ${f.hint ? html`<span class="entity-field-hint">${typeof f.hint === 'function' ? f.hint(draft) : f.hint}</span>` : null}
              </span>
            ` : html`
              <input type=${f.type || 'text'}
                     class=${`input${f.mono ? ' mono' : ''}`}
                     placeholder=${f.placeholder || ''}
                     value=${draft[f.key] || ''}
                     readonly=${isReadOnly(f)}
                     onInput=${(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                     autoFocus=${f.autoFocus && !isReadOnly(f)} />`}
            ${f.hint && f.type !== 'checkbox' ? html`
              <span class="entity-field-hint">${typeof f.hint === 'function' ? f.hint(draft) : f.hint}</span>` : null}
          </label>`)}
        ${testResult ? html`
          <div class=${`entity-test-result ${testResult.ok ? 'is-ok' : 'is-fail'}`}>
            <div class="entity-test-summary">
              ${testResult.ok ? '✓' : '✗'} ${testResult.ok ? 'works' : 'failed'}
              ${typeof testResult.exitCode === 'number' ? html` · exit ${testResult.exitCode}` : null}
              ${typeof testResult.durationMs === 'number' ? html` · ${testResult.durationMs}ms` : null}
              ${testResult.timedOut ? html` · timed out` : null}
              ${testResult.matchedType === true ? html` · type matches ${testResult.expectedType}` : null}
              ${testResult.matchedType === false ? html` · type mismatch (expected ${testResult.expectedType})` : null}
            </div>
            ${testResult.spawnError ? html`<pre class="entity-test-out">${testResult.spawnError}</pre>` : null}
            ${testResult.stdout ? html`<pre class="entity-test-out">${testResult.stdout}</pre>` : null}
            ${testResult.stderr ? html`<pre class="entity-test-out is-stderr">${testResult.stderr}</pre>` : null}
          </div>` : null}
        <div class="entity-form-actions">
          ${onTest ? html`
            <button type="button" class="action small subtle entity-test-button"
                    disabled=${testing} onClick=${runTest}>
              ${testing ? 'Testing…' : testLabel}
            </button>` : null}
          <button type="button" class="action small subtle" onClick=${onClose}>Cancel</button>
          <button type="submit" class=${`action small ${danger ? 'danger' : 'primary'}`}
                  disabled=${saving}>
            ${saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </${Modal}>`;
}

function initialFrom(fields) {
  const out = {};
  for (const f of fields) out[f.key] = f.default ?? '';
  return out;
}
