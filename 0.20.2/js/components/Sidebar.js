import { html } from '../html.js';
import { signal } from '@preact/signals';
import {
  activeTab, sidebarCollapsed, sidebarForcedCollapsed, isMobile, configDirty, capabilities,
  sessions, folders, sessionsByFolder, foldersCollapsed, activeSessionId,
  selectTab, selectSession, toggleSidebar, toggleFolder, setSidebarWidth,
} from '../state.js';
import { createFolder, renameFolder, deleteFolder, reorderFolders, setSessionFolder, reorderSessions, deleteSession, resumeSession, setSessionTitle } from '../api.js';
import { isRemoteAccess } from '../backend.js';
import { ccsmPrompt, ccsmConfirm } from '../dialog.js';
import { setToast } from '../toast.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';
import { useDragSort } from './useDragSort.js';
import {
  IconLaunch, IconConfigure, IconRemote,
  IconSidebarToggle, IconPencil, IconClose, IconFolder, IconFolderOpen, IconPlus, BrandMark,
} from '../icons.js';

// Module-level drag state for session → folder moves. Lives outside the
// useDragSort hook (which handles same-list folder reorder) so the two
// don't interfere — session drags and folder drags use disjoint state.
// Folder key: folder.id for real folders, the literal string 'unsorted'
// for the implicit top-level Unsorted bucket.
const draggingSessionId = signal(null);
const dragOverFolderKey = signal(null);
const folderKey = (folder) => folder ? folder.id : 'unsorted';

function NavItem({ tab, icon, label, dirty }) {
  const selected = activeTab.value === tab;
  return html`
    <button class=${`nav-item${dirty ? ' has-changes' : ''}${selected ? ' is-active' : ''}`}
            role="tab" aria-selected=${selected ? 'true' : 'false'}
            onClick=${() => selectTab(tab)}>
      <span class="nav-icon">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>`;
}

// Module-level: the SessionRow currently being hovered as a reorder
// drop target. Set on dragOver, cleared on dragLeave/end. Drives the
// "above this row" insert-line indicator.
const reorderOverSessionId = signal(null);

