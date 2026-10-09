import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { firstSentence } from './skills.js';
import { jsonLines, labelFromPath, readChunk } from './sessions-io.js';
import { codexAliases } from './db.js';
import {
  codexRolloutPath, codexWrittenFiles, readCodexTranscript, scanCodexSessions,
} from './codex.js';

// Re-exported because half the server already imports them from here, and the
// move into sessions-io.js was about breaking an import cycle, not about
// changing where anyone looks for them.
export { jsonLines, labelFromPath, readChunk };

// Metadata is cached on file identity, so a label change needs a cache-busting
// restart — which `node --watch` and a normal server start both provide.

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Claude Code names a project folder after its cwd with the slashes replaced.
const HOME_AS_DIRNAME = homedir().replaceAll('/', '-');

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

// Parsed metadata is cached on (size, mtime) so a board refresh over hundreds of
// transcripts costs a stat() each, not a full re-read.
const cache = new Map();

function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Strip the slash-command wrapper Claude Code writes around invoked skills. */
export function cleanPrompt(raw) {
  if (!raw) return '';
  let s = raw;
  const cmd = s.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = s.match(/<command-args>([^<]*)<\/command-args>/);
    return (cmd[1] + (args && args[1].trim() ? ` ${args[1].trim()}` : '')).trim();
  }
  s = s.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function labelFromCwd(cwd) {
  return labelFromPath(cwd);
}

/** The label a session wrote into most — its work, not merely what it read. */
function pickLabel(counts) {
  if (!counts.size) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [label, client] = best[0].split('|');
  return { label, client, writes: best[1] };
}

function projectLabel(dirName, cwd) {
  if (cwd) {
    const label = labelFromCwd(cwd);
    if (label) return label.label;
    if (cwd === homedir()) return 'home';
    const base = basename(cwd);
    if (base) return base;
    return 'home';
  }
  // Claude Code encodes a working directory as its path with the separators
  // turned into dashes, so a session under home starts with the encoded home
  // path. Strip that and what remains is the part worth showing.
  return dirName.startsWith(HOME_AS_DIRNAME)
    ? dirName.slice(HOME_AS_DIRNAME.length).replace(/^-/, '') || '~'
    : dirName;
}

function parseTranscript(path, stat) {
  const meta = {
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    isSidechain: false,
    aiTitle: null,
    summary: null,
    lastPrompt: null,
    firstPrompt: null,
    lastActivity: null,
    lastAssistant: null,
    lastEventType: null,
    awaitingAnswer: false,
    userTurns: 0,
    model: null,
    // What Claude has been doing lately, counted from the recent transcript.
    activity: { files: [], commands: 0, searches: 0, agents: 0 },
    labelWrites: new Map(),
  };

  const head = readChunk(path, 0, Math.min(HEAD_BYTES, stat.size));
  for (const d of jsonLines(head)) {
    if (meta.cwd === null && d.cwd) {
      meta.cwd = d.cwd;
      meta.gitBranch = d.gitBranch || null;
      meta.version = d.version || null;
      meta.entrypoint = d.entrypoint || null;
      meta.isSidechain = Boolean(d.isSidechain);
    }
    if (d.type === 'ai-title' && d.aiTitle) meta.aiTitle = d.aiTitle;
    if (d.type === 'summary' && d.summary) meta.summary = d.summary;
    if (!meta.firstPrompt && d.type === 'user' && d.message?.role === 'user') {
      const t = cleanPrompt(textOf(d.message));
      if (t) meta.firstPrompt = t;
    }
    if (d.type === 'assistant') collectActivity(d.message, { files: [] }, meta.labelWrites);
  }

  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = readChunk(path, start, stat.size - start);
    for (const d of jsonLines(tail, { dropFirst: start > 0 })) {
      if (d.type === 'ai-title' && d.aiTitle) meta.aiTitle = d.aiTitle;
      if (d.type === 'summary' && d.summary) meta.summary = d.summary;
      if (d.type === 'last-prompt' && d.lastPrompt) meta.lastPrompt = d.lastPrompt;
      if (d.timestamp) meta.lastActivity = d.timestamp;
      if (d.type === 'user' || d.type === 'assistant') meta.lastEventType = d.type;
      if (d.type === 'user' && d.message?.role === 'user') meta.userTurns++;
      if (d.type === 'assistant') {
        if (d.message?.model) meta.model = d.message.model;
        const t = textOf(d.message);
        if (t.trim()) meta.lastAssistant = t.trim();
        // Recomputed on every assistant turn, so a question that was answered and
        // worked past stops counting the moment Claude speaks again.
        meta.awaitingAnswer = isAsking(d.message, t);
        collectActivity(d.message, meta.activity, meta.labelWrites);
      }
    }
  } else {
    for (const d of jsonLines(head)) {
      if (d.type === 'last-prompt' && d.lastPrompt) meta.lastPrompt = d.lastPrompt;
      if (d.timestamp) meta.lastActivity = d.timestamp;
      if (d.type === 'user' || d.type === 'assistant') meta.lastEventType = d.type;
      if (d.type === 'user' && d.message?.role === 'user') meta.userTurns++;
      if (d.type === 'assistant') {
        if (d.message?.model) meta.model = d.message.model;
        const t = textOf(d.message);
        if (t.trim()) meta.lastAssistant = t.trim();
        // Recomputed on every assistant turn, so a question that was answered and
        // worked past stops counting the moment Claude speaks again.
        meta.awaitingAnswer = isAsking(d.message, t);
        collectActivity(d.message, meta.activity, meta.labelWrites);
      }
    }
  }

  return meta;
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']);
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch']);

