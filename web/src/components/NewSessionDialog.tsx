import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { FolderPicker } from './FolderPicker';
import type { ColumnChoice, EngineStatus } from '../types';

type Props = {
  defaultColumnId?: string;
  labelsEnabled: boolean;
  labelNoun: string;
  /** The engine the board is set to — named here so it isn't a surprise. */
  engine?: EngineStatus | null;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onError: (message: string) => void;
};

export function NewSessionDialog({
  defaultColumnId,
  labelsEnabled,
  labelNoun,
  engine,
  onClose,
  onCreated,
  onError,
}: Props) {
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [columns, setColumns] = useState<ColumnChoice[]>([]);
  const [columnId, setColumnId] = useState(defaultColumnId ?? '');
  const [picking, setPicking] = useState(false);
  const [resolved, setResolved] = useState<{ ok: boolean; display?: string; label?: string | null; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .allColumns()
      .then((cols) => {
        setColumns(cols);
        if (!columnId && cols[0]) setColumnId(cols[0].id);
      })
      .catch(() => setColumns([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Say what a typed path resolves to before the session starts, rather than
   * failing afterwards. Typing `downloads` should visibly become ~/Downloads.
   */
  useEffect(() => {
    if (!cwd.trim()) {
      setResolved(null);
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      api
        .resolveDir(cwd)
        .then((r) => live && setResolved(r))
        .catch(() => live && setResolved(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [cwd]);

  // Boards keep their columns together, in board order, so the list reads the
  // same way the tabs do.
  const grouped = useMemo(() => {
    const out: { board: string; columns: ColumnChoice[] }[] = [];
    for (const c of columns) {
      const last = out[out.length - 1];
      if (last && last.board === c.boardName) last.columns.push(c);
      else out.push({ board: c.boardName, columns: [c] });
    }
    return out;
  }, [columns]);

  const submit = async () => {
    setBusy(true);
    try {
      const { sessionId } = await api.newSession({
        cwd: cwd.trim() || '~',
        title: title.trim() || undefined,
        columnId: columnId || undefined,
      });
      onCreated(sessionId);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  /** Dragging a folder out of Finder gives a file:// URL; the server decodes it. */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (uri) setCwd(uri.split('\n')[0].trim());
  };

  // Always the picker rather than jumping straight to the Finder panel: it
  // offers recent folders and, where configured, labels — both faster than
  // walking a tree — and it offers the Finder panel anyway.
  const browse = () => setPicking(true);

  return (
    <>
      <div className="overlay-bg" onClick={onClose}>
        <div className="dialog" onClick={(e) => e.stopPropagation()}>
          <h2>New {engine?.name ?? 'Claude Code'} session</h2>
          <p className="sub">
            Starts <code>{engine?.id === 'codex' ? 'codex' : 'claude'}</code> in a terminal this
            board owns, so you can work in it from here. Change which one in the header.
          </p>

          <div className="field">
            <label>Folder to work in</label>
            <p className="field-help">
              The folder the session can read and write. Browse for it, drag it in from Finder, or
              type a path — <code>downloads</code> and <code>~/code/thing</code> both work.
            </p>
            <div className="row">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                placeholder="Pick a folder, or drag one here from Finder"
                autoFocus
              />
              <button className="primary" onClick={browse}>
                Browse…
              </button>
            </div>
            {!cwd.trim() && (
              <div className="field-note">Nothing chosen — the session would start in your home folder.</div>
            )}
            {cwd.trim() && resolved && (
              <div className={`field-note${resolved.ok ? ' ok' : ' bad'}`}>
                {resolved.ok ? (
                  <>
                    ✓ {resolved.display}
                    {resolved.label && <span className="badge label">{resolved.label}</span>}
                  </>
                ) : (
                  resolved.message
                )}
              </div>
            )}
          </div>

          <div className="field">
            <label>Card title (optional)</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave blank to use the session's own title"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) submit();
              }}
            />
          </div>

          <div className="field">
            <label>Put the card on</label>
            <select value={columnId} onChange={(e) => setColumnId(e.target.value)}>
              {grouped.map((g) => (
                <optgroup key={g.board} label={g.board}>
                  {g.columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="dialog-actions">
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={submit} disabled={busy || (resolved !== null && !resolved.ok)}>
              {busy ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      </div>

      {picking && (
        <FolderPicker
          labelsEnabled={labelsEnabled}
          labelNoun={labelNoun}
          initial={cwd || undefined}
          onPick={(p) => {
            setCwd(p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
