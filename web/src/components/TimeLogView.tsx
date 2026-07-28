import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TimeLog } from '../types';

/**
 * How a row's label was arrived at, strongest first. Named on every row because
 * the weakest of them — a file number you mentioned in a prompt — is the one
 * where nothing was necessarily done in the label itself.
 */
const SOURCE_LABEL: Record<string, string> = {
  manual: 'you set this',
  cwd: 'from folder',
  files: 'from files',
  prompt: 'from a prompt',
};

export function TimeLogView({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<TimeLog | null>(null);
  const [sinceDays, setSinceDays] = useState(14);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [showEntered, setShowEntered] = useState(false);

  useEffect(() => {
    setData(null);
    api.timelog(sinceDays, idleMinutes).then(setData).catch((e) => onError((e as Error).message));
  }, [sinceDays, idleMinutes, onError]);

  // Only label work can be reconciled against Clio, so that is what this shows.
  const rows = (data?.entries ?? []).filter(
    (e) => e.label && (showEntered || e.unbilledHours > 0)
  );

  const copy = () => {
    const lines = rows.map((e) => [e.date, e.label, e.unbilledHours.toFixed(1)].join('\t'));
    navigator.clipboard.writeText(['Date\tMatter\tHours', ...lines].join('\n'));
  };

  return (
    <div className="view">
      <h2>Time not yet in Clio</h2>
      <p className="sub">
        Working time reconstructed from your sessions, minus what is already posted to Clio for the
        same label and day. Consecutive activity counts; a gap longer than the idle threshold does
        not. A label comes from the card you set, the session’s folder, the label folder its files
        landed in, or — weakest, and labelled as such — a file number recognised in what you typed.
        Hours round up to the tenth, the way Clio bills them. Nothing here posts anywhere.
      </p>

      {data?.posted.error && (
        <div className="notice">
          Couldn’t reach Clio, so nothing is netted out and everything below reads as unbilled:{' '}
          <code>{data.posted.error}</code>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="switch">
          Window
          <select value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <label className="switch">
          Idle gap
          <select value={idleMinutes} onChange={(e) => setIdleMinutes(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
          </select>
        </label>
        <label className="switch">
          <input type="checkbox" checked={showEntered} onChange={(e) => setShowEntered(e.target.checked)} />
          Also show work already entered
        </label>
        <button onClick={copy} disabled={!rows.length}>Copy as TSV</button>
      </div>

      {!data ? (
        <div className="pane-empty">Reconstructing, and checking Clio…</div>
      ) : (
        <>
          <div className="tl-totals">
            <div className="tl-stat">
              <div className="n" style={{ color: '#fbbf24' }}>{data.totals.unbilledHours.toFixed(1)}</div>
              <div className="l">Not in Clio</div>
            </div>
            <div className="tl-stat">
              <div className="n">{data.totals.labelHours.toFixed(1)}</div>
              <div className="l">Label hours tracked</div>
            </div>
            <div className="tl-stat">
              <div className="n">{data.totals.postedHours.toFixed(1)}</div>
              <div className="l">Already posted</div>
            </div>
          </div>

          <table className="tl">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Date</th>
                <th>Label</th>
                <th style={{ width: 80, textAlign: 'right' }}>Tracked</th>
                <th style={{ width: 80, textAlign: 'right' }}>In Clio</th>
                <th style={{ width: 90, textAlign: 'right' }}>To enter</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.date}-${e.label}-${i}`}>
                  <td className="day">{e.date}</td>
                  <td>
                    <span style={{ fontWeight: 550 }}>{e.label}</span>
                    {e.labelSource && (
                      <span
                        className={`src ${e.labelSource}`}
                        title={
                          e.labelSource === 'prompt'
                            ? 'Recognised in what you typed — no files were written into this label'
                            : undefined
                        }
                      >
                        {SOURCE_LABEL[e.labelSource]}
                      </span>
                    )}
                    <div className="sessions">
                      {e.sessions.slice(0, 3).map((s) => s.title).join(' · ')}
                      {e.sessions.length > 3 && ` · +${e.sessions.length - 3} more`}
                    </div>
                  </td>
                  <td className="h dim">{e.hours.toFixed(1)}</td>
                  <td className="h dim">{e.postedHours ? e.postedHours.toFixed(1) : '—'}</td>
                  <td className="h" style={{ color: e.unbilledHours > 0 ? '#fbbf24' : 'var(--text-faint)' }}>
                    {e.unbilledHours.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <div className="pane-empty">
              <div>Nothing outstanding</div>
              <div className="hint">
                Every label session in this window is already accounted for in Clio.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