/**
 * Is this turn a question waiting on an answer?
 *
 * Two signals. AskUserQuestion is unambiguous — the session is blocked until you
 * choose. Otherwise the last line has to actually end in a question mark: a `?`
 * anywhere in the reply catches every rhetorical aside and every question Claude
 * asked and then answered itself, which would flag nearly every turn.
 */
function isAsking(message, text) {
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'tool_use' && (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode')) {
        return true;
      }
    }
  }
  if (!text) return false;
  const lines = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return Boolean(last && last.endsWith('?'));
}

/**
 * A few plain bullets on what Claude was actually doing, read off the recent
 * transcript rather than generated — so they cost nothing and can't be wrong
 * about work that did or didn't happen.
 */
function summarize(meta) {
  const bullets = [];
  const { activity } = meta;

  if (activity.files.length) {
    const names = activity.files.slice(0, 2).join(', ');
    const rest = activity.files.length - 2;
    bullets.push(
      `Edited ${activity.files.length} file${activity.files.length === 1 ? '' : 's'} — ${names}${rest > 0 ? ` +${rest}` : ''}`
    );
  }
  if (activity.commands) {
    bullets.push(`Ran ${activity.commands} command${activity.commands === 1 ? '' : 's'}`);
  }
  if (activity.searches) {
    bullets.push(`${activity.searches} web lookup${activity.searches === 1 ? '' : 's'}`);
  }
  if (activity.agents) {
    bullets.push(`Dispatched ${activity.agents} subagent${activity.agents === 1 ? '' : 's'}`);
  }

  // What it said last matters more than any of the counts, so it goes first.
  if (meta.lastAssistant) {
    const plain = meta.lastAssistant
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sentence = firstSentence(plain).trim();
    if (sentence) bullets.unshift(truncate(sentence, 130));
  }

  return bullets.slice(0, 4);
}

/** Tally the tool calls in one assistant message. */
function collectActivity(message, activity, labelWrites) {
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type !== 'tool_use') continue;
    if (EDIT_TOOLS.has(b.name)) {
      const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
      if (typeof p === 'string') {
        const name = basename(p);
        if (!activity.files.includes(name)) activity.files.push(name);
        // Writing into a label folder is what ties a session to a label.
        const hit = labelFromPath(p);
        if (hit && labelWrites) {
          const key = `${hit.label}|${hit.client}`;
          labelWrites.set(key, (labelWrites.get(key) || 0) + 1);
        }
      }
    } else if (b.name === 'Bash') {
      activity.commands++;
    } else if (SEARCH_TOOLS.has(b.name)) {
      activity.searches++;
    } else if (b.name === 'Agent' || b.name === 'Task') {
      activity.agents++;
    }
  }
}

/**
 * Typing /clear (and its lifecycle siblings) ends the session and starts a new
 * one, so Claude Code writes a transcript holding nothing but that command —
 * no assistant turn, no work. Those are session plumbing, not sessions, and a
 * card for each buries the real ones.
 */
const NO_WORK_COMMANDS = new Set([
  '/clear', '/compact', '/exit', '/quit', '/resume', '/login', '/logout',
]);

function isNoWorkStub(meta) {
  if (meta.lastAssistant) return false; // Claude said something — real session
  if (!meta.firstPrompt) return false;
  return NO_WORK_COMMANDS.has(meta.firstPrompt.split(/\s+/)[0]);
}

