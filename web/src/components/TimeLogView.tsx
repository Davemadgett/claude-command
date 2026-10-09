import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TimeLog } from '../types';

/**
 * How a row's label was arrived at, strongest first. Named on every row because
 * the weakest of them — a key you mentioned in a prompt — is the one where
 * nothing was necessarily done in the label itself.
 */
const SOURCE_LABEL: Record<string, string> = {
  manual: 'you set this',
  cwd: 'from folder',
  files: 'from files',
  prompt: 'from a prompt',
  board: 'board default',
};

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Hours worked, reconstructed from transcripts.
 *
 * This view has three shapes, because the same numbers answer different
 * questions depending on what is configured:
 *
 *   no labels          hours per folder — the honest default, and useful on its
 *                      own for anyone wondering where a week went
 *   labels             hours per label, with how each was attributed
 *   labels + posted    the above, minus what some other system already records,
 *                      leaving only work not yet written down anywhere
 *
 * Nothing here posts anywhere, in any shape.
 */
export function TimeLogView({
  labelsEnabled,
  labelNoun,
  onError,
}: {
  labelsEnabled: boolean;
  labelNoun: string;
  onError: (m: string) => void;
}) {
  const [data, setData] = useState<TimeLog | null>(null);
  const [sinceDays, setSinceDays] = useState(14);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [showEntered, setShowEntered] = useState(false);

  useEffect(() => {
    setData(null);
    api.timelog(sinceDays, idleMinutes).then(setData).catch((e) => onError((e as Error).message));
  }, [sinceDays, idleMinutes, onError]);

  // Netting only means something when something else is keeping the books.
  const netting = labelsEnabled && Boolean(data?.posted.configured);

  /*
   * Without labels every row is worth showing — the folder is the grouping, and
   * there is nothing to reconcile it against. With labels but no netting, the
   * unlabelled rows are the ones with no answer to "what was this for", so they
   * stay hidden rather than filling the table with blanks.
   */
  const rows = (data?.entries ?? []).filter((e) => {
    if (!labelsEnabled) return true;
    if (!e.label) return false;
    return netting ? showEntered || e.unbilledHours > 0 : true;
  });

  const copy = () => {
    const head = ['Date', labelsEnabled ? capitalise(labelNoun) : 'Folder', 'Hours'];
    const lines = rows.map((e) =>
      [
        e.date,
        labelsEnabled ? e.label : e.project,
        (netting ? e.unbilledHours : e.hours).toFixed(1),
      ].join('\t')
    );
    navigator.clipboard.writeText([head.join('\t'), ...lines].join('\n'));
  };

  return (
    <div className="view">
      <h2>{netting ? 'Time not yet recorded' : 'Time'}</h2>
      <p className="sub">
        Working time reconstructed from your sessions. Consecutive activity counts; a gap longer
        than the idle threshold does not. Hours round up to the tenth.
        {labelsEnabled && (
          <>
            {' '}
            A {labelNoun} comes from the card you set, the session’s folder, the {labelNoun} folder
            its files landed in, or — weakest, and marked as such — a key recognised in what you
            typed.
          </>
        )}
        {netting && ' What another system already records for the same day is subtracted.'} Nothing
        here posts anywhere.
      </p>

      {data?.posted.error && (
        <div className="notice">
          The posted-hours command failed, so nothing is subtracted and everything below reads as
          outstanding: <code>{data.posted.error}</code>
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
        {netting && (
          <label className="switch">
            <input type="checkbox" checked={showEntered} onChange={(e) => setShowEntered(e.target.checked)} />
            Also show work already recorded
          </label>
        )}
        <button onClick={copy} disabled={!rows.length}>Copy as TSV</button>
      </div>

      {!data ? (
        <div className="pane-empty">Reconstructing…</div>
      ) : (
        <>
          <div className="tl-totals">
            {netting && (
              <div className="tl-stat">
                <div className="n" style={{ color: '#fbbf24' }}>{data.totals.unbilledHours.toFixed(1)}</div>
                <div className="l">Not yet recorded</div>
              </div>
            )}
            <div className="tl-stat">
              <div className="n">{(labelsEnabled ? data.totals.labelHours : data.totals.hours).toFixed(1)}</div>
              <div className="l">{labelsEnabled ? `${capitalise(labelNoun)} hours tracked` : 'Hours tracked'}</div>
            </div>
            {netting && (
              <div className="tl-stat">
                <div className="n">{data.totals.postedHours.toFixed(1)}</div>
                <div className="l">Already recorded</div>
              </div>
            )}
            {!netting && (
              <div className="tl-stat">
                <div className="n">{data.totals.days}</div>
                <div className="l">Days with work</div>
              </div>
            )}
          </div>

          <table className="tl">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Date</th>
                <th>{labelsEnabled ? capitalise(labelNoun) : 'Folder'}</th>
                <th style={{ width: 80, textAlign: 'right' }}>Tracked</th>
                {netting && <th style={{ width: 80, textAlign: 'right' }}>Recorded</th>}
                {netting && <th style={{ width: 90, textAlign: 'right' }}>To enter</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.date}-${e.label ?? e.project}-${i}`}>
                  <td className="day">{e.date}</td>
                  <td>
                    <span style={{ fontWeight: 550 }}>{labelsEnabled ? e.label : e.project}</span>
                    {labelsEnabled && e.labelSource && (
                      <span
                        className={`src ${e.labelSource}`}
                        title={
                          e.labelSource === 'prompt'
                            ? `Recognised in what you typed — no files were written into this ${labelNoun}`
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
                  <td className={netting ? 'h dim' : 'h'}>{e.hours.toFixed(1)}</td>
                  {netting && <td className="h dim">{e.postedHours ? e.postedHours.toFixed(1) : '—'}</td>}
                  {netting && (
                    <td className="h" style={{ color: e.unbilledHours > 0 ? '#fbbf24' : 'var(--text-faint)' }}>
                      {e.unbilledHours.toFixed(1)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <div className="pane-empty">
              <div>{netting ? 'Nothing outstanding' : 'No working time found'}</div>
              <div className="hint">
                {netting
                  ? `Every ${labelNoun} session in this window is already recorded.`
                  : 'No sessions in this window were active for long enough to count.'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
