import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'board.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    position REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS columns (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    position  REAL NOT NULL,
    color     TEXT NOT NULL DEFAULT '#64748b',
    wip_limit INTEGER
  );

  CREATE TABLE IF NOT EXISTS cards (
    session_id TEXT PRIMARY KEY,
    column_id  TEXT NOT NULL,
    position   REAL NOT NULL,
    title      TEXT,
    notes      TEXT,
    cwd        TEXT,
    archived   INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routines (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    command         TEXT NOT NULL,
    cwd             TEXT,
    time_of_day     TEXT NOT NULL DEFAULT '07:00',
    enabled         INTEGER NOT NULL DEFAULT 0,
    last_run_at     TEXT,
    last_session_id TEXT,
    position        REAL NOT NULL
  );
`);

// Columns gained a board when boards were introduced; backfill existing rows onto
// the firm board so an upgrade keeps every card exactly where it was.
const columnCols = db.prepare('PRAGMA table_info(columns)').all();
if (!columnCols.some((c) => c.name === 'board_id')) {
  db.exec("ALTER TABLE columns ADD COLUMN board_id TEXT NOT NULL DEFAULT 'firm'");
}

// Cards you type in yourself, rather than ones discovered from a transcript.
let cardCols = db.prepare('PRAGMA table_info(cards)').all();

/*
 * These columns were called matter/matter_source/… back when the board only
 * knew about legal matters. Rename them in place rather than adding a second
 * set: a board that predates the change keeps every label it had, and nobody
 * has to re-attach anything. RENAME COLUMN needs SQLite 3.25, which every
 * better-sqlite3 build has long since carried.
 */
for (const [from, to] of [
  ['matter', 'label'],
  ['matter_source', 'label_source'],
  ['matter_suggested', 'label_suggested'],
  ['matter_dismissed', 'label_dismissed'],
]) {
  const hasOld = cardCols.some((c) => c.name === from);
  const hasNew = cardCols.some((c) => c.name === to);
  if (hasOld && !hasNew) db.exec(`ALTER TABLE cards RENAME COLUMN ${from} TO ${to}`);
}
cardCols = db.prepare('PRAGMA table_info(cards)').all();
if (!cardCols.some((c) => c.name === 'manual')) {
  db.exec('ALTER TABLE cards ADD COLUMN manual INTEGER NOT NULL DEFAULT 0');
}
// Which activity timestamp we last auto-moved this card for, so a card dragged
// back out of review does not immediately jump into it again.
if (!cardCols.some((c) => c.name === 'auto_moved_activity')) {
  db.exec('ALTER TABLE cards ADD COLUMN auto_moved_activity TEXT');
}
// When it was archived, so the archive can be read newest-first.
if (!cardCols.some((c) => c.name === 'archived_at')) {
  db.exec('ALTER TABLE cards ADD COLUMN archived_at TEXT');
}

// A review lane is a column that belongs to the work column on its left.
if (!columnCols.some((c) => c.name === 'review_of')) {
  db.exec('ALTER TABLE columns ADD COLUMN review_of TEXT');
}

// How urgent this card is: 'high' | 'medium' | 'low', or NULL for unset. Unset is
// its own state rather than a silent "medium" — most cards never need a priority,
// and defaulting them all to the middle would make the colour say nothing.
if (!cardCols.some((c) => c.name === 'priority')) {
  db.exec('ALTER TABLE cards ADD COLUMN priority TEXT');
}

/*
 * A label attached to the card itself, rather than one derived from where the
 * session ran. Three columns because the confidence matters as much as the answer:
 *
 *   label          — the attached label number, once it is settled
 *   label_source   — 'prompt' (a file number recognised in what was typed) or
 *                     'manual' (you set or confirmed it). Manual outranks
 *                     everything; a detected one still yields to a session whose
 *                     working directory is a label folder.
 *   label_suggested / label_dismissed — a surname-strength guess awaiting a
 *                     yes or no, and the one you already said no to, so a
 *                     rejected guess never comes back.
 */
for (const [col, type] of [
  ['label', 'TEXT'],
  ['label_source', 'TEXT'],
  ['label_suggested', 'TEXT'],
  ['label_dismissed', 'TEXT'],
]) {
  if (!cardCols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`);
  }
}

/**
 * A column carrying this in `review_of` is the board's inbox: work that comes
 * back — finished, or stopped to ask you something — lands here from any column
 * to its left. Distinct from a review lane, which belongs to one column and
 * renders beside it; the inbox is a full column of its own, and everything to its
 * right (Filing, Complete) is terminal and never pulled out of.
 */