function describe(path, dirName, stat) {
  const key = `${path}:${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.value;

  const sessionId = basename(path, '.jsonl');
  const meta = parseTranscript(path, stat);
  const fromCwd = labelFromCwd(meta.cwd);
  const inferred = fromCwd ? null : pickLabel(meta.labelWrites);
  const label = fromCwd || inferred;

  const derivedTitle =
    meta.aiTitle ||
    meta.summary ||
    truncate(cleanPrompt(meta.lastPrompt), 70) ||
    truncate(meta.firstPrompt, 70) ||
    projectLabel(dirName, meta.cwd);

  const value = {
    sessionId,
    engine: 'claude',
    // Claude Code takes the session id the board hands it, so the id it knows
    // the conversation by and the id the card is filed under are the same one.
    // Codex is the case where those differ — see codex.js.
    engineThread: sessionId,
    path,
    project: projectLabel(dirName, meta.cwd),
    projectDir: dirName,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    version: meta.version,
    entrypoint: meta.entrypoint || 'unknown',
    isSidechain: meta.isSidechain,
    stub: isNoWorkStub(meta),
    label: label?.label || null,
    client: label?.client || null,
    labelSource: fromCwd ? 'cwd' : inferred ? 'files' : null,
    model: meta.model,
    derivedTitle,
    lastPrompt: truncate(cleanPrompt(meta.lastPrompt) || meta.firstPrompt, 160),
    lastAssistant: truncate(meta.lastAssistant, 220),
    userTurns: meta.userTurns,
    lastEventType: meta.lastEventType,
    awaitingAnswer: meta.awaitingAnswer && meta.lastEventType === 'assistant',
    summary: summarize(meta),
    sizeBytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    lastActivity: meta.lastActivity || new Date(stat.mtimeMs).toISOString(),
  };

  cache.set(path, { key, value });
  return value;
}

/**
 * Every session on this machine, whichever engine wrote it.
 *
 * Claude Code's transcripts come out of ~/.claude/projects and Codex's rollouts
 * out of ~/.codex/sessions; both are described into the same object here, sorted
 * together, and handed on. `interactiveOnly` keeps real terminal sessions and
 * drops the `sdk-cli` runs the firm's automation pipelines produce — and, on the
 * Codex side, the threads belonging to the ChatGPT desktop app, which are
 * somebody else's window rather than a card on this board.
 */
export function scanSessions(opts = {}) {
  const {
    sinceDays = 7,
    interactiveOnly = true,
    includeSidechains = false,
    includeStubs = false,
  } = opts;

  const out = scanClaudeSessions({ sinceDays, interactiveOnly, includeSidechains, includeStubs });

  out.push(
    ...scanCodexSessions({
      sinceDays,
      interactiveOnly,
      includeSidechains,
      includeStubs,
      // Board-launched codex threads answer to the card id the board gave them,
      // not to the id Codex chose. Without this a session started from here
      // would show up twice.
      aliases: codexAliases(),
    })
  );

  out.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return out;
}

function scanClaudeSessions({ sinceDays, interactiveOnly, includeSidechains, includeStubs }) {
  let dirs;
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
  const out = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(PROJECTS_DIR, dir.name);
    let files;
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dirPath, file);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;
      if (stat.mtimeMs < cutoff) continue;

      const s = describe(path, dir.name, stat);
      if (interactiveOnly && s.entrypoint !== 'cli') continue;
      if (!includeSidechains && s.isSidechain) continue;
      if (!includeStubs && s.stub) continue;
      out.push(s);
    }
  }

  return out;
}

/**
 * Where one session's transcript lives, without parsing anything. findSession
 * describes every transcript on disk to answer the same question, which is far
 * too much work when all you need is the path.
 */
export function transcriptPath(sessionId) {
  let dirs;
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }

  // Not a Claude transcript. It may be a codex thread — either under its own id
  // or under the card id the board started it as.
  const thread = codexAliases({ byCard: true }).get(sessionId) ?? sessionId;
  return codexRolloutPath(thread);
}

export function findSession(sessionId) {
  const all = scanSessions({
    sinceDays: 0,
    interactiveOnly: false,
    includeSidechains: true,
    includeStubs: true,
  });
  return all.find((s) => s.sessionId === sessionId) || null;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'dist', 'build', '.next', '.cache', 'Library', '.Trash', '.claude',
]);

const SKIP_FILES = /(^\.DS_Store$|\.pyc$|\.log$|~\$|^\.~lock)/;

/**
 * What counts as a document. The Files tab exists so the .docx and .pdf a
 * session produced can be opened without hunting for them; scripts, JSON and
 * scratch .md are noise there. Extensions decide, nothing cleverer.
 */
const DOC_EXTS = new Set(['pdf', 'doc', 'docx']);

function extOf(path) {
  return (path.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
}

export function fileKind(path) {
  const ext = extOf(path);
  if (DOC_EXTS.has(ext)) return 'doc';
  if (ext === 'md') return 'md';
  return 'other';
}

// How sure we are that the session made a file. A later, weaker source never
// replaces a stronger one for the same path.
const SOURCE_RANK = { tool: 4, mention: 3, received: 2, window: 1 };

function record(out, path, source) {
  const have = out.get(path);
  if (!have || SOURCE_RANK[source] > SOURCE_RANK[have]) out.set(path, source);
}

// Bounds on the mtime sweep. Documents are always kept; everything else stops
// at MAX_OTHER so a session run from a big folder does not list its whole tree.
const MAX_OTHER = 400;
const MAX_VISITED = 25_000;

/** Files under `root` whose mtime lands inside the session's active window. */
function scanWindow(root, fromMs, toMs, out, budget = { visited: 0, other: 0 }, depth = 0) {
  if (depth > 4 || budget.visited > MAX_VISITED) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (++budget.visited > MAX_VISITED) return;
    if (e.name.startsWith('.') && e.name !== '.claude') {
      if (e.isDirectory()) continue;
    }
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      scanWindow(full, fromMs, toMs, out, budget, depth + 1);
    } else if (e.isFile()) {
      if (SKIP_FILES.test(e.name)) continue;
      const isDoc = fileKind(full) === 'doc';
      if (!isDoc && budget.other >= MAX_OTHER) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= fromMs && stat.mtimeMs <= toMs && !out.has(full)) {
        out.set(full, 'window');
        if (!isDoc) budget.other += 1;
      }
    }
  }
}

/*
 * Documents named anywhere in the transcript.
 *
 * Most of the firm's .docx and .pdf output is written by a script the session
 * ran, not by a Write call, and it lands in a Dropbox matter folder the mtime
 * sweep never reaches. But the path is nearly always in the transcript: in the
 * command that made it, in the script's "Wrote …" output, or in the reply that
 * reports it. So every string in the transcript is searched for something that
 * ends in a document extension, and each hit is resolved against the disk.
 *
 * Paths here carry spaces and apostrophes ("Plaintiffs' Amended Petition.pdf"),
 * so a match runs from a slash to the extension and is then trimmed from the
 * left, one slash at a time, until a suffix exists. Relative paths resolve
 * against the session's cwd. A file that exists but was last modified before
 * the session began was read, not made, and is left out — that is what keeps a
 * directory listing of the matter folder from turning into a "produced" list.
 */
const DOC_MENTION = /(?:^|[\s"'`(\[<,])((?:~\/|\.{1,2}\/|\/)[^\n"`<>]*?\.(?:docx|doc|pdf))(?=$|[\s"'`)\]>,;:])/gi;

function* strings(value, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const v of value) yield* strings(v, depth + 1);
  } else if (typeof value === 'object') {
    for (const v of Object.values(value)) yield* strings(v, depth + 1);
  }
}

function resolveMention(raw, cwd) {
  const home = homedir();
  let text = raw;
  if (text.startsWith('~/')) text = join(home, text.slice(2));
  else if (text.startsWith('./') || text.startsWith('../')) {
    if (!cwd) return null;
    text = join(cwd, text);
  }
  // The lazy match may have started at an earlier slash on the line; try each
  // slash-rooted suffix from the left and keep the first one that is a file.
  let at = 0;
  while (at !== -1 && at < text.length) {
    const candidate = text.slice(at);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
    at = text.indexOf('/', at + 1);
  }
  return null;
}

// `out` maps each resolved path to the timestamp of the line that first named it.
function collectMentions(value, cwd, ts, out, seen) {
  for (const str of strings(value)) {
    if (str.length > 200_000 || !/\.(?:docx|doc|pdf)\b/i.test(str)) continue;
    for (const m of str.matchAll(DOC_MENTION)) {
      const raw = m[1];
      if (seen.has(raw)) continue;
      seen.add(raw);
      const path = resolveMention(raw, cwd);
      if (path) firstNamed(out, path, ts);
    }
  }
}

// Transcripts are read one after another (the card's own, then its subagents'),
// so "first named" is the earliest line across all of them, not the first seen.
function firstNamed(out, path, ts) {
  if (!out.has(path)) return out.set(path, ts);
  const have = out.get(path);
  if (have !== null && ts !== null && ts !== undefined && ts < have) out.set(path, ts);
}

// How long before a document is first named that it may have been written and
// still count as this session's. A script writes the file and then prints the
// path, so the result line that names it comes after the mtime — by seconds,
// or by minutes for a long conversion run. Hours means something else made it.
const MENTION_LEAD_MS = 10 * 60_000;

/*
 * Documents named without a folder.
 *
 * A build script usually knows its output folder as a variable and reports
 * only the file: `SAVED 01 First Amended Complaint.docx`. That is the most
 * common way a firm draft is announced, and it carries no slash for the path
 * scan to catch. But the folder itself was named earlier — in the script's
 * source, in a mkdir, in a Write call — so every absolute folder the session
 * named is remembered, and a bare `<name>.docx` is tried in each of them,
 * newest mention first. The name can hold spaces, so every word boundary on
 * the line is tried as its start and the longest that exists wins.
 */
const ABS_PATH = /(?:~\/|\/)[^\n"'`<>]*/g;
// Folders are listed once each (indexDocs), so the cap can be generous: a
// session that dispatched subagents names several hundred.
const MAX_DIRS = 400;

// Remember every existing directory that an absolute path in `value` names
// or sits inside. `dirs` maps path -> ms of the latest line that named it.
function collectDirs(value, ts, dirs, seen) {
  for (const str of strings(value)) {
    if (str.length > 200_000 || !str.includes('/')) continue;
    for (const m of str.matchAll(ABS_PATH)) {
      let raw = m[0].trim();
      if (raw.length < 2 || raw.length > 400 || seen.has(raw)) continue;
      seen.add(raw);
      if (raw.startsWith('~/')) raw = join(homedir(), raw.slice(2));
      // Longest prefix, cut at slashes, that is a directory.
      let at = raw.length;
      while (at > 1) {
        const candidate = raw.slice(0, at);
        try {
          if (statSync(candidate).isDirectory()) {
            dirs.set(candidate, Math.max(ts ?? 0, dirs.get(candidate) ?? 0));
            break;
          }
        } catch {
          /* keep cutting */
        }
        at = candidate.lastIndexOf('/');
      }
    }
  }
}

const BARE_DOC_LINE = /^[^\n]*?\.(?:docx|doc|pdf)(?=$|[\s"'`)\]>,;:])/gim;

function resolveBare(line, docsByName) {
  // Word-start offsets, so "SAVED 01 First Amended Complaint.docx" is tried as
  // the whole line, then from "01", then from "First", and so on.
  const starts = [0];
  for (let i = 1; i < line.length && starts.length < 40; i++) {
    if (/[\s"'`(\[<,=:]/.test(line[i - 1]) && !/\s/.test(line[i])) starts.push(i);
  }
  for (const start of starts) {
    const name = line.slice(start).replace(/^["'`(\[<]+/, '');
    if (!name || name.includes('/') || name.length > 200) continue;
    for (const dir of docsByName.get(nameKey(name)) ?? []) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* listed a moment ago, gone now */
      }
    }
  }
  return null;
}

// Every document in the folders a bare name may resolve in, by file name,
// newest-named folder first. One listing per folder replaces a stat for every
// word on every line: the matter folders sit behind Dropbox's file provider,
// where a miss is slow and there were thousands of them per session.
// The disk hands back decomposed accents and does not care about case.
const nameKey = (name) => name.normalize('NFC').toLowerCase();

function indexDocs(dirs) {
  const docsByName = new Map();
  const ordered = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIRS);
  for (const [dir] of ordered) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const raw of names) {
      if (fileKind(raw) !== 'doc') continue;
      const name = nameKey(raw);
      if (!docsByName.has(name)) docsByName.set(name, []);
      docsByName.get(name).push(dir);
    }
  }
  return docsByName;
}

function collectBareMentions(value, ts, docsByName, out, seen) {
  if (!docsByName.size) return;
  for (const str of strings(value)) {
    if (str.length > 200_000 || !/\.(?:docx|doc|pdf)\b/i.test(str)) continue;
    for (const m of str.matchAll(BARE_DOC_LINE)) {
      const line = m[0].length > 300 ? m[0].slice(-300) : m[0];
      if (line.includes('/') || seen.has(line)) continue;
      seen.add(line);
      const path = resolveBare(line, docsByName);
      if (path) firstNamed(out, path, ts);
    }
  }
}

/*
 * Folders and documents named by a relative path.
 *
 * The reply that reports a package says "it is in `2. Motions/<name>/Final/`",
 * and the command that checked it ran `cd "$R/2. Motions/<name>"` with the
 * matter folder held in a shell variable. Neither carries an absolute path, so
 * the folder is never learned and the bare `…_v4.docx` names beside it have
 * nowhere to resolve. A quoted or backticked fragment with a slash in it is
 * therefore tried under every folder the session did name, and under up to
 * three of each one's parents. Only a fragment whose first segment is really a
 * child of that folder costs a stat, so URLs and prose fall out for free.
 */
const REL_SPAN = /[`"]([^`"\n<>]{3,300})[`"]/g;
const MAX_REL = 4000;
const REL_PARENTS = 3;

function collectRelative(value, ts, rels) {
  for (const str of strings(value)) {
    if (str.length > 200_000 || !str.includes('/')) continue;
    for (const m of str.matchAll(REL_SPAN)) {
      if (rels.size >= MAX_REL) return;
      // `$R/2. Motions/…`, `${ROOT}/…` and `./…` all mean "under some folder".
      const raw = m[1].trim().replace(/^(?:\$\{?\w+\}?\/|\.\/)+/, '');
      if (!raw.includes('/') || raw.startsWith('/') || raw.startsWith('~') || raw.includes('://')) continue;
      if (!rels.has(raw)) rels.set(raw, ts);
    }
  }
}

function resolveRelative(rels, dirs, mentioned) {
  if (!rels.size) return;
  const home = homedir();
  const roots = new Set();
  for (const dir of dirs.keys()) {
    let at = dir;
    for (let up = 0; up <= REL_PARENTS; up++) {
      // A parent is only worth trying below the home folder; the home folder
      // itself counts when the session named it (it is every firm cwd).
      if (up > 0 && (at === home || !at.startsWith(home + '/'))) break;
      roots.add(at);
      if (at === '/') break;
      at = dirname(at);
    }
  }
  const parentsOf = new Map(); // child name -> folders that hold it
  for (const root of roots) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!parentsOf.has(name)) parentsOf.set(name, []);
      parentsOf.get(name).push(root);
    }
  }
  for (const [raw, ts] of rels) {
    const first = raw.slice(0, raw.indexOf('/'));
    for (const root of parentsOf.get(first) ?? []) {
      // Longest prefix, cut at slashes, that exists: a document is a mention,
      // a folder is somewhere a bare name may resolve.
      let at = raw.replace(/\/+$/, '').length;
      while (at > 0) {
        const candidate = join(root, raw.slice(0, at));
        try {
          const st = statSync(candidate);
          if (st.isDirectory()) dirs.set(candidate, Math.max(ts ?? 0, dirs.get(candidate) ?? 0));
          else if (st.isFile() && fileKind(candidate) === 'doc') firstNamed(mentioned, candidate, ts);
          break;
        } catch {
          /* keep cutting */
        }
        at = raw.lastIndexOf('/', at - 1);
      }
    }
  }
}

