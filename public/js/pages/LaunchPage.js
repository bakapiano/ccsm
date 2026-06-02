// Launch page. ChatGPT-style centered composer with custom popover
// pickers for CLI / Folder / Repos. Each picker shares the unified
// PickerPanel component and can inline-create new entries.

import { html } from '../html.js';
import { useState, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { config, folders, selectSession, selectTab } from '../state.js';
import { createCli, createFolder, createRepo, refreshAll } from '../api.js';
import { setToast } from '../toast.js';
import { streamNewSession, resetProgress } from '../streaming.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { ProgressList } from '../components/ProgressList.js';
import { Modal } from '../components/Modal.js';
import { PickerPanel } from '../components/Picker.js';
import { DirectoryPicker } from '../components/DirectoryPicker.js';
import { AdoptModal } from '../components/AdoptModal.js';
import { BrandMark, IconTerminal, IconFolder, IconFolderOpen, IconBranch, IconChevronDown, IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor, IconSparkle, IconWorkspace, IconArrowRight } from '../icons.js';

const ROOT_ID = 'newSessionProgress';
const selectedRepos = signal(new Set());

// Persist the user's last Launch picks (CLI / folder / mode / cwd /
// selected repos) so the form stays as they left it across reloads
// and tab switches. localStorage is best-effort — any access failure
// falls back silently.
const LS_KEY = 'ccsm.launch-state';
function loadLaunchState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch {}
  return null;
}
function saveLaunchState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

function initRepoSelection(repos, override) {
  if (override && Array.isArray(override)) {
    // Only honour names that still exist in the user's repo list;
    // anything else was deleted between sessions.
    const valid = new Set(repos.map((r) => r.name));
    selectedRepos.value = new Set(override.filter((n) => valid.has(n)));
    return;
  }
  const want = new Set(repos.filter((r) => r.defaultSelected).map((r) => r.name));
  selectedRepos.value = want;
}