export const BOARD_INBOX = '*';

// Starting boards and columns. All editable from the UI — this only seeds empty.
/*
 * Only ever used to seed an empty board — everything here is editable from the
 * UI, and a board that already exists is left exactly as it is.
 *
 * The ids are historical and deliberately not renamed. Seeding keys on the id,
 * so changing `firm` to `work` would not rename anybody's board; it would leave
 * theirs alone and add a second, empty one beside it.
 */
const DEFAULT_BOARDS = [
  {
    id: 'firm',
    name: 'Work',
    columns: [
      { id: 'todo', name: 'To Do', color: '#3b82f6' },
      { id: 'yourturn', name: 'Your Turn', color: '#f59e0b', reviewOf: BOARD_INBOX },
      { id: 'complete', name: 'Done', color: '#10b981' },
    ],
  },
  {
    id: 'personal',
    name: 'Personal',
    columns: [
      { id: 'personal_todo', name: 'To Do', color: '#38bdf8' },
      { id: 'personal_doing', name: 'Doing', color: '#f59e0b' },
      { id: 'personal_done', name: 'Done', color: '#10b981' },
    ],
  },
];

/*
 * Whether this file was empty when we opened it, decided before anything is
 * seeded into it. The one-time migrations below exist to reshape boards created
 * by older versions; run against a database that never had those shapes they do
 * not upgrade anything, they just undo the current defaults. A fresh database is
 * already in its final state, so they are marked done rather than run.
 */
const isNewDatabase = db.prepare('SELECT COUNT(*) n FROM boards').get().n === 0;

const insBoard = db.prepare('INSERT INTO boards (id, name, position) VALUES (?, ?, ?)');
const insColumn = db.prepare(
  'INSERT INTO columns (id, name, position, color, board_id) VALUES (?, ?, ?, ?, ?)'
);
const insColumnWithRole = db.prepare(
  'INSERT INTO columns (id, name, position, color, board_id, review_of) VALUES (?, ?, ?, ?, ?, ?)'
);

DEFAULT_BOARDS.forEach((board, bi) => {
  const exists = db.prepare('SELECT 1 FROM boards WHERE id = ?').get(board.id);
  if (exists) return;

  insBoard.run(board.id, board.name, (bi + 1) * 1000);
  // Only seed columns for a board that has none — an upgrade already has the
  // firm columns, and re-adding them would duplicate every stage.
  const have = db.prepare('SELECT COUNT(*) n FROM columns WHERE board_id = ?').get(board.id).n;
  if (have === 0) {
    board.columns.forEach((c, i) =>
      insColumnWithRole.run(c.id, c.name, (i + 1) * 1000, c.color, board.id, c.reviewOf ?? null)
    );
  }
});

