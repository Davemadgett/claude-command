import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Brief } from '../types';

/**
 * The morning brief is already generated as standalone HTML by /morningbrief, so
 * it is iframed verbatim rather than re-rendered — what you see is the real brief.
 */
export function BriefPanel() {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api
      .briefs()
      .then((list) => {
        setBriefs(list);
        setDate((d) => d ?? list[0]?.date ?? null);
      })
      .catch(() => setBriefs([]));
  }, [nonce]);

  if (!briefs.length) {
    return (
      <div className="pane-empty">
        <div>No morning brief found</div>
        <div className="hint">
          Run <code>/morningbrief</code> — it writes <code>morning_brief_&lt;date&gt;.html</code> into
          Personal_Assistant, and it will show up here.
        </div>
        <button onClick={() => setNonce((n) => n + 1)}>Check again</button>
      </div>
    );
  }

  const current = briefs.find((b) => b.date === date) ?? briefs[0];

  return (
    <div className="brief">
      <div className="pane-bar">
        <select value={current.date} onChange={(e) => setDate(e.target.value)}>
          {briefs.map((b) => (
            <option key={b.date} value={b.date}>
              {b.date}
            </option>
          ))}
        </select>
        <span>generated {new Date(current.mtime).toLocaleString()}</span>
        <div className="spacer" />
        <button className="ghost" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </button>
        <button className="ghost" onClick={() => window.open(`/api/brief/html?date=${current.date}`, '_blank')}>
          Open full page ↗
        </button>
      </div>
      <iframe
        key={`${current.date}:${nonce}`}
        src={`/api/brief/html?date=${current.date}`}
        title={`Morning brief ${current.date}`}
      />
    </div>
  );
}
