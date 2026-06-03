// Chip multi-select. Selected names are tracked locally per-instance
// because the inline form and the modal can have different selections.

import { html } from '../html.js';
import { config } from '../state.js';
import { useEffect, useState } from 'preact/hooks';

export function RepoPicker({ selectedSig }) {
  const repos = config.value?.repos || [];

  useEffect(() => {
    // initialise to default-selected repos on first mount + whenever the set
    // of available repos changes (so a newly-added default flips on)
    const want = new Set(repos.filter((r) => r.defaultSelected).map((r) => r.name));
    selectedSig.value = want;
    // we only want to re-init when the repo NAMES change, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.map((r) => r.name + ':' + r.defaultSelected).join('|')]);

  if (repos.length === 0) {
    return html`<span class="muted-text">no repos configured · use <strong>+ Add repo</strong> below</span>`;
  }

  const toggle = (name, on) => {
    const next = new Set(selectedSig.value);
    if (on) next.add(name);
    else next.delete(name);
    selectedSig.value = next;
  };

  return html`<div class="chip-row">${repos.map((r) => {
    const checked = selectedSig.value.has(r.name);
    return html`
      <label class=${`chip${checked ? ' checked' : ''}`} key=${r.name}>
        <input type="checkbox" checked=${checked}
               onChange=${(e) => toggle(r.name, e.target.checked)} />
        ${r.name}
      </label>`;
  })}</div>`;
}
