import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { TerminalView } from './TerminalView';
import type { Brief, BriefRun } from '../types';

const RUN_POLL_MS = 3000;
const LIST_POLL_MS = 20_000;

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Mode = 'session' | 'brief';

/**
 * The morning brief, run and read in one place.
 *
 * The brief is not a report that appears — it is a session that asks questions
 * on the way (the billing walkthrough wants an answer per draft) and writes the
 * HTML at the end. Run from the board, that session was one card among many,
 * and a question it asked went unseen; the brief was then started again, and
 * again. So the tab owns the run: one button starts it, the terminal sits here
 * to answer it, and the finished HTML is iframed verbatim beneath the same bar
 * once the file lands — what you see is the real brief.
 */
type Props = {
  /** `reports.runCommand` is configured, so the tab can start the brief itself. */
  canRun: boolean;
  onOpenSession?: (sessionId: string) => void;
};

export function BriefPanel({ canRun, onOpenSession }: Props) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [run, setRun] = useState<BriefRun | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode | null>(null); // null = follow the run
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasLive = useRef<boolean | null>(null);

  const loadBriefs = useCallback(() => {
    api
      .briefs()
      .then((list) => {
        setBriefs(list);
        setDate((d) => d ?? list[0]?.date ?? null);
      })
      .catch(() => setBriefs([]));
  }, []);

  const loadRun = useCallback(() => api.briefRun().then(setRun).catch(() => {}), []);

  useEffect(() => {
    loadBriefs();
    const id = setInterval(loadBriefs, LIST_POLL_MS);
    return () => clearInterval(id);
  }, [loadBriefs, nonce]);

  useEffect(() => {
    loadRun();
    const id = setInterval(loadRun, RUN_POLL_MS);
    return () => clearInterval(id);
  }, [loadRun]);

  /*
   * Follow the run. When it ends the brief has (usually) just been written, so
   * re-list the folder and show the newest one; until then the terminal is the
   * thing that matters. A deliberate click on the switch overrides this, and
   * the next transition takes over again.
   */
  useEffect(() => {
    if (run === undefined) return;
    const live = Boolean(run?.live);
    if (wasLive.current !== null && wasLive.current !== live) {
      setMode(null);
      if (!live) {
        loadBriefs();
        setDate(null);
      }
    }
    wasLive.current = live;
  }, [run, loadBriefs]);

  const start = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.runBrief(force);
      setRun(started);
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await api.startSession(run.sessionId, { mode: 'resume', cwd: run.cwd });
      await loadRun();
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onExit = useCallback(() => {
    loadRun();
  }, [loadRun]);

  const live = Boolean(run?.live);
  const current = briefs.find((b) => b.date === date) ?? briefs[0] ?? null;
  const hasToday = briefs.some((b) => b.date === today());
  const shown: Mode = mode ?? (live ? 'session' : 'brief');

  const runButton = !canRun ? null : live ? (
    <button
      className="ghost"
      disabled={busy}
      title="The brief is already running — start a second one only if this one is stuck"
      onClick={() => {
        if (confirm('The morning brief is still running. Start a fresh one anyway?')) start(true);
      }}
    >
      Start over
    </button>
  ) : (
    <button className="primary" disabled={busy} onClick={() => start(false)}>
      {busy ? 'Starting…' : hasToday ? 'Run again' : 'Run morning brief'}
    </button>
  );

  return (
    <div className="brief">
      <div className="pane-bar">
        {runButton}

        {run && (
          <div className="seg">
            <button className={shown === 'session' ? 'on' : ''} onClick={() => setMode('session')}>
              Session
            </button>
            <button
              className={shown === 'brief' ? 'on' : ''}
              onClick={() => setMode('brief')}
              disabled={!briefs.length}
              title={briefs.length ? 'The finished brief' : 'No brief written yet'}
            >
              Brief
            </button>
          </div>
        )}

        {live && run && (
          <span className={`badge ${run.working ? 'live' : 'wait'}`}>
            <span className="pulse" />
            {run.working ? 'running' : 'waiting for your answer'}
          </span>
        )}
        {!live && run && <span className="badge exited">session ended</span>}

        {!live && run && (
          <button className="ghost" disabled={busy} onClick={resume} title="Pick the same conversation up where it left off">
            Resume
          </button>
        )}
        {run && onOpenSession && (
          <button className="ghost" onClick={() => onOpenSession(run.sessionId)} title="Open this run's card on the board">
            Show on board
          </button>
        )}

        <div className="spacer" />

        {shown === 'brief' && current && (
          <>
            <select value={current.date} onChange={(e) => setDate(e.target.value)}>
              {briefs.map((b) => (
                <option key={b.date} value={b.date}>
                  {b.date}
                </option>
              ))}
            </select>
            <span>generated {new Date(current.mtime).toLocaleString()}</span>
            <button className="ghost" onClick={() => setNonce((n) => n + 1)}>
              Refresh
            </button>
            <button className="ghost" onClick={() => window.open(`/api/brief/html?date=${current.date}`, '_blank')}>
              Open full page ↗
            </button>
          </>
        )}
      </div>

      {error && <div className="notice">{error}</div>}

      <div className="pane-content">
        {shown === 'session' && run && live ? (
          <TerminalView key={run.sessionId} sessionId={run.sessionId} onExit={onExit} />
        ) : shown === 'session' && run ? (
          <div className="pane-empty">
            <div>The morning-brief session isn’t running</div>
            <div className="hint">
              Started {new Date(run.startedAt).toLocaleString()}. “Resume” reopens the same
              conversation — useful if it was cut off mid-walkthrough. “Run again” starts today’s brief
              from the top.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" disabled={busy} onClick={resume}>
                Resume
              </button>
              {canRun && (
                <button disabled={busy} onClick={() => start(false)}>
                  Run again
                </button>
              )}
            </div>
          </div>
        ) : current ? (
          <iframe
            key={`${current.date}:${nonce}`}
            src={`/api/brief/html?date=${current.date}`}
            title={`Morning brief ${current.date}`}
          />
        ) : (
          <div className="pane-empty">
            <div>No morning brief yet</div>
            <div className="hint">
              “Run morning brief” starts <code>/morningbrief</code> in a session that lives in this
              tab. Answer its questions here; when it finishes, the brief appears in this same spot.
            </div>
            {canRun ? (
              <button className="primary" disabled={busy} onClick={() => start(false)}>
                {busy ? 'Starting…' : 'Run morning brief'}
              </button>
            ) : (
              <div className="hint">
                Set <code>reports.runCommand</code> in <code>config.json</code> to run it from here.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
