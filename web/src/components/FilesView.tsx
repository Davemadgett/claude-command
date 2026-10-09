import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SessionFile, SessionFiles } from '../types';

// Document types worth spotting at a glance get a colour; everything else is grey.
const TINTS: Record<string, string> = {
  docx: '#60a5fa', doc: '#60a5fa', pdf: '#f87171', xlsx: '#34d399', csv: '#34d399',
  md: '#a78bfa', html: '#fbbf24', png: '#f472b6', jpg: '#f472b6', jpeg: '#f472b6',
};

// Where a file came from, in the words the server uses. 'tool' is a Write call
// in the transcript; 'mention' is a document path the transcript names that
// changed after the session began; 'window' merely changed in the cwd.
const SOURCE_LABEL: Record<SessionFile['source'], string> = {
  tool: 'written',
  mention: 'generated',
  received: 'arrived during the session',
  window: 'changed while it ran',
};

function size(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Documents a session produced.
 *
 * The .pdf and .docx files are the point of this tab, so they are the list.
 * Markdown is behind a toggle, off by default; scripts and everything else are
 * behind a second one. Both are still one click away, but neither can bury a
 * draft under forty helper files.
 */
export function FilesView({ sessionId, refreshKey, onError }: {
  sessionId: string;
  refreshKey: number;
  onError: (m: string) => void;
}) {
  const [data, setData] = useState<SessionFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showShelved, setShowShelved] = useState(false);
  const [showMd, setShowMd] = useState(false);
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

  // The list is the documents to look at. A superseded copy, a scratchpad
  // working file, or one that has since been moved or deleted is kept, but
  // folded away — the point is to find the current draft in one glance.
  const isShelved = (f: SessionFile) => f.superseded || f.scratch || !f.exists;
  const allDocs = data.files.filter((f) => f.kind === 'doc');
  const docs = allDocs.filter((f) => !isShelved(f));
  const shelved = allDocs.filter(isShelved);
  const md = data.files.filter((f) => f.kind === 'md');
  const other = data.files.filter((f) => f.kind === 'other');

  if (!data.files.length) {
    return (
      <div className="pane-empty">
        <div>No documents from this session</div>
        <div className="hint">
          A .pdf or .docx shows up here once the session writes one, or once a script
          it runs reports where it saved one.
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
          {f.superseded && <span className="file-gone"> — superseded</span>}
          {f.scratch && !f.superseded && <span className="file-gone"> — working copy</span>}
          {!f.exists && <span className="file-gone"> — moved or deleted</span>}
        </div>
        <div className="file-dir" title={f.path}>{f.dir}</div>
      </div>
      <span className="file-src" title="How the board knows about this file">{SOURCE_LABEL[f.source]}</span>
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
      <div className="files-head">Documents from this session · {docs.length}</div>
      {docs.length > 0 ? (
        docs.map(row)
      ) : (
        <div className="files-none">
          No current .pdf or .docx from this session{shelved.length > 0 ? ' — only superseded or working copies' : ' yet'}.
        </div>
      )}

      {shelved.length > 0 && (
        <>
          <button className="files-head toggle" onClick={() => setShowShelved((v) => !v)}>
            {showShelved ? '▾' : '▸'} Superseded, working and removed copies · {shelved.length}
          </button>
          {showShelved && shelved.map(row)}
        </>
      )}

      {md.length > 0 && (
        <>
          <button className="files-head toggle" onClick={() => setShowMd((v) => !v)}>
            {showMd ? '▾' : '▸'} Markdown · {md.length}
          </button>
          {showMd && md.map(row)}
        </>
      )}

      {other.length > 0 && (
        <>
          <button className="files-head toggle" onClick={() => setShowOther((v) => !v)}>
            {showOther ? '▾' : '▸'} Scripts and other files · {other.length}
          </button>
          {showOther && other.map(row)}
        </>
      )}
    </div>
  );
}
