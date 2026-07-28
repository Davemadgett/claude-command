import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { jsonLines, labelFromPath, readChunk, scanSessions } from './sessions.js';
import { labelUrl, labelFolder } from './providers/index.js';
import { config } from './config.js';
import { listCards } from './db.js';

/**
 * Time actually worked, derived from the gaps between a transcript's timestamps.
 *
 * Consecutive events closer together than the idle threshold count as continuous
 * work; a longer gap is treated as you having walked away, and is not billed.
 * This is a defensible floor for a time entry, not a substitute for your judgment
 * — nothing here posts anywhere.
 */
const MAX_READ = 8 * 1024 * 1024;

/** Local calendar day for a timestamp. Shared with the routine scheduler. */
export function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']);

/**
 * Which label a session's time belongs to.
 *
 * Only files the session actually WROTE count. An earlier version scanned the
 * whole transcript for label paths, which billed a website-migration session to
 * a client whose folder it had merely read — for a time entry that is worse than
 * no attribution at all.
 */
function pickLabel(counts) {
  if (!counts.size) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [label, client] = best[0].split('|');
  return { label, client, writes: best[1] };
}

function readSession(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { stamps: [], label: null };
  }
  const start = Math.max(0, stat.size - MAX_READ);
  const text = readChunk(path, start, stat.size - start);

  const stamps = [];
  const labelWrites = new Map();

  for (const d of jsonLines(text, { dropFirst: start > 0 })) {
    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (!Number.isNaN(t)) stamps.push(t);
    }
    if (d.type !== 'assistant') continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
      if (typeof p !== 'string') continue;
      const hit = labelFromPath(p);
      if (!hit) continue;
      const key = `${hit.label}|${hit.client}`;
      labelWrites.set(key, (labelWrites.get(key) || 0) + 1);
    }
  }

  stamps.sort((a, b) => a - b);
  return { stamps, label: pickLabel(labelWrites) };
}

/** Billing systems round up to the tenth of an hour, so a time entry should too. */
function toTenths(seconds) {
  return Math.ceil(seconds / 360) / 10;
}

/**
 * Time already recorded somewhere else, keyed by `${date}|${labelKey}`.
 *
 * Optional, and off until `timeLog.postedCommand` is configured — without it
 * the tab simply shows everything it reconstructed, which is the honest answer
 * for someone who has no other system to compare against. With it, the tab can
 * subtract, and what remains is the only part worth looking at: work that is
 * not yet written down anywhere. Cached briefly, because it is a round trip.
 */
const postedCache = new Map();
const POSTED_TTL_MS = 5 * 60_000;

function fetchPostedHours(from, to) {
  const command = config.timeLog.postedCommand;
  if (!Array.isArray(command) || !command.length) {
    return { posted: new Map(), error: null, configured: false };
  }

  const key = `${from}|${to}`;
  const hit = postedCache.get(key);
  if (hit && Date.now() - hit.at < POSTED_TTL_MS) return hit.value;

  const [bin, ...args] = command;
  let value = { posted: new Map(), error: null, configured: true };

  try {
    const out = execFileSync(bin, [...args, from, to], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...(config.timeLog.env || {}) },
    });
    const parsed = JSON.parse(out);
    if (parsed.error) {
      value = { posted: new Map(), error: parsed.error, configured: true };
    } else {
      const posted = new Map();
      for (const e of parsed.entries ?? []) {
        if (!e.label || !e.date) continue;
        const k = `${e.date}|${e.label}`;
        posted.set(k, (posted.get(k) || 0) + e.hours);
      }
      value = { posted, error: null, configured: true };
    }
  } catch (err) {
    // An unreachable source must not blank the tab — show tracked time, say why.
    value = { posted: new Map(), error: err.message.split('\n')[0], configured: true };
  }

  postedCache.set(key, { at: Date.now(), value });
  return value;
}

function dayRange(sinceDays) {
  const to = new Date();
  const from = new Date(to.getTime() - sinceDays * 86_400_000);
  return [dateKey(from.getTime()), dateKey(to.getTime())];
}

