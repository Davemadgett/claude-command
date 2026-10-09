/**
 * Reading Codex the way the board reads Claude Code.
 *
 * Codex keeps a "rollout" per thread under ~/.codex/sessions/YYYY/MM/DD, one
 * JSON object per line, and it is a different shape from a Claude transcript in
 * every respect that matters here: the id is the thread's rather than one we
 * chose, the working directory arrives in a header line instead of on every
 * event, and what the model did is spread across two parallel streams — the
 * `event_msg` narration the TUI renders, and the `response_item` record of what
 * was actually sent to the API.
 *
 * Everything below turns that into the same session object sessions.js produces
 * for a Claude transcript, so the board, the cards, the mirror and the time log
 * never have to know which one they are looking at.
 *
 * Two formats, both live. Codex changed its event vocabulary partway through
 * 0.14x: older rollouts narrate with `agent_message` / `user_message` /
 * `patch_apply_end`, newer ones with a single `item_completed` carrying a typed
 * item. Both are parsed, because both are sitting on disk right now and a board
 * that only understood the current one would show a week of blank cards.
 *
 * WHAT IS DELIBERATELY WEAKER THAN THE CLAUDE PATH — file attribution. A Claude
 * session announces every write as a Write/Edit tool call with the path in it.
 * Codex writes through `apply_patch`, which is recorded with full paths, but it
 * can also write by running a shell command, which is recorded only as the
 * command. So a codex session that generates a document from a script attributes
 * by working directory alone. That is the same trade the rest of this program
 * makes: an unattributed session is honest, a wrongly attributed one bills the
 * wrong client. Nothing here guesses a label from a path the session merely read.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { jsonLines, labelFromPath, readChunk } from './sessions-io.js';

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

/** Parsed metadata cached on (size, mtime), exactly as the Claude scan does. */
const cache = new Map();

export function codexSessionsDir() {
  return SESSIONS_DIR;
}

/* ------------------------------------------------------------ walking --- */

/**
 * Every rollout file, newest day first.
 *
 * The tree is ~/.codex/sessions/YYYY/MM/DD, which is a gift: a `sinceDays`
 * window can throw away whole directories without stat-ing a single file inside
 * them, and the archive of everything before last week never gets touched.
 */
function rolloutFiles({ sinceDays = 7 } = {}) {
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
  const out = [];

  const dirs = (root) => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  };

  for (const year of dirs(SESSIONS_DIR)) {
    for (const month of dirs(join(SESSIONS_DIR, year))) {
      for (const day of dirs(join(SESSIONS_DIR, year, month))) {
        // The folder is a date, so a whole day can be ruled out at once. A day
        // is kept if any part of it could still be inside the window — the
        // file's own mtime decides after that.
        if (cutoff) {
          const endOfDay = Date.parse(`${year}-${month}-${day}T23:59:59Z`) + 86400_000;
          if (!Number.isNaN(endOfDay) && endOfDay < cutoff) continue;
        }
        const dir = join(SESSIONS_DIR, year, month, day);
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (!name.endsWith('.jsonl')) continue;
          const path = join(dir, name);
          let stat;
          try {
            stat = statSync(path);
          } catch {
            continue;
          }
          if (stat.size === 0) continue;
          if (stat.mtimeMs < cutoff) continue;
          out.push({ path, stat });
        }
      }
    }
  }
  return out;
}

/** The thread id is in the filename — `rollout-<timestamp>-<uuid>.jsonl`. */
function threadIdFromPath(path) {
  const m = basename(path, '.jsonl').match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
  );
  return m ? m[1] : null;
}

/* ------------------------------------------------------------ parsing --- */

/** Text out of a content array, whichever of the three spellings it uses. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * A `codex` shell alias, a MCP tool, a spawned sub-agent — what kind of work a
 * recorded call represents. Only the buckets the card summary counts.
 */
const SHELL_CALLS = new Set(['exec', 'exec_command', 'shell', 'local_shell_call', 'run_command']);
const AGENT_CALLS = new Set(['spawn_agent', 'followup_task']);

/**
 * One pass over a chunk of a rollout, folding what it finds into `meta`.
 *
 * Both event vocabularies are handled in the same walk rather than sniffed
 * first: a long-running thread can straddle a Codex upgrade, and a rollout with
 * old lines at the top and new lines at the bottom is a real file on this disk.
 */
