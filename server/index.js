import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listColumns, listCards, ensureCard, moveCard, updateCard,
  createManualCard, deleteCard, getCard, attachSession,
  archiveCard, restoreCard, listArchivedCards,
  setPriority, setCardLabel, dismissCardLabel, PRIORITIES,
  createColumn, updateColumn, deleteColumn, reorderColumns,
  listBoards, defaultBoardId, createBoard, renameBoard, deleteBoard, moveCardToBoard,
  listRoutines, createRoutine, updateRoutine, deleteRoutine,
  createReviewLane, removeReviewLane,
  getSetting, setSetting,
} from './db.js';
import { listSkills } from './skills.js';
import { listAgents } from './agents.js';
import { buildTimeLog } from './timelog.js';
import { runRoutine, isDue, startScheduler } from './routines.js';
import { startReviewWatcher } from './review.js';
import { noteResume, clearResume, effectiveActivity } from './resume.js';
import { isCaffeinated, setCaffeinate } from './caffeinate.js';
import {
  labelUrl, refreshLabels, labelsStatus, isKnownLabel, knownLabelKeys, labelFolder,
} from './providers/index.js';
import { startLabelWatcher, detectForSession, invalidateIndexes } from './labeldetect.js';
import { resolveDir, listDirs, places, labelChoices, prettyPath } from './paths.js';
import {
  listEvents, nextEventForLabel, eventsForLabel, calendarStatus, requestCalendarAccess,
} from './calendar.js';
import { scanSessions, findSession, readTranscript, readSessionFiles, labelFromPath } from './sessions.js';
import * as term from './pty.js';
import { listBriefs, readBrief, reportsEnabled } from './brief.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = config.port;

const app = express();