/**
 * How a session's time got attributed, strongest first.
 *
 *   manual — you attached the label to the card yourself
 *   cwd    — the session ran inside the label's folder
 *   files  — it wrote files into the label's folder
 *   prompt — a file number recognised in what you typed
 *
 * A prompt sits last on purpose. It is real evidence — you named the file — but
 * it is the only one of the four where nothing was actually done *in* the label,
 * and time is the one place in this app where a confident wrong answer costs
 * money. It is reported so you can see it, and labelled so you can weigh it.
 */
function attribute(session, inferred, card) {
  if (card?.label && card.label_source === 'manual') {
    return { label: card.label, client: null, labelSource: 'manual' };
  }
  if (session.label && session.labelSource === 'cwd') {
    return { label: session.label, client: session.client, labelSource: 'cwd' };
  }
  if (inferred) {
    return { label: inferred.label, client: inferred.client, labelSource: 'files' };
  }
  if (card?.label) {
    return { label: card.label, client: null, labelSource: 'prompt' };
  }
  return { label: null, client: null, labelSource: null };
}

export function buildTimeLog({ sinceDays = 14, idleMinutes = 10, minSeconds = 60 } = {}) {
  const idleMs = idleMinutes * 60_000;
  const sessions = scanSessions({ sinceDays, interactiveOnly: true });
  const cards = new Map(listCards().map((c) => [c.session_id, c]));

  // key: `${date}|${label ?? cwd}` — a label's work on one day is one entry,
  // even when it was spread across several terminal sessions.
  const buckets = new Map();

  for (const s of sessions) {
    const { stamps: ts, label: inferred } = readSession(s.path);
    if (ts.length < 2) continue;

    const { label, client, labelSource } = attribute(s, inferred, cards.get(s.sessionId));

    const perDay = new Map();
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      if (gap > idleMs || gap <= 0) continue;
      const key = dateKey(ts[i - 1]);
      perDay.set(key, (perDay.get(key) || 0) + gap);
    }

    for (const [date, ms] of perDay) {
      const seconds = Math.round(ms / 1000);
      if (seconds < minSeconds) continue;

      const groupKey = `${date}|${label || s.cwd || s.project}`;
      const bucket = buckets.get(groupKey) || {
        date,
        label,
        client,
        labelSource,
        project: s.project,
        cwd: s.cwd,
        seconds: 0,
        sessions: [],
      };
      bucket.seconds += seconds;
      bucket.sessions.push({ sessionId: s.sessionId, title: s.derivedTitle, seconds });
      buckets.set(groupKey, bucket);
    }
  }

  const [from, to] = dayRange(sinceDays);
  const postedSource = fetchPostedHours(from, to);

  const entries = [...buckets.values()]
    .map((b) => {
      const tracked = toTenths(b.seconds);
      // Only a label can be reconciled — unattributed time has nothing on the
      // other side to compare against, so it is reported as tracked but never
      // as outstanding.
      const posted = b.label ? postedSource.posted.get(`${b.date}|${b.label}`) ?? 0 : 0;
      const unbilled = b.label ? Math.max(0, Math.round((tracked - posted) * 10) / 10) : 0;
      return {
        ...b,
        labelUrl: labelUrl(b.label),
        labelFolder: labelFolder(b.label),
        hours: tracked,
        postedHours: Math.round(posted * 10) / 10,
        unbilledHours: unbilled,
        sessions: b.sessions.sort((x, y) => y.seconds - x.seconds),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.unbilledHours - a.unbilledHours);

  const sum = (list, key) => Math.round(list.reduce((n, e) => n + e[key], 0) * 10) / 10;
  const withLabel = entries.filter((e) => e.label);

  return {
    entries,
    totals: {
      hours: sum(entries, 'hours'),
      labelHours: sum(withLabel, 'hours'),
      postedHours: sum(withLabel, 'postedHours'),
      unbilledHours: sum(withLabel, 'unbilledHours'),
      days: [...new Set(entries.map((e) => e.date))].length,
    },
    posted: { from, to, error: postedSource.error, configured: postedSource.configured },
    params: { sinceDays, idleMinutes },
  };
}