function fold(meta, obj, { head }) {
  const kind = obj?.type;
  const p = obj?.payload;
  if (obj?.timestamp) meta.lastActivity = obj.timestamp;

  if (kind === 'session_meta' && p) {
    // `id` is this thread; `session_id` can point at a parent when the rollout
    // is a sub-agent's, so it is never the one to key on.
    meta.threadId = p.id || p.session_id || meta.threadId;
    meta.parentThreadId = p.parent_thread_id || null;
    meta.cwd = p.cwd || meta.cwd;
    meta.originator = p.originator || null;
    meta.version = p.cli_version || null;
    meta.isSidechain = p.thread_source === 'subagent';
    meta.startedAt = p.timestamp || obj.timestamp || null;
    return;
  }

  if (kind === 'turn_context' && p) {
    if (p.cwd) meta.cwd = p.cwd;
    if (p.model) meta.model = p.model;
    return;
  }

  if (kind === 'event_msg' && p) {
    switch (p.type) {
      case 'thread_settings_applied':
        if (p.thread_settings?.model) meta.model = p.thread_settings.model;
        return;

      /* --- the older narration ------------------------------------------ */
      case 'user_message': {
        const t = (p.message || '').trim();
        if (!t) return;
        meta.userTurns++;
        meta.lastEventType = 'user';
        if (!meta.firstPrompt) meta.firstPrompt = t;
        meta.lastPrompt = t;
        return;
      }
      case 'agent_message': {
        const t = (p.message || '').trim();
        if (!t) return;
        meta.lastEventType = 'assistant';
        meta.lastAssistant = t;
        meta.awaitingAnswer = endsInQuestion(t);
        return;
      }
      case 'patch_apply_end':
        // The authoritative record of what was written, with absolute paths.
        if (p.success !== false && p.changes && typeof p.changes === 'object') {
          for (const path of Object.keys(p.changes)) noteWrite(meta, path);
        }
        return;
      case 'web_search_end':
        meta.activity.searches++;
        return;
      case 'mcp_tool_call_end':
        meta.activity.commands++;
        return;
      case 'task_complete':
        // The definitive final answer for the turn — better than the last
        // `agent_message`, which is often just the "I'm about to…" preamble.
        if (p.last_agent_message?.trim()) {
          meta.lastEventType = 'assistant';
          meta.lastAssistant = p.last_agent_message.trim();
          meta.awaitingAnswer = endsInQuestion(meta.lastAssistant);
        }
        return;

      /* --- the current narration ---------------------------------------- */
      case 'item_completed':
        return foldItem(meta, p.item, { head });
      default:
        return;
    }
  }

  if (kind === 'response_item' && p) {
    // `message` lines are skipped on purpose. The user-role ones include every
    // AGENTS.md file and every injected reminder, which read exactly like
    // something you typed — and reading those as prompts is how a label gets
    // attached to the wrong card. The narration above says what a person
    // actually said.
    if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const name = p.name || p.type;
      if (name === 'apply_patch') {
        // Older rollouts record the patch as the tool's input; the paths are on
        // the `*** Add File:` / `*** Update File:` header lines.
        for (const path of patchPaths(p.input)) noteWrite(meta, path);
      } else if (SHELL_CALLS.has(name)) {
        meta.activity.commands++;
      } else if (AGENT_CALLS.has(name)) {
        meta.activity.agents++;
      } else if (p.namespace === 'web' || name === 'web_search') {
        meta.activity.searches++;
      } else if (typeof name === 'string' && name.startsWith('_')) {
        meta.activity.commands++; // an app connector call
      }
    }
  }
}

/** The current format's typed items. */
function foldItem(meta, item, { head }) {
  if (!item) return;
  switch (item.type) {
    case 'UserMessage': {
      const t = textOf(item.content).trim();
      if (!t) return;
      meta.userTurns++;
      meta.lastEventType = 'user';
      if (!meta.firstPrompt) meta.firstPrompt = t;
      meta.lastPrompt = t;
      return;
    }
    case 'AgentMessage': {
      const t = textOf(item.content).trim();
      if (!t) return;
      meta.lastEventType = 'assistant';
      meta.lastAssistant = t;
      meta.awaitingAnswer = endsInQuestion(t);
      return;
    }
    case 'CommandExecution':
      meta.activity.commands++;
      return;
    case 'WebSearch':
      meta.activity.searches++;
      return;
    case 'FileChange':
    case 'PatchApply': {
      const changes = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
      for (const path of changes) noteWrite(meta, path);
      for (const c of Array.isArray(item.files) ? item.files : []) {
        if (typeof c?.path === 'string') noteWrite(meta, c.path);
      }
      return;
    }
    case 'AgentSpawn':
    case 'SubAgent':
      meta.activity.agents++;
      return;
    default:
      // Reasoning, Extension, TodoList — narration, not work.
      if (head) return;
  }
}

