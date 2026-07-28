/**
 * Reactivating a session is not the same as working on it.
 *
 * Resuming an old conversation makes Claude Code write to its transcript, which
 * would otherwise make a months-old session look like the most recent thing you
 * did — bumping it to the top of the recent list, and making the review sweep
 * think it had just finished something.
 *
 * So a resume takes a snapshot of where the session stood. Until you actually
 * enter a prompt — until its user-turn count goes up — the session keeps its
 * previous position and is reported as reactivated rather than active.
 */

/** sessionId -> { userTurns, lastActivity, resumedAt } */
const snapshots = new Map();

export function noteResume(sessionId, { userTurns = 0, lastActivity = null } = {}) {
  snapshots.set(sessionId, {
    userTurns,
    lastActivity,
    resumedAt: new Date().toISOString(),
  });
}

export function clearResume(sessionId) {
  snapshots.delete(sessionId);
}

/**
 * The activity timestamp a session should be judged by, and whether it is merely
 * reactivated. Once a prompt has been entered the snapshot is dropped and the
 * session behaves normally from then on.
 */
export function effectiveActivity(session) {
  const snap = snapshots.get(session.sessionId);
  if (!snap) return { lastActivity: session.lastActivity, reactivated: false };

  if (session.userTurns > snap.userTurns) {
    snapshots.delete(session.sessionId);
    return { lastActivity: session.lastActivity, reactivated: false };
  }

  return {
    lastActivity: snap.lastActivity || session.lastActivity,
    reactivated: true,
  };
}

export function isReactivated(sessionId) {
  return snapshots.has(sessionId);
}
