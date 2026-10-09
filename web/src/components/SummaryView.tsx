import { useEffect, useState } from 'react';
import { relTime } from './CardView';
import { api } from '../api';
import type { Card } from '../types';

/**
 * Your own note on a session card.
 *
 * Manual cards have had an editable note since the beginning; session cards
 * carried the same column and had nowhere to show or set it, so a note on one
 * was write-only through the API. It sits above the machine-written summary
 * because it is the one line on this screen a person chose to write.
 *
 * Saves on blur, like every other free-text field here — there is no Save
 * button anywhere in this app and adding one here would be the odd case out.
 */
function NotesBlock({ card, onChanged }: { card: Card; onChanged?: () => void }) {
  const [notes, setNotes] = useState(card.notes);
  const [error, setError] = useState<string | null>(null);

  // Follow the card. Without this, clicking a second card would show the first
  // one's note in the box.
  useEffect(() => {
    setNotes(card.notes);
    setError(null);
  }, [card.sessionId, card.notes]);

  const save = async () => {
    if (notes === card.notes) return;
    try {
      await api.updateCard(card.sessionId, { notes });
      setError(null);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="summary-block">
      <h3>Your note</h3>
      <textarea
        className="summary-notes"
        rows={notes.trim() ? 4 : 2}
        value={notes}
        placeholder="Anything you want to remember about this one."
        onChange={(e) => setNotes(e.target.value)}
        onBlur={save}
      />
      {error && <p className="summary-empty" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}

/**
 * The drill-down layer between a card and the raw transcript: what this session
 * was doing, in a few lines, so you can decide whether to go further.
 */
export function SummaryView({ card, onChanged }: { card: Card; onChanged?: () => void }) {
  const facts = [
    card.label
      ? [
          'Label',
          card.labelSource === 'files'
            ? `${card.label} — inferred from files it wrote`
            : card.labelSource === 'board'
              ? `${card.label} — the board's default`
              : card.label,
        ]
      : null,
    card.cwd ? ['Folder', card.cwd.replace(/^\/Users\/[^/]+/, '~')] : null,
    ['Last activity', relTime(card.lastActivity)],
    card.userTurns > 0 ? ['Exchanges', String(card.userTurns)] : null,
    card.live ? ['Status', `running · pid ${card.pid}`] : null,
  ].filter(Boolean) as [string, string][];

  return (
    <div className="summary">
      <NotesBlock card={card} onChanged={onChanged} />

      <div className="summary-block">
        <h3>What Claude was doing</h3>
        {card.summary?.length ? (
          <ul className="summary-bullets">
            {card.summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="summary-empty">
            Nothing recorded yet — this session hasn’t done anything worth summarising.
          </p>
        )}
      </div>

      <div className="summary-block">
        <h3>Where it sits</h3>
        {(card.labelUrl || card.labelFolder) && (
          <p className="summary-links">
            {card.labelUrl && (
              <a className="label-link" href={card.labelUrl} target="_blank" rel="noreferrer">
                Open {card.label} →
              </a>
            )}
            {card.labelFolder && (
              <button
                className="label-link as-link"
                onClick={() => api.openFile(card.labelFolder!).catch(() => {})}
                title={card.labelFolder}
              >
                Open the folder →
              </button>
            )}
          </p>
        )}
        <dl className="summary-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="summary-hint">
        Mirror shows the full conversation. Files shows what it produced.
      </p>
    </div>
  );
}
