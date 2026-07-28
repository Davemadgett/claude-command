import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api';
import type { Card, Priority } from '../types';

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** "Tomorrow", "Mon 2:00 PM", "Aug 14" — short enough for a card. */
function eventWhen(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - midnight.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (days === 0) return allDay ? 'Today' : `Today ${time}`;
  if (days === 1) return allDay ? 'Tomorrow' : `Tomorrow ${time}`;
  if (days > 1 && days < 7) {
    const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
    return allDay ? wd : `${wd} ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PRIORITY_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MED', low: 'LOW' };

/**
 * Click order, and why High comes first: the reason you reach for priority at all
 * is almost always to say "this one now". Putting High one click away makes the
 * common case free, and the rest of the cycle is there for the times you want to
 * push something down instead.
 */
const PRIORITY_CYCLE: Priority[] = ['high', 'medium', 'low', null];

const nextPriority = (current: Priority): Priority =>
  PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(current ?? null) + 1) % PRIORITY_CYCLE.length];

const PRIORITY_HINT: Record<string, string> = {
  high: 'High priority — click for Medium',
  medium: 'Medium priority — click for Low',
  low: 'Low priority — click to clear',
};

type Props = {
  card: Card;
  selected: boolean;
  onSelect: (card: Card) => void;
  onOpen: (card: Card) => void;
  onArchive: (card: Card) => void;
  onMenu: (card: Card, x: number, y: number) => void;
  onConfirmLabel?: (card: Card, label: string) => void;
  onDismissLabel?: (card: Card) => void;
  onCyclePriority?: (card: Card, priority: Priority) => void;
};

/**
 * Deliberately spare: a status, where it belongs, what it is, and a way in.
 * Everything else — what Claude did, the transcript, the files — lives one click
 * away in the panel, so cards stay quick to scan and quick to drag.
 */
export function CardContent({
  card,
  onOpen,
  onConfirmLabel,
  onDismissLabel,
  onCyclePriority,
}: {
  card: Card;
  onOpen?: (card: Card) => void;
  onConfirmLabel?: (card: Card, label: string) => void;
  onDismissLabel?: (card: Card) => void;
  onCyclePriority?: (card: Card, priority: Priority) => void;
}) {
  return (
    <>
      <div className="card-top">
        {/*
          The chip is the control. Priority lived in the ⋯ menu, which meant two
          clicks and a menu to say one word about a card — and a card you have
          said nothing about showed nothing at all, so there was no way to learn
          the feature existed from looking at the board. An unset card now carries
          a quiet dot instead: visible enough to click, faint enough that a board
          of unprioritised cards still reads as unprioritised.
        */}
        {onCyclePriority ? (
          <button
            className={`badge prio ${card.priority ?? 'unset'}`}
            title={card.priority ? PRIORITY_HINT[card.priority] : 'Set priority — click for High'}
            aria-label={card.priority ? `${card.priority} priority` : 'No priority set'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCyclePriority(card, nextPriority(card.priority ?? null));
            }}
          >
            {card.priority ? PRIORITY_LABEL[card.priority] : <span className="dot" />}
          </button>
        ) : (
          card.priority && (
            <span className={`badge prio ${card.priority}`}>{PRIORITY_LABEL[card.priority]}</span>
          )
        )}
        {card.live && (
          <span className="badge live">
            <span className="pulse" />
            LIVE
          </span>
        )}
        {card.manual && <span className="badge note">note</span>}
        {card.label ? (
          card.labelUrl ? (
            <a
              className="badge label"
              href={card.labelUrl}
              target="_blank"
              rel="noreferrer"
              title={`Open ${card.label} in Clio`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {card.label}
            </a>
          ) : (
            <span className="badge label">{card.label}</span>
          )
        ) : (
          !card.manual && <span className="badge">{card.project}</span>
        )}

        {card.labelFolder && (
          <button
            className="folder-btn"
            title={`Open the Dropbox folder for ${card.label} in Finder`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              api.openFile(card.labelFolder!).catch(() => {});
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M1.5 3.5h4l1.2 1.6h7.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="card-title">{card.title}</div>

      {/*
        A guess, not an answer. It came from a surname in what you typed, which is
        the evidence that has been wrong before — so it sits here as a question
        with two ways out, and never quietly becomes the card's label.
      */}
      {!card.label && card.labelSuggested && onConfirmLabel && (
        <div className="card-suggest" onPointerDown={(e) => e.stopPropagation()}>
          <span className="q" title="Detected in what you typed in this session">
            {card.labelSuggested}?
          </span>
          <button
            className="yes"
            title={`Attach ${card.labelSuggested} to this card`}
            onClick={(e) => {
              e.stopPropagation();
              onConfirmLabel(card, card.labelSuggested!);
            }}
          >
            ✓
          </button>
          <button
            className="no"
            title="Not this label — don’t ask again"
            onClick={(e) => {
              e.stopPropagation();
              onDismissLabel?.(card);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {card.nextEvent && (
        <div className="card-event" title={card.nextEvent.title}>
          <span className="card-event-when">{eventWhen(card.nextEvent.start, card.nextEvent.allDay)}</span>
          {card.nextEvent.title}
        </div>
      )}

      <div className="card-meta">
        <span>{relTime(card.lastActivity)}</span>
        <div className="spacer" />
        {!card.manual && onOpen && (
          <button
            className="card-open"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(card);
            }}
          >
            Open
          </button>
        )}
      </div>
    </>
  );
}

export function CardView({
  card, selected, onSelect, onOpen, onArchive, onMenu, onConfirmLabel, onDismissLabel,
  onCyclePriority,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.sessionId,
    data: { type: 'card', card },
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        'card',
        card.manual ? 'manual' : '',
        card.live ? 'live' : '',
        // Priority owns the left edge when it is set — it outranks both of the
        // above, which is the point of setting it.
        card.priority ? `prio-${card.priority}` : '',
        selected ? 'selected' : '',
        isDragging ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onSelect(card)}
      onDoubleClick={() => onOpen(card)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(card, e.clientX, e.clientY);
      }}
      {...attributes}
      {...listeners}
    >
      <div className="card-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="ghost"
          title="More — rename, move to another board, close"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(card, r.left - 170, r.bottom + 4);
          }}
        >
          ⋯
        </button>
        <button
          className="ghost"
          title="Close card — recoverable from the Archive tab"
          onClick={(e) => {
            e.stopPropagation();
            onArchive(card);
          }}
        >
          ✕
        </button>
      </div>
      <CardContent
        card={card}
        onOpen={onOpen}
        onConfirmLabel={onConfirmLabel}
        onDismissLabel={onDismissLabel}
        onCyclePriority={onCyclePriority}
      />
    </div>
  );
}
