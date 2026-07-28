import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { frontmatter, firstSentence } from './skills.js';
import { config } from './config.js';

const AGENTS_DIR = join(homedir(), '.claude', 'agents');

const PRINCIPAL = { id: '__principal__', name: config.principal, role: 'Principal', kind: 'person' };
const COORDINATOR = {
  id: 'claude',
  name: 'Claude',
  role: 'Coordinator — routes work, owns the session',
  kind: 'coordinator',
  parent: PRINCIPAL.id,
};

/**
 * Reporting lines are stated in each agent's own prompt ("You sit under Steph"),
 * so read them from there rather than keeping a second copy that drifts.
 */
function parentFrom(text, self) {
  const m = text.match(/\bsits?\s+under\s+\*{0,2}([A-Z][a-z]+)/);
  if (m) {
    const parent = m[1].toLowerCase();
    if (parent !== self) return parent;
  }
  return COORDINATOR.id;
}

export function listAgents() {
  let files;
  try {
    files = readdirSync(AGENTS_DIR);
  } catch {
    return { nodes: [PRINCIPAL, COORDINATOR], agents: [] };
  }

  const agents = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const path = join(AGENTS_DIR, file);
    let text;
    let stat;
    try {
      text = readFileSync(path, 'utf8');
      stat = statSync(path);
    } catch {
      continue;
    }

    const fm = frontmatter(text);
    const id = (fm.name || file.replace(/\.md$/, '')).toLowerCase();
    const description = (fm.description || '').replace(/\s+/g, ' ').trim();

    agents.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      kind: 'agent',
      role: firstSentence(description),
      description,
      tools: (fm.tools || '').split(',').map((t) => t.trim()).filter(Boolean),
      model: fm.model || null,
      parent: parentFrom(text, id),
      path,
      updated: new Date(stat.mtimeMs).toISOString(),
    });
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { nodes: [PRINCIPAL, COORDINATOR, ...agents], agents };
}