// Opt-in request log — the app bundle discards server output, so this is the way
// to see what a window is actually asking for. SB_REQLOG=/path/to/log
if (process.env.SB_REQLOG) {
  app.use((req, _res, next) => {
    appendFileSync(process.env.SB_REQLOG, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
    next();
  });
}

app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/* ---------------------------------------------------------------- board --- */

/**
 * Which label a card shows, when the transcript and the card disagree.
 *
 * A label you set or confirmed by hand always wins — you had the whole picture.
 * Below that, a session running inside a label folder beats a file number
 * recognised in the text, because where you chose to work is stronger evidence
 * than what you mentioned. A detected number still beats the weakest source,
 * which is the folders the session happened to write files into.
 */
function attachedLabel(session, row) {
  const derived = { label: session.label, client: session.client, source: session.labelSource };
  if (!row.label) return derived;

  const manual = row.label_source === 'manual';
  // Anything the session did itself — where it ran, the label folders it wrote
  // into — outranks a number read out of a sentence. Only your own answer
  // outranks the session.
  if (!manual && derived.label && derived.source !== 'prompt') return derived;

  return {
    label: row.label,
    // The client's own name is only known when a folder or transcript produced
    // the label; a number typed into a prompt carries no client with it.
    client: row.label === derived.label ? derived.client : null,
    source: manual ? 'manual' : 'prompt',
  };
}

/**
 * Turn what you typed into a real label number. "1953", "01953" and
 * "01953-Acme" all name the same file; anything that matches nothing is
 * rejected rather than guessed at.
 */
function resolveLabelKey(raw) {
  if (isKnownLabel(raw) || labelFolder(raw)) {
    return isKnownLabel(raw) ? raw : labelFolder(raw).split('/').pop();
  }

  const digits = raw.match(/\d{1,6}/)?.[0];
  if (!digits) return null;
  const padded = digits.padStart(5, '0');

  const folder = labelFolder(padded);
  if (folder) return folder.split('/').pop();

  return knownLabelKeys().find((n) => n.split('-')[0] === padded) ?? null;
}

function buildBoard(query = {}) {
  const prefs = {
    sinceDays: Number(query.sinceDays ?? getSetting('sinceDays', 7)),
    interactiveOnly: query.interactiveOnly !== undefined
      ? query.interactiveOnly === 'true'
      : getSetting('interactiveOnly', true),
    includeArchived: query.includeArchived === 'true',
  };

  const boards = listBoards();
  const boardId = boards.some((b) => b.id === query.boardId) ? query.boardId : defaultBoardId();
  const columns = listColumns(boardId);
  const inBoard = new Set(columns.map((c) => c.id));

  const sessions = scanSessions({
    sinceDays: prefs.sinceDays,
    interactiveOnly: prefs.interactiveOnly,
  });
  const live = new Set(term.liveSessionIds());

  // A board-launched session has a card before its transcript exists, so union
  // the discovered sessions with any card rows we already hold.
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const rows = new Map(listCards().map((c) => [c.session_id, c]));

  // Cards typed in by hand have no transcript to describe them.
  for (const row of rows.values()) {
    if (!row.manual || byId.has(row.session_id)) continue;
    // A card made from a calendar event is filed in its label folder, which is
    // what ties it back to that label — and to the event that created it.
    const hit = labelFromPath(row.cwd);
    byId.set(row.session_id, {
      sessionId: row.session_id,
      path: null,
      project: hit?.label || (row.cwd ? row.cwd.split('/').pop() : '—'),
      cwd: row.cwd,
      entrypoint: 'manual',
      label: hit?.label ?? null,
      client: hit?.client ?? null,
      derivedTitle: row.title || 'Untitled card',
      lastPrompt: '',
      lastAssistant: row.notes || '',
      userTurns: 0,
      lastActivity: row.updated_at ? `${row.updated_at.replace(' ', 'T')}Z` : new Date().toISOString(),
      manual: true,
    });
  }

  /**
   * Cards whose session fell outside the discovery window still need describing.
   * Only the ones that will actually be rendered are worth the trouble: an
   * archived card, or one belonging to another board, is discarded a few lines
   * below, and looking it up first meant a full sweep of every transcript on disk
   * for a result thrown straight away.
   */
  const needsLookup = [...new Set([...rows.keys(), ...live])].filter((id) => {
    if (byId.has(id)) return false;
    const row = rows.get(id);
    if (!row) return true; // live but unknown — always describe it
    if (row.archived && !prefs.includeArchived) return false;
    return inBoard.has(row.column_id);
  });

  // One sweep for all of them, rather than one sweep each.
  const older = needsLookup.length
    ? new Map(
        scanSessions({ sinceDays: 0, interactiveOnly: false, includeSidechains: true })
          .map((s) => [s.sessionId, s])
      )
    : new Map();

  for (const id of needsLookup) {
    const found = older.get(id);
    if (found) {
      byId.set(id, found);
      continue;
    }
    // No transcript yet — a board-launched session that hasn't written one.
    const t = term.getTerm(id);
    // …or no transcript at all: a stub the sweep now filters out, or one whose
    // transcript is gone. With no terminal behind it there is nothing to show
    // or resume, so it renders as a "New session" ghost. Leave it off the board.
    if (!t && !live.has(id) && !rows.get(id)?.manual) continue;
    byId.set(id, {
      sessionId: id,
      path: null,
      project: t?.cwd ? t.cwd.split('/').pop() : '—',
      cwd: t?.cwd || rows.get(id)?.cwd || null,
      entrypoint: 'cli',
      label: null,
      derivedTitle: rows.get(id)?.title || 'New session',
      lastPrompt: '',
      lastAssistant: '',
      userTurns: 0,
      lastActivity: t?.startedAt || new Date().toISOString(),
      pending: true,
    });
  }

  const cards = [];
  for (const s of byId.values()) {
    const row = rows.get(s.sessionId) || ensureCard(s.sessionId, { cwd: s.cwd });
    if (!row) continue;
    if (row.archived && !prefs.includeArchived) continue;
    if (!inBoard.has(row.column_id)) continue; // lives on another board

    const t = term.getTerm(s.sessionId);
    const eff = effectiveActivity(s);
    const attached = attachedLabel(s, row);
    cards.push({
      ...s,
      label: attached.label,
      client: attached.client,
      labelSource: attached.source,
      labelSuggested: row.label_suggested || null,
      priority: row.priority || null,
      lastActivity: eff.lastActivity,
      reactivated: eff.reactivated,
      // No transcript file means there is no conversation to resume yet.
      hasTranscript: Boolean(s.path),
      columnId: row.column_id,
      position: row.position,
      title: row.title || s.derivedTitle,
      customTitle: Boolean(row.title),
      notes: row.notes || '',
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      manual: Boolean(row.manual),
      live: live.has(s.sessionId),
      pid: t && !t.exited ? t.pid : null,
      exitCode: t?.exited ? t.exitCode : null,
    });
  }

  // Recomputed after the fact so the Clio link and folder follow the label the
  // card actually ended up with, not the one the transcript alone implied.
  for (const card of cards) {
    card.labelUrl = labelUrl(card.label);
    card.labelFolder = labelFolder(card.label);
    card.nextEvent = nextEventForLabel(card.label);
  }

  cards.sort((a, b) => a.position - b.position);
  return { boards, boardId, columns, cards, prefs, caffeinated: isCaffeinated() };
}

app.get('/api/board', wrap((req, res) => res.json(buildBoard(req.query))));

/**
 * Running sessions, for the live wall. Kept separate from the board so the wall
 * can poll quickly without reassembling columns and cards each time.
 */
app.get('/api/live', wrap((_req, res) => {
  const rows = new Map(listCards().map((c) => [c.session_id, c]));
  const now = Date.now();

  const live = term.liveTerms().map((t) => {
    const known = findSession(t.sessionId);
    const row = rows.get(t.sessionId);
    const label = known?.label ?? labelFromPath(t.cwd)?.label ?? null;

    /*
     * Working or waiting, decided from the transcript rather than the terminal.
     * The TUI repaints constantly, so PTY silence never happens; the transcript
     * only grows when something real occurs. Claude owes you a reply unless it
     * spoke last and has since gone quiet.
     */
    const lastActivity = known?.lastActivity ? Date.parse(known.lastActivity) : null;
    const idleMs = lastActivity ? now - lastActivity : now - Date.parse(t.startedAt);

    // A session with no transcript has never been given anything to do: it is
    // booting for the first few seconds, and sitting at its prompt after that.
    // When Claude owes a reply it is working — but not indefinitely: a session
    // interrupted mid-turn would otherwise claim to be working forever.
    const owesReply = known && known.lastEventType !== 'assistant';
    const working = known
      ? (owesReply ? idleMs < 5 * 60_000 : idleMs < 10_000)
      : idleMs < 20_000;

    return {
      ...t,
      title: row?.title || known?.derivedTitle || 'New session',
      label,
      labelUrl: labelUrl(label),
      project: known?.project ?? (t.cwd ? t.cwd.split('/').pop() : '—'),
      working,
      idleMs,
      reactivated: known ? effectiveActivity(known).reactivated : false,
    };
  });

  res.json({ sessions: live });
}));

/** Sessions newest-first, whatever board or column they ended up in. */
app.get('/api/recent', wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit || 40), 200);
  const sinceDays = Number(req.query.sinceDays || 30);

  const columns = new Map(listColumns().map((c) => [c.id, c]));
  const boards = new Map(listBoards().map((b) => [b.id, b]));
  const rows = new Map(listCards().map((c) => [c.session_id, c]));
  const liveIds = new Set(term.liveSessionIds());

  const sessions = scanSessions({ sinceDays, interactiveOnly: true })
    .map((s) => {
      const row = rows.get(s.sessionId);
      const column = row ? columns.get(row.column_id) : null;
      const eff = effectiveActivity(s);
      return {
        sessionId: s.sessionId,
        title: row?.title || s.derivedTitle,
        label: s.label,
        labelUrl: labelUrl(s.label),
        labelFolder: labelFolder(s.label),
        project: s.project,
        cwd: s.cwd,
        userTurns: s.userTurns,
        lastActivity: eff.lastActivity,
        reactivated: eff.reactivated,
        live: liveIds.has(s.sessionId),
        archived: Boolean(row?.archived),
        columnName: column?.name ?? null,
        boardName: column ? boards.get(column.board_id)?.name ?? null : null,
      };
    });

  // Re-sorted after the fact: a reactivated session keeps its old position.
  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  res.json({ sessions: sessions.slice(0, limit) });
}));

