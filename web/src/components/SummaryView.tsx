import { relTime } from './CardView';
import { api } from '../api';
import type { Card } from '../types';

/**
 * The drill-down layer between a card and the raw transcript: what this session
 * was doing, in a few lines, so you can decide whether to go further.
 */
export function SummaryView({ card }: { card: Card }) {
  const facts = [
    card.label
      ? ['Label', card.labelSource === 'files' ? `${card.label} — inferred from files it wrote` : card.label]
      : null,
    card.cwd ? ['Folder', card.cwd.replace(/^\/Users\/[^/]+/, '~')] : null,
    ['Last activity', relTime(card.lastActivity)],
    card.userTurns > 0 ? ['Exchanges', String(card.userTurns)] : null,
    card.live ? ['Status', `running · pid ${card.pid}`] : null,
  ].filter(Boolean) as [string, string][];

  return (
    <div className="summary">
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
                Open {card.label} in Clio →
              </a>
            )}
            {card.labelFolder && (
              <button
                className="label-link as-link"
                onClick={() => api.openFile(card.labelFolder!).catch(() => {})}
                title={card.labelFolder}
              >
                Open the Dropbox folder →
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
