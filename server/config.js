/**
 * Everything that is true of one person's machine rather than of the program.
 *
 * This started as a tool for one law firm, and the firm was spelled out in the
 * source: a Dropbox path, two calendar names, a principal's name, a wordmark.
 * None of that is a feature — it is configuration that happened to be typed
 * into the wrong file. It lives here now, and `config.json` is gitignored so a
 * fork never inherits somebody else's disk layout.
 *
 * Missing config is not an error. Every key has a default that produces a
 * working board; the optional integrations simply stay switched off, which is
 * the right behaviour for someone who cloned this ten seconds ago.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOME = homedir();

const DEFAULTS = {
  /** Shown in the window title and the header lockup. */
  appName: 'Claude Command',

  /** macOS bundle identifier, used by the app build and by window targeting. */
  bundleId: 'com.example.claudecommand',

  /** Who sits at the top of the Team org chart. */
  principal: 'You',

  port: 4317,

  /**
   * Labels are the optional answer to "which piece of work is this session
   * about" — a client, a case, an account, a product line. Two independent
   * questions, deliberately kept apart:
   *
   *   index    where the list of valid labels comes from ('folders' | 'clio' | 'none')
   *   root     where the matching folder lives on disk, if anywhere
   *
   * Keeping them apart is what lets a Clio user take the label list from an API
   * while still resolving folders on a local Dropbox mirror.
   */
  labels: {
    index: 'folders',
    root: null,
    /** 1 → <root>/<label>, 2 → <root>/<group>/<label>. */
    depth: 1,
    /** A folder only counts as a label if its name matches. null accepts all. */
    pattern: null,
    /** Word used in the UI. 'label', 'matter', 'client', 'account'… */
    noun: 'label',
    /**
     * argv for index: 'command' — a program printing {"labels": {...}} on
     * stdout. See server/providers/command.js and examples/clio-labels.py.
     */
    command: null,
    /** Extra environment for that command — an API key, an account id. */
    env: {},
    /**
     * Words that must never be read as a label name — your subagents, your own
     * name, anyone you discuss rather than work for. 'claude' is always added.
     */
    stoplist: [],
  },

  timeLog: {
    /**
     * argv for a program printing {"entries": [{date, label, hours, ...}]},
     * given a start and end date. The Time tab subtracts these from what it
     * reconstructs, so it only shows work not yet recorded elsewhere. Off
     * unless set, in which case the tab simply shows everything it found.
     */
    postedCommand: null,
    env: {},
  },

  calendars: {
    /**
     * Calendars whose events are trusted to name a label. Empty means the
     * calendar panel still works but never attributes an event on its own.
     */
    work: [],
  },

  /**
   * A folder of pre-generated HTML reports to surface in the panel. Off unless
   * you point it somewhere — this exists because something else on the author's
   * machine writes a daily brief, and reading it here beat opening a browser.
   */
  reports: {
    dir: null,
    pattern: '^report_(\\d{4}-\\d{2}-\\d{2})\\.html$',
    label: 'Reports',
  },
};

/** `~/foo` and `~` mean what they mean in a shell; everything else is literal. */
export function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return HOME;
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p;
}

/**
 * Merge one level deeper than Object.assign. A config that sets only
 * `labels.root` should keep the default `labels.index`, not erase it.
 */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object'
        ? merge(base[key], value)
        : value;
  }
  return out;
}

function load() {
  const path = process.env.CC_CONFIG ? expandHome(process.env.CC_CONFIG) : join(ROOT, 'config.json');

  let user = {};
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      // Refusing to start over a stray comma would be worse than the mistake.
      console.error(`config: ignoring ${path} — ${err.message}`);
    }
  }

  const merged = merge(DEFAULTS, user);
  merged.labels.root = expandHome(merged.labels.root);
  merged.reports.dir = expandHome(merged.reports.dir);
  merged.port = Number(process.env.PORT || merged.port);
  merged.configPath = existsSync(path) ? path : null;
  return merged;
}

export const config = load();

/** True when a label index is configured at all — the UI hides the chip if not. */
export function labelsEnabled() {
  return config.labels.index !== 'none';
}
