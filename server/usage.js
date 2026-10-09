/**
 * What the sessions are actually spending, read off the transcripts.
 *
 * Every assistant turn Claude Code writes carries the API's own `usage` block —
 * input, output, cache reads and cache writes, with a model name and a
 * timestamp. That is the only ledger on this machine, and it is exact: these are
 * the numbers Anthropic billed, not an estimate of them.
 *
 * Two things it is NOT:
 *
 *   - It is not your plan meter. Headroom against the 5-hour and weekly limits
 *     comes from Anthropic, in `limits.js`; the windows below are this tool's
 *     own arithmetic over the transcripts, which answers a different question
 *     in units that do not convert.
 *   - The dollars are list API prices for the tokens spent. On a subscription
 *     you did not pay them. They are here because "4.8M tokens" says nothing
 *     about whether one matter is expensive and another isn't, and a dollar
 *     figure does — see `pricing` on the response, which the panel prints.
 *
 * Reading is incremental. A transcript only ever grows, so each pass reads the
 * bytes appended since the last one and remembers the offset; a full first pass
 * over a week of transcripts costs about a second, and every pass after it
 * costs a stat() per file.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

import { readChunk, scanSessions } from './sessions.js';
import { dateKey } from './timelog.js';
import { labelUrl, labelFolder } from './providers/index.js';
import { listCards } from './db.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** How much history to keep in memory. A day past the widest window shown. */
const RETAIN_DAYS = 8;
const RETAIN_MS = RETAIN_DAYS * 86_400_000;

/** Resolution of every chart and rolling window here. Shared with history.js. */
export const BUCKET_MS = 5 * 60_000;
const FIVE_HOURS = 5 * 60 * 60_000;

/** A session counts as burning right now if it billed within this long. */
const ACTIVE_MS = 15 * 60_000;
/**
 * Window the per-minute rate is measured over. Short enough that a session
 * ramping up or going quiet shows it within a refresh or two — a longer window
 * is steadier but reports a burn that stopped several minutes ago.
 */
const RATE_MS = 5 * 60_000;

/** Never read more than this from a file we have not seen before. */
const MAX_FIRST_READ = 64 * 1024 * 1024;

/**
 * List API prices per million tokens, by model family.
 *
 * Cache reads bill at 0.1x the input rate; a 5-minute cache write at 1.25x and
 * a 1-hour write at 2x. Those multipliers are the same for every model, so only
 * the base pair is listed here.
 */
const PRICES = [
  [/^claude-(fable|mythos)-5/, { in: 10, out: 50 }],
  [/^claude-opus-4-[01]/, { in: 15, out: 75 }],
  [/^claude-opus/, { in: 5, out: 25 }],
  [/^claude-sonnet/, { in: 3, out: 15 }],
  [/^claude-haiku-3/, { in: 0.8, out: 4 }],
  [/^claude-haiku/, { in: 1, out: 5 }],
];
const UNKNOWN_PRICE = { in: 5, out: 25 };
/** Fast mode runs the same model at a premium. */
const FAST_PRICE = { in: 10, out: 50 };

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

/**
 * Changes whenever the table above does. `history.js` caches costs it computed
 * from these prices and has no way to notice an edit otherwise — it would go on
 * charting last month at rates that no longer apply.
 */
export const PRICING_FINGERPRINT = [
  ...PRICES.map(([re, p]) => `${re.source}=${p.in}/${p.out}`),
  `fast=${FAST_PRICE.in}/${FAST_PRICE.out}`,
  `unknown=${UNKNOWN_PRICE.in}/${UNKNOWN_PRICE.out}`,
  `mult=${CACHE_READ_MULT}/${CACHE_WRITE_5M_MULT}/${CACHE_WRITE_1H_MULT}`,
].join('|');

function priceFor(model, fast) {
  if (fast) return FAST_PRICE;
  if (!model) return UNKNOWN_PRICE;
  for (const [re, price] of PRICES) if (re.test(model)) return price;
  return UNKNOWN_PRICE;
}

