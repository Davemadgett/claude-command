/**
 * Which coding agent a session is.
 *
 * The board was written when there was one answer — every card was a `claude`
 * process reading a transcript under ~/.claude/projects — and that assumption
 * was spread across the spawn, the scan, the mirror and the time log. There are
 * two answers now, so the differences live here and everything else asks.
 *
 * An engine is three facts and nothing more:
 *
 *   where its binary is            so a session can be started
 *   how it is told to resume       so a card can be reopened
 *   where it writes its transcript so the board can read what happened
 *
 * The third is the one that costs something. Claude Code names a transcript
 * after a session id we choose, which is why the board could pick an id up front
 * and have the file appear under it. Codex names its own thread and there is no
 * flag to override that, so a codex card keeps the id the board gave it and the
 * codex thread id is recorded beside it once the rollout shows up. See
 * `adoptThread` in codex.js — that gap is the whole reason this file exists
 * rather than a `bin` variable in pty.js.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSetting, setSetting } from './db.js';
import { config } from './config.js';

const HOME = homedir();

export const ENGINES = [
  {
    id: 'claude',
    name: 'Claude Code',
    /** The command, as you would type it. */
    bin: 'claude',
    /**
     * Where it lands when it is not on the PATH a GUI app inherits. Ordered by
     * how likely each is to be the one you actually installed.
     */
    candidates: [
      join(HOME, '.local/bin/claude'),
      join(HOME, '.claude/local/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ],
    /** Claude Code takes the session id, so the board picks it. */
    picksSessionId: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    candidates: [
      join(HOME, '.local/bin/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      // The ChatGPT desktop app ships the CLI inside its bundle, and on a Mac
      // that installed it that way there is nothing on the PATH at all — the
      // usual setup is a shell alias, which a spawned process never sees.
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ],
    picksSessionId: false,
  },
];

const BY_ID = new Map(ENGINES.map((e) => [e.id, e]));

export const DEFAULT_ENGINE = 'claude';

/** The engine record, or the default one for anything unrecognised. */
export function engine(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_ENGINE);
}

export function isEngine(id) {
  return BY_ID.has(id);
}

/**
 * Which engine new sessions start as.
 *
 * One setting for the whole board rather than one per card: the question "am I
 * working in Claude or in Codex today" is answered once, and a per-card choice
 * would mean answering it again on every card while looking at a board that
 * mixes the two. A card still remembers what it was started as, because
 * reopening it has to reach the right conversation.
 */
export function currentEngine() {
  const id = getSetting('engine', DEFAULT_ENGINE);
  return isEngine(id) ? id : DEFAULT_ENGINE;
}

export function setCurrentEngine(id) {
  if (!isEngine(id)) throw new Error(`No such engine: ${id}`);
  setSetting('engine', id);
  return id;
}

/** A per-engine override from config.json — `{"engines": {"codex": {"bin": "…"}}}`. */
export function configuredBin(id) {
  const bin = config.engines?.[id]?.bin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : null;
}
