import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Card, CwdSuggestion } from '../types';

type Props = {
  card: Card;
  onChanged: () => void;
  onError: (message: string) => void;
  onStarted: (sessionId: string) => void;
  onDeleted: () => void;
};

/**
 * A card you wrote yourself. Editing saves on blur; starting a session keeps the
 * card — same column, same position — and attaches the new session to it.
 */
export function ManualCardPanel({ card, onChanged, onError, onStarted, onDeleted }: Props) {
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [cwd, setCwd] = useState(card.cwd ?? '~');
  const [suggestions, setSuggestions] = useState<CwdSuggestion[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(card.title);
    setNotes(card.notes);
    setCwd(card.cwd ?? '~');
  }, [card.sessionId, card.title, card.notes, card.cwd]);

  useEffect(() => {
    api.cwds().then(setSuggestions).catch(() => setSuggestions([]));
  }, []);

  const save = async (fields: Record<string, unknown>) => {
    try {
      await api.updateCard(card.sessionId, fields);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const { sessionId } = await api.startSessionForCard(card.sessionId, cwd);
      onStarted(sessionId);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="manual-panel">
      <div className="field">
        <label>Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== card.title && save({ title: title.trim() })}
        />
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          rows={5}
          value={notes}
          placeholder="Anything you want to remember about this one."
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== card.notes && save({ notes })}
        />
      </div>

      <div className="field">
        <label>Start a Claude session for this card, in</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <div className="suggest">
          {suggestions.slice(0, 8).map((s) => (
            <button key={s.cwd} onClick={() => setCwd(s.cwd)} title={s.cwd}>
              {s.label ?? s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="manual-actions">
        <button className="primary" onClick={start} disabled={busy || !cwd.trim()}>
          {busy ? 'Starting…' : 'Start session'}
        </button>
        <div className="spacer" />
        <button
          className="danger"
          onClick={() =>
            api.archiveCard(card.sessionId).then(onDeleted).catch((e) => onError((e as Error).message))
          }
          title="Moves the card to the Archive, where you can search for it and restore it"
        >
          Close card
        </button>
      </div>

      <p className="hint" style={{ maxWidth: 620, marginTop: 4 }}>
        Starting a session keeps this card where it is — the card stops being a note and becomes the
        live session, with its title and notes intact.
      </p>
    </div>
  );
}