function costOf(e) {
  const p = priceFor(e.model, e.fast);
  const inRate = p.in / 1e6;
  return (
    e.in * inRate +
    e.out * (p.out / 1e6) +
    e.cacheRead * inRate * CACHE_READ_MULT +
    e.write5m * inRate * CACHE_WRITE_5M_MULT +
    e.write1h * inRate * CACHE_WRITE_1H_MULT
  );
}

/* ------------------------------------------------------------- reading --- */

/*
 * One `usage` block spans several transcript lines — Claude Code writes one per
 * content block of the same assistant turn, each carrying an identical copy of
 * the usage and the same requestId. Counting lines would multiply the bill by
 * however many blocks the turn happened to have, so the requestId is the unit.
 */
const RE_REQ = /"requestId":"([^"]+)"/;
const RE_TS = /"timestamp":"([^"]+)"/;
const RE_MODEL = /"model":"([^"]+)"/;
const RE_IN = /"input_tokens":(\d+)/;
const RE_OUT = /"output_tokens":(\d+)/;
const RE_CACHE_READ = /"cache_read_input_tokens":(\d+)/;
const RE_CACHE_WRITE = /"cache_creation_input_tokens":(\d+)/;
const RE_WRITE_1H = /"ephemeral_1h_input_tokens":(\d+)/;
const RE_WRITE_5M = /"ephemeral_5m_input_tokens":(\d+)/;
const RE_SPEED = /"speed":"([^"]+)"/;

const num = (re, s) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : 0;
};

/** path -> { size, mtimeMs, offset, sessionId, events, seen } */
const files = new Map();

/**
 * Pull the billed request out of one transcript line, or null if it isn't one.
 *
 * Deliberately regex rather than JSON.parse: a week of transcripts is a few
 * hundred megabytes, nearly all of it prompts and tool output this never looks
 * at, and parsing all of it to read six integers costs about fifty times as
 * much as finding them. Every field read here sits at a fixed place in the
 * line — the model before the usage block, the timestamp and requestId after
 * it — so the first match on the correct side of `"usage"` is the top-level
 * one, and the repeats inside `iterations` are never picked up.
 */
