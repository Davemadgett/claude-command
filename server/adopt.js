/**
 * Attaching a Codex session to the card that started it.
 *
 * Claude Code needs none of this: the board hands it a session id and the
 * transcript appears under that name. Codex names its own thread, so a session
 * the board just started is, for a while, a running process the board cannot
 * identify. This closes that gap by watching for the rollout that appeared and
 * writing the thread id onto the card.
 *
 * FOR A WHILE, not for a moment. Codex writes nothing to ~/.codex/sessions when
 * it launches — not the header, not an empty file. The rollout appears when the
 * first message is actually sent, which is after the trust prompt on a new
 * folder, after the MCP servers finish starting, and after you have finished
 * deciding what to type. That can be seconds or it can be an hour, and a fixed
 * window would quietly give up on the slow case — leaving a card that works
 * perfectly until the day you try to reopen it.
 *
 * So the watch lives as long as the session does: it keeps looking while the
 * process is alive, backing off as the likely moment passes, and stops the
 * instant it finds the thread or the session ends. The cost of a look is a
 * readdir over a few date folders and a header read on anything new.
 *
 * When it never finds one — the session was closed without a word being said,
 * which produces no thread at all — nothing breaks and nothing lies. The card
 * keeps its own id and can be started fresh; what it cannot do is reopen a
 * conversation that was never recorded.
 */

import { findNewThread } from './codex.js';
import { knownCodexThreads, setEngineThread } from './db.js';
import { isLive } from './pty.js';

/**
 * How often to look, by how long we have been waiting. The first minute is when
 * a session that is going to say something usually says it; after that this is
 * just making sure a long-idle session is not stranded.
 */
function intervalFor(elapsedMs) {
  if (elapsedMs < 60_000) return 2_000;
  if (elapsedMs < 10 * 60_000) return 10_000;
  return 60_000;
}

/**
 * Stop watching a session that has outlived any reasonable answer. Only reached
 * by a session still running after this long without ever sending a message —
 * at which point it is a terminal somebody left open, not work in flight.
 */
const GIVE_UP_MS = 12 * 60 * 60_000;

const pending = new Map(); // sessionId -> timer

export function adoptCodexSession(sessionId, cwd, startedAtMs = Date.now()) {
  cancelAdoption(sessionId);

  const look = () => {
    const elapsed = Date.now() - startedAtMs;

    // The session ended without producing a thread, or it has been open far too
    // long to still be waiting on a first message.
    if (!isLive(sessionId) || elapsed > GIVE_UP_MS) {
      pending.delete(sessionId);
      return;
    }

    try {
      const found = findNewThread({ cwd, sinceMs: startedAtMs, knownThreads: knownCodexThreads() });
      if (found) {
        setEngineThread(sessionId, 'codex', found.threadId);
        pending.delete(sessionId);
        console.log(`codex: session ${sessionId} is thread ${found.threadId}`);
        return;
      }
    } catch (err) {
      console.error('codex adoption failed:', err.message);
    }

    schedule(elapsed);
  };

  const schedule = (elapsed) => {
    const timer = setTimeout(look, intervalFor(elapsed));
    timer.unref?.();
    pending.set(sessionId, timer);
  };

  schedule(0);
}

export function cancelAdoption(sessionId) {
  const timer = pending.get(sessionId);
  if (timer) clearTimeout(timer);
  pending.delete(sessionId);
}