// One row in the session tree. Click → open in main pane. Drag-to-folder
// is handled by FolderGroup's drop zone; same-folder reorder is handled
// here: the row is a drop target when an in-folder sibling is dragged.
function SessionRow({ s, folderId, siblingIds }) {
  clockTick.value; // subscribe for fmtAgo refresh
  const isActive = activeSessionId.value === s.id;
  const running = s.status === 'running';
  const title = s.title || s.workspace || s.id.slice(0, 12);

  const onClick = async (ev) => {
    ev.preventDefault();
    selectSession(s.id);
    // Auto-resume on click if the session is stopped — saves the user
    // from a second click on the "Resume" button in the right pane.
    // No-op if already running.
    if (s.status !== 'running') {
      try { await resumeSession(s.id); }
      catch (e) { setToast(e.message, 'error'); }
    }
  };

  const onRenameClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const next = await ccsmPrompt('New title', title, { title: 'Rename session', okLabel: 'Save' });
    if (next === null) return;
    try { await setSessionTitle(s.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDeleteClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ok = await ccsmConfirm(`Delete session ${title}? PTY will be killed if alive.`, {
      title: 'Delete session', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deleteSession(s.id);
      if (activeSessionId.value === s.id) activeSessionId.value = null;
    } catch (e) { setToast(e.message, 'error'); }
  };

  const onDragStart = (ev) => {
    draggingSessionId.value = s.id;
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', s.id); } catch {}
  };
  const onDragEnd = () => {
    draggingSessionId.value = null;
    dragOverFolderKey.value = null;
    reorderOverSessionId.value = null;
  };

  // Drop on a session row → place the dragged session at THIS row's
  // position. Same folder = pure reorder. Different folder = move +
  // position in one shot (reorderSessions sets both folderId and
  // order in one backend call). stopPropagation so .tree-folder
  // doesn't also fire its "drop into folder" handler — landing on a
  // row is the more specific intent.
  const draggedId = draggingSessionId.value;
  const acceptDrop = !!draggedId && draggedId !== s.id;
  const showInsertLine = acceptDrop && reorderOverSessionId.value === s.id;

  const onRowDragOver = (ev) => {
    if (!acceptDrop) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'move';
    if (reorderOverSessionId.value !== s.id) reorderOverSessionId.value = s.id;
    // Also clear the parent folder's drop-target highlight — we're
    // overriding to "drop on this row" semantics.
    if (dragOverFolderKey.value) dragOverFolderKey.value = null;
  };
  const onRowDragLeave = (ev) => {
    if (!acceptDrop) return;
    const rt = ev.relatedTarget;
    if (rt && ev.currentTarget.contains(rt)) return;
    if (reorderOverSessionId.value === s.id) reorderOverSessionId.value = null;
  };
  const onRowDrop = (ev) => {
    if (!acceptDrop) return;
    ev.preventDefault();
    ev.stopPropagation();
    const draggedSid = draggingSessionId.value;
    draggingSessionId.value = null;
    reorderOverSessionId.value = null;
    dragOverFolderKey.value = null;
    if (!draggedSid || !siblingIds) return;
    // Build the new sibling sequence: remove dragged (in case it was
    // already in this folder) then insert at this row's slot.
    const next = siblingIds.filter((id) => id !== draggedSid);
    const targetIdx = next.indexOf(s.id);
    if (targetIdx < 0) return;
    next.splice(targetIdx, 0, draggedSid);
    reorderSessions(folderId || null, next)
      .catch((e) => setToast(e.message, 'error'));
  };

  // Skip the HTML5 drag affordance on touch devices — `draggable=true`
  // makes mobile browsers interpret the first tap as a drag-start
  // gesture, swallowing the click event entirely. The user then needs
  // a second tap to navigate. Touch users don't reorder sessions by
  // drag anyway; we'd add a dedicated "move to folder" affordance if
  // anyone asked.
  const touchDevice = isMobile.value || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  return html`
    <div class=${`tree-session${isActive ? ' is-active' : ''}${running ? ' is-running' : ' is-stopped'}${running && s.activity === 'working' ? ' is-working' : ''}${showInsertLine ? ' is-reorder-target' : ''}`}
         draggable=${!touchDevice}
         onDragStart=${onDragStart}
         onDragEnd=${onDragEnd}
         onDragOver=${onRowDragOver}
         onDragLeave=${onRowDragLeave}
         onDrop=${onRowDrop}
         onClick=${onClick}
         title=${`${title}\n${s.cwd}\n${running ? (s.activity === 'working' ? 'working' : 'idle') : 'stopped'} · ${s.cliId}`}>
      <span class=${`tree-dot ${running ? 'is-running' : 'is-stopped'}${running && s.activity === 'working' ? ' is-working' : ''}`}></span>
      <span class="tree-label">${title}</span>
      <span class="tree-session-actions">
        <button class="tree-session-action" title="rename" onClick=${onRenameClick}><${IconPencil} /></button>
        <button class="tree-session-action" title="delete" onClick=${onDeleteClick}><${IconClose} /></button>
      </span>
      <span class="tree-meta">${fmtAgo(s.lastActiveAt)}</span>
    </div>`;
}

function FolderGroup({ folder, sessionList, dndHandle, dndRow }) {
  // folder is now always set — backend materializes a synthetic
  // {id:'unsorted', name:'Unsorted', builtin:true} entry alongside the
  // user folders. The bucket can be drag-reordered like any other but
  // Rename / Delete are hidden, and drops set folderId=null so existing
  // sessions don't need a data migration.
  const isUnsorted = folder?.id === 'unsorted' || folder?.builtin;
  const key = folder ? folder.id : 'unsorted';
  const collapsed = !!foldersCollapsed.value[key];
  const name = folder ? folder.name : 'Unsorted';
  const onToggle = () => toggleFolder(folder ? folder.id : null);

  const onRename = async (ev) => {
    ev.stopPropagation();
    if (!folder || isUnsorted) return;
    const next = await ccsmPrompt('Rename folder', folder.name, { title: folder.name, okLabel: 'Save' });
    if (next === null || !next.trim()) return;
    try { await renameFolder(folder.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDelete = async (ev) => {
    ev.stopPropagation();
    if (!folder || isUnsorted) return;
    const ok = await ccsmConfirm(`Delete folder "${folder.name}"? Sessions inside move to Unsorted.`, {
      title: 'Delete folder', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await deleteFolder(folder.id); }
    catch (e) { setToast(e.message, 'error'); }
  };

  // Session-into-folder drop target. We don't go through useDragSort
  // because that one is wired for folder-reorder. Folder reorder's
  // handlers (in dndRow) short-circuit when no folder is being dragged,
  // and our handlers below short-circuit when no session is being
  // dragged — so composing both is safe.
  // When the dragged session lands on the Unsorted bucket, we persist
  // it with folderId=null (matches the existing data model — sessions
  // with no folder are null, not 'unsorted'). Same for the sameFolder
  // guard below.
  const dropFolderId = isUnsorted ? null : (folder ? folder.id : null);
  const draggedSession = draggingSessionId.value
    ? sessions.value.find((s) => s.id === draggingSessionId.value)
    : null;
  const sameFolder = draggedSession
    && (draggedSession.folderId || null) === dropFolderId;
  const isOver = !sameFolder && dragOverFolderKey.value === key;

  const onSessionDragOver = (ev) => {
    if (!draggingSessionId.value || sameFolder) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    if (dragOverFolderKey.value !== key) dragOverFolderKey.value = key;
  };
  const onSessionDragLeave = (ev) => {
    if (!draggingSessionId.value) return;
    const rt = ev.relatedTarget;
    if (rt && ev.currentTarget.contains(rt)) return;
    if (dragOverFolderKey.value === key) dragOverFolderKey.value = null;
  };
  const onSessionDrop = (ev) => {
    const sid = draggingSessionId.value;
    draggingSessionId.value = null;
    dragOverFolderKey.value = null;
    if (!sid || sameFolder) return;
    ev.preventDefault();
    ev.stopPropagation();
    setSessionFolder(sid, dropFolderId)
      .then(() => setToast(`moved to ${name}`))
      .catch((e) => setToast(e.message, 'error'));
  };

  // Spread folder-reorder row handlers first, then compose our
  // session-drop handlers on top so both fire.
  const { onDragOver: rowOver, onDragLeave: rowLeave, onDrop: rowDrop, ...rowAttrs } = dndRow || {};
  const composedOver = (ev) => { onSessionDragOver(ev); rowOver?.(ev); };
  const composedLeave = (ev) => { onSessionDragLeave(ev); rowLeave?.(ev); };
  const composedDrop = (ev) => { onSessionDrop(ev); rowDrop?.(ev); };

  return html`
    <div class=${`tree-folder${isOver ? ' is-session-drop-target' : ''}`}
         ...${rowAttrs}
         onDragOver=${composedOver}
         onDragLeave=${composedLeave}
         onDrop=${composedDrop}>
      <button class=${`tree-folder-head${collapsed ? '' : ' is-open'}`} onClick=${onToggle}
              ...${dndHandle || {}}>
        <span class="tree-folder-icon">
          ${collapsed ? html`<${IconFolder} />` : html`<${IconFolderOpen} />`}
        </span>
        <span class="tree-folder-name">${name}</span>
        ${folder && !isUnsorted ? html`
          <span class="tree-folder-actions">
            <button class="tree-folder-action" title="rename" onClick=${onRename}><${IconPencil} /></button>
            <button class="tree-folder-action" title="delete" onClick=${onDelete}><${IconClose} /></button>
          </span>` : null}
      </button>
      ${!collapsed ? html`
        <div class="tree-folder-body">
          ${sessionList.length === 0
            ? html`<div class="tree-empty">no sessions</div>`
            : (() => {
                // siblingIds captured once per render so each row sees a
                // consistent snapshot for splice math.
                const siblingIds = sessionList.map((x) => x.id);
                return sessionList.map((s) => html`
                  <${SessionRow} key=${s.id} s=${s}
                                 folderId=${dropFolderId}
                                 siblingIds=${siblingIds} />`);
              })()}
        </div>
      ` : null}
    </div>`;
}

function SessionTree() {
  const grouped = sessionsByFolder.value;
  const orderedFolders = folders.value;
  const dnd = useDragSort(
    orderedFolders.map((f) => f.id),
    async (nextIds) => {
      try { await reorderFolders(nextIds); }
      catch (e) { setToast(e.message, 'error'); }
    },
  );

  const onNewFolder = async () => {
    const name = await ccsmPrompt('Folder name', '', { title: 'New folder', okLabel: 'Create' });
    if (!name || !name.trim()) return;
    try { await createFolder(name.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <div class="tree">
      <div class="tree-head">
        <span class="tree-head-label">Sessions</span>
        <button class="tree-head-action" title="New folder" onClick=${onNewFolder}>
          <${IconPlus} />
        </button>
      </div>
      ${orderedFolders.map((f) => html`
        <${FolderGroup} key=${f.id} folder=${f}
                        sessionList=${grouped.get(f.id) || []}
                        dndHandle=${dnd.handleProps(f.id)}
                        dndRow=${dnd.rowProps(f.id)} />`)}
    </div>`;
}

export function Sidebar() {
  // On phones the sidebar is rendered inside a full-screen drawer
  // (App applies .is-mobile + .drawer-open classes). It should always
  // appear in EXPANDED form there — full labels + sessions tree.
  // Desktop/tablet keeps the original collapse behaviour.
  const mobile = isMobile.value;
  const collapsed = !mobile && (sidebarCollapsed.value || sidebarForcedCollapsed.value);
  const forced = !mobile && sidebarForcedCollapsed.value;

  const onResizeStart = (ev) => {
    if (collapsed) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-resizing-sidebar');
    const move = (e) => setSidebarWidth(e.clientX);
    const up = () => {
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      document.body.classList.remove('is-resizing-sidebar');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return html`
    <aside class="sidebar" data-collapsed=${collapsed ? 'true' : 'false'}>
      <div class="sidebar-top">
        <button class="sidebar-brand sidebar-brand-button"
                role="tab" aria-selected=${activeTab.value === 'about' ? 'true' : 'false'}
                title="About"
                onClick=${() => selectTab('about')}>
          <span class="brand-mark"><${BrandMark} /></span>
          <span class="brand-name">CCSM</span>
        </button>
      </div>

      <nav class="sidebar-nav compact" role="tablist" aria-label="Sections">
        <${NavItem} tab="launch"    icon=${html`<${IconLaunch} />`}    label="New Session" />
        ${!isRemoteAccess() ? html`
          <${NavItem} tab="remote"  icon=${html`<${IconRemote} />`}    label="Remote" />
        ` : null}
        <${NavItem} tab="configure" icon=${html`<${IconConfigure} />`} label="Settings" dirty=${configDirty.value} />
      </nav>

      ${!collapsed ? html`<${SessionTree} />` : null}

      <div class="sidebar-foot">
        ${!forced ? html`
          <button class="util-item collapse-toggle" aria-label=${collapsed ? 'expand sidebar' : 'collapse sidebar'}
                  title=${collapsed ? 'expand sidebar' : 'collapse sidebar'}
                  onClick=${toggleSidebar}>
            <span class="nav-icon"><${IconSidebarToggle} /></span>
          </button>
        ` : null}
      </div>

      ${!collapsed ? html`
        <div class="sidebar-resize-handle" role="separator" aria-orientation="vertical"
             aria-label="resize sidebar"
             title="drag to resize · double-click to reset"
             onPointerDown=${onResizeStart}
             onDblClick=${() => setSidebarWidth(232)}></div>
      ` : null}
    </aside>`;
}