export function parseLine(line, fallbackMs) {
  const at = line.indexOf('"usage"');
  if (at === -1) return null;

  const head = line.slice(0, at);
  const tail = line.slice(at);

  // Only an assistant turn is a billed request. A subagent's result is echoed
  // back into the parent transcript as a `user` line whose `toolUseResult`
  // carries a copy of the subagent's usage — counting that would bill the same
  // tokens twice, once here and once in the sidechain transcript that actually
  // spent them. On a real assistant line the usage sits inside the `message`
  // object, so `role` is the last thing before it and there is no tool result.
  if (head.includes('"toolUseResult"')) return null;
  if (!head.includes('"role":"assistant"')) return null;

  const out = num(RE_OUT, tail);
  const input = num(RE_IN, tail);
  const cacheRead = num(RE_CACHE_READ, tail);
  const cacheWrite = num(RE_CACHE_WRITE, tail);
  if (!out && !input && !cacheRead && !cacheWrite) return null;

  const write1h = num(RE_WRITE_1H, tail);
  const write5m = num(RE_WRITE_5M, tail);

  const model = (RE_MODEL.exec(head)?.[1] || '').replace(/\[.*$/, '') || null;
  const ts = RE_TS.exec(tail)?.[1];
  const t = ts ? Date.parse(ts) : NaN;

  const e = {
    t: Number.isNaN(t) ? fallbackMs : t,
    model,
    fast: RE_SPEED.exec(tail)?.[1] === 'fast',
    in: input,
    out,
    cacheRead,
    // Older transcripts carry only the total; treat it as the cheaper write
    // rather than inventing a 1-hour one.
    write1h,
    write5m: write1h || write5m ? write5m : cacheWrite,
  };
  e.cost = costOf(e);

  // A transcript predating requestId still has one turn per timestamp, and the
  // duplicate lines of one turn share it — enough to collapse them.
  e.key = RE_REQ.exec(tail)?.[1] || RE_REQ.exec(line)?.[1] || `${e.t}:${out}`;
  return e;
}

function ingest(entry, text, stat) {
  for (const line of text.split('\n')) {
    const e = parseLine(line, stat.mtimeMs);
    if (!e) continue;
    if (entry.seen.has(e.key)) continue;
    entry.seen.add(e.key);
    entry.events.push(e);
  }
  // The dedupe set only has to span one turn's worth of lines; letting it grow
  // for the life of the process would be the one unbounded thing here.
  if (entry.seen.size > 40_000) {
    entry.seen = new Set(entry.events.slice(-2000).map((e) => e.key));
  }
}

/**
 * Every transcript on the machine, paired with the session whose bill it is.
 *
 * The layout is `projects/<project>/<sessionId>.jsonl`, and beside it
 * `projects/<project>/<sessionId>/subagents/agent-*.jsonl` — one file per
 * subagent the session spawned. Those nested files are not a footnote: they
 * hold about 40% of every token spent here, because a subagent does its own
 * reading and its own thinking and only hands back a summary.
 *
 * The parent transcript echoes a subagent's usage back inside a
 * `toolUseResult`, which `parseLine` skips so the same tokens are not billed
 * twice. That skip is only correct if the sidechain file itself is read — a
 * walk that stopped at the top level dropped the spend at both ends.
 *
 * A subagent's tokens are attributed to the session that spawned it rather
 * than to its own id: the work was done for that matter, and `agent-a95a89b…`
 * is a name nothing else on the board can resolve.
 */
export function* transcriptFiles() {
  let projects;
  try {
    projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const project of projects) {
    if (project.isDirectory()) yield* walkTranscripts(join(PROJECTS_DIR, project.name), null);
  }
}

function* walkTranscripts(dir, owner) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      // Descending into `<sessionId>/` names the owner; `subagents/` below it
      // is a container and keeps whatever owner we already have.
      yield* walkTranscripts(path, e.name === 'subagents' ? owner : e.name);
    } else if (e.name.endsWith('.jsonl')) {
      yield { path, sessionId: owner ?? basename(e.name, '.jsonl') };
    }
  }
}

/** Read whatever has been appended since last time, across every transcript. */
function refresh() {
  const cutoff = Date.now() - RETAIN_MS;

  for (const { path, sessionId } of transcriptFiles()) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.size) continue;

    let entry = files.get(path);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) continue;
    // A transcript untouched for longer than we retain has nothing to add.
    if (!entry && stat.mtimeMs < cutoff) continue;

    // Resuming reads from the last newline we consumed. A file that shrank
    // was replaced rather than appended to, so start it over.
    const resuming = entry && stat.size >= entry.offset;
    const start = resuming ? entry.offset : Math.max(0, stat.size - MAX_FIRST_READ);
    if (!entry || !resuming) {
      entry = {
        size: 0,
        mtimeMs: 0,
        offset: start,
        sessionId,
        events: [],
        seen: new Set(),
      };
      files.set(path, entry);
    }

    const length = stat.size - start;
    if (length > 0) {
      let text;
      try {
        text = readChunk(path, start, length);
      } catch {
        continue;
      }
      // Stop at the last complete line — a session writing right now leaves a
      // half-written one, and picking it up here would lose it for good.
      const end = text.lastIndexOf('\n');
      if (end !== -1) {
        const whole = text.slice(0, end + 1);
        ingest(entry, whole, stat);
        entry.offset = start + Buffer.byteLength(whole, 'utf8');
      }
    }

    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
  }

  for (const entry of files.values()) {
    if (entry.events.length && entry.events[0].t < cutoff) {
      entry.events = entry.events.filter((e) => e.t >= cutoff);
    }
  }
}

/* ------------------------------------------------------------ reporting --- */

const zero = () => ({
  tokens: 0,
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
});

function add(acc, e) {
  acc.tokens += e.in + e.out + e.cacheRead + e.write5m + e.write1h;
  acc.cost += e.cost;
  acc.input += e.in;
  acc.output += e.out;
  acc.cacheRead += e.cacheRead;
  acc.cacheWrite += e.write5m + e.write1h;
  acc.requests += 1;
  return acc;
}

