import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Routine } from '../types';

function relDay(iso: string | null) {
  if (!iso) return 'never run';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `ran today at ${time}`;
  if (days === 1) return `ran yesterday at ${time}`;
  return `last ran ${d.toLocaleDateString()}`;
}

export function ScheduledView({ onRan, onError }: { onRan: (sessionId: string) => void; onError: (m: string) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', command: '', timeOfDay: '07:00' });

  const load = useCallback(() => {
    api.routines().then(setRoutines).catch((e) => onError((e as Error).message));
  }, [onError]);

  useEffect(load, [load]);

  const patch = async (id: string, fields: Record<string, unknown>) => {
    try {
      await api.updateRoutine(id, fields);
      load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const run = async (r: Routine) => {
    setBusy(r.id);
    try {
      const { sessionId } = await api.runRoutine(r.id);
      onRan(sessionId);
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!routines) return <div className="view">Loading…</div>;

  return (
    <div className="view">
      <h2>Scheduled</h2>
      <p className="sub">
        Daily routines. “Run now” opens a session on the board and invokes the command there.
        Turning one on runs it automatically at its time — but only while this app is open, and a
        missed day is never backfilled. Nothing runs unless you switch it on.
      </p>

      {routines.map((r) => (
        <div className="routine" key={r.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{r.name}</div>
            <div className="meta">
              <span className="cmd">{r.command}</span> · {relDay(r.last_run_at)}
              {r.due && <span style={{ color: '#fbbf24' }}> · due now</span>}
            </div>
          </div>

          <input
            type="time"
            value={r.time_of_day}
            onChange={(e) => patch(r.id, { timeOfDay: e.target.value })}
            title="Time of day to run"
          />

          <label className="switch">
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={(e) => patch(r.id, { enabled: e.target.checked })}
            />
            Auto
          </label>

          <button className="primary" disabled={busy === r.id} onClick={() => run(r)}>
            {busy === r.id ? 'Starting…' : 'Run now'}
          </button>
          <button
            className="ghost danger"
            title="Remove routine"
            onClick={() => {
              if (confirm(`Remove “${r.name}”?`)) {
                api.deleteRoutine(r.id).then(load).catch((e) => onError((e as Error).message));
              }
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {adding ? (
        <div className="routine" style={{ gap: 8 }}>
          <input
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ flex: 1 }}
            autoFocus
          />
          <input
            placeholder="/command"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            type="time"
            value={draft.timeOfDay}
            onChange={(e) => setDraft({ ...draft, timeOfDay: e.target.value })}
          />
          <button
            className="primary"
            disabled={!draft.name.trim() || !draft.command.trim()}
            onClick={async () => {
              try {
                await api.addRoutine(draft);
                setDraft({ name: '', command: '', timeOfDay: '07:00' });
                setAdding(false);
                load();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            Add
          </button>
          <button onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}>+ Add routine</button>
      )}
    </div>
  );
}
