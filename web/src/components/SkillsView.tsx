import { useEffect, useState } from 'react';
import { api } from '../api';

type Skill = {
  name: string;
  command: string;
  description: string;
  summary: string;
  updated: string;
};

export function SkillsView({ onRan, onError }: { onRan: (sessionId: string) => void; onError: (m: string) => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.skills().then(setSkills).catch((e) => onError((e as Error).message));
  }, [onError]);

  const run = async (command: string) => {
    setBusy(command);
    try {
      const { sessionId } = await api.runSkill(command);
      onRan(sessionId);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!skills) return <div className="view">Loading skills…</div>;

  const shown = skills.filter(
    (s) =>
      !filter ||
      s.command.toLowerCase().includes(filter.toLowerCase()) ||
      s.description.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="view">
      <h2>Skills</h2>
      <p className="sub">
        The {skills.length} skills in <code>~/.claude/skills</code>. Running one opens a new
        session on the board and invokes it there, so you can watch it work and answer its prompts.
      </p>

      <div style={{ maxWidth: 320, marginBottom: 14 }}>
        <input placeholder="Filter skills…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="grid">
        {shown.map((s) => (
          <div className="tile" key={s.command}>
            <div className="tile-title">
              <span className="cmd">{s.command}</span>
            </div>
            <div className="tile-desc">{s.summary}</div>
            <div className="tile-foot">
              <div className="spacer" />
              <button className="primary" disabled={busy === s.command} onClick={() => run(s.command)}>
                {busy === s.command ? 'Starting…' : 'Run'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {shown.length === 0 && <div className="pane-empty">Nothing matches “{filter}”.</div>}
    </div>
  );
}