/** Upcoming events, each tied to a label where one can be identified. */
app.get('/api/calendar', wrap((req, res) => {
  const days = Number(req.query.days || 21);
  const { events, error, denied } = listEvents({ days });
  const enriched = events.map((e) => ({
    ...e,
    labelUrl: labelUrl(e.label),
    labelFolder: labelFolder(e.label),
  }));
  res.json({ events: enriched, error, denied: Boolean(denied), status: calendarStatus() });
}));

/** Clear a recorded denial so the next read prompts again. */
app.post('/api/calendar/permission', wrap((_req, res) => res.json(requestCalendarAccess())));

app.get('/api/calendar/label/:label', wrap((req, res) =>
  res.json({ events: eventsForLabel(req.params.label) })
));

/**
 * What the UI needs to describe itself: what this install calls things, and
 * which optional panels have anything behind them. Sent once at startup so a
 * board with no label index never renders a chip it cannot fill.
 */
app.get('/api/config', wrap((_req, res) =>
  res.json({
    appName: config.appName,
    labels: {
      enabled: config.labels.index !== 'none',
      noun: config.labels.noun,
    },
    reports: { enabled: reportsEnabled(), label: config.reports.label },
  })
));

app.get('/api/labels', wrap((_req, res) => res.json(labelsStatus())));