/** Attach a review lane immediately to the right of a work column. */
export function createReviewLane(workColumnId) {
  const work = db.prepare('SELECT * FROM columns WHERE id = ?').get(workColumnId);
  if (!work) throw new Error('No such column');
  if (work.review_of) throw new Error('A review lane cannot have its own review lane');

  const existing = db.prepare('SELECT id FROM columns WHERE review_of = ?').get(workColumnId);
  if (existing) return existing.id;

  const id = `review_${workColumnId}`;
  db.prepare(
    'INSERT INTO columns (id, name, position, color, board_id, review_of) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'Review', work.position + 500, '#f59e0b', work.board_id, workColumnId);
  return id;
}

export function removeReviewLane(workColumnId) {
  const lane = db.prepare('SELECT id FROM columns WHERE review_of = ?').get(workColumnId);
  if (!lane) return;
  db.transaction(() => {
    db.prepare('UPDATE cards SET column_id = ? WHERE column_id = ?').run(workColumnId, lane.id);
    db.prepare('DELETE FROM columns WHERE id = ?').run(lane.id);
  })();
}

export function reviewLaneFor(columnId) {
  return db.prepare('SELECT id FROM columns WHERE review_of = ?').get(columnId)?.id ?? null;
}

/** Every work column that has a review lane -> that lane's id, in one query. */
export function reviewLanes() {
  const map = new Map();
  for (const row of db.prepare('SELECT id, review_of FROM columns WHERE review_of IS NOT NULL').all()) {
    if (row.review_of === BOARD_INBOX) continue; // a board inbox, not a column's lane
    map.set(row.review_of, row.id);
  }
  return map;
}

/**
 * Board inboxes: column id -> the set of columns that feed it. Only columns to
 * the inbox's left feed it, which is what keeps Filing and Complete terminal
 * without needing a flag of their own.
 */
export function boardInboxes() {
  const out = [];
  const inboxes = db
    .prepare('SELECT * FROM columns WHERE review_of = ? ORDER BY position')
    .all(BOARD_INBOX);
  for (const inbox of inboxes) {
    const feeders = db
      .prepare('SELECT id FROM columns WHERE board_id = ? AND position < ? AND review_of IS NULL')
      .all(inbox.board_id, inbox.position)
      .map((c) => c.id);
    if (feeders.length) out.push({ inbox: inbox.id, feeders: new Set(feeders) });
  }
  return out;
}

/**
 * One-time board reshape: the stand-alone "Review" stage is replaced by review
 * lanes on the stages that actually produce work. Filing and Complete are
 * terminal, so they get none. Keyed on a setting so it never fights a later edit.
 */
function migrateReviewLanes() {
  if (getSetting('migrated_review_lanes', false)) return;

  const stale = db.prepare("SELECT * FROM columns WHERE id = 'review'").get();
  if (stale) {
    const fallback = db
      .prepare("SELECT id FROM columns WHERE board_id = ? AND id != 'review' ORDER BY position LIMIT 1")
      .get(stale.board_id);
    db.transaction(() => {
      if (fallback) {
        db.prepare('UPDATE cards SET column_id = ? WHERE column_id = ?').run(fallback.id, 'review');
      }
      db.prepare("DELETE FROM columns WHERE id = 'review'").run();
    })();
  }

  for (const workId of ['strategy', 'drafting']) {
    if (db.prepare('SELECT 1 FROM columns WHERE id = ?').get(workId)) {
      try {
        createReviewLane(workId);
      } catch {
        /* already present */
      }
    }
  }

  setSetting('migrated_review_lanes', true);
}

/**
 * The Cases board settles into four columns: what needs doing, what has come
 * back to you, what is being filed, and what is done.
 *
 * The stages it replaces (Strategy & Intake, Document Drafting, and the review
 * lanes hanging off them) described how a document gets written — but the board's
 * job is to tell you where your attention is owed, and by that measure everything
 * before "it's back with you" is one pile. Cards from the old work stages land in
 * To Do; anything already sitting in a review lane was waiting on you, so it
 * lands in Your Turn.
 */
function migrateCasesColumns() {
  if (getSetting('migrated_cases_inbox', false)) return;

  const board = db.prepare("SELECT id FROM boards WHERE id = 'firm'").get();
  if (!board) {
    setSetting('migrated_cases_inbox', true);
    return;
  }

  const WANTED = [
    { id: 'todo', name: 'To Do', color: '#3b82f6', reviewOf: null },
    { id: 'yourturn', name: 'Your Turn', color: '#f59e0b', reviewOf: BOARD_INBOX },
    { id: 'filing', name: 'Filing', color: '#ec4899', reviewOf: null },
    { id: 'complete', name: 'Complete', color: '#10b981', reviewOf: null },
  ];

  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM columns WHERE board_id = ?').all('firm');
    const keep = new Set(WANTED.map((c) => c.id));

    WANTED.forEach((c, i) => {
      const position = (i + 1) * 1000;
      if (existing.some((e) => e.id === c.id)) {
        db.prepare('UPDATE columns SET name = ?, position = ?, review_of = ? WHERE id = ?')
          .run(c.name, position, c.reviewOf, c.id);
      } else {
        insColumnWithRole.run(c.id, c.name, position, c.color, 'firm', c.reviewOf);
      }
    });

    // A card waiting in a review lane was already your turn; everything else was
    // work in progress, which is now simply To Do.
    for (const stale of existing.filter((e) => !keep.has(e.id))) {
      const target = stale.review_of ? 'yourturn' : 'todo';
      const max = db
        .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
        .get(target).p;
      const cards = db.prepare('SELECT session_id FROM cards WHERE column_id = ?').all(stale.id);
      const move = db.prepare('UPDATE cards SET column_id = ?, position = ? WHERE session_id = ?');
      cards.forEach((card, i) => move.run(target, max + (i + 1) * 1000, card.session_id));
      db.prepare('DELETE FROM columns WHERE id = ?').run(stale.id);
    }
  })();

  setSetting('migrated_cases_inbox', true);
}

