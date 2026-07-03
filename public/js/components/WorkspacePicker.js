// "auto" + every workspace. We deliberately don't filter by inUse —
// frontend's view can be stale and the server validates the chosen name
// on the request anyway. sessionsHere is only used as a visual marker
// on the option label so the user has the info.

import { html } from '../html.js';
import { workspaces } from '../state.js';

export function WorkspacePicker({ value, onChange }) {
  const all = workspaces.value;
  return html`
    <select class="input narrow" value=${value} onChange=${(e) => onChange(e.target.value)}>
      <option value="">auto — find or create unused</option>
      ${all.map((w) => {
        const n = Array.isArray(w.sessionsHere) ? w.sessionsHere.length : 0;
        return html`
        <option key=${w.name} value=${w.name}>
          ${w.name}${n ? ` · ${n} ${n === 1 ? 'session' : 'sessions'}` : ''}
        </option>`;
      })}
    </select>`;
}
