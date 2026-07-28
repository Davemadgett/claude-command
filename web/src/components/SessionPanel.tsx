import { useEffect, useState } from 'react';
import { api } from '../api';
import { MirrorView } from './MirrorView';
import { TerminalView } from './TerminalView';
import { FilesView } from './FilesView';
import { ManualCardPanel } from './ManualCardPanel';
import { SummaryView } from './SummaryView';
import type { Card } from '../types';

type Mode = 'summary' | 'live' | 'mirror' | 'files';

type Props = {
  card: Card | null;
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenSession: (sessionId: string) => void;
};

export function SessionPanel({ card, onChanged, onError, onOpenSession }: Props) {
  const [mode, setMode] = useState<Mode>('summary');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Follow the session: a live one opens its terminal, a dormant one its mirror.
  useEffect(() => {
    setMode(card?.live ? 'live' : 'summary');
  }, [card?.sessionId, card?.live]);

  if (!card) {
    return (
      <div className="pane-empty">
        <div>No session selected</div>
        <div className="hint">
          Click a card to open it. Sessions started from this board run live here; sessions you
          started elsewhere open as a read-only mirror you can resume; a card with no session yet
          offers to start one.
        </div>
      </div>
    );
  }

  if (card.manual) {
    return (
      <div className="session-view">
        <div className="pane-bar">
          <span className="badge note">note</span>
          <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{card.title}</strong>
        </div>
        <div className="pane-content" style={{ overflowY: 'auto' }}>
          <ManualCardPanel
            card={card}
            onChanged={onChanged}
            onError={onError}
            onStarted={onOpenSession}
            onDeleted={onChanged}
          />
        </div>
      </div>
    );
  }

  /**
   * One button for both cases. A card can exist before its conversation does —
   * started from the board and never typed into, or made from a calendar event —
   * and "Resume here" had nothing to resume, so it simply failed. The server
   * makes the final call from whether a transcript exists; this only decides
   * what the button should say.
   */
  const canResume = card.hasTranscript ?? card.userTurns > 0;

  const start = async (startMode: 'resume' | 'new') => {
    setBusy(true);
    try {
      await api.startSession(card.sessionId, { mode: startMode, cwd: card.cwd ?? undefined });
      setMode('live');
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.stopSession(card.sessionId);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-view">
      <div className="pane-bar">
        <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{card.title}</strong>
        {card.label && <span className="badge label">{card.label}</span>}
        <span className="path" title={card.cwd ?? ''}>
          {card.cwd?.replace(/^\/Users\/[^/]+/, '~')}
        </span>

        <div className="spacer" />

        <div className="seg">
          <button
            className={mode === 'summary' ? 'on' : ''}
            onClick={() => setMode('summary')}
            title="What this session was doing"
          >
            Summary
          </button>
          <button
            className={mode === 'live' ? 'on' : ''}
            onClick={() => setMode('live')}
            disabled={!card.live}
            title={card.live ? 'Live terminal' : 'Session is not running'}
          >
            Terminal
          </button>
          <button
            className={mode === 'mirror' ? 'on' : ''}
            onClick={() => {
              setMode('mirror');
              setRefreshKey((k) => k + 1);
            }}
          >
            Mirror
          </button>
          <button
            className={mode === 'files' ? 'on' : ''}
            onClick={() => {
              setMode('files');
              setRefreshKey((k) => k + 1);
            }}
            title="Documents this session produced"
          >
            Files
          </button>
        </div>

        {card.live ? (
          <button className="danger" onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => start(canResume ? 'resume' : 'new')}
            disabled={busy}
            title={
              canResume
                ? 'Pick this conversation up where it left off'
                : 'This card has no conversation yet — start one'
            }
          >
            {busy ? 'Starting…' : canResume ? 'Resume here' : 'Start session'}
          </button>
        )}
      </div>

      <div className="pane-content">
        {mode === 'summary' ? (
          <SummaryView card={card} />
        ) : mode === 'files' ? (
          <FilesView sessionId={card.sessionId} refreshKey={refreshKey} onError={onError} />
        ) : mode === 'live' && card.live ? (
          <TerminalView key={card.sessionId} sessionId={card.sessionId} onExit={onChanged} />
        ) : mode === 'live' ? (
          <div className="pane-empty">
            <div>{canResume ? 'This session isn’t running in the board' : 'No session yet'}</div>
            <div className="hint">
              {canResume ? (
                <>
                  “Resume here” runs <code>claude --resume {card.sessionId.slice(0, 8)}…</code> in{' '}
                  <code>{card.cwd?.replace(/^\/Users\/[^/]+/, '~')}</code>. It keeps the same session
                  id, so this card and its history follow it.
                </>
              ) : (
                <>
                  This card has never been worked in. “Start session” opens a fresh Claude in{' '}
                  <code>{card.cwd?.replace(/^\/Users\/[^/]+/, '~')}</code> under this card’s id, so
                  everything it does stays attached here.
                </>
              )}
            </div>
            <button
              className="primary"
              onClick={() => start(canResume ? 'resume' : 'new')}
              disabled={busy}
            >
              {canResume ? 'Resume here' : 'Start session'}
            </button>
          </div>
        ) : (
          <MirrorView sessionId={card.sessionId} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  );
}