/**
 * Throw away every label the board guessed from a prompt, once, so the improved
 * detector gets to look again.
 *
 * The first version of it read expanded skill bodies as though they were your own
 * words, and a skill that documents itself with an example file number handed out
 * that number as an answer. Those labels are stuck — a card with a label is a
 * card the sweep leaves alone — so they have to be cleared to be corrected.
 * Labels you set by hand, and labels read off a folder, are untouched.
 */
function redetectPromptLabels() {
  if (getSetting('redetected_prompt_matters_v2', false)) return;
  db.prepare("UPDATE cards SET label = NULL, label_suggested = NULL WHERE label_source = 'prompt'").run();
  setSetting('redetected_prompt_matters_v2', true);
}

export function listBoards() {
  return db.prepare('SELECT * FROM boards ORDER BY position').all();
}

export function defaultBoardId() {
  return db.prepare('SELECT id FROM boards ORDER BY position LIMIT 1').get()?.id ?? 'firm';
}

export function createBoard(name) {
  const id = `board_${Math.random().toString(36).slice(2, 10)}`;
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) p FROM boards').get().p;
  db.transaction(() => {
    insBoard.run(id, name, max + 1000);
    [
      { name: 'To Do', color: '#38bdf8' },
      { name: 'Doing', color: '#f59e0b' },
      { name: 'Done', color: '#10b981' },
    ].forEach((c, i) =>
      insColumn.run(`col_${Math.random().toString(36).slice(2, 10)}`, c.name, (i + 1) * 1000, c.color, id)
    );
  })();
  return db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
}

export function renameBoard(id, name) {
  db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, id);
}

/** Deleting a board moves its cards to the first column of the board that remains. */
export function deleteBoard(id) {
  const boards = listBoards();
  if (boards.length <= 1) throw new Error('Cannot delete the last board');
  const fallbackBoard = boards.find((b) => b.id !== id);
  const fallbackColumn = db
    .prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1')
    .get(fallbackBoard.id);
  if (!fallbackColumn) throw new Error('The remaining board has no columns');

  db.transaction(() => {
    db.prepare(
      'UPDATE cards SET column_id = ? WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)'
    ).run(fallbackColumn.id, id);
    db.prepare('DELETE FROM columns WHERE board_id = ?').run(id);
    db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  })();
  return fallbackBoard.id;
}

/** Send a card to another board, landing in that board's first column. */
export function moveCardToBoard(sessionId, boardId) {
  const target = db
    .prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1')
    .get(boardId);
  if (!target) throw new Error('That board has no columns');
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
    .get(target.id).p;
  ensureCard(sessionId);
  db.prepare(
    "UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE session_id = ?"
  ).run(target.id, max + 1000, sessionId);
}

// One seeded routine so the tab isn't empty; automatic running stays OFF until
// it is switched on deliberately.
if (db.prepare('SELECT COUNT(*) n FROM routines').get().n === 0) {
  db.prepare(
    'INSERT INTO routines (id, name, command, time_of_day, enabled, position) VALUES (?, ?, ?, ?, 0, 1000)'
  ).run('morningbrief', 'Morning Brief', '/morningbrief', '07:00');
}

export function listRoutines() {
  return db.prepare('SELECT * FROM routines ORDER BY position').all();
}

export function createRoutine({ name, command, cwd = null, timeOfDay = '07:00' }) {
  const id = `routine_${Math.random().toString(36).slice(2, 10)}`;
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) p FROM routines').get().p;
  db.prepare(
    'INSERT INTO routines (id, name, command, cwd, time_of_day, enabled, position) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, name, command, cwd, timeOfDay, max + 1000);
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
}

export function updateRoutine(id, fields) {
  const map = {
    name: 'name', command: 'command', cwd: 'cwd',
    timeOfDay: 'time_of_day', enabled: 'enabled',
    lastRunAt: 'last_run_at', lastSessionId: 'last_session_id',
  };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) {
      sets.push(`${col} = ?`);
      vals.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(vals);
}