/** Absolute paths named in an `apply_patch` body. */
function patchPaths(input) {
  if (typeof input !== 'string') return [];
  const out = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(input))) {
    const p = m[1].trim();
    if (p.startsWith('/')) out.push(p);
  }
  return out;
}

/** A file this session wrote — for the card summary and for label attribution. */
function noteWrite(meta, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return;
  const name = basename(path);
  if (!meta.activity.files.includes(name)) meta.activity.files.push(name);
  const hit = labelFromPath(path);
  if (!hit) return;
  const key = `${hit.label}|${hit.client}`;
  meta.labelWrites.set(key, (meta.labelWrites.get(key) || 0) + 1);
}

/**
 * Is this turn a question waiting on an answer? Same rule as the Claude side:
 * the last line has to actually end in a question mark, because a `?` anywhere
 * in the reply flags nearly every turn.
 */
function endsInQuestion(text) {
  if (!text) return false;
  const lines = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return Boolean(last && last.endsWith('?'));
}

function emptyMeta() {
  return {
    threadId: null,
    parentThreadId: null,
    cwd: null,
    originator: null,
    version: null,
    isSidechain: false,
    model: null,
    startedAt: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    lastEventType: null,
    lastActivity: null,
    awaitingAnswer: false,
    userTurns: 0,
    activity: { files: [], commands: 0, searches: 0, agents: 0 },
    labelWrites: new Map(),
  };
}

/** Head for the header and the opening, tail for where the session got to. */
export function parseRollout(path, stat) {
  const meta = emptyMeta();

  const head = readChunk(path, 0, Math.min(HEAD_BYTES, stat.size));
  for (const d of jsonLines(head)) fold(meta, d, { head: true });

  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = readChunk(path, start, stat.size - start);
    for (const d of jsonLines(tail, { dropFirst: start > 0 })) fold(meta, d, { head: false });
  }

  return meta;
}

/* ------------------------------------------------------------ sessions --- */

/**
 * Which of Codex's front ends wrote this. The board only owns the ones it
 * started, and those are the TUI; a thread from the ChatGPT desktop app is
 * somebody else's window and shows up here only when interactive-only is off.
 */
function entrypointFor(originator) {
  if (!originator) return 'unknown';
  return /^codex-?tui$/i.test(originator) ? 'cli' : originator;
}

function projectFor(cwd) {
  if (!cwd) return '—';
  const hit = labelFromPath(cwd);
  if (hit) return hit.label;
  if (cwd === homedir()) return 'home';
  return basename(cwd) || 'home';
}

/**
 * A few plain bullets on what Codex was doing — read off the rollout rather
 * than generated, so they cost nothing and cannot be wrong about work that did
 * or did not happen.
 */
function summarize(meta) {
  const bullets = [];
  const a = meta.activity;
  if (a.files.length) {
    const names = a.files.slice(0, 2).join(', ');
    const rest = a.files.length - 2;
    bullets.push(
      `Wrote ${a.files.length} file${a.files.length === 1 ? '' : 's'} — ${names}${rest > 0 ? ` +${rest}` : ''}`
    );
  }
  if (a.commands) bullets.push(`Ran ${a.commands} command${a.commands === 1 ? '' : 's'}`);
  if (a.searches) bullets.push(`${a.searches} web lookup${a.searches === 1 ? '' : 's'}`);
  if (a.agents) bullets.push(`Dispatched ${a.agents} sub-agent${a.agents === 1 ? '' : 's'}`);

  if (meta.lastAssistant) {
    const plain = meta.lastAssistant
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sentence = (plain.match(/^.*?[.!?](?=\s|$)/)?.[0] || plain).trim();
    if (sentence) bullets.unshift(truncate(sentence, 130));
  }
  return bullets.slice(0, 4);
}