app.post('/api/labels/refresh', wrap((_req, res) => {
  refreshLabels({ force: true });
  invalidateIndexes();
  res.json({ ok: true });
}));

/** Keep the display awake while long work runs. */
app.get('/api/caffeinate', wrap((_req, res) => res.json({ enabled: isCaffeinated() })));

app.post('/api/caffeinate', wrap((req, res) => {
  const enabled = setCaffeinate(Boolean(req.body?.enabled));
  res.json({ enabled });
}));

app.get('/api/prefs', wrap((_req, res) =>
  res.json({
    sinceDays: getSetting('sinceDays', 7),
    interactiveOnly: getSetting('interactiveOnly', true),
    briefOpen: getSetting('briefOpen', false),
  })
));

app.put('/api/prefs', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v);
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- boards --- */

app.post('/api/boards', wrap((req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) throw new Error('Board name is required');
  res.json(createBoard(name));
}));

app.patch('/api/boards/:id', wrap((req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) throw new Error('Board name is required');
  renameBoard(req.params.id, name);
  res.json({ ok: true });
}));

app.delete('/api/boards/:id', wrap((req, res) => {
  res.json({ movedTo: deleteBoard(req.params.id) });
}));

/* -------------------------------------------------------------- columns --- */

app.post('/api/columns', wrap((req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) throw new Error('Column name is required');
  res.json(
    createColumn({
      name,
      color: req.body.color,
      wipLimit: req.body.wipLimit ?? null,
      boardId: req.body.boardId ?? null,
    })
  );
}));

app.patch('/api/columns/:id', wrap((req, res) => {
  updateColumn(req.params.id, req.body || {});
  res.json({ ok: true });
}));

/** Turn a column's review lane on or off. */
app.post('/api/columns/:id/review-lane', wrap((req, res) => {
  if (req.body?.enabled === false) {
    removeReviewLane(req.params.id);
    return res.json({ laneId: null });
  }
  res.json({ laneId: createReviewLane(req.params.id) });
}));

app.delete('/api/columns/:id', wrap((req, res) => {
  res.json({ movedTo: deleteColumn(req.params.id) });
}));

