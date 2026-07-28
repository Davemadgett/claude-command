import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const MAX_BUFFER = 400 * 1024; // replayed to a client when it (re)attaches

/** sessionId -> Term */
const terms = new Map();

let claudeBin = null;

/**
 * The server may be started by launchd or a bare shell, neither of which has the
 * login PATH, so fall back to asking an interactive-login zsh where `claude` is.
 */
function resolveClaude() {
  if (claudeBin) return claudeBin;

  try {
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
    if (found && existsSync(found)) return (claudeBin = found);
  } catch {
    /* fall through to the well-known locations */
  }

  const candidates = [
    `${homedir()}/.local/bin/claude`,
    `${homedir()}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) if (existsSync(c)) return (claudeBin = c);

  throw new Error('Could not locate the `claude` executable on PATH');
}

/**
 * If the server itself was launched from inside a Claude Code session, its env
 * carries that session's markers. Inheriting them makes the child think it is a
 * nested agent — which, among other things, turns transcript saving OFF, so the
 * session would never produce the JSONL this board reads. Strip them so every
 * board-launched session is an ordinary top-level one. `CLAUDE_CONFIG_DIR` and
 * any other user-set config survive; only the internal markers are removed.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') {
      delete env[key];
    }
  }
  return env;
}

export function isLive(sessionId) {
  const t = terms.get(sessionId);
  return Boolean(t && !t.exited);
}

export function liveSessionIds() {
  return [...terms.entries()].filter(([, t]) => !t.exited).map(([id]) => id);
}

/**
 * Every running session with enough state to render a tile.
 *
 * Note `quietMs` is NOT a usable "is it working" signal: Claude Code's terminal
 * UI repaints continuously, so PTY output never actually stops. Whether a session
 * is working is decided from its transcript instead — see /api/live.
 */
export function liveTerms() {
  return [...terms.values()]
    .filter((t) => !t.exited)
    .map((t) => ({
      sessionId: t.sessionId,
      cwd: t.cwd,
      pid: t.pid,
      mode: t.mode,
      startedAt: t.startedAt,
      lastOutputAt: new Date(t.lastOutputAt).toISOString(),
      quietMs: Date.now() - t.lastOutputAt,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function getTerm(sessionId) {
  return terms.get(sessionId) || null;
}

/**
 * Start a board-owned Claude session.
 *   mode 'new'    — fresh conversation pinned to a session id we choose
 *   mode 'resume' — take over an existing transcript, keeping its id (and card)
 */
export function startTerm({ sessionId, cwd, mode = 'new', cols = 120, rows = 32, extraArgs = [] }) {
  const existing = terms.get(sessionId);
  if (existing && !existing.exited) return existing;

  const bin = resolveClaude();
  const workdir = cwd && existsSync(cwd) ? cwd : homedir();
  const args =
    mode === 'resume'
      ? ['--resume', sessionId, ...extraArgs]
      : ['--session-id', sessionId, ...extraArgs];

  const p = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: workdir,
    env: {
      ...cleanEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLAUDE_KANBAN: '1',
    },
  });

  const term = {
    sessionId,
    cwd: workdir,
    mode,
    pid: p.pid,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    lastOutputAt: Date.now(),
    cols,
    rows,
    buffer: '',
    clients: new Set(),
    pty: p,
  };

  p.onData((data) => {
    term.lastOutputAt = Date.now();
    term.buffer += data;
    if (term.buffer.length > MAX_BUFFER) {
      term.buffer = term.buffer.slice(term.buffer.length - MAX_BUFFER);
    }
    for (const ws of term.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'data', d: data }));
    }
  });

  p.onExit(({ exitCode }) => {
    term.exited = true;
    term.exitCode = exitCode;
    for (const ws of term.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
    }
  });

  terms.set(sessionId, term);
  return term;
}

export function attach(sessionId, ws) {
  const term = terms.get(sessionId);
  if (!term) return false;

  term.clients.add(ws);
  ws.send(JSON.stringify({ t: 'attached', sessionId, cols: term.cols, rows: term.rows, mode: term.mode }));
  if (term.buffer) ws.send(JSON.stringify({ t: 'data', d: term.buffer }));
  if (term.exited) ws.send(JSON.stringify({ t: 'exit', code: term.exitCode }));

  ws.on('close', () => term.clients.delete(ws));
  return true;
}

export function write(sessionId, data) {
  const term = terms.get(sessionId);
  if (term && !term.exited) term.pty.write(data);
}

export function resize(sessionId, cols, rows) {
  const term = terms.get(sessionId);
  if (!term || term.exited) return;
  // A resize to zero happens when a pane is hidden; it would wedge the child.
  if (!cols || !rows) return;
  term.cols = cols;
  term.rows = rows;
  try {
    term.pty.resize(cols, rows);
  } catch {
    /* the child may have exited between the check and the call */
  }
}

export function stopTerm(sessionId, signal = 'SIGHUP') {
  const term = terms.get(sessionId);
  if (!term || term.exited) return false;
  try {
    term.pty.kill(signal);
  } catch {
    return false;
  }
  return true;
}

export function shutdownAll() {
  for (const id of terms.keys()) stopTerm(id);
}
