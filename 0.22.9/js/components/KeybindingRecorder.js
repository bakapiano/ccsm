// Full-screen modal that captures a key combo with a live preview of
// what the user is currently holding. Click to record → push modifiers
// in real time → release / press a non-modifier key to commit → close.
// Esc with no modifiers cancels.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function modsFromEvent(ev) {
  const out = [];
  if (ev.ctrlKey)  out.push('Ctrl');
  if (ev.altKey)   out.push('Alt');
  if (ev.shiftKey) out.push('Shift');
  if (ev.metaKey)  out.push('Meta');
  return out;
}

function prettyKey(k) {
  if (k === 'ArrowUp')    return '↑';
  if (k === 'ArrowDown')  return '↓';
  if (k === 'ArrowLeft')  return '←';
  if (k === 'ArrowRight') return '→';
  if (k === ' ')          return 'Space';
  if (k === 'Escape')     return 'Esc';
  if (/^[a-z]$/.test(k))  return k.toUpperCase();
  return k;
}

export function KeybindingRecorder({ actionLabel, onCommit, onCancel }) {
  // While `captured` is null, we're listening — display reflects whatever
  // is currently held. Once a non-modifier key lands, we freeze that
  // combo into `captured` and surface explicit Confirm / Try again
  // buttons. Pressing another non-modifier key replaces the captured
  // combo (useful when the user mis-pressed and wants to retry without
  // clicking).
  const [mods, setMods] = useState([]);
  const [captured, setCaptured] = useState(null);

  useEffect(() => {
    const onDown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      // Esc with no modifiers = cancel. Esc-as-shortcut is allowed when
      // any modifier is also held.
      if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
        onCancel();
        return;
      }

      // Enter while a combo is captured = confirm (so the user can finish
      // with a single hand on the keyboard, no mouse round-trip).
      if (ev.key === 'Enter' && captured && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
        onCommit(captured);
        return;
      }

      const currentMods = modsFromEvent(ev);
      if (MODIFIER_KEYS.has(ev.key)) {
        setMods(currentMods);
        return;
      }

      // Real key landed — freeze it; user still has to confirm.
      let k = ev.key;
      if (/^[a-z]$/.test(k)) k = k.toUpperCase();
      const combo = [...currentMods, k].join('+');
      setCaptured(combo);
    };

    const onUp = (ev) => {
      setMods(modsFromEvent(ev));
    };

    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [onCommit, onCancel, captured]);

  // The keys shown in the keycap row. While listening: live modifier
  // state + last-pressed key (if captured replaced live state). When
  // captured: parse the frozen combo back into parts so we show the
  // exact thing about to be saved.
  let parts;
  if (captured) {
    parts = captured.split('+');
  } else {
    parts = [...mods];
  }

  return html`
    <div class="kbd-recorder-overlay" role="dialog" aria-modal="true"
         onClick=${onCancel}>
      <div class="kbd-recorder-card" onClick=${(ev) => ev.stopPropagation()}>
        <div class="kbd-recorder-label">
          ${captured ? 'Captured shortcut for' : 'Press a shortcut for'}
        </div>
        <div class="kbd-recorder-action">${actionLabel}</div>

        <div class="kbd-recorder-keys">
          ${parts.length === 0
            ? html`<span class="kbd-recorder-placeholder">Press any key combo…</span>`
            : parts.map((p, i) => html`
                <span class="kbd-recorder-key" key=${i}>${prettyKey(p)}</span>
                ${i < parts.length - 1
                  ? html`<span class="kbd-recorder-plus">+</span>`
                  : null}
              `)}
        </div>

        ${captured ? html`
          <div class="kbd-recorder-actions">
            <button class="action small subtle" onClick=${() => setCaptured(null)}>
              Try again
            </button>
            <button class="action small subtle" onClick=${onCancel}>
              Cancel
            </button>
            <button class="action small primary" onClick=${() => onCommit(captured)}>
              Confirm
            </button>
          </div>
          <div class="kbd-recorder-hint">
            <kbd>Enter</kbd> to confirm · <kbd>Esc</kbd> to cancel · press another combo to replace
          </div>
        ` : html`
          <div class="kbd-recorder-hint">
            <kbd>Esc</kbd> to cancel · click outside to dismiss
          </div>
        `}
      </div>
    </div>`;
}