const round = (n) => Math.round(n * 100) / 100;

function finish(acc, extra = {}) {
  return { ...acc, cost: round(acc.cost), ...extra };
}

/**
 * Which label this session's spend belongs to, strongest evidence first — the
 * same order the time log uses, and for the same reason: an unattributed
 * session is honest, a wrongly attributed one points at the wrong client.
 */
function attribute(session, card) {
  if (card?.label && card.label_source === 'manual') {
    return { label: card.label, client: null, labelSource: 'manual' };
  }
  if (session?.label && session.labelSource === 'cwd') {
    return { label: session.label, client: session.client, labelSource: 'cwd' };
  }
  if (session?.label && session.labelSource === 'files') {
    return { label: session.label, client: session.client, labelSource: 'files' };
  }
  if (card?.label) return { label: card.label, client: null, labelSource: 'prompt' };
  return { label: null, client: null, labelSource: null };
}

/** Tokens per 5-minute bucket, as absolute bucket indexes. */
function bucketize(events) {
  const m = new Map();
  for (const e of events) {
    const i = Math.floor(e.t / BUCKET_MS);
    m.set(i, (m.get(i) || 0) + e.in + e.out + e.cacheRead + e.write5m + e.write1h);
  }
  return m;
}

/**
 * The busiest 5 hours in the window — what the current 5 hours is drawn
 * against. Deliberately not the plan limit, even though `limits.js` now knows
 * it: that meter is a percentage of an allowance in Anthropic's own units, and
 * these are tokens. Scaling against your own heaviest stretch answers the
 * question this bar is for, which is "is this heavy for me".
 */
function peakWindow(buckets, fromIdx, toIdx, span) {
  let best = 0;
  let running = 0;
  const q = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    running += buckets.get(i) || 0;
    q.push(i);
    while (q.length > span) running -= buckets.get(q.shift()) || 0;
    if (running > best) best = running;
  }
  return best;
}

