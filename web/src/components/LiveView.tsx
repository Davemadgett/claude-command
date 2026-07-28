import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { TerminalView } from './TerminalView';
import { relTime } from './CardView';
import type { LiveSession, RecentSession } from '../types';

const POLL_MS = 3000;

function Tile({
  session,
  expanded,
  onToggle,
  onOpen,
}: {
  session: LiveSession;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={`tile${expanded ? ' expanded' : ''}`}>
      <div className="tile-head">
        <span className={`tile-dot${session.working ? ' working' : ''}`} />
        {session.label ? (
          session.labelUrl ? (
            <a className="badge label" href={session.labelUrl} target="_blank" rel="noreferrer">
              {session.label}
            </a>
          ) : (
            <span className="badge label">{session.label}</span>
          )
        ) : (
          <span className="badge">{session.project}</span>
        )}
        <span className="tile-title" title={session.title}>
          {session.title}
        </span>
        <span className="tile-state">{session.working ? 'working' : 'waiting on you'}</span>
        <button className="ghost tile-btn" onClick={onToggle} title={expanded ? 'Shrink' : 'Expand'}>
          {expanded ? '⤡' : '⤢'}
        </button>
        <button className="ghost tile-btn" onClick={onOpen} title="Open on the board">
          ↗
        </button>
      </div>
      <div className="tile-term">
        {/* Not auto-focused: with several tiles on screen, focus has to be a choice. */}
        <TerminalView
          sessionId={session.sessionId}
          onExit={() => {}}
          fontSize={expanded ? 12.5 : 10}
          autoFocus={false}
        />
      </div>
    </div>
  );
}

export function LiveView({
  onOpenSession,
  onError,
}: {
  onOpenSession: (sessionId: string) => void;
  onError: (m: string) => void;
}) {
  const [live, setLive] = useState<LiveSession[] | null>(null);
  const [recent, setRecent] = useState<RecentSession[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [waking, setWaking] = useState<string | null>(null);

  /**
   * One click reactivates a past session and drops you into its terminal.
   * The server snapshots where it stood, so reopening it doesn't make it look
   * like the most recent thing you did — that only happens once you type.
   */
  const reactivate = async (s: RecentSession) => {
    if (s.live) {
      onOpenSession(s.sessionId);
      return;
    }
    setWaking(s.sessionId);
    try {
      await api.startSession(s.sessionId, { mode: 'resume', cwd: s.cwd ?? undefined });
      loadLive();
      onOpenSession(s.sessionId);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWaking(null);
    }
  };

  const loadLive = useCallback(() => {
    api.live().then((d) => setLive(d.sessions)).catch((e) => onError((e as Error).message));
  }, [onError]);

  useEffect(() => {
    loadLive();
    const id = setInterval(loadLive, POLL_MS);
    return () => clearInterval(id);
  }, [loadLive]);

  useEffect(() => {
    api.recent(40).then((d) => setRecent(d.sessions)).catch(() => setRecent([]));
  }, []);

  const shown = expanded ? (live ?? []).filter((s) => s.sessionId === expanded) : live ?? [];

  return (
    <div className="view wide">
      <h2>Live</h2>
      <p className="sub">
        Every session running right now, side by side. A tile is <em>working</em> while Claude is
        still producing output and <em>waiting on you</em> once it goes quiet — so you can see at a
        glance which one wants you. Click into a tile to type in it; expand for a full-size terminal.
      </p>

      {!live ? (
        <div className="pane-empty">Looking for running sessions…</div>
      ) : live.length === 0 ? (
        <div className="pane-empty">
          <div>Nothing running</div>
          <div className="hint">
            Sessions started from the board appear here. Open a card and hit <em>Resume here</em>, or
            use <em>+ New session</em>.
          </div>
        </div>
      ) : (
        <>
          {expanded && (
            <button className="ghost" style={{ marginBottom: 10 }} onClick={() => setExpanded(null)}>
              ← back to all {live.length} sessions
            </button>
          )}
          <div className={`wall${expanded ? ' single' : ''}`}>
            {shown.map((s) => (
              <Tile
                key={s.sessionId}
                session={s}
                expanded={expanded === s.sessionId}
                onToggle={() => setExpanded(expanded === s.sessionId ? null : s.sessionId)}
                onOpen={() => onOpenSession(s.sessionId)}
              />
            ))}
          </div>
        </>
      )}

      <h2 style={{ marginTop: 30 }}>Recent sessions</h2>
      <p className="sub">Newest first, wherever they ended up.</p>

      {!recent ? (
        <div className="pane-empty">Loading…</div>
      ) : (
        <div className="recent">
          {recent.map((s) => (
            <button
              key={s.sessionId}
              className="recent-row"
              onClick={() => reactivate(s)}
              disabled={waking === s.sessionId}
              title={s.live ? 'Open this session' : 'Reactivate and open this session'}
            >
              <span className="recent-when">{relTime(s.lastActivity)}</span>
              <span className="recent-main">
                <span className="recent-title">{s.title}</span>
                <span className="recent-meta">
                  {s.label ?? s.project}
                  {s.boardName && ` · ${s.boardName} / ${s.columnName}`}
                  {s.archived && ' · archived'}
                  {s.userTurns > 0 && ` · ${s.userTurns} turns`}
                </span>
              </span>
              {waking === s.sessionId && <span className="recent-state">waking…</span>}
              {s.reactivated && !s.live && <span className="recent-state">reopened</span>}
              {s.live && (
                <span className={`badge live${s.reactivated ? ' idle' : ''}`}>
                  {!s.reactivated && <span className="pulse" />}
                  {s.reactivated ? 'REOPENED' : 'LIVE'}
                </span>
              )}
            </button>
          ))}
          {recent.length === 0 && <div className="pane-empty">No sessions in the last 30 days.</div>}
        </div>
      )}
    </div>
  );
}
