import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** Minimal frontmatter reader — these files only ever use flat scalar keys. */
export function frontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};

  const out = {};
  let key = null;
  for (const raw of text.slice(4, end).split('\n')) {
    const m = raw.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2].trim();
    } else if (key && raw.trim()) {
      // A description wrapped across lines.
      out[key] += ' ' + raw.trim();
    }
  }
  return out;
}

// Splitting on ". " alone would cut "Produce Dr. Chen's daily digest" down to
// "Produce Mr." — these are the abbreviations that actually show up here.
const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Inc|LLC|PLLC|Ltd|No|vs|v|e\.g|i\.e|etc|Jr|Sr|St|Ex|Fig|cf|approx|Stat|Minn|Ct|App)\.$/i;

export function firstSentence(text) {
  const re = /([.!?])\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const head = text.slice(0, m.index + 1);
    if (ABBREV.test(head.trim())) continue;
    return head.trim();
  }
  return text;
}

/** Skills without frontmatter still document themselves in prose — use that. */
function fromBody(text) {
  const heading = text.match(/^#\s+(.+)$/m);
  const title = heading ? heading[1].replace(/^\/[\w-]+\s*[—–-]\s*/, '').trim() : null;

  let description = '';
  if (heading) {
    const after = text.slice(text.indexOf(heading[0]) + heading[0].length);
    for (const para of after.split(/\n\s*\n/)) {
      const clean = para.trim();
      if (!clean || clean.startsWith('#') || clean.startsWith('>')) continue;
      description = clean.replace(/\s+/g, ' ');
      break;
    }
  }
  return { title, description };
}

export function listSkills() {
  let dirs;
  try {
    dirs = readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(SKILLS_DIR, dir.name, 'SKILL.md');
    let text;
    let stat;
    try {
      text = readFileSync(path, 'utf8');
      stat = statSync(path);
    } catch {
      continue;
    }

    const fm = frontmatter(text);
    const body = fromBody(text);
    const description = (fm.description || body.description || '').replace(/\s+/g, ' ').trim();

    skills.push({
      name: fm.name || dir.name,
      command: `/${dir.name}`,
      title: body.title,
      description,
      // The first sentence is the "what it does"; the rest is trigger guidance.
      summary: firstSentence(description),
      path,
      updated: new Date(stat.mtimeMs).toISOString(),
    });
  }

  skills.sort((a, b) => a.command.localeCompare(b.command));
  return skills;
}