app.post('/api/columns/reorder', wrap((req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) throw new Error('ids array is required');
  reorderColumns(ids);
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- cards --- */

/* -------------------------------------------------------------- archive --- */

/**
 * Everything that has been closed, newest first, searchable across title, notes,
 * label and folder. Enriched from one full transcript scan rather than a lookup
 * per card, since archived work is often older than the board's window.
 */
app.get('/api/archive', wrap((req, res) => {
  const rows = listArchivedCards();
  const sessions = new Map(
    scanSessions({ sinceDays: 0, interactiveOnly: false, includeSidechains: true })
      .map((s) => [s.sessionId, s])
  );

  const columns = new Map(listColumns().map((c) => [c.id, c]));
  const boards = new Map(listBoards().map((b) => [b.id, b]));

  const q = String(req.query.q || '').trim().toLowerCase();

  const items = rows.map((row) => {
    const s = sessions.get(row.session_id) || null;
    const column = columns.get(row.column_id) || null;
    const board = column ? boards.get(column.board_id) : null;

    // The card's own label first: a closed card should still show the label you
    // attached to it, which the transcript alone may never have named.
    const label = s ? attachedLabel(s, row).label : row.label ?? null;

    return {
      sessionId: row.session_id,
      title: row.title || s?.derivedTitle || 'Untitled card',
      notes: row.notes || '',
      manual: Boolean(row.manual),
      label,
      labelUrl: labelUrl(label),
      labelFolder: labelFolder(label),
      project: s?.project ?? null,
      cwd: row.cwd || s?.cwd || null,
      lastActivity: s?.lastActivity ?? null,
      userTurns: s?.userTurns ?? 0,
      hasTranscript: Boolean(s),
      archivedAt: row.archived_at || row.updated_at,
      // Where it will go back to, so "restore" is never a surprise.
      columnName: column?.name ?? null,
      boardName: board?.name ?? null,
      columnMissing: !column,
    };
  });

  const filtered = q
    ? items.filter((i) =>
        [i.title, i.notes, i.label, i.project, i.cwd, i.boardName, i.columnName]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q))
      )
    : items;

  res.json({ items: filtered, total: items.length });
}));

app.post('/api/cards/:sessionId/restore', wrap((req, res) => {
  res.json({ columnId: restoreCard(req.params.sessionId) });
}));

/**
 * Turn a calendar event into work: a card on the board, and optionally a live
 * session already sitting in that label's folder. The column is resolved here
 * so the caller doesn't have to know the board's shape.
 */
app.post('/api/cards/from-event', wrap((req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) throw new Error('The event needs a title');

  const columnId =
    (req.body?.columnId && listColumns().find((c) => c.id === req.body.columnId)?.id) ||
    listColumns(defaultBoardId()).find((c) => !c.review_of)?.id;
  if (!columnId) throw new Error('There is no column to put this card in');

  // Prefer the label's own folder so a session starts where the work lives.
  const folder = req.body?.label ? labelFolder(req.body.label) : null;
  const cwd = folder && existsSync(folder) ? folder : homedir();

  const card = createManualCard({
    columnId,
    title,
    notes: (req.body?.notes || '').trim() || null,
    cwd,
  });

  if (!req.body?.startSession) {
    return res.json({ sessionId: card.session_id, started: false, cwd });
  }

  const sessionId = randomUUID();
  const t = term.startTerm({ sessionId, cwd, mode: 'new', cols: 120, rows: 32 });
  attachSession(card.session_id, sessionId);
  updateCard(sessionId, { cwd });
  scheduleDetect(sessionId);
  res.json({ sessionId, started: true, pid: t.pid, cwd: t.cwd });
}));

/** Create a card by hand — a piece of work that has no session yet. */
app.post('/api/cards', wrap((req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) throw new Error('A card needs a title');
  res.json(
    createManualCard({
      columnId: req.body?.columnId,
      title,
      notes: (req.body?.notes || '').trim() || null,
      cwd: req.body?.cwd || null,
    })
  );
}));

app.post('/api/cards/:sessionId/archive', wrap((req, res) => {
  archiveCard(req.params.sessionId);
  res.json({ ok: true });
}));

/** Permanent. The UI only offers this from inside the archive. */
app.delete('/api/cards/:sessionId', wrap((req, res) => {
  deleteCard(req.params.sessionId);
  res.json({ ok: true });
}));

/** Start a session for a hand-written card, keeping the card you already placed. */
app.post('/api/cards/:sessionId/session', wrap((req, res) => {
  const card = getCard(req.params.sessionId);
  if (!card) throw new Error('No such card');
  if (!card.manual) throw new Error('That card already has a session');

  const cwd = req.body?.cwd ? resolveDir(req.body.cwd) : card.cwd || homedir();

  const sessionId = randomUUID();
  const t = term.startTerm({ sessionId, cwd, mode: 'new', cols: 120, rows: 32 });
  attachSession(card.session_id, sessionId);
  updateCard(sessionId, { cwd });
  scheduleDetect(sessionId);

  res.json({ sessionId, pid: t.pid, cwd: t.cwd });
}));

