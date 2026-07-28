import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CardView } from './CardView';
import type { Card, Column, Priority } from '../types';

type Props = {
  column: Column;
  cards: Card[];
  selectedId: string | null;
  onSelect: (card: Card) => void;
  onOpen: (card: Card) => void;
  onArchive: (card: Card) => void;
  onMenu: (card: Card, x: number, y: number) => void;
  onConfirmLabel: (card: Card, label: string) => void;
  onDismissLabel: (card: Card) => void;
  onCyclePriority: (card: Card, priority: Priority) => void;
  onAddCard: (columnId: string, title: string) => void;
  onRenameColumn: (id: string, name: string) => void;
  onRecolorColumn: (id: string, color: string) => void;
  onDeleteColumn: (id: string) => void;
  onToggleReviewLane: (id: string, enabled: boolean) => void;
  hasReviewLane: boolean;
};

export function ColumnView({
  column,
  cards,
  selectedId,
  onSelect,
  onOpen,
  onArchive,
  onMenu,
  onConfirmLabel,
  onDismissLabel,
  onCyclePriority,
  onAddCard,
  onRenameColumn,
  onRecolorColumn,
  onDeleteColumn,
  onToggleReviewLane,
  hasReviewLane,
}: Props) {
  // A lane belongs to one column and sits narrow beside it. A board inbox is a
  // column in its own right — it just happens to be where finished work lands.
  const isInbox = column.review_of === '*';
  const isLane = Boolean(column.review_of) && !isInbox;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const commitCard = () => {
    const title = newTitle.trim();
    if (!title) return;
    onAddCard(column.id, title);
    setNewTitle('');
    setComposing(false);
  };

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `column:${column.id}`,
    data: { type: 'column', columnId: column.id },
  });

  const {
    attributes,
    listeners,
    setNodeRef: setSortRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `col-sort:${column.id}`, data: { type: 'column-handle', columnId: column.id } });

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== column.name) onRenameColumn(column.id, name);
    else setDraft(column.name);
  };

  return (
    <div
      ref={setSortRef}
      className={['column', isLane ? 'lane' : '', isOver ? 'over' : '', isDragging ? 'dragging' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="column-head">
        <span className="grip" {...attributes} {...listeners} title="Drag to reorder column">
          ⠿
        </span>
        <label
          className="swatch"
          style={{ background: column.color, cursor: 'pointer' }}
          title="Change column color"
        >
          <input
            type="color"
            value={column.color}
            onChange={(e) => onRecolorColumn(column.id, e.target.value)}
            style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
          />
        </label>

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(column.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="name"
            onDoubleClick={() => {
              setDraft(column.name);
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {column.name}
          </span>
        )}

        <span className="n">{cards.length}</span>
        {!isLane && !isInbox && (
          <button
            className={`ghost lane-toggle${hasReviewLane ? ' on' : ''}`}
            title={hasReviewLane
              ? 'Remove this column’s review lane'
              : 'Add a review lane — finished work lands there'}
            onClick={() => onToggleReviewLane(column.id, !hasReviewLane)}
          >
            ✓
          </button>
        )}
        {!isLane && (
          <button
            className="ghost"
            title="Delete column (cards move to the first column)"
            onClick={() => onDeleteColumn(column.id)}
          >
            ✕
          </button>
        )}
      </div>

      <div className="column-body" ref={setDropRef}>
        <SortableContext items={cards.map((c) => c.sessionId)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <CardView
              key={card.sessionId}
              card={card}
              selected={card.sessionId === selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
              onArchive={onArchive}
              onMenu={onMenu}
              onConfirmLabel={onConfirmLabel}
              onDismissLabel={onDismissLabel}
              onCyclePriority={onCyclePriority}
            />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <div className="column-empty">
            {isLane
              ? 'Finished work lands here'
              : isInbox
                ? 'Work comes back here when Claude finishes or asks you something'
                : 'Drop sessions here'}
          </div>
        )}

        {isLane ? null : composing ? (
          <div className="compose" onPointerDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="What needs doing?"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCard();
                if (e.key === 'Escape') {
                  setComposing(false);
                  setNewTitle('');
                }
              }}
            />
            <div className="compose-actions">
              <button className="primary" disabled={!newTitle.trim()} onClick={commitCard}>
                Add card
              </button>
              <button
                onClick={() => {
                  setComposing(false);
                  setNewTitle('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="add-card" onClick={() => setComposing(true)}>
            + Add a card
          </button>
        )}
      </div>
    </div>
  );
}
