// Mobile-only terminal accessory bar. The soft keyboard has no Esc / Tab /
// arrows / Ctrl, which are exactly the keys claude & codex TUIs lean on
// (menu nav, cancel, autocomplete, interrupt). We float a row of those
// keys just above the soft keyboard — the same "extra-keys row" pattern
// Termux / Blink / Termius all settled on.
//
// Web has no native keyboard-accessory API, so the bar is a position:fixed
// element anchored to the top of the keyboard via the visualViewport API:
// when the keyboard opens, visualViewport.height shrinks and the gap below
// it (window.innerHeight − vv.height) is the keyboard's height; we park the
// bar at that offset.
//
// Every button MUST preventDefault on pointerdown — otherwise tapping it
// blurs the terminal's hidden textarea, which dismisses the soft keyboard
// (and would hide this bar). preventDefault keeps focus on the textarea so
// the keyboard stays up and we just inject the escape sequence over the WS.

import { html } from '../html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { isMobile } from '../state.js';
import { IconChevronUp, IconChevronDown, IconChevronLeft, IconChevronRight } from '../icons.js';

// Ctrl+<letter> is the letter's code & 0x1f. Pre-computed for the combos
// that actually come up in a REPL / TUI session.
const CTRL_COMBOS = [
  { label: '^C', data: '\x03', hint: 'interrupt' },
  { label: '^D', data: '\x04', hint: 'EOF' },
  { label: '^Z', data: '\x1a', hint: 'suspend' },
  { label: '^R', data: '\x12', hint: 'rev-search' },
  { label: '^L', data: '\x0c', hint: 'clear' },
  { label: '^A', data: '\x01', hint: 'line start' },
  { label: '^E', data: '\x05', hint: 'line end' },
  { label: '^U', data: '\x15', hint: 'kill line' },
  { label: '^K', data: '\x0b', hint: 'kill to end' },
  { label: '^W', data: '\x17', hint: 'kill word' },
];

export function TerminalKeyBar({ send, cliType }) {
  if (!isMobile.value) return null;
  const [visible, setVisible] = useState(false);
  const [kbOffset, setKbOffset] = useState(0);
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const gesture = useRef({ x: 0, y: 0, id: null, moved: false });

  // Show only while the terminal textarea holds focus (i.e. keyboard up).
  // Buttons preventDefault so they never steal focus → no spurious blur
  // while the bar is in use; focusout only fires on a genuine dismissal.
  useEffect(() => {
    const inTerm = (el) => !!(el && el.closest && el.closest('.terminal-host'));
    const onFocusIn = (e) => { if (inTerm(e.target)) setVisible(true); };
    const onFocusOut = () => {
      // Defer one tick so document.activeElement settles to the new target.
      setTimeout(() => {
        if (!inTerm(document.activeElement)) { setVisible(false); setCtrlOpen(false); }
      }, 0);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // Track the keyboard's top edge. window.innerHeight stays constant when
  // the soft keyboard opens (both iOS Safari & Android Chrome with the
  // default resizes-visual behaviour); vv.height shrinks. The difference
  // is the keyboard height → the bar's distance from the layout-viewport
  // bottom.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setKbOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => { vv.removeEventListener('resize', sync); vv.removeEventListener('scroll', sync); };
  }, []);

  if (!visible) return null;

  // Insert-newline (composer multi-line). Mirrors TerminalView's Shift/Ctrl
  // +Enter handler: claude's prompt parses a bare LF as insert-newline;
  // crossterm-based TUIs (codex/copilot) take ESC+CR i.e. Alt+Enter. This
  // is the ONLY way to add a newline on a soft keyboard whose Enter submits.
  const newlineData = cliType === 'claude' ? '\n' : '\x1b\r';

  // Tap-vs-drag discrimination. The key row scrolls horizontally
  // (overflow-x), so a swipe to scroll it starts on a button — firing the
  // key on pointerdown meant every scroll-drag injected a keystroke. Track
  // the pointer from down→up and only fire if it stayed put (a real tap).
  // One pointer at a time on a touch bar, so a single shared ref is enough.
  //
  // preventDefault on pointerdown keeps the terminal's textarea focused (the
  // button never grabs focus) so the soft keyboard stays up. Scrolling is
  // governed by touch-action, not this preventDefault, so the row still pans.
  const DRAG_PX = 8;
  const onDown = (e) => {
    gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    e.preventDefault();
  };
  const onMove = (e) => {
    const g = gesture.current;
    if (g.id !== e.pointerId || g.moved) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > DRAG_PX) g.moved = true;
  };
  const onCancel = () => { gesture.current.moved = true; };
  // Fire on release, but only for a tap (no drag) and the same pointer.
  const keyProps = (fn) => ({
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerCancel: onCancel,
    onPointerUp: (e) => {
      const g = gesture.current;
      if (g.id !== e.pointerId || g.moved) return;
      e.preventDefault();
      fn();
    },
  });
  const sendKey = (data) => keyProps(() => send(data));
  const ctrlCombo = (data) => keyProps(() => { send(data); setCtrlOpen(false); });

  return html`
    <div class="term-keybar" style=${`bottom:${kbOffset}px`}>
      ${ctrlOpen ? html`
        <div class="term-keybar-pop">
          ${CTRL_COMBOS.map((c) => html`
            <button class="tkb-key tkb-combo" key=${c.label}
                    ...${ctrlCombo(c.data)} title=${c.hint}>
              <span class="tkb-combo-label">${c.label}</span>
              <span class="tkb-combo-hint">${c.hint}</span>
            </button>`)}
        </div>` : null}

      <div class="term-keybar-row">
        <button class=${`tkb-key${ctrlOpen ? ' is-active' : ''}`}
                ...${keyProps(() => setCtrlOpen((v) => !v))}>Ctrl</button>
        <button class="tkb-key" ...${sendKey('\x1b')}>Esc</button>
        <button class="tkb-key" ...${sendKey('\t')}>Tab</button>
        <button class="tkb-key tkb-wide" ...${sendKey('\x1b[Z')}>S-Tab</button>
        <button class="tkb-key tkb-arrow" ...${sendKey(newlineData)} aria-label="newline"><span class="tkb-glyph">↵</span></button>
        <button class="tkb-key tkb-arrow" ...${sendKey('\x1b[A')} aria-label="up"><${IconChevronUp} /></button>
        <button class="tkb-key tkb-arrow" ...${sendKey('\x1b[B')} aria-label="down"><${IconChevronDown} /></button>
        <button class="tkb-key tkb-arrow" ...${sendKey('\x1b[D')} aria-label="left"><${IconChevronLeft} /></button>
        <button class="tkb-key tkb-arrow" ...${sendKey('\x1b[C')} aria-label="right"><${IconChevronRight} /></button>
      </div>
    </div>`;
}
