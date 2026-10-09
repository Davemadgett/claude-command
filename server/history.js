/**
 * Spend week over week, as far back as the transcripts go.
 *
 * `usage.js` answers "what is happening now" and keeps eight days in memory to
 * do it. This answers the slower question — is this week heavier than the last
 * five — and to do that it has to read everything: about 1.5 GB across 900
 * transcripts, back to the first week of July.
 *
 * Three things make that affordable.
 *
 *   - A full scan is genuinely fast. The parser is a handful of regexes over
 *     lines that mostly do not match, and reading the whole history takes about
 *     four seconds. It is the kind of thing you can do once at startup and
 *     forget.
 *   - It is done once. Every file's totals are cached against its size and
 *     mtime and written to disk, so a restart re-reads only what changed —
 *     which, for a transcript that was finished last Tuesday, is nothing.
 *   - It yields. Four seconds of straight-line work would freeze the board for
 *     four seconds, because there is one thread. The scan hands control back
 *     between files.
 *
 * The weeks are the plan's weeks, not calendar weeks. The subscription resets
 * on a Friday evening, so a Monday-to-Sunday chart would cut every week in two
 * and neither half would mean anything. The reset instant comes from the same
 * meter the Usage tab shows and is remembered on disk, so the chart keeps its
 * shape while the machine is offline.
 */

import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BUCKET_MS, PRICING_FINGERPRINT, parseLine, transcriptFiles } from './usage.js';
import { getLimits } from './limits.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CACHE_FILE = join(DATA_DIR, 'usage-history.json');
const CACHE_VERSION = 1;

const WEEK_MS = 7 * 86_400_000;
/** How much of a transcript to hold in memory at once while scanning. */
const CHUNK = 8 * 1024 * 1024;
/** Files to read before handing the event loop back. */
const YIELD_EVERY = 12;
/** Re-stat the transcripts at most this often. */
const TTL_MS = 60_000;

/** path -> { size, mtimeMs, rows: [bucketIdx, tokens, cost, in, out, cacheRead, cacheWrite, req][] } */
const cache = new Map();
let loaded = false;
let lastScan = 0;
let scanning = null;
/** The weekly reset we last saw, kept so the chart survives being offline. */
let anchorMs = null;
let anchorSource = 'assumed';
/** What the cache on disk currently records, so it is rewritten only on news. */
let savedAnchor = null;

/* --------------------------------------------------------------- cache --- */

function loadCache() {
  loaded = true;
  let raw;
  try {
    raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return; // no cache yet, or an unreadable one — scan from scratch
  }
  // A cache written by an older layout, or with costs from a price table that
  // has since been edited, is not worth salvaging piecemeal.
  if (raw?.version !== CACHE_VERSION || raw.pricing !== PRICING_FINGERPRINT) return;
  if (typeof raw.anchor === 'number') {
    anchorMs = raw.anchor;
    savedAnchor = raw.anchor;
    anchorSource = 'remembered';
  }
  for (const [path, e] of Object.entries(raw.files ?? {})) {
    if (Array.isArray(e?.rows)) cache.set(path, e);
  }
}

function saveCache() {
  const files = {};
  for (const [path, e] of cache) files[path] = e;
  try {
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        version: CACHE_VERSION,
        pricing: PRICING_FINGERPRINT,
        anchor: anchorMs,
        savedAt: new Date().toISOString(),
        files,
      })
    );
    savedAnchor = anchorMs;
  } catch {
    // A cache that cannot be written costs a rescan, nothing more.
  }
}

/* ---------------------------------------------------------------- scan --- */

/**
 * Every billed request in one transcript, folded into 5-minute buckets.
 *
 * Read in chunks with the tail of each carried into the next, because some of
 * these files are hundreds of megabytes and slurping one whole would spike the
 * server's memory by more than the board itself uses.
 */
function scanFile(path, size, mtimeMs) {
  const totals = new Map();
  const seen = new Set();
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size));
    let pos = 0;
    let carry = '';
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.toString('utf8', 0, n);
      // Everything up to the last newline is whole lines; the rest is the start
      // of one and waits for the next chunk.
      const end = text.lastIndexOf('\n');
      if (end === -1) {
        carry = text;
        continue;
      }
      carry = text.slice(end + 1);
      let from = 0;
      while (from <= end) {
        const nl = text.indexOf('\n', from);
        const line = text.slice(from, nl);
        from = nl + 1;
        const e = parseLine(line, mtimeMs);
        if (!e || seen.has(e.key)) continue;
        seen.add(e.key);
        const idx = Math.floor(e.t / BUCKET_MS);
        let row = totals.get(idx);
        if (!row) totals.set(idx, (row = [idx, 0, 0, 0, 0, 0, 0, 0]));
        row[1] += e.in + e.out + e.cacheRead + e.write5m + e.write1h;
        row[2] += e.cost;
        row[3] += e.in;
        row[4] += e.out;
        row[5] += e.cacheRead;
        row[6] += e.write5m + e.write1h;
        row[7] += 1;
      }
    }
  } finally {
    closeSync(fd);
  }

  const rows = [...totals.values()].sort((a, b) => a[0] - b[0]);
  for (const r of rows) r[2] = Math.round(r[2] * 10_000) / 10_000;
  return { size, mtimeMs, rows };
}