function LaunchHero() {
  const cfg = config.value || {};
  const clis = cfg.clis || [];
  const repos = cfg.repos || [];
  const defaultCli = cfg.defaultCliId || clis[0]?.id || '';
  const saved = loadLaunchState();

  // Initial values pull from localStorage first (last-used picks),
  // then fall back to config defaults. cliId is validated below in
  // the useEffect once `clis` arrives.
  const [cliId, setCliId] = useState(saved?.cliId || defaultCli);
  const [folderId, setFolderId] = useState(saved?.folderId || '');
  const [mode, setMode] = useState(saved?.mode === 'cwd' ? 'cwd' : 'auto');
  const [cwd, setCwd] = useState(saved?.cwd || ''); // only used when mode === 'cwd'
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [openPicker, setOpenPicker] = useState(null); // 'cli' | 'folder' | 'workdir' | null
  const [adoptOpen, setAdoptOpen] = useState(false);

  // If config arrives after first render (cliId === '') OR the saved
  // cli was removed, snap to the current default.
  useEffect(() => {
    if (!clis.length) return;
    if (!cliId || !clis.find((c) => c.id === cliId)) {
      setCliId(defaultCli);
    }
  }, [defaultCli, clis.length]);

  // Validate the persisted folder id against the live folders list
  // — folders deleted between sessions snap back to "no folder".
  useEffect(() => {
    if (!folderId) return;
    if (!folders.value.find((f) => f.id === folderId)) setFolderId('');
  }, [folderId, folders.value.length]);

  // Persist every change. JSON-stringifying a Set isn't useful, so
  // we materialize selectedRepos to an array here.
  useEffect(() => {
    saveLaunchState({
      cliId, folderId, mode, cwd,
      repos: [...selectedRepos.value],
    });
  }, [cliId, folderId, mode, cwd, selectedRepos.value]);


  const sig = repos.map((r) => r.name + ':' + r.defaultSelected).join('|');
  useStateOnce(sig, () => initRepoSelection(repos, saved?.repos));

  const cli = clis.find((c) => c.id === cliId) || clis[0];
  const folder = folders.value.find((f) => f.id === folderId);

  const toggleRepo = (name, on) => {
    const next = new Set(selectedRepos.value);
    if (on) next.add(name); else next.delete(name);
    selectedRepos.value = next;
  };

  const onLaunch = async () => {
    const useCwd = mode === 'cwd' && cwd;
    const chosen = useCwd ? [] : [...selectedRepos.value];
    setBusy(true);
    setResult('');
    resetProgress(chosen, ROOT_ID);
    try {
      const final = await streamNewSession(
        {
          repos: chosen,
          cwd: useCwd ? cwd : undefined,
          cliId: cliId || undefined,
          folderId: folderId || undefined,
        },
        {
          progressRootId: ROOT_ID,
          onMeta: (ev) => {
            if (ev.type === 'workspace') {
              setResult(`workspace · ${ev.workspace.path}${ev.created ? ' · newly created' : ''}`);
            } else if (ev.type === 'launched') {
              setResult(`launched · session ${ev.launched.id}`);
            }
          },
        },
      );
      if (final.success && final.launched) {
        setToast(`launched · ${final.workspace.name}`);
        await refreshAll();
        selectSession(final.launched.id);
        selectTab('sessions');
      } else if (!final.success) {
        setResult(`error · ${final.error}`);
        setToast(final.error || 'launch failed', 'error');
      }
    } catch (e) {
      setResult(`error · ${e.message}`);
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const close = () => setOpenPicker(null);

  // --- CLI picker config -----------------------------------------------
  const cliItems = clis.map((c) => {
    const Icon = IconForCliType(c.type);
    return {
      id: c.id,
      icon: html`<${Icon} />`,
      label: c.name,
      meta: `${c.command}${c.shell && c.shell !== 'direct' ? ' · ' + c.shell : ''}`,
    };
  });
  const cliCreateFields = [
    { key: 'type', label: 'Type', type: 'iconRadio', default: 'other', options: [
      { value: 'claude',  label: 'Claude CLI',     icon: html`<${IconClaudeColor} />` },
      { value: 'codex',   label: 'Codex CLI',      icon: html`<${IconCodexColor} />` },
      { value: 'copilot', label: 'GitHub Copilot', icon: html`<${IconCopilotColor} />` },
      { value: 'other',   label: 'Other',          icon: html`<${IconTerminal} />` },
    ],
      onChange: (v, next) => {
        const presets = { claude:  { command: 'claude',  resumeArgs: '--continue',    resumeIdArgs: '--resume <id>', name: 'Claude Code' },
                          codex:   { command: 'codex',   resumeArgs: 'resume --last', resumeIdArgs: 'resume <id>',   name: 'OpenAI Codex' },
                          copilot: { command: 'copilot', resumeArgs: '--continue',    resumeIdArgs: '--resume <id>', name: 'GitHub Copilot' },
                          other:   {} }[v] || {};
        const patch = {};
        if (presets.resumeArgs != null) patch.resumeArgs = presets.resumeArgs;
        if (presets.resumeIdArgs != null) patch.resumeIdArgs = presets.resumeIdArgs;
        if (!next.command || !next.command.trim()) patch.command = presets.command || '';
        if (!next.name || !next.name.trim()) patch.name = presets.name || '';
        return patch;
      },
    },
    { key: 'name', label: 'Name', placeholder: 'My CLI', required: true },
    { key: 'command', label: 'Command', mono: true, placeholder: 'ccp / claude / ...', required: true },
    { key: 'args', label: 'Args (space-separated)', mono: true, placeholder: '' },
    { key: 'resumeArgs', label: 'Resume args (fallback)', mono: true, placeholder: '--continue',
      hint: 'Used when ccsm has no captured upstream session id.' },
    { key: 'resumeIdArgs', label: 'Resume by id args', mono: true, placeholder: '--resume <id>',
      hint: 'Use <id> as the placeholder for the captured upstream session UUID.' },
    { key: 'shell', label: 'Shell', type: 'select', default: 'direct', options: [
      { value: 'direct', label: 'direct (real .exe / .cmd)' },
      { value: 'pwsh', label: 'pwsh (PowerShell aliases & functions)' },
      { value: 'cmd', label: 'cmd (doskey)' },
    ] },
  ];

  // --- Folder picker config --------------------------------------------
  const folderItems = [
    { id: '', label: 'Unsorted', meta: 'no folder', undraggable: true, icon: html`<${IconFolderOpen} />` },
    ...folders.value.map((f) => ({ id: f.id, label: f.name, icon: html`<${IconFolder} />` })),
  ];
  const folderCreateFields = [
    { key: 'name', label: 'Folder name', placeholder: 'Work / Personal / ...', autoFocus: true, required: true },
  ];

  // --- Repo picker config ----------------------------------------------
  const repoItems = repos.map((r) => ({
    id: r.name,
    label: r.name,
    meta: r.url,
  }));
  const repoCreateFields = [
    { key: 'name', label: 'Name', placeholder: 'my-repo', autoFocus: true, required: true },
    { key: 'url', label: 'URL', mono: true, placeholder: 'https://github.com/me/foo.git', required: true },
  ];

  const selectedRepoCount = selectedRepos.value.size;

  // Label + title for the unified workdir/repos pill.
  const workdirLabel = (() => {
    if (mode === 'cwd') return cwd ? shortenPath(cwd) : 'Pick folder…';
    if (selectedRepoCount === 0) return 'Auto workspace';
    if (selectedRepoCount === 1) return [...selectedRepos.value][0];
    return `Auto · ${selectedRepoCount} repos`;
  })();
  const workdirTitle = mode === 'cwd'
    ? (cwd ? `Working dir · ${cwd}` : 'Pick an existing folder')
    : (selectedRepoCount === 0
        ? 'Auto: a fresh workspace under workDir (no repos)'
        : `Auto workspace · clone ${selectedRepoCount} repo(s)`);

  return html`
    <div class="launch-hero">
      <div class="launch-brand">
        <span class="launch-brand-mark"><${BrandMark} /></span>
      </div>
      <h1 class="launch-tagline">
        One shell. <em>Every CLI.</em>
      </h1>

      <div class="launch-toolbar">
        <button type="button"
                class=${`pill${openPicker === 'cli' ? ' is-open' : ''}`}
                title="Choose CLI"
                onClick=${() => setOpenPicker(openPicker === 'cli' ? null : 'cli')}>
          <span class="pill-icon">${(() => { const I = IconForCliType(cli?.type); return html`<${I} />`; })()}</span>
          <span class="pill-label">${cli ? cli.name : 'Choose CLI'}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'cli' ? html`
          <${Modal} title="Choose CLI" onClose=${close} width=${440}>
            <${PickerPanel} items=${cliItems} selectedId=${cliId}
                            showSearch=${false}
                            onSelect=${(id) => setCliId(id)}
                            onCreate=${async (v) => {
                              try {
                                const id = await createCli(v);
                                setToast(`created CLI · ${v.name}`);
                                return id;
                              } catch (e) { setToast(e.message, 'error'); throw e; }
                            }}
                            createLabel="New CLI" createFields=${cliCreateFields}
                            onClose=${close} />
          </${Modal}>` : null}

        <button type="button"
                class=${`pill${openPicker === 'workdir' ? ' is-open' : ''}${(mode === 'cwd' && cwd) ? ' is-set' : ''}`}
                title=${workdirTitle}
                onClick=${() => setOpenPicker(openPicker === 'workdir' ? null : 'workdir')}>
          <span class="pill-icon"><${IconWorkspace} /></span>
          <span class="pill-label">${workdirLabel}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'workdir' ? html`
          <${Modal} title="Working directory" onClose=${close} width=${640}
                    footer=${html`
                      <button type="button" class="action subtle" onClick=${close}>Cancel</button>
                      <button type="button" class="action primary"
                              disabled=${mode === 'cwd' && !cwd}
                              onClick=${close}>
                        ${mode === 'cwd' ? 'Use folder' : 'Done'}
                      </button>`}>
            <div class="workdir-modal">
              <div class="workdir-mode-grid">
                <button type="button"
                        class=${`workdir-mode-opt${mode === 'auto' ? ' is-active' : ''}`}
                        onClick=${() => setMode('auto')}>
                  <span class="workdir-mode-icon"><${IconSparkle} /></span>
                  <span class="workdir-mode-name">Auto workspace</span>
                  <span class="workdir-mode-sub">Fresh <span class="mono">ws-N</span> + clone repos</span>
                </button>
                <button type="button"
                        class=${`workdir-mode-opt${mode === 'cwd' ? ' is-active' : ''}`}
                        onClick=${() => setMode('cwd')}>
                  <span class="workdir-mode-icon"><${IconFolderOpen} /></span>
                  <span class="workdir-mode-name">Existing folder</span>
                  <span class="workdir-mode-sub">Launch directly · no clone</span>
                </button>
              </div>
              <div class="workdir-detail">
                ${mode === 'auto' ? html`
                  <${PickerPanel} items=${repoItems} multi
                                  showSearch=${false}
                                  selectedIds=${selectedRepos.value}
                                  onToggle=${toggleRepo}
                                  title="Repos to clone"
                                  emptyHint="No repos configured. Add one below to clone it into the workspace."
                                  onCreate=${async (v) => {
                                    try {
                                      const name = await createRepo(v);
                                      setToast(`added repo · ${name}`);
                                      return name;
                                    } catch (e) { setToast(e.message, 'error'); throw e; }
                                  }}
                                  createLabel="New repo" createFields=${repoCreateFields}
                                  onClose=${close} />
                ` : html`
                  <${DirectoryPicker} initialPath=${cwd || ''}
                                      onPick=${(p) => { setCwd(p); }} />
                `}
              </div>
            </div>
          </${Modal}>` : null}

        <button type="button"
                class=${`pill${openPicker === 'folder' ? ' is-open' : ''}`}
                title="Choose folder"
                onClick=${() => setOpenPicker(openPicker === 'folder' ? null : 'folder')}>
          <span class="pill-icon"><${IconFolder} /></span>
          <span class="pill-label">${folder ? folder.name : 'Unsorted'}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'folder' ? html`
          <${Modal} title="Choose folder" onClose=${close} width=${400}>
            <${PickerPanel} items=${folderItems} selectedId=${folderId}
                            showSearch=${false}
                            onSelect=${(id) => setFolderId(id)}
                            onCreate=${async (v) => {
                              try {
                                const f = await createFolder(v.name);
                                setToast(`created folder · ${v.name}`);
                                return f?.id;
                              } catch (e) { setToast(e.message, 'error'); throw e; }
                            }}
                            createLabel="New folder" createFields=${folderCreateFields}
                            onClose=${close} />
          </${Modal}>` : null}
      </div>

      <button class="action primary launch-cta"
              disabled=${busy || !cliId || (mode === 'cwd' && !cwd)}
              onClick=${onLaunch}>
        ${busy ? 'Launching…' : html`Launch <span class="launch-cta-plane" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2 11 13"/>
            <path d="M22 2 15 22l-4-9-9-4Z"/>
          </svg>
        </span>`}
      </button>

      <button type="button" class="launch-import-link"
              onClick=${() => setAdoptOpen(true)}>
        or import existing<span class="launch-import-arrow" aria-hidden="true"><${IconArrowRight} /></span>
      </button>

      ${adoptOpen ? html`
        <${AdoptModal} onClose=${() => setAdoptOpen(false)}
                       onAdopted=${async (id) => {
                         setAdoptOpen(false);
                         await refreshAll();
                         if (id) selectSession(id);
                         selectTab('sessions');
                       }} />` : null}

      <${ProgressList} rootId=${ROOT_ID} />
      ${result ? html`<div class="launch-status mono">${result}</div>` : null}
    </div>`;
}

let lastKey = null;
function useStateOnce(key, init) {
  if (key !== lastKey) {
    lastKey = key;
    init();
  }
}

// Truncate a long path so it fits the pill nicely.
//   C:\Users\admin\proj\foo\bar  →  …\foo\bar
function shortenPath(p) {
  if (!p) return '';
  if (p.length <= 28) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + sep + parts.slice(-2).join(sep);
}

export function LaunchPage() {
  return html`
    <${PageTitleBar} title="New session" />
    <${LaunchHero} />`;
}