export function buildUsage({ days = 7, liveIds = [] } = {}) {
  refresh();

  const now = Date.now();
  const live = new Set(liveIds);
  const windowMs = days * 86_400_000;
  const since = now - windowMs;

  const events = [];
  const perSession = new Map();
  for (const entry of files.values()) {
    for (const e of entry.events) {
      if (e.t < since) continue;
      events.push(e);
      let list = perSession.get(entry.sessionId);
      if (!list) perSession.set(entry.sessionId, (list = []));
      list.push(e);
    }
  }
  events.sort((a, b) => a.t - b.t);

  // Everything the transcripts know about the sessions themselves. Sidechains
  // and the automation runs are deliberately included — a subagent's tokens are
  // spent whether or not its transcript ever shows up as a card.
  const sessions = new Map(
    scanSessions({
      sinceDays: days + 1,
      interactiveOnly: false,
      includeSidechains: true,
      includeStubs: true,
    }).map((s) => [s.sessionId, s])
  );
  const cards = new Map(listCards().map((c) => [c.session_id, c]));

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const windows = {
    fiveHour: zero(),
    today: zero(),
    week: zero(),
  };
  const byLabel = new Map();
  const byModel = new Map();
  const byDay = new Map();

  for (const e of events) {
    add(windows.week, e);
    if (e.t >= now - FIVE_HOURS) add(windows.fiveHour, e);
    if (e.t >= todayMs) add(windows.today, e);

    const model = e.model || 'unknown';
    add(byModel.get(model) || byModel.set(model, zero()).get(model), e);

    const day = dateKey(e.t);
    add(byDay.get(day) || byDay.set(day, zero()).get(day), e);
  }

  for (const [sessionId, list] of perSession) {
    const { label, client, labelSource } = attribute(sessions.get(sessionId), cards.get(sessionId));
    const key = label ?? ' none';
    let bucket = byLabel.get(key);
    if (!bucket) {
      bucket = { ...zero(), label, client, labelSource, sessions: 0 };
      byLabel.set(key, bucket);
    }
    // The strongest attribution any of the label's sessions had — a row backed
    // by a folder shouldn't be marked "from a prompt" by a weaker sibling.
    const rank = { manual: 4, cwd: 3, files: 2, prompt: 1 };
    if ((rank[labelSource] || 0) > (rank[bucket.labelSource] || 0)) {
      bucket.labelSource = labelSource;
      bucket.client = client ?? bucket.client;
    }
    bucket.sessions += 1;
    for (const e of list) add(bucket, e);
  }

  // What is burning right now, and how fast.
  const active = [];
  for (const [sessionId, list] of perSession) {
    const last = list[list.length - 1];
    if (!last || last.t < now - ACTIVE_MS) continue;

    const s = sessions.get(sessionId);
    const card = cards.get(sessionId);
    const recent = list.filter((e) => e.t >= now - RATE_MS);
    const tokens = recent.reduce(
      (n, e) => n + e.in + e.out + e.cacheRead + e.write5m + e.write1h,
      0
    );
    const cost = recent.reduce((n, e) => n + e.cost, 0);

    // Twelve 5-minute buckets — the last hour, oldest first.
    const buckets = bucketize(list);
    const nowIdx = Math.floor(now / BUCKET_MS);
    const spark = [];
    for (let i = nowIdx - 11; i <= nowIdx; i++) spark.push(buckets.get(i) || 0);

    const totals = list.reduce((acc, e) => add(acc, e), zero());
    const { label } = attribute(s, card);

    active.push({
      sessionId,
      title: card?.title || s?.derivedTitle || 'Session',
      project: s?.project ?? '—',
      label,
      labelUrl: labelUrl(label),
      model: s?.model ?? null,
      live: live.has(sessionId),
      lastAt: new Date(last.t).toISOString(),
      tokensPerMin: Math.round(tokens / (RATE_MS / 60_000)),
      costPerHour: round((cost / (RATE_MS / 3_600_000)) || 0),
      spark,
      ...finish(totals),
    });
  }
  active.sort((a, b) => b.tokensPerMin - a.tokensPerMin);

  // Scales for the three headline bars — each drawn against the heaviest
  // equivalent stretch in the window, for the reason in `peakWindow`.
  const allBuckets = bucketize(events);
  const fromIdx = Math.floor(since / BUCKET_MS);
  const nowIdx = Math.floor(now / BUCKET_MS);
  const peakFiveHour = peakWindow(allBuckets, fromIdx, nowIdx, FIVE_HOURS / BUCKET_MS);

  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dateKey(now - i * 86_400_000);
    daily.push(finish(byDay.get(d) || zero(), { date: d }));
  }
  const peakDay = daily.reduce((n, d) => Math.max(n, d.tokens), 0);

  return {
    generatedAt: new Date(now).toISOString(),
    windows: {
      fiveHour: finish(windows.fiveHour, { peak: peakFiveHour, hours: 5 }),
      today: finish(windows.today, { peak: peakDay, date: dateKey(now) }),
      week: finish(windows.week, { days }),
    },
    active,
    daily,
    byLabel: [...byLabel.values()]
      .map((b) =>
        finish(b, {
          label: b.label,
          client: b.client,
          labelSource: b.labelSource,
          sessions: b.sessions,
          labelUrl: labelUrl(b.label),
          labelFolder: labelFolder(b.label),
        })
      )
      .sort((a, b) => b.tokens - a.tokens),
    byModel: [...byModel.entries()]
      .map(([model, b]) => finish(b, { model }))
      .sort((a, b) => b.cost - a.cost),
    pricing: {
      basis: 'List API prices per million tokens at the time this was written.',
      cacheRead: CACHE_READ_MULT,
      cacheWrite5m: CACHE_WRITE_5M_MULT,
      cacheWrite1h: CACHE_WRITE_1H_MULT,
      models: PRICES.map(([re, p]) => ({ match: re.source, input: p.in, output: p.out })),
    },
    params: { days, retainDays: RETAIN_DAYS, rateMinutes: RATE_MS / 60_000 },
  };
}