/**
 * How urgent this card is. Anything that isn't one of the three levels clears it,
 * so "None" and a stale value both land in the same place.
 */
app.post('/api/cards/:sessionId/priority', wrap((req, res) => {
  const wanted = req.body?.priority ?? null;
  if (wanted && !PRIORITIES.includes(wanted)) {
    throw new Error(`Priority must be one of ${PRIORITIES.join(', ')}`);
  }
  res.json({ priority: setPriority(req.params.sessionId, wanted) });
}));

/**
 * Attach a label by hand, or confirm the one the board guessed. Checked against
 * Clio and the folder index so a typo becomes an error rather than a card
 * labelled with a label that doesn't exist.
 */
app.post('/api/cards/:sessionId/label', wrap((req, res) => {
  const raw = String(req.body?.label ?? '').trim();
  if (!raw) {
    setCardLabel(req.params.sessionId, null);
    return res.json({ label: null });
  }

  const label = resolveLabelKey(raw);
  if (!label) throw new Error(`No label matches “${raw}”`);
  setCardLabel(req.params.sessionId, label, 'manual');
  res.json({ label });
}));

/** No — and remembered, so the same guess is not offered again. */
app.post('/api/cards/:sessionId/label/dismiss', wrap((req, res) => {
  dismissCardLabel(req.params.sessionId);
  res.json({ ok: true });
}));

