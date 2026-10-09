/**
 * A folder of pre-generated HTML reports, listed newest first.
 *
 * This exists because something else on the author's machine writes a daily
 * brief, and reading it in the panel beat switching to a browser. The listing
 * is deliberately dumb — it reads what is already there — so it fits any tool
 * that writes dated HTML into a folder. The run at the bottom of this file is
 * the one concession: the tab can also *start* the brief, in a session it
 * remembers, so the questions the brief asks have a fixed place to be answered.
 *
 * Off until `reports.dir` is configured, in which case the panel hides the tab
 * rather than showing an empty one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSetting, setSetting } from './db.js';
import * as term from './pty.js';
import { runRoutine } from './routines.js';
import { config } from './config.js';

function pattern() {
  try {
    return new RegExp(config.reports.pattern);
  } catch {
    return null; // a broken pattern shows nothing rather than crashing the tab
  }
}

export function reportsEnabled() {
  return Boolean(config.reports.dir);
}

/** Newest-first list of the reports found on disk. */
export function listBriefs() {
  const dir = config.reports.dir;
  const re = pattern();
  if (!dir || !re) return [];

  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  return files
    .map((f) => {
      const m = f.match(re);
      if (!m) return null;
      let stat;
      try {
        stat = statSync(join(dir, f));
      } catch {
        return null;
      }
      return {
        // A dated filename sorts and labels itself; anything else falls back to
        // the name, so a report called "summary.html" is still listed.
        date: m[1] ?? f,
        file: f,
        path: join(dir, f),
        sizeBytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function readBrief(date) {
  const briefs = listBriefs();
  const pick = date ? briefs.find((b) => b.date === date) : briefs[0];
  if (!pick) return null;
  return { ...pick, html: readFileSync(pick.path, 'utf8') };
}

/* ----------------------------------------------------------- the run --- */


/**
 * The one morning-brief session the tab owns.
 *
 * The brief is interactive — the billing walkthrough at its start asks a
 * question per draft — so it cannot run headless. Before this, "run the brief"
 * meant starting a session somewhere on the board, losing it among the other
 * cards when a question came up, and starting another. Remembering the run
 * here gives the tab one session to show, one to put questions in, and a reason
 * to refuse a second start while the first is still alive.
 */
const RUN_KEY = 'briefRun';

export function runEnabled() {
  return /^\/[\w-]+$/.test(String(config.reports.runCommand || ''));
}

export function briefRun() {
  const run = getSetting(RUN_KEY, null);
  if (!run?.sessionId) return null;
  return { ...run, live: term.isLive(run.sessionId) };
}

/**
 * Start the brief, or hand back the run already going. `force` starts a fresh
 * one regardless — for the case where the live one is wedged — and it is the
 * caller's job to have asked.
 */
export function startBriefRun({ force = false } = {}) {
  if (!runEnabled()) throw new Error('No reports.runCommand is configured');
  const current = briefRun();
  if (current?.live && !force) return { ...current, reused: true };

  const command = config.reports.runCommand;
  const { sessionId, cwd } = runRoutine({
    id: `report_${command.slice(1)}`,
    name: config.reports.label || command,
    command,
    cwd: homedir(),
  });
  const run = { sessionId, cwd, startedAt: new Date().toISOString() };
  setSetting(RUN_KEY, run);
  return { ...run, live: true, reused: false };
}
