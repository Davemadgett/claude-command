import { useEffect, useRef } from 'react';
import type { BoardTab, Card, Priority } from '../types';

const LEVELS: { value: Priority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: null, label: 'None' },
];

type Props = {
  card: Card;
  boards: BoardTab[];
  currentBoardId: string;
  x: number;
  y: number;
  onClose: () => void;
  onRename: (card: Card) => void;
  onArchive: (card: Card) => void;
  onDelete: (card: Card) => void;
  onMoveToBoard: (card: Card, boardId: string) => void;
  onSetPriority: (card: Card, priority: Priority) => void;
  onSetLabel: (card: Card) => void;
};

export function CardMenu({
  card, boards, currentBoardId, x, y, onClose, onRename, onArchive, onDelete, onMoveToBoard,
  onSetPriority, onSetLabel,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const others = boards.filter((b) => b.id !== currentBoardId);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="card-menu"
      ref={ref}
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 340) }}
    >
      <button onClick={run(() => onRename(card))}>Rename…</button>
      <button onClick={run(() => onSetLabel(card))}>
        {card.label ? `Label · ${card.label}` : 'Set label…'}
      </button>

      <div className="card-menu-label">Priority</div>
      {LEVELS.map((level) => (
        <button
          key={level.label}
          className={`prio-option${(card.priority ?? null) === level.value ? ' on' : ''}`}
          onClick={run(() => onSetPriority(card, level.value))}
        >
          {level.value && <span className={`dot ${level.value}`} />}
          {level.label}
          {(card.priority ?? null) === level.value && <span className="tick">✓</span>}
        </button>
      ))}

      {others.length > 0 && (
        <>
          <div className="card-menu-label">Move to board</div>
          {others.map((b) => (
            <button key={b.id} onClick={run(() => onMoveToBoard(card, b.id))}>
              {b.name}
            </button>
          ))}
        </>
      )}

      <div className="card-menu-sep" />
      <button className="danger" onClick={run(() => (card.manual ? onDelete(card) : onArchive(card)))}>
        Close card
      </button>
    </div>
  );
}
