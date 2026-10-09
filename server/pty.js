import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { DEFAULT_ENGINE, ENGINES, configuredBin, engine as engineFor } from './engines.js';

const MAX_BUFFER = 400 * 1024; // replayed to a client when it (re)attaches

/** sessionId -> Term */
const terms = new Map();

/** engine id -> absolute path, once found. */
const bins = new Map();

/**
 * Where an engine's command actually is.
 *
 * The server may be started by launchd, by the app bundle, or by a bare shell,
 * and none of those has the PATH a terminal does — so asking a login shell comes
 * first, and a list of well-known locations second.
 *
 * A shell *alias* is the case the login shell misses, and it is not exotic: the
 * ChatGPT desktop app ships the Codex CLI inside its bundle, and the usual way
 * people reach it is an `alias codex=…` line in .zshrc, which a non-interactive
 * shell never reads and a spawned process could not execute anyway. That bundle
 * path is in the candidate list for exactly that reason. Anything stranger is
 * what `engines.<id>.bin` in config.json is for.
 */
function resolveBin(engineId) {
  const hit = bins.get(engineId);
  if (hit) return hit;

  const spec = engineFor(engineId);
  const configured = configuredBin(spec.id);
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`config.json points ${spec.name} at ${configured}, which does not exist.`);
    }
    bins.set(spec.id, configured);
    return configured;
  }

  try {
    const found = execFileSync('/bin/zsh', ['-lc', `command -v ${spec.bin}`], {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
    // An alias resolves to its definition rather than a path; only a real
    // executable counts.
    if (found.startsWith('/') && existsSync(found)) {
      bins.set(spec.id, found);
      return found;
    }
  } catch {
    /* fall through to the well-known locations */
  }

  for (const c of spec.candidates) {
    if (existsSync(c)) {
      bins.set(spec.id, c);
      return c;
    }
  }

  throw new Error(
    `Could not find the \`${spec.bin}\` command. Install ${spec.name}, then run ` +
      `\`${spec.bin}\` once in a terminal to sign in.`
  );
}

/**
 * The same question, asked without consequences — for the setup check the UI
 * runs at startup. Being told up front beats a stack trace on the first click,
 * which is the only other way anyone finds out.
 */
export function engineStatus(engineId) {
  try {
    return { found: true, path: resolveBin(engineId) };
  } catch {
    return { found: false, path: null };
  }
}

/** Every engine, said the same way, for /api/config. */
export function enginesStatus() {
  return ENGINES.map((e) => ({ id: e.id, name: e.name, ...engineStatus(e.id) }));
}

export function claudeStatus() {
  return engineStatus(DEFAULT_ENGINE);
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
    // The same trap on the Codex side: a sandbox marker inherited from a parent
    // agent makes the child believe it is already inside one. `CODEX_HOME` is
    // config, not a marker, and survives.
    if (key.startsWith('CODEX_SANDBOX') || key === 'CODEX_THREAD_ID' || key === 'CODEX_SESSION_ID') {
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
      engine: t.engine,
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
 * Resident memory per pid, in bytes.
 *
 * Every open session is a real agent process holding a real conversation in
 * memory, and a board left running for a week accumulates dozens of them. The
 * wall says how many; without this it can't say what they cost, which is the
 * number that makes closing them an obvious thing to do.
 *
 * One `ps` for the whole set, and best-effort: a machine that answers oddly
 * loses the column, not the wall.
 */
export function rssByPid(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    const text = execFileSync('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: 5000,
      // A pid that died between listing and asking makes ps complain; that is a
      // missing memory figure, not something worth printing in the server log.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) out.set(Number(m[1]), Number(m[2]) * 1024); // ps reports KiB
    }
  } catch {
    /* no memory column this time */
  }
  return out;
}

/**
 * How an engine is told what conversation to be.
 *
 * Claude Code takes the id, so `new` pins the transcript to the id the board
 * chose and `resume` names the same one. Codex names its own thread and has no
 * equivalent flag, so `new` says nothing at all and `resume` needs the thread id
 * the board recorded after the fact — which is why `resumeId` is a parameter
 * rather than being assumed to equal the session id.
 */
function argsFor(engineId, { sessionId, mode, resumeId, extraArgs }) {
  if (engineId === 'codex') {
    return mode === 'resume' && resumeId ? ['resume', resumeId, ...extraArgs] : [...extraArgs];
  }
  return mode === 'resume'
    ? ['--resume', sessionId, ...extraArgs]
    : ['--session-id', sessionId, ...extraArgs];
}

/**
 * Start a board-owned session.
 *   mode 'new'    — a fresh conversation
 *   mode 'resume' — take over an existing one, keeping its card
 *
 * `resumeId` is what the engine calls the conversation, which is the session id
 * for Claude and the recorded codex thread for Codex. Callers that don't know
 * the difference can leave it out and get the session id.
 */
export function startTerm({
  sessionId,
  cwd,
  mode = 'new',
  cols = 120,
  rows = 32,
  extraArgs = [],
  engine = DEFAULT_ENGINE,
  resumeId = null,
}) {
  const existing = terms.get(sessionId);
  if (existing && !existing.exited) return existing;

  const spec = engineFor(engine);
  const bin = resolveBin(spec.id);
  const workdir = cwd && existsSync(cwd) ? cwd : homedir();
  const args = argsFor(spec.id, { sessionId, mode, resumeId: resumeId || sessionId, extraArgs });

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
    engine: spec.id,
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
  ws.send(
    JSON.stringify({
      t: 'attached',
      sessionId,
      cols: term.cols,
      rows: term.rows,
      mode: term.mode,
      engine: term.engine,
    })
  );
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
