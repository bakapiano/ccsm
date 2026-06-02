// Inline editable repos table — used in two places (Configure tab inline,
// and inside the new-session modal's "Manage repos" disclosure).
//
// Row inputs are locally controlled (useState) and only flush to the
// config signal on blur. Without this, every keystroke would mutate
// config.value and cascade a re-render through every config consumer
// (Footer, RepoPicker, WorkspacesHeader, the other ReposEditor instance),
// which made typing feel laggy.

import { html } from '../html.js';
import { useState, useEffect } from 'preact/hooks';
import { config } from '../state.js';

export function ReposEditor({ onChange }) {
  const repos = config.value?.repos || [];

  const commit = (idx, patch) => {
    const next = (config.value?.repos || []).map((r, i) => i === idx ? { ...r, ...patch } : r);
    config.value = { ...config.value, repos: next };
    onChange?.(next);
  };
  const remove = (idx) => {
    const next = (config.value?.repos || []).filter((_, i) => i !== idx);
    config.value = { ...config.value, repos: next };
    onChange?.(next);
  };

  return html`
    <table class="data repos-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>URL</th>
          <th class="num">Default</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
      <tbody>
        ${repos.map((r, idx) => html`
          <${Row} key=${idx} idx=${idx} repo=${r} commit=${commit} remove=${remove} />`)}
      </tbody>
    </table>`;
}

function Row({ idx, repo, commit, remove }) {
  const [name, setName] = useState(repo.name);
  const [url, setUrl]   = useState(repo.url);
  // Keep local state in sync when the underlying repo changes from
  // outside (e.g. a fresh /api/config GET after Save). We compare against
  // the prop so unrelated cascades don't clobber in-progress edits.
  useEffect(() => { setName(repo.name); }, [repo.name]);
  useEffect(() => { setUrl(repo.url);   }, [repo.url]);

  return html`
    <tr>
      <td><input type="text" value=${name}
                 onInput=${(e) => setName(e.target.value)}
                 onBlur=${() => name !== repo.name && commit(idx, { name })} /></td>
      <td><input type="text" value=${url}
                 onInput=${(e) => setUrl(e.target.value)}
                 onBlur=${() => url !== repo.url && commit(idx, { url })} /></td>
      <td class="num"><input type="checkbox" checked=${!!repo.defaultSelected}
                             onChange=${(e) => commit(idx, { defaultSelected: e.target.checked })} /></td>
      <td><div class="row-actions">
        <button class="action tiny danger" onClick=${() => remove(idx)}>Remove</button>
      </div></td>
    </tr>`;
}

export function addEmptyRepo(onChange) {
  const repos = [...(config.value?.repos || []), { name: '', url: '', defaultSelected: false }];
  config.value = { ...config.value, repos };
  onChange?.(repos);
}