/** Bring the cache level with what is on disk, without blocking the board. */
async function scan() {
  if (!loaded) loadCache();

  const present = new Set();
  let read = 0;
  let bytes = 0;
  let n = 0;

  for (const { path } of transcriptFiles()) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.size) continue;
    present.add(path);

    const have = cache.get(path);
    if (have && have.size === stat.size && have.mtimeMs === stat.mtimeMs) continue;

    try {
      cache.set(path, scanFile(path, stat.size, stat.mtimeMs));
      read += 1;
      bytes += stat.size;
    } catch {
      continue;
    }
    // Long enough to matter only on the very first pass, when this runs 900
    // times; after that it is a handful of files and the yield is free.
    if (++n % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
  }

  // A transcript that was deleted should stop counting, and its rows should
  // stop being written back out.
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);

  lastScan = Date.now();
  if (read) saveCache();
  return { read, bytes };
}

/* -------------------------------------------------------------- anchor --- */

/**
 * The instant the weekly allowance rolls over.
 *
 * Anthropic reports it at :59:59, which reads an hour early once a formatter
 * truncates it, so it is rounded to the minute here exactly as the meter is.
 * Whatever we last learned is remembered, and stepped forward a whole number of
 * weeks — a reset from three weeks ago still tells you which evening of which
 * day the boundary falls on.
 */
async function resolveAnchor(now) {
  try {
    const plan = await getLimits();
    const weekly = plan?.limits?.find((l) => l.kind === 'weekly_all' && l.resetsAt);
    if (weekly) {
      const at = Math.round(new Date(weekly.resetsAt).getTime() / 60_000) * 60_000;
      if (Number.isFinite(at)) {
        anchorMs = at;
        anchorSource = 'plan';
      }
    }
  } catch {
    // Offline, or signed out. The remembered anchor is still the right shape.
  }

  if (anchorMs == null) {
    // Never seen a reset. Anything is a guess, so guess the boundary that makes
    // the current week end tonight and say plainly that it is assumed.
    anchorMs = now;
    anchorSource = 'assumed';
  }

  // Learning the real boundary is worth a write on its own — the next restart
  // should not have to be online to draw the chart correctly.
  if (anchorSource === 'plan' && anchorMs !== savedAnchor) saveCache();

  // Step to the first boundary that has not happened yet.
  const k = Math.floor((now - anchorMs) / WEEK_MS) + 1;
  return anchorMs + Math.max(k, 0) * WEEK_MS;
}

/* ----------------------------------------------------------- reporting --- */

const zero = () => ({
  tokens: 0,
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
});

function addRow(acc, row) {
  acc.tokens += row[1];
  acc.cost += row[2];
  acc.input += row[3];
  acc.output += row[4];
  acc.cacheRead += row[5];
  acc.cacheWrite += row[6];
  acc.requests += row[7];
}

const round = (n) => Math.round(n * 100) / 100;

export async function buildHistory({ weeks = 8 } = {}) {
  const now = Date.now();

  // One scan at a time. Two requests arriving together during the first pass
  // would otherwise both read 1.5 GB.
  if (!lastScan || now - lastScan > TTL_MS) {
    scanning = scanning ?? scan().finally(() => (scanning = null));
    await scanning;
  }

  const anchor = await resolveAnchor(now);
  const count = Math.max(1, Math.min(weeks, 52));

  const buckets = Array.from({ length: count }, () => zero());
  const toDate = Array.from({ length: count }, () => zero());
  // How far into the current week we are — the same offset is applied to every
  // earlier week so a Tuesday is compared against a Tuesday.
  const elapsed = now - (anchor - WEEK_MS);

  let earliest = Infinity;
  let latest = 0;
  let files = 0;

  for (const entry of cache.values()) {
    if (!entry.rows.length) continue;
    files += 1;
    for (const row of entry.rows) {
      const t = row[0] * BUCKET_MS;
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
      const i = Math.ceil((anchor - t) / WEEK_MS) - 1;
      if (i < 0 || i >= count) continue;
      addRow(buckets[i], row);
      if (t - (anchor - (i + 1) * WEEK_MS) < elapsed) addRow(toDate[i], row);
    }
  }

  // Oldest first, so the chart reads left to right.
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = anchor - (i + 1) * WEEK_MS;
    const end = anchor - i * WEEK_MS;
    const b = buckets[i];
    const d = toDate[i];
    out.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      current: i === 0,
      /** False when the transcripts do not reach back this far. */
      covered: Number.isFinite(earliest) && end > earliest,
      ...b,
      cost: round(b.cost),
      toDate: { tokens: d.tokens, cost: round(d.cost) },
    });
  }

  const current = out[out.length - 1];
  const prior = out.length > 1 ? out[out.length - 2] : null;
  const fraction = Math.min(1, Math.max(0, elapsed / WEEK_MS));

  return {
    anchor: new Date(anchor).toISOString(),
    anchorSource,
    weeks: out,
    pace: {
      /** How far through the current week we are, 0 to 1. */
      elapsed: Math.round(fraction * 1000) / 1000,
      projectedTokens: fraction > 0.02 ? Math.round(current.tokens / fraction) : null,
      projectedCost: fraction > 0.02 ? round(current.cost / fraction) : null,
      /**
       * This week against last week at the same hour — the only honest way to
       * compare a week that is a third over with one that finished.
       */
      vsPrior:
        prior?.toDate.tokens > 0
          ? Math.round((current.tokens / prior.toDate.tokens - 1) * 100)
          : null,
    },
    coverage: {
      from: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
      to: latest ? new Date(latest).toISOString() : null,
      files,
    },
    generatedAt: new Date(now).toISOString(),
  };
}