function pickLabel(counts) {
  if (!counts.size) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [label, client] = best[0].split('|');
  return { label, client };
}

/**
 * One rollout as a board session.
 *
 * `alias` is how a codex thread ends up under the id the board gave the card
 * that started it. Without it a board-launched session would appear twice —
 * once as the card, once as the thread the card produced.
 */
function describe(path, stat, aliases) {
  const key = `${path}:${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return withAlias(hit.value, aliases);

  const meta = parseRollout(path, stat);
  const threadId = meta.threadId || threadIdFromPath(path);
  if (!threadId) return null;

  const fromCwd = labelFromPath(meta.cwd);
  const inferred = fromCwd ? null : pickLabel(meta.labelWrites);
  const label = fromCwd || inferred;

  const derivedTitle =
    truncate(meta.lastPrompt, 70) || truncate(meta.firstPrompt, 70) || projectFor(meta.cwd);

  const value = {
    sessionId: threadId,
    engine: 'codex',
    /** Always the thread Codex knows about, whatever the card is keyed on. */
    engineThread: threadId,
    path,
    project: projectFor(meta.cwd),
    projectDir: null,
    cwd: meta.cwd,
    gitBranch: null,
    version: meta.version,
    entrypoint: entrypointFor(meta.originator),
    isSidechain: meta.isSidechain,
    // A thread with nothing said in it either way is Codex plumbing, the same
    // way a /clear transcript is on the Claude side.
    stub: !meta.lastAssistant && !meta.firstPrompt,
    label: label?.label || null,
    client: label?.client || null,
    labelSource: fromCwd ? 'cwd' : inferred ? 'files' : null,
    model: meta.model,
    derivedTitle,
    lastPrompt: truncate(meta.lastPrompt || meta.firstPrompt, 160),
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
  return withAlias(value, aliases);
}

function withAlias(session, aliases) {
  const cardId = aliases?.get(session.engineThread);
  return cardId && cardId !== session.sessionId ? { ...session, sessionId: cardId } : session;
}

/**
 * Every Codex thread, described like a Claude session.
 *
 * `aliases` maps a codex thread id to the card id the board is holding it
 * under — see db.js `codexAliases()`.
 */
export function scanCodexSessions({
  sinceDays = 7,
  interactiveOnly = true,
  includeSidechains = false,
  includeStubs = false,
  aliases = new Map(),
} = {}) {
  if (!existsSync(SESSIONS_DIR)) return [];

  /*
   * Keyed by thread rather than by file, because a resumed thread can leave more
   * than one rollout on disk and two cards for one conversation is worse than
   * losing the older half of it. The newest wins — it is the one `codex resume`
   * will continue.
   */
  const byThread = new Map();

  for (const { path, stat } of rolloutFiles({ sinceDays })) {
    let s;
    try {
      s = describe(path, stat, aliases);
    } catch {
      continue; // a rollout being written as we read it
    }
    if (!s) continue;
    if (interactiveOnly && s.entrypoint !== 'cli') continue;
    if (!includeSidechains && s.isSidechain) continue;
    if (!includeStubs && s.stub) continue;

    const seen = byThread.get(s.engineThread);
    if (!seen || seen.lastActivity < s.lastActivity) byThread.set(s.engineThread, s);
  }

  return [...byThread.values()];
}

/** Where one thread's rollout lives — the newest, if a resume made more than one. */
export function codexRolloutPath(threadId) {
  if (!threadId) return null;
  let best = null;
  for (const { path, stat } of rolloutFiles({ sinceDays: 0 })) {
    if (threadIdFromPath(path) !== threadId) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path, mtimeMs: stat.mtimeMs };
  }
  return best?.path ?? null;
}

/* ------------------------------------------------------------ adoption --- */

/** Thread ids already spoken for, so two sessions started at once can't collide. */
const claimed = new Set();

export function claimThread(threadId) {
  if (threadId) claimed.add(threadId);
}

/**
 * Find the thread a session we just started belongs to.
 *
 * Codex has no `--session-id`: it names its own thread, writes the rollout, and
 * never tells the process that spawned it which one it got. So the board starts
 * the session under an id of its own and then looks for the rollout that
 * appeared — same working directory, from the TUI, not a sub-agent's, and begun
 * no earlier than the moment we spawned.
 *
 * Everything about that is a guess except the parts that aren't: the cwd is
 * exact, the start time is bounded on both sides, and any thread already
 * attached to another card is skipped. Two codex sessions started in the same
 * folder in the same second could still be swapped, and the honest answer is
 * that this returns the earliest unclaimed match rather than pretending to
 * more certainty than the file gives.
 */
export function findNewThread({ cwd, sinceMs, knownThreads = new Set() }) {
  let best = null;

  for (const { path, stat } of rolloutFiles({ sinceDays: 2 })) {
    // A rollout that existed before we spawned cannot be ours.
    if (stat.mtimeMs < sinceMs - 5_000) continue;

    const threadId = threadIdFromPath(path);
    if (!threadId || claimed.has(threadId) || knownThreads.has(threadId)) continue;

    let meta;
    try {
      meta = parseRollout(path, { size: Math.min(stat.size, HEAD_BYTES) });
    } catch {
      continue;
    }
    if (meta.cwd !== cwd) continue;
    if (meta.isSidechain) continue;
    if (entrypointFor(meta.originator) !== 'cli') continue;

    const startedMs = meta.startedAt ? Date.parse(meta.startedAt) : stat.mtimeMs;
    if (Number.isNaN(startedMs) || startedMs < sinceMs - 5_000) continue;

    if (!best || startedMs < best.startedMs) best = { threadId, path, startedMs };
  }

  if (best) claimed.add(best.threadId);
  return best;
}

/* ---------------------------------------------------------- transcript --- */

/**
 * The rollout as a message list for the mirror pane — the same block vocabulary
 * the Claude reader produces, so the pane renders both without branching.
 */
export function readCodexTranscript(session, { limit = 120 } = {}) {
  const stat = statSync(session.path);
  const start = Math.max(0, stat.size - 2 * 1024 * 1024);
  const text = readChunk(session.path, start, stat.size - start);

  const messages = [];
  /** Tool calls wait for their turn's message so a reply reads as one block. */
  const push = (role, timestamp, blocks) => {
    if (!blocks.length) return;
    messages.push({ uuid: null, role, timestamp: timestamp || null, model: null, blocks });
  };

  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    const p = d?.payload;
    if (d?.type !== 'event_msg' || !p) continue;

    switch (p.type) {
      case 'user_message':
        if (p.message?.trim()) push('user', d.timestamp, [{ type: 'text', text: p.message.trim() }]);
        break;
      case 'agent_message':
        if (p.message?.trim()) {
          push('assistant', d.timestamp, [{ type: 'text', text: p.message.trim() }]);
        }
        break;
      case 'agent_reasoning':
        if (p.text?.trim()) push('assistant', d.timestamp, [{ type: 'thinking', text: p.text.trim() }]);
        break;
      case 'patch_apply_end': {
        const paths = p.changes && typeof p.changes === 'object' ? Object.keys(p.changes) : [];
        if (!paths.length) break;
        push('assistant', d.timestamp, [
          {
            type: 'tool_use',
            name: 'apply_patch',
            input: truncate(paths.join('\n'), 600),
            verb: p.success === false ? 'Failed to write' : 'Wrote',
            target: truncate(paths.map((x) => basename(x)).join(', '), 80),
          },
        ]);
        break;
      }
      case 'web_search_end':
        push('assistant', d.timestamp, [
          {
            type: 'tool_use',
            name: 'web_search',
            input: truncate(p.query || '', 600),
            verb: 'Looked up',
            target: truncate(p.query || 'the web', 80),
          },
        ]);
        break;
      case 'mcp_tool_call_end':
        push('assistant', d.timestamp, [
          {
            type: 'tool_use',
            name: p.invocation?.tool || 'mcp',
            input: truncate(JSON.stringify(p.invocation?.arguments ?? {}), 600),
            verb: 'Used',
            target: truncate(p.app_name || p.invocation?.server || 'a connected tool', 80),
          },
        ]);
        break;
      case 'item_completed': {
        const item = p.item;
        if (!item) break;
        if (item.type === 'UserMessage') {
          const t = textOf(item.content).trim();
          if (t) push('user', d.timestamp, [{ type: 'text', text: t }]);
        } else if (item.type === 'AgentMessage') {
          const t = textOf(item.content).trim();
          if (t) push('assistant', d.timestamp, [{ type: 'text', text: t }]);
        } else if (item.type === 'CommandExecution') {
          const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
          push('assistant', d.timestamp, [
            {
              type: 'tool_use',
              name: 'exec',
              input: truncate(cmd, 600),
              verb: 'Ran',
              // The shell wrapper is noise; what was run is the last argument.
              target: truncate(
                (Array.isArray(item.command) ? item.command[item.command.length - 1] : cmd) || 'a command',
                80
              ),
            },
          ]);
        }
        break;
      }
      default:
        break;
    }
  }

  return { session, messages: messages.slice(-limit), truncated: start > 0 };
}

/**
 * Files this thread wrote, from the rollout's own record.
 *
 * Only `apply_patch` is authoritative here — see the note at the top of the
 * file. sessions.js supplements this with the working-directory mtime sweep it
 * already runs for Claude sessions, which is what catches script output.
 */
export function codexWrittenFiles(session) {
  const stat = statSync(session.path);
  const start = Math.max(0, stat.size - 8 * 1024 * 1024);
  const text = readChunk(session.path, start, stat.size - start);

  const found = new Set();
  let firstTs = null;
  let lastTs = null;

  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    if (d?.timestamp) {
      const t = Date.parse(d.timestamp);
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t;
        if (lastTs === null || t > lastTs) lastTs = t;
      }
    }
    const p = d?.payload;
    if (!p) continue;
    if (d.type === 'event_msg' && p.type === 'patch_apply_end' && p.success !== false) {
      for (const path of Object.keys(p.changes ?? {})) if (path.startsWith('/')) found.add(path);
    } else if (d.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item;
      if (item?.type === 'FileChange' || item?.type === 'PatchApply') {
        for (const path of Object.keys(item.changes ?? {})) if (path.startsWith('/')) found.add(path);
      }
    } else if (d.type === 'response_item' && p.name === 'apply_patch') {
      for (const path of patchPaths(p.input)) found.add(path);
    }
  }

  return { paths: [...found], window: { from: firstTs, to: lastTs } };
}

/**
 * What a person actually typed, turn by turn — for label detection.
 *
 * Only the narration counts. The `response_item` user-role messages carry every
 * AGENTS.md file and every injected reminder, and reading those as prompts is
 * exactly how a label gets attached to a card that never mentioned it.
 */
export function codexUserTurns(path, { maxText = 60_000 } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }

  const parts = [];
  let budget = maxText;

  const take = (text, opts) => {
    for (const d of jsonLines(text, opts)) {
      if (budget <= 0) return;
      const p = d?.payload;
      if (d?.type !== 'event_msg' || !p) continue;
      let raw = '';
      if (p.type === 'user_message') raw = p.message || '';
      else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        raw = textOf(p.item.content);
      }
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      parts.push(clean.slice(0, budget));
      budget -= clean.length;
    }
  };

  take(readChunk(path, 0, Math.min(HEAD_BYTES, stat.size)));
  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    take(readChunk(path, start, stat.size - start), { dropFirst: start > 0 });
  }
  return parts;
}

/** Activity stamps and label writes for the time log. */
export function codexTimeline(path, { maxRead = 8 * 1024 * 1024 } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { stamps: [], labelWrites: new Map() };
  }
  const start = Math.max(0, stat.size - maxRead);
  const text = readChunk(path, start, stat.size - start);

  const stamps = [];
  const labelWrites = new Map();

  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    if (d?.timestamp) {
      const t = Date.parse(d.timestamp);
      if (!Number.isNaN(t)) stamps.push(t);
    }
    const p = d?.payload;
    if (!p) continue;
    const paths =
      d.type === 'event_msg' && p.type === 'patch_apply_end' && p.success !== false
        ? Object.keys(p.changes ?? {})
        : d.type === 'response_item' && p.name === 'apply_patch'
          ? patchPaths(p.input)
          : [];
    for (const path of paths) {
      const hit = labelFromPath(path);
      if (!hit) continue;
      const key = `${hit.label}|${hit.client}`;
      labelWrites.set(key, (labelWrites.get(key) || 0) + 1);
    }
  }

  stamps.sort((a, b) => a - b);
  return { stamps, labelWrites };
}

/** True for a path inside Codex's own session store. */
export function isCodexTranscript(path) {
  return Boolean(path && path.startsWith(SESSIONS_DIR + '/'));
}
