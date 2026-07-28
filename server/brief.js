/**
 * A folder of pre-generated HTML reports, listed newest first.
 *
 * This exists because something else on the author's machine writes a daily
 * brief, and reading it in the panel beat switching to a browser. It is
 * deliberately dumb — it does not generate anything, it reads what is already
 * there — so it fits any tool that writes dated HTML into a folder.
 *
 * Off until `reports.dir` is configured, in which case the panel hides the tab
 * rather than showing an empty one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
