// Lightweight HTML5 drag-reorder helper.
//
// Usage:
//   const dnd = useDragSort(items.map((i) => i.id), async (nextIds) => {
//     await reorderFolders(nextIds);
//   });
//   items.map((it) => html`
//     <div ...${dnd.rowProps(it.id)}>
//       <span ...${dnd.handleProps(it.id)}>⋮⋮</span>
//       ...
//     </div>`);
//
// rowProps spreads onDragOver / onDrop / data-* on the row container.
// handleProps spreads draggable + onDragStart on the drag handle. We
// gate "draggable" on the handle so clicks inside the row don't start a
// drag and the user can still click rows normally.

import { useRef, useState } from 'preact/hooks';

export function useDragSort(ids, onCommit) {
  const dragging = useRef(null);
  const [overId, setOverId] = useState(null);

  const handleProps = (id) => ({
    draggable: true,
    onDragStart: (ev) => {
      dragging.current = id;
      ev.dataTransfer.effectAllowed = 'move';
      // Setting some data is required for Firefox to actually start a drag.
      try { ev.dataTransfer.setData('text/plain', id); } catch {}
    },
    onDragEnd: () => { dragging.current = null; setOverId(null); },
  });

  const rowProps = (id) => ({
    'data-dnd-id': id,
    'data-dnd-over': overId === id ? 'true' : undefined,
    onDragOver: (ev) => {
      if (dragging.current == null || dragging.current === id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (overId !== id) setOverId(id);
    },
    onDragLeave: (ev) => {
      // Only clear if the pointer leaves the row entirely (not when entering a child).
      const rt = ev.relatedTarget;
      if (rt && ev.currentTarget.contains(rt)) return;
      if (overId === id) setOverId(null);
    },
    onDrop: (ev) => {
      ev.preventDefault();
      const src = dragging.current;
      dragging.current = null;
      setOverId(null);
      if (src == null || src === id) return;
      const cur = [...ids];
      const from = cur.indexOf(src);
      const to = cur.indexOf(id);
      if (from < 0 || to < 0) return;
      cur.splice(from, 1);
      cur.splice(to, 0, src);
      onCommit?.(cur);
    },
  });

  return { handleProps, rowProps, draggingId: dragging.current, overId };
}
