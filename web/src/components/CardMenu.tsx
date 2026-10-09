import { useEffect, useRef, useState } from 'react';
import type { BoardTab, Card, Priority } from '../types';

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const LEVELS: { value: Priority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: null, label: 'None' },
];

/*
 * Early enough to be waiting for you at the start of the day rather than landing
 * in the middle of it. Worked out in the browser, so a card brought back
 * "tomorrow" arrives on your tomorrow morning wherever you happen to be.
 */
const WAKE_HOUR = 8;

function morningIn(days: number, months = 0) {
  const d = new Date();
  if (months) d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() + days);
  d.setHours(WAKE_HOUR, 0, 0, 0);
  return d;
}

const PRESETS: { label: string; when: () => Date }[] = [
  { label: 'Tomorrow', when: () => morningIn(1) },
  { label: 'In a week', when: () => morningIn(7) },
  { label: 'In a month', when: () => morningIn(0, 1) },
];

/** Today as the date field wants it. Built from local parts — `toISOString` is UTC,
 *  which east of Greenwich would offer you a day that has already gone. */
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  onSnooze: (card: Card, wakeAt: string) => void;
  labelsEnabled: boolean;
  labelNoun: string;
};

export function CardMenu({
  card, boards, currentBoardId, x, y, onClose, onRename, onArchive, onDelete, onMoveToBoard,
  onSetPriority, onSetLabel, onSnooze, labelsEnabled, labelNoun,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pickDate, setPickDate] = useState<string | null>(null);

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
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 470) }}
    >
      <button onClick={run(() => onRename(card))}>Rename…</button>
      {labelsEnabled && (
        <button onClick={run(() => onSetLabel(card))}>
          {card.label
            ? `${capitalise(labelNoun)} · ${card.label}`
            : `Set ${labelNoun}…`}
        </button>
      )}

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

      {/*
        * Closing a card and scheduling its return are the same gesture: the work
        * is done for now, and you want it in front of you again on a date you
        * choose. The card leaves the board either way — it comes back to the
        * first column on its own, and sits in the Archive until it does.
        */}
      <div className="card-menu-label">Close and bring back</div>
      {pickDate === null ? (
        <>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={run(() => onSnooze(card, p.when().toISOString()))}>
              {p.label}
            </button>
          ))}
          <button onClick={() => setPickDate('')}>Pick a date…</button>
        </>
      ) : (
        <div className="card-menu-date">
          <input
            type="date"
            autoFocus
            value={pickDate}
            min={todayLocal()}
            onChange={(e) => setPickDate(e.target.value)}
          />
          <button
            className="primary"
            disabled={!pickDate}
            onClick={run(() => {
              // Parsed as local parts, not as the UTC midnight `new Date('…')` would give.
              const [y, m, d] = pickDate.split('-').map(Number);
              onSnooze(card, new Date(y, m - 1, d, WAKE_HOUR, 0, 0, 0).toISOString());
            })}
          >
            Set
          </button>
        </div>
      )}

      <div className="card-menu-sep" />
      <button className="danger" onClick={run(() => (card.manual ? onDelete(card) : onArchive(card)))}>
        Close card
      </button>
    </div>
  );
}
