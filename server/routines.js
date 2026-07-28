import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import { listRoutines, updateRoutine, ensureCard } from './db.js';
import * as term from './pty.js';
import { dateKey } from './timelog.js';

// Claude Code needs a moment to boot before it will accept typed input.
const BOOT_DELAY_MS = 4500;

/**
 * Run a routine by starting a visible session and typing its command into it.
 * Deliberately visible rather than headless: the run lands on the board as a card
 * you can watch, interrupt, and answer prompts in.
 */
export function runRoutine(routine) {
  const cwd = routine.cwd && existsSync(routine.cwd) ? routine.cwd : homedir();
  const sessionId = randomUUID();

  term.startTerm({ sessionId, cwd, mode: 'new', cols: 120, rows: 32 });
  ensureCard(sessionId, { title: routine.name, cwd });

  setTimeout(() => {
    if (term.isLive(sessionId)) term.write(sessionId, `${routine.command}\r`);
  }, BOOT_DELAY_MS);

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
