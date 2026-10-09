import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { TerminalView } from './TerminalView';
import { relTime } from './CardView';
import type { LiveSession, RecentSession } from '../types';

const POLL_MS = 3000;

/** How long a session must have been quiet before the sweep will close it. */
const SWEEP_CHOICES = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 120, label: '2 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: 'a day' },
];

function gigabytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function idleFor(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function Tile({
  session,
  expanded,
  onToggle,
  onOpen,
  onClose,
}: {
  session: LiveSession;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onClose: () => void;
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
        <span className="tile-state">
          {session.working ? 'working' : `idle ${idleFor(session.idleMs)}`}
          {session.rssBytes ? ` · ${gigabytes(session.rssBytes)}` : ''}
        </span>
        <button className="ghost tile-btn" onClick={onToggle} title={expanded ? 'Shrink' : 'Expand'}>
          {expanded ? '⤡' : '⤢'}
        </button>
        <button className="ghost tile-btn" onClick={onOpen} title="Open on the board">
          ↗
        </button>
        <button
          className="ghost tile-btn danger"
          onClick={onClose}
          title="Close this session — the conversation is kept and can be resumed"
        >
          ✕
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
  const [memory, setMemory] = useState(0);
  const [recent, setRecent] = useState<RecentSession[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [waking, setWaking] = useState<string | null>(null);
  const [sweepMinutes, setSweepMinutes] = useState(360);
  const [closing, setClosing] = useState(false);

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
    api
      .live()
      .then((d) => {
        setLive(d.sessions);
        setMemory(d.rssBytes);
      })
      .catch((e) => onError((e as Error).message));
  }, [onError]);

  /**
   * Close sessions.
   *
   * Worth being plain about what this does, because "close" reads as
   * destructive and here it isn't: a session is a `claude` process reading and
   * writing a transcript that stays on disk. Ending it leaves the card, the
   * conversation and the ability to resume exactly where they were, and gives
   * back the few hundred megabytes the process was holding. Sessions started
   * from the board and left open accumulate — that is the whole problem this
   * solves.
   */
  const close = useCallback(
    async (sessions: LiveSession[], message: string) => {
      if (!sessions.length || !confirm(message)) return;
      setClosing(true);
      try {
        const { failed } = await api.stopSessions(sessions.map((s) => s.sessionId));
        if (failed.length) onError(`${failed.length} session(s) would not close`);
        loadLive();
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setClosing(false);
      }
    },
    [loadLive, onError]
  );

  useEffect(() => {
    loadLive();
    const id = setInterval(loadLive, POLL_MS);
    return () => clearInterval(id);
  }, [loadLive]);

  useEffect(() => {
    api.recent(40).then((d) => setRecent(d.sessions)).catch(() => setRecent([]));
  }, []);

  const shown = expanded ? (live ?? []).filter((s) => s.sessionId === expanded) : live ?? [];

  // Never sweep a session Claude is still working in, however long the
  // transcript has been quiet — the one case where idle time lies.
  const sweepable = (live ?? []).filter((s) => !s.working && s.idleMs >= sweepMinutes * 60_000);
  const sweepBytes = sweepable.reduce((n, s) => n + (s.rssBytes || 0), 0);

  return (
    <div className="view wide">
      <h2>Live</h2>
      <p className="sub">
        Every session running right now, side by side. A tile is <em>working</em> while Claude is
        still producing output and <em>idle</em> once it goes quiet — so you can see at a glance
        which one wants you. Click into a tile to type in it; expand for a full-size terminal.
        Each one is a real <code>claude</code> process holding its conversation in memory, so
        sessions left open add up — close the ones you are done with. Closing keeps the transcript
        and the card; you can resume from the board whenever you want.
      </p>

      {live && live.length > 0 && (
        <div
          style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}
        >
          <span className="count-pill">
            {live.length} open{memory > 0 && ` · ${gigabytes(memory)}`}
          </span>
          <label className="switch">
            Idle longer than
            <select
              value={sweepMinutes}
              onChange={(e) => setSweepMinutes(Number(e.target.value))}
              style={{ width: 'auto' }}
            >
              {SWEEP_CHOICES.map((c) => (
                <option key={c.minutes} value={c.minutes}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={closing || sweepable.length === 0}
            onClick={() =>
              close(
                sweepable,
                `Close ${sweepable.length} session${sweepable.length === 1 ? '' : 's'} idle longer than ` +
                  `${SWEEP_CHOICES.find((c) => c.minutes === sweepMinutes)?.label}` +
                  `${sweepBytes ? `, freeing about ${gigabytes(sweepBytes)}` : ''}?\n\n` +
                  'Their transcripts and cards are kept — you can resume any of them from the board.'
              )
            }
          >
            {sweepable.length === 0
              ? 'Nothing idle that long'
              : `Close ${sweepable.length} idle${sweepBytes ? ` · ${gigabytes(sweepBytes)}` : ''}`}
          </button>
        </div>
      )}

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
                onClose={() => {
                  if (expanded === s.sessionId) setExpanded(null);
                  close(
                    [s],
                    `Close “${s.title}”?\n\n` +
                      'The transcript and the card are kept — you can resume it from the board.'
                  );
                }}
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
