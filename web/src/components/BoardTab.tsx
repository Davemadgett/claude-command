import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { MouseEvent, ReactNode } from 'react';

/**
 * One tab in the second row, draggable to reorder.
 *
 * The tab is its own drag handle, so it has to tell a drag from a click: dnd-kit
 * is given a small distance to travel before a drag starts, and anything shorter
 * than that stays a click and switches boards. Without that the row would be
 * unusable — every attempt to change board would begin a drag.
 */
export function BoardTab({
  id,
  active,
  title,
  onClick,
  onDoubleClick,
  onContextMenu,
  children,
}: {
  id: string;
  active: boolean;
  title?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <button
      ref={setNodeRef}
      className={`board-tab${active ? ' on' : ''}${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={title}
      {...attributes}
      {...listeners}
    >
      {children}
    </button>
  );
}
