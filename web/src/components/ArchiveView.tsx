import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relTime } from './CardView';
import type { ArchivedCard } from '../types';

/** "tomorrow", "in 3 days", "on 12 Aug" — enough to judge without reading a date. */
function whenBack(iso: string) {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'any moment';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  return `on ${new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

export function ArchiveView({ onRestored, onError }: {
  onRestored: () => void;
  onError: (m: string) => void;
}) {
  const [items, setItems] = useState<ArchivedCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (query: string) => {
      api
        .archive(query)
        .then((d) => {
          setItems(d.items);
          setTotal(d.total);
        })
        .catch((e) => onError((e as Error).message));
    },
    [onError]
  );

  // Debounced so typing doesn't fire a full transcript scan per keystroke.
  useEffect(() => {
    const id = setTimeout(() => load(q), q ? 220 : 0);
    return () => clearTimeout(id);
  }, [q, load]);

  const restore = async (card: ArchivedCard) => {
    setBusy(card.sessionId);
    try {
      await api.restoreCard(card.sessionId);
      load(q);
      onRestored();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Drop a scheduled return without reopening the card — it stays closed, for good. */
  const cancelReturn = async (card: ArchivedCard) => {
    setBusy(card.sessionId);
    try {
      await api.snoozeCard(card.sessionId, null);
      load(q);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const purge = async (card: ArchivedCard) => {
    if (!confirm(`Permanently delete “${card.title}”?\n\nThis removes the card for good. It does not touch the Claude transcript itself.`)) return;
    setBusy(card.sessionId);
    try {
      await api.deleteCard(card.sessionId);
      load(q);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="view">
      <h2>Archive</h2>
      <p className="sub">
        Every card you have closed, newest first. Closing never deletes anything — restore puts a
        card back in the column it came from. Deleting for good is only possible from here, and even
        that removes the card, never the Claude transcript behind it. Cards you closed with a return
        date sort to the top and come back on their own, whether or not the app was open that day.
      </p>

      <div style={{ maxWidth: 420, marginBottom: 16 }}>
        <input
          placeholder="Search title, notes, label, folder…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      {!items ? (
        <div className="pane-empty">Loading archive…</div>
      ) : items.length === 0 ? (
        <div className="pane-empty">
          <div>{q ? `Nothing archived matches “${q}”` : 'Nothing archived'}</div>
          {!q && <div className="hint">Cards you close will collect here.</div>}
        </div>
      ) : (
        <>
          <div className="archive-count">
            {q ? `${items.length} of ${total} archived cards` : `${total} archived cards`}
            {(() => {
              const due = items.filter((c) => c.wakeAt).length;
              return due > 0 ? ` · ${due} coming back` : '';
            })()}
          </div>

          {items.map((card) => (
            <div className="archive-row" key={card.sessionId}>
              <div className="archive-main">
                <div className="archive-title">
                  {card.manual && <span className="badge note">note</span>}
                  {card.label && <span className="badge label">{card.label}</span>}
                  {card.wakeAt && <span className="badge returning">back {whenBack(card.wakeAt)}</span>}
                  {card.title}
                </div>
                <div className="archive-meta">
                  closed {relTime(card.archivedAt)}
                  {card.boardName && (
                    <>
                      {' · from '}
                      <strong>{card.boardName}</strong> / {card.columnName}
                    </>
                  )}
                  {card.columnMissing && (
                    <span style={{ color: '#fbbf24' }}> · that column is gone — restores to the first one</span>
                  )}
                  {card.userTurns > 0 && ` · ${card.userTurns} turns`}
                </div>
                {card.notes && <div className="archive-notes">{card.notes}</div>}
              </div>

              <div className="archive-actions">
                {card.wakeAt && (
                  <button
                    className="ghost"
                    disabled={busy === card.sessionId}
                    title={`Scheduled to return ${new Date(card.wakeAt).toLocaleString()}`}
                    onClick={() => cancelReturn(card)}
                  >
                    Don’t bring back
                  </button>
                )}
                <button className="primary" disabled={busy === card.sessionId} onClick={() => restore(card)}>
                  Restore
                </button>
                <button className="ghost danger" disabled={busy === card.sessionId} onClick={() => purge(card)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