export function deleteRoutine(id) {
  db.prepare('DELETE FROM routines WHERE id = ?').run(id);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

// Runs after getSetting/setSetting are defined, and after the default seeds above.
if (isNewDatabase) {
  // Nothing to upgrade — see the note beside isNewDatabase.
  setSetting('migrated_review_lanes', true);
  setSetting('migrated_cases_inbox', true);
  setSetting('redetected_prompt_matters_v2', true);
}

migrateReviewLanes();
migrateCasesColumns();
redetectPromptLabels();

export function listColumns(boardId = null) {
  return boardId
    ? db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position').all(boardId)
    : db.prepare('SELECT * FROM columns ORDER BY position').all();
}

export function listCards() {
  return db.prepare('SELECT * FROM cards').all();
}

/**
 * Cards are created lazily: a session gets a row the first time we see it, landing
 * in the leftmost column. After that the row is authoritative — moving a card
 * persists here and survives restarts, renames and Claude Code upgrades.
 */
export function ensureCard(sessionId, { columnId = null, title = null, cwd = null } = {}) {
  const existing = db.prepare('SELECT * FROM cards WHERE session_id = ?').get(sessionId);
  if (existing) return existing;

  // A newly discovered session lands in the first column of the default board.
  const target =
    (columnId && db.prepare('SELECT id FROM columns WHERE id = ?').get(columnId)?.id) ||
    db
      .prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1')
      .get(defaultBoardId())?.id ||
    db.prepare('SELECT id FROM columns ORDER BY position LIMIT 1').get()?.id;
  if (!target) return null;

  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
    .get(target).p;

  db.prepare(
    'INSERT INTO cards (session_id, column_id, position, title, cwd) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, target, max + 1000, title, cwd);

  return db.prepare('SELECT * FROM cards WHERE session_id = ?').get(sessionId);
}

/** A card you write yourself. It has no session until you start one for it. */
export function createManualCard({ columnId, title, notes = null, cwd = null }) {
  const column = db.prepare('SELECT id FROM columns WHERE id = ?').get(columnId);
  if (!column) throw new Error('No such column');

  const id = `manual_${randomUUID()}`;
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
    .get(columnId).p;

  db.prepare(
    'INSERT INTO cards (session_id, column_id, position, title, notes, cwd, manual) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).run(id, columnId, max + 1000, title, notes, cwd);

  return db.prepare('SELECT * FROM cards WHERE session_id = ?').get(id);
}

/**
 * Closing a card archives it. Nothing on the board destroys anything — a card
 * closed by accident has to be recoverable, so the only true delete lives in the
 * archive itself.
 */
export function archiveCard(sessionId) {
  db.prepare(
    "UPDATE cards SET archived = 1, archived_at = datetime('now'), updated_at = datetime('now') WHERE session_id = ?"
  ).run(sessionId);
}

/**
 * Put a card back where it was. If the column it came from has since been
 * deleted, land it in the first column of the default board rather than leaving
 * it orphaned and invisible.
 */
export function restoreCard(sessionId) {
  const card = getCard(sessionId);
  if (!card) throw new Error('No such card');

  let columnId = card.column_id;
  if (!db.prepare('SELECT 1 FROM columns WHERE id = ?').get(columnId)) {
    columnId = db
      .prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1')
      .get(defaultBoardId())?.id;
    if (!columnId) throw new Error('There is nowhere to restore this card to');
  }

  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE column_id = ?')
    .get(columnId).p;

  db.prepare(
    `UPDATE cards
        SET archived = 0, archived_at = NULL, column_id = ?, position = ?,
            auto_moved_activity = NULL, updated_at = datetime('now')
      WHERE session_id = ?`
  ).run(columnId, max + 1000, sessionId);

  return columnId;
}

/** Permanent — only reachable from the archive. */
export function deleteCard(sessionId) {
  db.prepare('DELETE FROM cards WHERE session_id = ?').run(sessionId);
}

export function listArchivedCards() {
  return db
    .prepare('SELECT * FROM cards WHERE archived = 1 ORDER BY COALESCE(archived_at, updated_at) DESC')
    .all();
}

export function getCard(sessionId) {
  return db.prepare('SELECT * FROM cards WHERE session_id = ?').get(sessionId) ?? null;
}

/**
 * Point a manual card at a real session, keeping its column, position, title and
 * notes — so starting work on a card you wrote does not create a second card.
 */
export function attachSession(manualId, sessionId) {
  const card = getCard(manualId);
  if (!card) throw new Error('No such card');
  db.prepare(
    "UPDATE cards SET session_id = ?, manual = 0, updated_at = datetime('now') WHERE session_id = ?"
  ).run(sessionId, manualId);
  return getCard(sessionId);
}

export function moveCard(sessionId, columnId, position) {
  ensureCard(sessionId);
  db.prepare(
    "UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE session_id = ?"
  ).run(columnId, position, sessionId);
}

export const PRIORITIES = ['high', 'medium', 'low'];

/**
 * Set or clear a card's priority. Anything that isn't one of the three levels
 * clears it, so "None" in the menu and a stale value both land in the same place.
 */
export function setPriority(sessionId, priority) {
  ensureCard(sessionId);
  const value = PRIORITIES.includes(priority) ? priority : null;
  db.prepare("UPDATE cards SET priority = ?, updated_at = datetime('now') WHERE session_id = ?")
    .run(value, sessionId);

  /*
   * Marking something high moves it to the top of its column.
   *
   * Saying "this one first" and then having to drag it there is the same
   * instruction twice. Only high does this, and only at the moment you set it:
   * the board is not re-sorted by priority behind your back, so wherever you
   * drag a card afterwards is where it stays.
   */
  if (value === 'high') {
    const card = db.prepare('SELECT column_id FROM cards WHERE session_id = ?').get(sessionId);
    if (card?.column_id) {
      const top = db
        .prepare('SELECT COALESCE(MIN(position), 0) p FROM cards WHERE column_id = ? AND archived = 0')
        .get(card.column_id).p;
      db.prepare('UPDATE cards SET position = ? WHERE session_id = ?').run(top - 1000, sessionId);
    }
  }
  return value;
}

/**
 * Attach a label to a card.
 *
 * `source` is 'manual' when you chose it and 'prompt' when it was recognised in
 * what you typed. Setting one always clears the pending suggestion — the question
 * has been answered — and confirming a suggestion is just this with 'manual'.
 */
export function setCardLabel(sessionId, label, source = 'manual') {
  ensureCard(sessionId);
  db.prepare(
    `UPDATE cards
        SET label = ?, label_source = ?, label_suggested = NULL, updated_at = datetime('now')
      WHERE session_id = ?`
  ).run(label || null, label ? source : null, sessionId);
}

/** Offer a guess for confirmation, without touching what the card already shows. */
export function suggestCardLabel(sessionId, label) {
  db.prepare(
    "UPDATE cards SET label_suggested = ?, updated_at = datetime('now') WHERE session_id = ?"
  ).run(label, sessionId);
}

/** No. Remembered, so the same guess is not offered again on the next sweep. */
export function dismissCardLabel(sessionId) {
  const card = getCard(sessionId);
  if (!card?.label_suggested) return;
  db.prepare(
    `UPDATE cards
        SET label_dismissed = label_suggested, label_suggested = NULL,
            updated_at = datetime('now')
      WHERE session_id = ?`
  ).run(sessionId);
}

export function updateCard(sessionId, fields) {
  ensureCard(sessionId);
  const allowed = ['title', 'notes', 'cwd', 'archived', 'pinned', 'priority'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(sessionId);
  db.prepare(
    `UPDATE cards SET ${sets.join(', ')}, updated_at = datetime('now') WHERE session_id = ?`
  ).run(vals);
}

export function createColumn({ name, color = '#64748b', wipLimit = null, boardId = null }) {
  const id = `col_${Math.random().toString(36).slice(2, 10)}`;
  const board = boardId || defaultBoardId();
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) p FROM columns WHERE board_id = ?')
    .get(board).p;
  db.prepare(
    'INSERT INTO columns (id, name, position, color, wip_limit, board_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, max + 1000, color, wipLimit, board);
  return db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
}

export function updateColumn(id, fields) {
  const map = { name: 'name', color: 'color', position: 'position', wipLimit: 'wip_limit' };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) {
      sets.push(`${col} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE columns SET ${sets.join(', ')} WHERE id = ?`).run(vals);
}

/** Deleting a column relocates its cards rather than dropping them on the floor. */
export function deleteColumn(id) {
  const target = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(id);
  if (!target) throw new Error('No such column');
  const cols = listColumns(target.board_id);
  if (cols.length <= 1) throw new Error('Cannot delete a board’s last column');
  const fallback = cols.find((c) => c.id !== id);
  db.transaction(() => {
    db.prepare('UPDATE cards SET column_id = ? WHERE column_id = ?').run(fallback.id, id);
    db.prepare('DELETE FROM columns WHERE id = ?').run(id);
  })();
  return fallback.id;
}

export function reorderColumns(orderedIds) {
  const upd = db.prepare('UPDATE columns SET position = ? WHERE id = ?');
  db.transaction(() => orderedIds.forEach((id, i) => upd.run((i + 1) * 1000, id)))();
}
