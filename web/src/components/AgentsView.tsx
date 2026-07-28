import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AgentNode, Agents } from '../types';

function Node({ node }: { node: AgentNode }) {
  return (
    <div className={`org-node ${node.kind}`}>
      <div className="n">{node.name}</div>
      <div className="r">{node.role}</div>
    </div>
  );
}

/** Renders a node and, beneath it, anyone who reports to it. */
function Branch({ id, byParent }: { id: string; byParent: Map<string, AgentNode[]> }) {
  const children = byParent.get(id) ?? [];
  if (!children.length) return null;

  return (
    <>
      <div className="org-line" />
      <div className="org-row">
        {children.map((c) => (
          <div className="org-branch" key={c.id}>
            <Node node={c} />
            <Branch id={c.id} byParent={byParent} />
          </div>
        ))}
      </div>
    </>
  );
}

export function AgentsView({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<Agents | null>(null);

  useEffect(() => {
    api.agents().then(setData).catch((e) => onError((e as Error).message));
  }, [onError]);

  const byParent = useMemo(() => {
    const map = new Map<string, AgentNode[]>();
    for (const n of data?.nodes ?? []) {
      if (!n.parent) continue;
      const list = map.get(n.parent) ?? [];
      list.push(n);
      map.set(n.parent, list);
    }
    return map;
  }, [data]);

  if (!data) return <div className="view">Loading team…</div>;

  const principal = data.nodes.find((n) => n.kind === 'person');

  return (
    <div className="view">
      <h2>The team</h2>
      <p className="sub">
        The {data.agents.length} specialists defined in <code>~/.claude/agents</code>. Reporting
        lines come from each agent’s own brief — Clay sits under Steph because Clay’s prompt says so.
      </p>

      <div className="org">
        {principal && (
          <>
            <Node node={principal} />
            <Branch id={principal.id} byParent={byParent} />
          </>
        )}
      </div>

      <h2 style={{ marginTop: 26 }}>Roster</h2>
      <p className="sub">What each one owns, and what it can reach.</p>
      <div className="grid">
        {data.agents.map((a) => (
          <div className="tile" key={a.id}>
            <div className="tile-title">
              {a.name}
              {a.model && <span className="badge">{a.model}</span>}
            </div>
            <div className="tile-desc">{a.description}</div>
            <div className="tile-foot">
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {a.tools.length ? `${a.tools.length} tools` : 'all tools'}
                {a.parent !== 'claude' && ` · reports to ${a.parent}`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
