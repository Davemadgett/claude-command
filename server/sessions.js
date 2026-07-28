import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { firstSentence } from './skills.js';
import { config } from './config.js';

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

export function readChunk(path, start, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function* jsonLines(text, { dropFirst = false } = {}) {
  const lines = text.split('\n');
  // A tail chunk almost always starts mid-line; that fragment is unparseable.
  const start = dropFirst ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* truncated or partially-written line — skip */
    }
  }
}

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

/**
 * Which label, if any, a path sits inside — read from the configured folder
 * layout rather than a fixed convention.
 *
 * A path counts only if it is under `labels.root`, and the label is the segment
 * exactly `labels.depth` levels below it. Anything shallower is the tree above
 * the labels; anything deeper is a file *within* one, and its label is still the
 * segment at that depth. With no root configured this returns null, which is
 * what switches folder inference off for an install that has no such layout.
 *
 * Shared by the cwd check, the file-write inference below, and the time log.
 */
export function labelFromPath(p) {
  if (!p) return null;

  const root = config.labels.root;
  if (!root || !p.startsWith(`${root}/`)) return null;

  const depth = Math.max(1, Number(config.labels.depth) || 1);
  // Segment names carry spaces ("01977-Northwind Trading"), so split on the
  // separator rather than trying to match the name itself.
  const parts = p.slice(root.length + 1).split('/').filter(Boolean);
  if (parts.length < depth) return null;

  const label = parts[depth - 1].trim();
  if (!label) return null;

  const pattern = config.labels.pattern;
  if (pattern) {
    try {
      if (!new RegExp(pattern).test(label)) return null;
    } catch {
      /* a broken pattern should not silently reject every path */
    }
  }

  // The folder the label is grouped under, when the layout has one. Displayed
  // beside the label in the time log, where knowing whose work it is helps.
  const client = depth > 1 ? parts[depth - 2].trim() : null;
  return { label, client };
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
 * Walk ~/.claude/projects and describe every transcript.
 * `interactiveOnly` keeps real terminal sessions and drops the `sdk-cli` runs the
 * firm's automation pipelines produce, which would otherwise flood the board.
 */
export function scanSessions({
  sinceDays = 7,
  interactiveOnly = true,
  includeSidechains = false,
  includeStubs = false,
} = {}) {
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

  out.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
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
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
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

/** Files under `root` whose mtime lands inside the session's active window. */
function scanWindow(root, fromMs, toMs, out, depth = 0) {
  if (depth > 4 || out.size > 400) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') {
      if (e.isDirectory()) continue;
    }
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      scanWindow(full, fromMs, toMs, out, depth + 1);
    } else if (e.isFile()) {
      if (SKIP_FILES.test(e.name)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= fromMs && stat.mtimeMs <= toMs && !out.has(full)) {
        out.set(full, 'window');
      }
    }
  }
}

/**
 * Documents produced during a session.
 *
 * Two sources, because neither alone is enough: the transcript's own write tools
 * are authoritative but miss anything a script generated (which is how most of
 * the firm's .docx output is actually written), and an mtime sweep of the working
 * directory catches those but can't prove authorship.
 */
export function readSessionFiles(sessionId) {
  const s = findSession(sessionId);
  if (!s) return null;

  const stat = statSync(s.path);
  const start = Math.max(0, stat.size - 8 * 1024 * 1024);
  const text = readChunk(s.path, start, stat.size - start);

  const found = new Map(); // absolute path -> 'tool' | 'window'
  let firstTs = null;
  let lastTs = null;

  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t;
        if (lastTs === null || t > lastTs) lastTs = t;
      }
    }
    if (d.type !== 'assistant') continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
      if (typeof p === 'string' && p.startsWith('/')) found.set(p, 'tool');
    }
  }

  if (s.cwd && firstTs && lastTs) {
    // A small lead-in catches files a script wrote just before the first logged
    // timestamp of the turn that produced them.
    scanWindow(s.cwd, firstTs - 60_000, lastTs + 60_000, found);
  }

  const home = homedir();
  const files = [...found.entries()]
    .map(([path, source]) => {
      let stat = null;
      try {
        stat = statSync(path);
      } catch {
        /* written then moved or deleted */
      }
      return {
        path,
        name: basename(path),
        dir: dirname(path).replace(home, '~'),
        ext: (path.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase(),
        source,
        exists: Boolean(stat),
        sizeBytes: stat?.size ?? null,
        mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'tool' ? -1 : 1;
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