app.patch('/api/cards/:sessionId', wrap((req, res) => {
  const { columnId, position, boardId, ...rest } = req.body || {};
  if (boardId !== undefined) moveCardToBoard(req.params.sessionId, boardId);
  if (columnId !== undefined && position !== undefined) {
    moveCard(req.params.sessionId, columnId, position);
  }
  if (Object.keys(rest).length) updateCard(req.params.sessionId, rest);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- sessions --- */

/**
 * Watch a newly started session for the sentence that names its label.
 *
 * Nothing exists to read at the moment it starts — Claude Code writes no
 * transcript until the first message — so this looks again a few times over the
 * first couple of minutes, which is when you say what the session is for. The
 * background sweep catches anything later; these are only for the common case
 * where a card should be labelled while you are still looking at it.
 */
function scheduleDetect(sessionId) {
  for (const delay of [15_000, 45_000, 120_000]) {
    const id = setTimeout(() => {
      try {
        detectForSession(sessionId);
      } catch (err) {
        console.error('label detect failed:', err.message);
      }
    }, delay);
    id.unref?.();
  }
}

app.get('/api/sessions/:id/transcript', wrap((req, res) => {
  const data = readTranscript(req.params.id, { limit: Number(req.query.limit || 120) });
  if (!data) return res.status(404).json({ error: 'No transcript for that session yet' });
  res.json(data);
}));

app.get('/api/sessions/:id/files', wrap((req, res) => {
  const data = readSessionFiles(req.params.id);
  if (!data) return res.status(404).json({ error: 'No transcript for that session yet' });
  res.json(data);
}));

/** Hand a file to the Finder. Confined to the user's own files. */
app.post('/api/open', wrap((req, res) => {
  const target = String(req.body?.path || '');
  const allowed = [homedir(), '/private/tmp', '/tmp', '/Volumes'];
  const resolved = resolve(target);
  if (!allowed.some((root) => resolved === root || resolved.startsWith(root + '/'))) {
    throw new Error('Refusing to open a path outside your home directory');
  }
  if (!existsSync(resolved)) throw new Error('That file no longer exists');

  const args = req.body?.reveal ? ['-R', resolved] : [resolved];
  execFile('/usr/bin/open', args, (err) => {
    if (err) console.error('open failed:', err.message);
  });
  res.json({ ok: true });
}));

/** Take over an existing transcript: same session id, so the card follows it. */
app.post('/api/sessions/:id/start', wrap((req, res) => {
  const sessionId = req.params.id;
  const known = findSession(sessionId);
  // Through resolveDir so a `~` path isn't quietly discarded — startTerm falls
  // back to the home directory for anything it can't stat, which would start the
  // session in the wrong place without saying so.
  const cwd = req.body?.cwd ? resolveDir(req.body.cwd) : known?.cwd || homedir();

  /**
   * A card can exist before its conversation does — one started from the board
   * and never typed into, or made from a calendar event — because Claude Code
   * writes no transcript until the first message. `--resume` then has nothing to
   * resume and fails outright. Starting fresh under the same session id is the
   * right answer, and the card follows it either way, so the server decides
   * rather than trusting the caller to have guessed.
   */
  const wanted = req.body?.mode === 'new' ? 'new' : 'resume';
  const mode = wanted === 'resume' && known?.path ? 'resume' : 'new';

  if (mode === 'resume') {
    // Remember where it stood, so merely reopening it doesn't read as new work.
    noteResume(sessionId, {
      userTurns: known?.userTurns ?? 0,
      lastActivity: known?.lastActivity ?? null,
    });
  } else {
    clearResume(sessionId);
  }

  const t = term.startTerm({
    sessionId,
    cwd,
    mode,
    cols: Number(req.body?.cols || 120),
    rows: Number(req.body?.rows || 32),
  });
  ensureCard(sessionId, { cwd });
  scheduleDetect(sessionId);
  res.json({ sessionId, pid: t.pid, mode: t.mode, cwd: t.cwd });
}));

app.post('/api/sessions/:id/stop', wrap((req, res) => {
  res.json({ stopped: term.stopTerm(req.params.id) });
}));

/** Launch a brand-new session the board owns end to end. */
app.post('/api/sessions', wrap((req, res) => {
  // Forgiving on purpose: `downloads`, `~/Desktop`, a dragged file:// URL and a
  // bare label number all name a real folder, and refusing them teaches nobody
  // anything. resolveDir explains itself if there is genuinely no such folder.
  const cwd = resolveDir(req.body?.cwd);

  const sessionId = randomUUID();
  const title = (req.body?.title || '').trim() || null;

  const t = term.startTerm({
    sessionId,
    cwd,
    mode: 'new',
    cols: Number(req.body?.cols || 120),
    rows: Number(req.body?.rows || 32),
  });
  ensureCard(sessionId, { columnId: req.body?.columnId, title, cwd });
  scheduleDetect(sessionId);
  res.json({ sessionId, pid: t.pid, cwd: t.cwd });
}));

/** Directory suggestions for the new-session dialog, most recently used first. */
app.get('/api/cwds', wrap((_req, res) => {
  const seen = new Map();
  for (const s of scanSessions({ sinceDays: 90, interactiveOnly: true })) {
    if (s.cwd && !seen.has(s.cwd)) {
      seen.set(s.cwd, { cwd: s.cwd, label: s.label, display: s.project, lastActivity: s.lastActivity });
    }
  }
  res.json([...seen.values()].slice(0, 40));
}));

/* ------------------------------------------------------- folder picking --- */

/** One level of subfolders, plus the Finder-style shortcuts, for Browse…. */
app.get('/api/browse', wrap((req, res) => {
  res.json({ ...listDirs(req.query.path || '~'), places: places() });
}));

/** Every label folder on disk — the picker filters these client-side. */
app.get('/api/label-folders', wrap((_req, res) => res.json(labelChoices())));

/** What a typed path actually resolves to, so the dialog can confirm it early. */
app.get('/api/resolve-dir', wrap((req, res) => {
  try {
    const path = resolveDir(req.query.path);
    res.json({ ok: true, path, display: prettyPath(path), label: labelFromPath(path)?.label ?? null });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

/** Every column on every board, so a new session can start on any of them. */
app.get('/api/columns', wrap((_req, res) => {
  // Grouped by board, in tab order — listColumns() orders by position alone,
  // which interleaves the boards and would scramble the picker's groups.
  const boards = listBoards();
  const out = [];
  for (const b of boards) {
    for (const c of listColumns(b.id)) {
      // Review lanes are where work lands, not where it starts.
      if (c.review_of) continue;
      out.push({ id: c.id, name: c.name, boardId: b.id, boardName: b.name });
    }
  }
  res.json(out);
}));

/* --------------------------------------------------- skills & routines --- */

app.get('/api/skills', wrap((_req, res) => res.json(listSkills())));

app.get('/api/agents', wrap((_req, res) => res.json(listAgents())));

app.get('/api/timelog', wrap((req, res) =>
  res.json(
    buildTimeLog({
      sinceDays: Number(req.query.sinceDays || 14),
      idleMinutes: Number(req.query.idleMinutes || 10),
    })
  )
));

app.get('/api/routines', wrap((_req, res) =>
  res.json(listRoutines().map((r) => ({ ...r, enabled: Boolean(r.enabled), due: isDue(r) })))
));

app.post('/api/routines', wrap((req, res) => {
  const name = (req.body?.name || '').trim();
  const command = (req.body?.command || '').trim();
  if (!name || !command) throw new Error('Name and command are both required');
  res.json(createRoutine({ name, command, cwd: req.body.cwd || null, timeOfDay: req.body.timeOfDay }));
}));

app.patch('/api/routines/:id', wrap((req, res) => {
  updateRoutine(req.params.id, req.body || {});
  res.json({ ok: true });
}));

app.delete('/api/routines/:id', wrap((req, res) => {
  deleteRoutine(req.params.id);
  res.json({ ok: true });
}));

/** Run now: opens a real session on the board and types the command into it. */
app.post('/api/routines/:id/run', wrap((req, res) => {
  const routine = listRoutines().find((r) => r.id === req.params.id);
  if (!routine) throw new Error('No such routine');
  res.json(runRoutine(routine));
}));

/** Start a session and invoke a skill in it. */
app.post('/api/skills/run', wrap((req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!/^\/[\w-]+$/.test(command)) throw new Error('That does not look like a slash command');
  const cwd = req.body?.cwd ? resolveDir(req.body.cwd) : homedir();
  res.json(runRoutine({ id: `adhoc_${command.slice(1)}`, name: command, command, cwd }));
}));

/* --------------------------------------------------------------- briefs --- */

app.get('/api/briefs', wrap((_req, res) => res.json(listBriefs())));

app.get('/api/brief', wrap((req, res) => {
  const brief = readBrief(req.query.date);
  if (!brief) return res.status(404).json({ error: 'No morning brief found' });
  res.json(brief);
}));

/** Served standalone so the panel can iframe it without inlining the markup. */
app.get('/api/brief/html', wrap((req, res) => {
  const brief = readBrief(req.query.date);
  if (!brief) return res.status(404).send('<p>No morning brief found.</p>');
  res.type('html').send(brief.html);
}));

/* ------------------------------------------------------ static (prod) --- */

const dist = join(__dirname, '..', 'web', 'dist');

/*
 * The page itself is never cached; the bundles it names always are.
 *
 * Vite fingerprints every asset, so index.html is the one file whose staleness
 * labels — hold on to yesterday's copy and it goes on asking for yesterday's
 * bundle, which is no longer on disk. The window then keeps rendering the old
 * UI against the new API, and a feature that shipped simply never appears. That
 * is not a theory: it is why the priority menu didn't show up after a restart.
 */
const noStore = { setHeaders: (res, path) => {
  if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
} };

if (existsSync(dist)) {
  app.use(express.static(dist, noStore));
  app.get(/^(?!\/api).*/, (_req, res) =>
    res.sendFile(join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-store' } }));
}

/* ------------------------------------------------------------------ ws --- */

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/pty' });

wss.on('connection', (ws, req) => {
  const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
  if (!sessionId) {
    ws.send(JSON.stringify({ t: 'error', message: 'sessionId is required' }));
    return ws.close();
  }
  if (!term.attach(sessionId, ws)) {
    ws.send(JSON.stringify({ t: 'notlive', sessionId }));
    return ws.close();
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'input') term.write(sessionId, msg.d);
    else if (msg.t === 'resize') term.resize(sessionId, msg.cols, msg.rows);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-kanban server → http://127.0.0.1:${PORT}`);
  startScheduler();
  startReviewWatcher();
  startLabelWatcher();
  refreshLabels();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    setCaffeinate(false);
    term.shutdownAll();
    process.exit(0);
  });
}
