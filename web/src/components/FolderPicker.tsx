import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { chooseFolder, hasNative } from '../native';
import type { BrowseResult, CwdSuggestion, LabelFolder } from '../types';

type Source = 'labels' | 'recent' | 'browse';

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Picking where a session runs, without having to know what a path is.
 *
 * Up to three ways in: a label, somewhere you worked recently, or a walk
 * through the folders. Inside the Mac app there is a fourth — the real Finder
 * panel — which is better than all of them when you already know where you're
 * going, so it sits at the top.
 *
 * Labels are only one of those ways and only when they are configured. Without
 * them this is still a folder picker, which is the thing it has to be: you
 * cannot start a session without answering where it runs.
 */
export function FolderPicker({
  labelsEnabled,
  labelNoun,
  initial,
  onPick,
  onClose,
}: {
  labelsEnabled: boolean;
  labelNoun: string;
  initial?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const sources: Source[] = labelsEnabled ? ['labels', 'recent', 'browse'] : ['recent', 'browse'];
  const [source, setSource] = useState<Source>(sources[0]);
  const [query, setQuery] = useState('');
  const [labels, setLabels] = useState<LabelFolder[] | null>(null);
  const [recent, setRecent] = useState<CwdSuggestion[]>([]);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (labelsEnabled) api.labelFolders().then(setLabels).catch(() => setLabels([]));
    else setLabels([]);
    api.cwds().then(setRecent).catch(() => setRecent([]));
  }, [labelsEnabled]);

  useEffect(() => {
    searchRef.current?.focus();
  }, [source]);

  const go = (path: string) => {
    api
      .browse(path)
      .then((r) => {
        setBrowse(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(() => {
    if (source === 'browse' && !browse) go(initial || '~');
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredLabels = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = labels ?? [];
    if (!q) return all.slice(0, 60);
    return all
      .filter((m) => m.label.toLowerCase().includes(q) || m.client.toLowerCase().includes(q))
      .slice(0, 60);
  }, [labels, query]);

  const filteredRecent = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recent;
    return recent.filter(
      (r) => (r.label ?? '').toLowerCase().includes(q) || r.display.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q)
    );
  }, [recent, query]);

  const native = async () => {
    const picked = await chooseFolder(browse?.path || initial);
    if (picked) onPick(picked);
  };

  return (
    <div className="overlay-bg" onClick={onClose}>
      <div className="dialog picker" onClick={(e) => e.stopPropagation()}>
        <h2>Choose a folder</h2>
        <p className="sub">
          This is where Claude will be working — the folder it can read and write in.
          {labelsEnabled && ` Usually that is the ${labelNoun}'s own folder.`}
        </p>

        {hasNative() && (
          <button className="primary wide-btn" onClick={native}>
            Open the Finder chooser…
          </button>
        )}

        <div className="picker-tabs">
          {sources.map((s) => (
            <button key={s} className={source === s ? 'on' : ''} onClick={() => setSource(s)}>
              {s === 'labels' ? capitalise(`${labelNoun}s`) : s === 'recent' ? 'Recent' : 'Browse'}
            </button>
          ))}
        </div>

        {source !== 'browse' && (
          <input
            ref={searchRef}
            className="picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={source === 'labels' ? `Search ${labelNoun}s…` : 'Filter…'}
          />
        )}

        {source === 'labels' && (
          <div className="picker-list">
            {labels === null && <div className="pane-empty">Reading…</div>}
            {labels !== null && filteredLabels.length === 0 && (
              <div className="pane-empty">
                {query ? `Nothing matches “${query}”.` : `No ${labelNoun} folders found.`}
              </div>
            )}
            {filteredLabels.map((m) => (
              <button key={m.path} className="picker-row" onClick={() => onPick(m.path)}>
                <span className="badge label">{m.label}</span>
                <span className="picker-main">{m.client}</span>
              </button>
            ))}
          </div>
        )}

        {source === 'recent' && (
          <div className="picker-list">
            {filteredRecent.length === 0 && <div className="pane-empty">No recent folders.</div>}
            {filteredRecent.map((r) => (
              <button key={r.cwd} className="picker-row" onClick={() => onPick(r.cwd)}>
                {r.label ? (
                  <span className="badge label">{r.label}</span>
                ) : (
                  <span className="badge">{r.display}</span>
                )}
                <span className="picker-main mono">{r.cwd}</span>
              </button>
            ))}
          </div>
        )}

        {source === 'browse' && (
          <>
            <div className="picker-places">
              {(browse?.places ?? []).map((p) => (
                <button key={p.path} onClick={() => go(p.path)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="picker-crumb">
              <button className="ghost" disabled={!browse?.parent} onClick={() => browse?.parent && go(browse.parent)}>
                ↑ Up
              </button>
              <span className="mono">{browse?.display ?? '…'}</span>
            </div>
            <div className="picker-list">
              {error && <div className="pane-empty">{error}</div>}
              {!error && browse && browse.dirs.length === 0 && (
                <div className="pane-empty">No folders inside this one.</div>
              )}
              {(browse?.dirs ?? []).map((d) => (
                <div key={d.path} className="picker-row browse-row">
                  <button className="picker-into" onClick={() => go(d.path)} title="Open this folder">
                    📁 {d.name}
                  </button>
                  <button className="ghost pick-here" onClick={() => onPick(d.path)}>
                    Use this
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          {source === 'browse' && browse && (
            <button className="primary" onClick={() => onPick(browse.path)}>
              Use {browse.name}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
