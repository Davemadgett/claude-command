import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SessionFile, SessionFiles } from '../types';

// Document types worth spotting at a glance get a colour; everything else is grey.
const TINTS: Record<string, string> = {
  docx: '#60a5fa', doc: '#60a5fa', pdf: '#f87171', xlsx: '#34d399', csv: '#34d399',
  md: '#a78bfa', html: '#fbbf24', png: '#f472b6', jpg: '#f472b6', jpeg: '#f472b6',
};

function size(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Documents a session produced: written by its tools, or changed while it ran. */
export function FilesView({ sessionId, refreshKey, onError }: {
  sessionId: string;
  refreshKey: number;
  onError: (m: string) => void;
}) {
  const [data, setData] = useState<SessionFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .files(sessionId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  if (error) return <div className="pane-empty"><div>No files yet</div><div className="hint">{error}</div></div>;
  if (!data) return <div className="pane-empty">Looking for files…</div>;

  const written = data.files.filter((f) => f.source === 'tool');
  const touched = data.files.filter((f) => f.source === 'window');

  if (!data.files.length) {
    return (
      <div className="pane-empty">
        <div>No documents from this session</div>
        <div className="hint">
          Files show up here once the session writes one, or once something it runs
          changes a file in its working directory.
        </div>
      </div>
    );
  }

  const row = (f: SessionFile) => (
    <div className={`file-row${f.exists ? '' : ' missing'}`} key={f.path}>
      <span className="file-ext" style={TINTS[f.ext] ? { color: TINTS[f.ext] } : undefined}>
        {f.ext || 'file'}
      </span>
      <div className="file-main">
        <div className="file-name">
          {f.name}
          {!f.exists && <span className="file-gone"> — moved or deleted</span>}
        </div>
        <div className="file-dir" title={f.path}>{f.dir}</div>
      </div>
      <span className="file-size">{size(f.sizeBytes)}</span>
      <div className="file-actions">
        <button
          disabled={!f.exists}
          onClick={() => api.openFile(f.path).catch((e) => onError((e as Error).message))}
        >
          Open
        </button>
        <button
          disabled={!f.exists}
          onClick={() => api.openFile(f.path, true).catch((e) => onError((e as Error).message))}
        >
          Reveal
        </button>
      </div>
    </div>
  );

  return (
    <div className="files">
      {written.length > 0 && (
        <>
          <div className="files-head">Written by this session · {written.length}</div>
          {written.map(row)}
        </>
      )}

      {touched.length > 0 && (
        <>
          <button className="files-head toggle" onClick={() => setShowOther((v) => !v)}>
            {showOther ? '▾' : '▸'} Also changed while it ran · {touched.length}
          </button>
          {showOther && touched.map(row)}
        </>
      )}
    </div>
  );
}
