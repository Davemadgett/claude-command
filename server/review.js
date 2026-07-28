import { db, listCards, reviewLanes, boardInboxes } from './db.js';
import { scanSessions } from './sessions.js';
import { isReactivated } from './resume.js';

// How long Claude has to stay quiet before its last turn counts as finished.
const IDLE_MS = 60_000;

// A question is different: nothing more is coming, and the session is sitting
// there waiting on you. Waiting a full minute to say so wastes the minute.
const ASK_IDLE_MS = 8_000;

// ...and how recently it has to have finished for the result to still be
// something you want to look at. Without this, the first sweep after a review
// lane is created sweeps in every dormant session in the column — which is
// exactly what happened the first time: 34 cards from weeks of history.
const RECENT_MS = 4 * 60 * 60_000;

/**
 * A session is "finished" when Claude spoke last and has since gone quiet. While
 * a turn is running the transcript is written continuously, and while a tool is
 * executing the last entry is a user tool_result — so neither looks finished.
 *
 * A session that ended on a question counts sooner: it is not going to produce
 * anything else until you answer, so the quiet is meaningful immediately.
 */
function isFinished(session, now) {
  if (session.lastEventType !== 'assistant') return false;
  if (session.userTurns < 1) return false;
  const last = Date.parse(session.lastActivity);
  if (Number.isNaN(last)) return false;
  const quiet = now - last;
  return quiet >= (session.awaitingAnswer ? ASK_IDLE_MS : IDLE_MS) && quiet <= RECENT_MS;
}

function moveToReview(sessionId, laneId, activity) {
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
    .get(laneId).p;
  db.prepare(
    `UPDATE cards
        SET column_id = ?, position = ?, auto_moved_activity = ?, updated_at = datetime('now')
      WHERE session_id = ?`
  ).run(laneId, max + 1000, activity, sessionId);
}

export function sweepFinishedSessions({ now = Date.now() } = {}) {
  // Two ways a column can send work back to you: a review lane attached to one
  // column, or a board inbox fed by every column to its left. Both are fetched
  // once for the whole sweep rather than queried per card.
  const lanes = reviewLanes();
  const inboxes = boardInboxes();
  if (!lanes.size && !inboxes.length) return [];

  const sessions = new Map(
    scanSessions({ sinceDays: 14, interactiveOnly: true }).map((s) => [s.sessionId, s])
  );

  const moved = [];
  for (const card of listCards()) {
    if (card.manual || card.archived) continue;

    const lane =
      lanes.get(card.column_id) ??
      inboxes.find((i) => i.feeders.has(card.column_id))?.inbox ??
      null;
    if (!lane) continue;

    const session = sessions.get(card.session_id);
    if (!session || !isFinished(session, now)) continue;

    // Reopening a session writes to its transcript; that is not work finishing.
    if (isReactivated(card.session_id)) continue;

    // Already moved for this turn: the card was dragged back out, and nothing
    // has happened in the session since. Leave it where it was put.
    if (card.auto_moved_activity && card.auto_moved_activity >= session.lastActivity) continue;

    moveToReview(card.session_id, lane, session.lastActivity);
    moved.push({
      sessionId: card.session_id,
      title: session.derivedTitle,
      lane,
      asking: Boolean(session.awaitingAnswer),
    });
  }
  return moved;
}

// Ten seconds, not the twenty it used to be: with questions now moving a card
// after eight seconds of quiet, a slower sweep would be the thing you waited on.
export function startReviewWatcher({ intervalMs = 10_000 } = {}) {
  const tick = () => {
    try {
      const moved = sweepFinishedSessions();
      for (const m of moved) {
        console.log(`review: "${m.title}" → ${m.lane}${m.asking ? ' (asking)' : ''}`);
      }
    } catch (err) {
      console.error('review sweep failed:', err.message);
    }
  };
  const id = setInterval(tick, intervalMs);
  id.unref?.();
  return () => clearInterval(id);
}