/*
 * The transcripts of the subagents a session dispatched.
 *
 * Most firm documents are built by a specialist — Clay runs the build script,
 * Steph writes the draft — and that work is recorded in
 * `<session>/subagents/agent-*.jsonl`, not in the card's own transcript, which
 * holds only the agent's closing report. Those files are the card's work too.
 * Newest first, within a byte budget, so a month-long session stays quick.
 */
const SUBAGENT_BUDGET = 160 * 1024 * 1024;

function subagentTranscripts(sessionPath) {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.push({ path: join(dir, name), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* gone */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Documents produced during a session.
 *
 * Three sources, because none alone is enough: the transcript's own write tools
 * are authoritative but miss anything a script generated (which is how most of
 * the firm's .docx output is actually written); document paths named in the
 * transcript catch those wherever they landed, gated on having changed during
 * the session; and an mtime sweep of the working directory catches the rest but
 * can't prove authorship. Each file carries which source found it.
 */
export function readSessionFiles(sessionId) {
  const s = findSession(sessionId);
  if (!s) return null;

  const found = new Map(); // absolute path -> 'tool' | 'window'
  let firstTs = null;
  let lastTs = null;

  if (s.engine === 'codex') {
    // Codex records `apply_patch` writes with full paths and nothing else, so
    // the mtime sweep below is doing more of the work here than it does for a
    // Claude session. Both sources are still marked honestly: 'tool' means the
    // rollout says so, 'window' means the file merely changed while it ran.
    const { paths, window } = codexWrittenFiles(s);
    for (const p of paths) record(found, p, 'tool');
    firstTs = window.from;
    lastTs = window.to;
    return collectSessionFiles(s, found, firstTs, lastTs);
  }

  const stat = statSync(s.path);
  // A long-lived matter session runs to tens of megabytes, and the folder a
  // draft was saved into may have been named well before the draft was.
  const start = Math.max(0, stat.size - 32 * 1024 * 1024);
  const text = readChunk(s.path, start, stat.size - start);
  const mentioned = new Map(); // path -> ms of the line that first named it
  const seenRaw = new Set();
  const dirs = new Map(); // directory -> ms of the latest line that named it
  const seenDirRaw = new Set();
  const seenBare = new Set();
  const bareLines = []; // [content, ts] — resolved after every folder is known
  const rels = new Map(); // relative fragment -> ms of the line that first named it
  if (s.cwd) dirs.set(s.cwd, 0);

  // `own` is the card's transcript: it alone sets the session's time window. A
  // subagent's prompt arrives as a plain string, so content is wrapped.
  const scan = (chunk, dropFirst, own) => {
    for (const d of jsonLines(chunk, { dropFirst })) {
      let lineTs = null;
      if (d.timestamp) {
        const t = Date.parse(d.timestamp);
        if (!Number.isNaN(t)) {
          lineTs = t;
          if (own && (firstTs === null || t < firstTs)) firstTs = t;
          if (own && (lastTs === null || t > lastTs)) lastTs = t;
        }
      }
      if (d.type !== 'assistant' && d.type !== 'user') continue;
      let content = d.message?.content;
      if (typeof content === 'string' && !own) content = [content];
      if (!Array.isArray(content)) continue;
      collectMentions(content, s.cwd, lineTs ?? firstTs, mentioned, seenRaw);
      collectDirs(content, lineTs, dirs, seenDirRaw);
      collectRelative(content, lineTs ?? firstTs, rels);
      bareLines.push([content, lineTs ?? firstTs]);
      if (d.type !== 'assistant') continue;
      for (const b of content) {
        if (b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
        const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
        if (typeof p === 'string' && p.startsWith('/')) record(found, p, 'tool');
      }
    }
  };
  scan(text, start > 0, true);

  let budget = SUBAGENT_BUDGET;
  for (const sub of subagentTranscripts(s.path)) {
    if (budget <= 0) break;
    const take = Math.min(sub.size, 32 * 1024 * 1024, budget);
    budget -= take;
    try {
      scan(readChunk(sub.path, sub.size - take, take), take < sub.size, false);
    } catch {
      /* a transcript still being written, or gone */
    }
  }

  // A named document counts as this session's only if it changed at or after
  // the moment the session first named it. A file that was already on disk
  // when the transcript first mentions it — a court PDF downloaded overnight,
  // a scan, a listing of the matter folder — was read here, not made here,
  // whatever happened to it after the session began.
  //
  // A document that was already on disk when first named, but arrived after the
  // session began — a Court Watch download the session then read and filed —
  // is listed too, as 'received': it is part of what the session handled,
  // and the label keeps it distinct from what the session made.
  for (const p of mentioned.keys()) dirs.set(dirname(p), Math.max(dirs.get(dirname(p)) ?? 0, mentioned.get(p) ?? 0));
  for (const p of found.keys()) if (!dirs.has(dirname(p))) dirs.set(dirname(p), 0);
  resolveRelative(rels, dirs, mentioned);
  const docsByName = indexDocs(dirs);
  for (const [content, ts] of bareLines) collectBareMentions(content, ts, docsByName, mentioned, seenBare);

  const since = firstTs === null ? null : firstTs - 60_000;
  for (const [p, namedAt] of mentioned) {
    let mtime;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (namedAt === null || mtime >= namedAt - MENTION_LEAD_MS) record(found, p, 'mention');
    else if (since === null || mtime >= since) record(found, p, 'received');
  }

  return collectSessionFiles(s, found, firstTs, lastTs);
}

const KIND_ORDER = { doc: 0, md: 1, other: 2 };

// A path segment that marks a shelved copy. The firm's convention is
// `_Superseded/`; the bare word and `_Archive/` are accepted for older folders.
const SHELVED_DIR = /^(?:_?superseded|_archive)(?:$|[\s_.-])/i;
// Where a session's build intermediates live: the per-session scratchpad.
// TEMP_ROOT is the wider net — nothing under a temp folder is a deliverable.
const TEMP_ROOT = /^(?:\/private)?\/(?:tmp|var\/folders)\//;
const SCRATCH = /\/claude-\d+\/[^/]+\/[^/]+\/scratchpad(?:\/|$)/;

/**
 * Whether a file is one to look at, or a copy that has been moved aside.
 *
 * `superseded`: it sits in a _Superseded folder — or it is gone from where the
 * session wrote it and a file of the same name now sits in the _Superseded
 * folder beside that spot, which is what the firm's archive step leaves behind
 * (`path` is then swapped to the shelved copy so Open still works).
 * `scratch`: it is a working copy in the session scratchpad, not a deliverable.
 */
function shelve(path, stat) {
  const home = homedir();
  const segments = path.split('/');
  if (segments.some((seg) => SHELVED_DIR.test(seg))) return { path, stat, superseded: true, scratch: false };
  if (!stat) {
    const moved = join(dirname(path), '_Superseded', basename(path));
    try {
      const st = statSync(moved);
      if (st.isFile()) return { path: moved, stat: st, superseded: true, scratch: false };
    } catch {
      /* not archived, just gone */
    }
  }
  // Working copies: the session scratchpad, ~/.claude, anything under a temp
  // folder, and the firm's underscore folders (`_source/`, `_lee_v6b/`) — where
  // a citecheck parks the opinions it downloaded, by the hundred.
  const scratch = SCRATCH.test(path)
    || path.startsWith(join(home, '.claude') + '/')
    || TEMP_ROOT.test(path)
    || segments.slice(0, -1).some((seg) => seg.startsWith('_'));
  return { path, stat, superseded: false, scratch };
}

/** The mtime sweep and the file listing, shared by both engines. */
function collectSessionFiles(s, found, firstTs, lastTs) {
  // The sweep is evidence only when the cwd is a project. A session run from
  // the home folder would sweep Downloads, Documents and the Desktop, and every
  // court PDF that arrived while it ran would be listed as if it were produced.
  if (s.cwd && s.cwd !== homedir() && firstTs && lastTs) {
    // A small lead-in catches files a script wrote just before the first logged
    // timestamp of the turn that produced them.
    scanWindow(s.cwd, firstTs - 60_000, lastTs + 60_000, found);
  }

  const home = homedir();
  const files = [...found.entries()]
    // Word's ~$owner lock files and LibreOffice's .~lock files are not documents.
    .filter(([written]) => !SKIP_FILES.test(basename(written)))
    .map(([written, source]) => {
      let found = null;
      try {
        found = statSync(written);
      } catch {
        /* written then moved or deleted */
      }
      const { path, stat, superseded, scratch } = shelve(written, found);
      return {
        path,
        name: basename(path),
        dir: dirname(path).replace(home, '~'),
        ext: extOf(path),
        kind: fileKind(path),
        source,
        superseded,
        scratch,
        exists: Boolean(stat),
        sizeBytes: stat?.size ?? null,
        mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      // Word before PDF: the deliverable is the .docx, and a research session's
      // subagents can download PDFs by the hundred.
      if (a.kind === 'doc' && (a.ext === 'pdf') !== (b.ext === 'pdf')) return a.ext === 'pdf' ? 1 : -1;
      return (b.mtime || '').localeCompare(a.mtime || '');
    });

  return { session: s, files, window: { from: firstTs, to: lastTs } };
}

/**
 * One tool call, in the words you would use to describe it out loud.
 *
 * The mirror's whole job is to let you read a session the way you would read a
 * letter, and `Bash {"command":"soffice --headless --convert-to docx …"}` is not
 * that. Every call becomes a verb and a thing: what was read, what was written,
 * what was looked up. Bash carries its own one-line description, which is better
 * than anything derivable from the command itself, so that is used when present.
 */
function toolLabel(name, input = {}) {
  const file = (p) => (typeof p === 'string' ? basename(p) : null);
  const target = file(input.file_path || input.path || input.notebook_path);

  switch (name) {
    case 'Read':
      return { verb: 'Read', target };
    case 'Write':
      return { verb: 'Wrote', target };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'str_replace_editor':
      return { verb: 'Edited', target };
    case 'Bash':
      return { verb: 'Ran', target: input.description || 'a command' };
    case 'Grep':
    case 'Glob':
      return { verb: 'Searched', target: 'the files' };
    case 'WebSearch':
      return { verb: 'Looked up', target: input.query || 'the web' };
    case 'WebFetch': {
      let host = null;
      try {
        host = new URL(input.url).hostname.replace(/^www\./, '');
      } catch {
        /* not a URL we can read */
      }
      return { verb: 'Read', target: host || 'a web page' };
    }
    case 'Agent':
    case 'Task':
      return { verb: 'Handed off to', target: input.subagent_type || 'a subagent' };
    case 'Skill':
      return { verb: 'Invoked', target: input.skill ? `/${input.skill}` : 'a skill' };
    case 'TodoWrite':
      return null; // bookkeeping, not work
    default:
      if (name?.startsWith('mcp__')) {
        return { verb: 'Used', target: name.split('__')[1] || 'a connected tool' };
      }
      return { verb: 'Used', target: name };
  }
}

/** Full message list for the read-only mirror pane. */
export function readTranscript(sessionId, { limit = 120 } = {}) {
  const s = findSession(sessionId);
  if (!s) return null;
  if (s.engine === 'codex') return readCodexTranscript(s, { limit });

  const stat = statSync(s.path);
  const start = Math.max(0, stat.size - 2 * 1024 * 1024);
  const text = readChunk(s.path, start, stat.size - start);

  const messages = [];
  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg) continue;

    const blocks = [];
    const content = msg.content;
    if (typeof content === 'string') {
      /*
       * Only your turns are de-wrapped, and a turn that de-wraps to nothing is
       * dropped rather than falling back to its raw form. Command plumbing —
       * `<local-command-stdout>`, the caveat Claude Code injects around local
       * commands — is *entirely* wrapper, so the old fallback printed the raw
       * tags in full and attributed them to you.
       */
      const t = d.type === 'user' ? cleanPrompt(content) : content;
      if (t.trim()) blocks.push({ type: 'text', text: t });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) {
          // What you typed goes through the same de-wrapping as a plain string
          // turn: a slash command arrives wrapped in tags, and a system reminder
          // is machinery you never wrote and should not have to read.
          const text = d.type === 'user' ? cleanPrompt(b.text) : b.text;
          if (text.trim()) blocks.push({ type: 'text', text });
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          blocks.push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          const label = toolLabel(b.name, b.input ?? {});
          blocks.push({
            type: 'tool_use',
            name: b.name,
            input: truncate(JSON.stringify(b.input ?? {}), 600),
            // Carried alongside the raw call rather than instead of it: the clean
            // reading uses the label, the technical one still shows everything.
            verb: label?.verb ?? null,
            target: label ? truncate(label.target, 80) : null,
          });
        } else if (b.type === 'tool_result') {
          const c = b.content;
          const t = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
              : '';
          blocks.push({ type: 'tool_result', text: truncate(t, 800), isError: Boolean(b.is_error) });
        }
      }
    }
    if (!blocks.length) continue;
    messages.push({
      uuid: d.uuid,
      role: d.type,
      timestamp: d.timestamp || null,
      model: msg.model || null,
      blocks,
    });
  }

  return { session: s, messages: messages.slice(-limit), truncated: start > 0 };
}
