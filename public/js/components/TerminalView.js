// TerminalView is the Preact shell around a VS Code-style terminal instance:
// TerminalView -> TerminalInstance -> XtermTerminal -> raw xterm.js.

import { html } from '../html.js';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { themeMode } from '../state.js';
import { TerminalKeyBar } from './TerminalKeyBar.js';
import { TerminalInstance } from './TerminalInstance.js';

export function TerminalView({ terminalId, cliType }) {
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const [displaced, setDisplaced] = useState(false);
  const [reattachNonce, setReattach] = useState(0);
  const mode = themeMode.value;

  const sendInput = (data) => {
    instanceRef.current?.sendInput(data);
  };

  useEffect(() => {
    instanceRef.current?.applyTheme();
    const apply = () => instanceRef.current?.applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode, reattachNonce]);

  useEffect(() => {
    const host = hostRef.current;
    if (!terminalId || !host) return;

    const instance = new TerminalInstance({
      terminalId,
      cliType,
      onDisplaced: () => setDisplaced(true),
    });
    instanceRef.current = instance;
    instance.attachToElement(host);

    return () => {
      if (instanceRef.current === instance) instanceRef.current = null;
      instance.dispose();
    };
  }, [terminalId, reattachNonce]);

  useEffect(() => {
    instanceRef.current?.setCliType(cliType);
  }, [cliType, terminalId, reattachNonce]);

  if (!terminalId) {
    return html`<div class="terminal-empty">Select a terminal on the left, or launch a new one.</div>`;
  }
  if (displaced) {
    return html`
      <section key="displaced" class="terminal-displaced">
        <div class="terminal-displaced-card">
          <h2>Another device picked up this session</h2>
          <p>
            Only one client at a time can attach. Your terminal here was
            closed when another browser opened this session — its keystrokes
            and resize events would otherwise fight yours.
          </p>
          <div class="terminal-displaced-actions">
            <button class="action primary"
                    onClick=${() => {
                      setDisplaced(false);
                      setReattach((n) => n + 1);
                    }}>
              Take it back
            </button>
          </div>
          <p class="terminal-displaced-hint">
            Taking it back will close the other client the same way.
          </p>
        </div>
      </section>`;
  }
  return html`
    <${Fragment}>
      <div key="host" ref=${hostRef} class="terminal-host"></div>
      <${TerminalKeyBar} send=${sendInput} cliType=${cliType} />
    </${Fragment}>`;
}
