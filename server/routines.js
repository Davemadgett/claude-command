import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import { listRoutines, updateRoutine, ensureCard } from './db.js';
import * as term from './pty.js';
import { currentEngine } from './engines.js';
import { adoptCodexSession } from './adopt.js';
import { dateKey } from './timelog.js';

/**
 * How long to wait before typing the routine's command into a fresh session.
 *
 * Claude Code is ready in a few seconds. Codex is not: it starts its MCP servers
 * before it will take input, and on a machine with several connectors that runs
 * to twenty seconds or more — measured, not guessed. Typing into it early does
 * not queue, it is dropped, and the routine then sits at an empty prompt all
 * morning looking like it ran.
 */
const BOOT_DELAY_MS = { claude: 4_500, codex: 30_000 };

/**
 * Run a routine by starting a visible session and typing its command into it.
 * Deliberately visible rather than headless: the run lands on the board as a card
 * you can watch, interrupt, and answer prompts in.
 *
 * A routine runs in whichever engine the board is set to, like everything else
 * that starts a session — a scheduled run is not a special case, and having one
 * quietly stay on Claude after the toggle moved would be the surprising answer.
 */
export function runRoutine(routine) {
  const cwd = routine.cwd && existsSync(routine.cwd) ? routine.cwd : homedir();
  const sessionId = randomUUID();
  const engine = currentEngine();

  const t = term.startTerm({ sessionId, cwd, mode: 'new', cols: 120, rows: 32, engine });
  ensureCard(sessionId, { title: routine.name, cwd, engine });
  if (engine === 'codex') adoptCodexSession(sessionId, t.cwd, Date.parse(t.startedAt));

  setTimeout(() => {
    if (!term.isLive(sessionId)) return;
    // The text and the Return separately: the composer can still be settling
    // when the first bytes land, and a command submitted before it has focus is
    // lost silently.
    term.write(sessionId, routine.command);
    setTimeout(() => {
      if (term.isLive(sessionId)) term.write(sessionId, '\r');
    }, 1_500);
  }, BOOT_DELAY_MS[engine] ?? BOOT_DELAY_MS.claude);

  updateRoutine(routine.id, {
    lastRunAt: new Date().toISOString(),
    lastSessionId: sessionId,
  });

  return { sessionId, cwd };
}

function ranToday(routine) {
  if (!routine.last_run_at) return false;
  return dateKey(Date.parse(routine.last_run_at)) === dateKey(Date.now());
}

export function isDue(routine, now = new Date()) {
  if (!routine.enabled) return false;
  if (ranToday(routine)) return false;

  const [h, m] = String(routine.time_of_day || '07:00').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;

  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  return now >= due;
}

/**
 * Fires due routines while the app is running. Nothing runs unless a routine was
 * explicitly enabled, and a missed day is not backfilled — it just runs once when
 * the app is next open past its time.
 */
export function startScheduler({ intervalMs = 60_000 } = {}) {
  const tick = () => {
    for (const routine of listRoutines()) {
      if (!isDue(routine)) continue;
      try {
        console.log(`routine "${routine.name}" is due — starting`);
        runRoutine(routine);
      } catch (err) {
        console.error(`routine "${routine.name}" failed:`, err.message);
      }
    }
  };
  const id = setInterval(tick, intervalMs);
  id.unref?.();
  return () => clearInterval(id);
}
