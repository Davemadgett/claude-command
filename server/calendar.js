import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { knownLabelKeys, labelFolders } from './providers/index.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', 'bin', 'calendar-dump');

const TTL_MS = 5 * 60_000;
let cache = { at: 0, events: [], error: null, denied: false };

/**
 * Calendars whose events are trusted to name a label. Configured, because
 * whose calendar is "work" is a fact about a person, not about the program —
 * and an empty set is the right default: the panel still shows events, it just
 * never attributes one on its own.
 */
const WORK_CALENDARS = new Set(config.calendars.work ?? []);

/**
 * Key prefix -> canonical key ("01994" -> "01994-Acme"), built from both the
 * label index and the folder index so either source can resolve one.
 */
function numberIndex() {
  const index = new Map();
  for (const number of [...knownLabelKeys(), ...labelFolders().keys()]) {
    const prefix = number.split('-')[0];
    if (prefix && !index.has(prefix)) index.set(prefix, number);
  }
  return index;
}

/**
 * Which label an event concerns.
 *
 * Events often name the label outright — "01994-Acme — return signed contract",
 * "Mediation Deadline (01953-Acme)" — so the file number is the signal. A
 * number only counts when it is a label that actually exists, which keeps
 * dates, reference numbers and times from matching by accident.
 */
function matchLabel(event, index) {
  const haystack = [event.title, event.notes, event.location].filter(Boolean).join(' \n ');

  for (const m of haystack.matchAll(/\b(\d{4,6})\b/g)) {
    const hit = index.get(m[1]);
    if (hit) return { label: hit, confidence: 'number' };
  }

  // Deliberately no name matching. It was tried and abandoned twice: with a
  // common name on several labels it picked an arbitrary one, and once narrowed
  // to unique names it still tied a meeting to the wrong label because the title
  // named a person who was not the client — event titles are full of people you
  // are meeting *about* rather than *for*. An unattached event is honest; a
  // wrongly attached deadline is a hazard.
  return null;
}

function load({ days = 21, behind = 1 } = {}) {
  if (Date.now() - cache.at < TTL_MS && !cache.error) return cache;
  if (!existsSync(HELPER)) {
    cache = {
      at: Date.now(),
      events: [],
      error:
        'The calendar helper is not built. It needs Swift — run `xcode-select --install`, ' +
        'then ./start.sh or ./app/build.sh. Everything else works without it.',
      denied: false,
    };
    return cache;
  }

  try {
    const out = execFileSync(HELPER, [String(days), String(behind)], {
      encoding: 'utf8',
      timeout: 40_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    if (parsed.error) {
      cache = { at: Date.now(), events: [], error: parsed.error, denied: Boolean(parsed.denied) };
      return cache;
    }

    const index = numberIndex();
    const events = parsed.events.map((e) => {
      const hit = matchLabel(e, index);
      return { ...e, label: hit?.label ?? null, labelConfidence: hit?.confidence ?? null };
    });
    cache = { at: Date.now(), events, error: null, denied: false };
  } catch (err) {
    // The helper reports its own failures as JSON on stdout and exits non-zero,
    // so execFileSync throws with the useful part in err.stdout. Without this
    // the UI showed "Command failed: …/calendar-dump 21 1", which says nothing
    // about the only thing that had actually gone wrong: permission.
    let payload = null;
    try {
      payload = JSON.parse(String(err.stdout || ''));
    } catch {
      /* the helper died before writing anything */
    }
    cache = {
      at: Date.now(),
      events: [],
      error: payload?.error || err.message.split('\n')[0],
      denied: Boolean(payload?.denied),
    };
  }
  return cache;
}

/**
 * Ask macOS to forget its answer, so the next read prompts again.
 *
 * A denial is permanent as far as EventKit is concerned — it stops asking and
 * just returns false — so without this the only route back is System Settings,
 * which is a long way to go for a mis-click. `tccutil reset` is the supported
 * way to clear it, and an app may always reset its own decision.
 *
 * Deliberately a button rather than automatic: re-prompting on every visit to
 * the Calendar section would mean a denial could never be made to stick.
 */
export function requestCalendarAccess() {
  const targets = new Set([config.bundleId]);
  // The server can also be run straight from a terminal, in which case macOS
  // attributes the request to that terminal, not to the app.
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') targets.add('com.apple.Terminal');
  if (process.env.TERM_PROGRAM === 'iTerm.app') targets.add('com.googlecode.iterm2');

  const reset = [];
  for (const id of targets) {
    try {
      execFileSync('/usr/bin/tccutil', ['reset', 'Calendar', id], { encoding: 'utf8', timeout: 10_000 });
      reset.push(id);
    } catch {
      /* nothing recorded for that id — nothing to clear */
    }
  }

  // Force the next read to actually run the helper, which is what triggers the
  // system prompt; a cached error would otherwise answer for it.
  cache = { at: 0, events: [], error: null, denied: false };
  const result = load();
  return { reset, granted: !result.error, error: result.error, denied: result.denied };
}

export function listEvents(opts) {
  return load(opts);
}

/** Upcoming events for one label, soonest first. */
export function eventsForLabel(label, { from = Date.now() } = {}) {
  if (!label) return [];
  return load()
    .events.filter((e) => e.label === label && Date.parse(e.start) >= from - 3_600_000)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function nextEventForLabel(label) {
  return eventsForLabel(label)[0] ?? null;
}

export function calendarStatus() {
  const { at, events, error, denied } = load();
  return {
    count: events.length,
    matched: events.filter((e) => e.label).length,
    fetchedAt: at ? new Date(at).toISOString() : null,
    error,
    denied,
  };
}
