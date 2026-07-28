import { statSync } from 'node:fs';

import {
  cleanPrompt, jsonLines, labelFromPath, readChunk, scanSessions, transcriptPath,
} from './sessions.js';
import { knownLabels, labelFolders } from './providers/index.js';
import { config } from './config.js';
import { getCard, listCards, setCardLabel, suggestCardLabel } from './db.js';

/**
 * Which label a session is about, read from what you typed into it.
 *
 * A session started in ~/ and pointed at a case has nothing tying it to that case
 * — its working directory is home, and until it writes a file into the label
 * folder there is nothing to infer from. But you almost always say which label
 * it is in the first breath ("pull the Acme file", "/strategy 02123-Baker"),
 * and that sentence is sitting in the transcript.
 *
 * Two strengths of evidence, deliberately treated differently:
 *
 *   A file number that matches a real label is unambiguous — you had to have
 *   meant that label to type its number — so it is applied outright, unless the
 *   session names two labels equally often and there is no telling which is the
 *   subject.
 *
 *   A surname is not. The calendar matcher tried surnames twice and gave up both
 *   times: event titles are full of people you are meeting *about* rather than
 *   *for*, and it once tied a meeting to the wrong label because the title named
 *   one of them. A prompt is no safer. So a name only ever raises a suggestion
 *   you confirm or dismiss on the card.
 */

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

// Enough of the conversation to find the sentence that names the label, without
// pulling a megabyte of prose through the matcher on every sweep.
const MAX_TEXT = 24 * 1024;

/**
 * Words that are also label names but are almost never a reference to one.
 *
 * The case that forces this: name your subagents after people — and most people
 * do — and every time you write "have Lee check the cites" the matcher sees a
 * label called Lee. Your own name belongs here too, and so does anyone you talk
 * *about* rather than work *for*.
 *
 * Configured, because the list is entirely a fact about your setup. `claude` is
 * always included; there is no arrangement in which it means a label.
 */
const NAME_STOPLIST = new Set([
  'claude',
  ...(config.labels.stoplist ?? []).map((s) => String(s).toLowerCase()),
]);

/**
 * Text that arrives as a user turn but that you never typed: the body of a skill
 * Claude Code expanded into the conversation, the caveat it wraps local commands
 * in, the echo of a command's own output.
 *
 * Filtering it is not tidiness — it is the difference between right and wrong.
 * A skill body is documentation, and documentation explains itself with examples:
 * /park's own help text reads "file # (01982), display number (01982-Dunn)".
 * Handed to the matcher as though you had typed it, that example is
 * indistinguishable from you naming the label, and it is exactly how a session
 * that opened with "working in 01994-Acme" came to be filed under a label named
 * only in that example — carrying the wrong deadline onto the card with it.
 */
const MACHINERY = [
  /^Base directory for this skill:/i,
  /^Caveat: The messages below were generated/i,
  /^\[Request interrupted/i,
  /^Note: [^\n]*was read before the last conversation/i,
];

const cache = new Map(); // transcript path -> { key, turns }

/** What you typed, turn by turn — machinery dropped, order preserved. */
function userTurns(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }

  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.turns;

  const parts = [];
  let budget = MAX_TEXT;
  const take = (text, opts) => {
    for (const d of jsonLines(text, opts)) {
      if (budget <= 0) return;
      if (d.type !== 'user' || d.message?.role !== 'user') continue;
      const content = d.message.content;
      // A tool result is also a "user" line. Only what a person typed counts:
      // tool output is full of paths the session merely read.
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
            : '';
      const clean = cleanPrompt(raw);
      if (!clean) continue;
      if (MACHINERY.some((re) => re.test(clean))) continue;
      parts.push(clean.slice(0, budget));
      budget -= clean.length;
    }
  };

  take(readChunk(path, 0, Math.min(HEAD_BYTES, stat.size)));
  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    take(readChunk(path, start, stat.size - start), { dropFirst: start > 0 });
  }

  cache.set(path, { key, turns: parts });
  return parts;
}

/**
 * Key prefix -> canonical key ("01953" -> "01953-Acme"), from the index and
 * the folder tree both, so either source can resolve one.
 */
function numberIndex() {
  const index = new Map();
  for (const number of [...Object.keys(knownLabels()), ...labelFolders().keys()]) {
    const prefix = number.split('-')[0];
    if (prefix && !index.has(prefix)) index.set(prefix, number);
  }
  return index;
}

/**
 * Name -> the one open label that carries it.
 *
 * Every rule here throws candidates away, on purpose. Multi-word entries are
 * entity names ("Acme Holdings, LLC") that match ordinary
 * prose; short ones collide with words; a surname on more than one open label
 * cannot be resolved from a name alone; and a surname shared with a closed label
 * is still fine, because a closed label is not work you are doing today.
 */
function nameIndex() {
  const bySurname = new Map();
  for (const [number, m] of Object.entries(knownLabels())) {
    // A source that tracks status lets us ignore finished work; one that does
    // not (folders on disk) reports none, and everything it knows counts.
    if (m.status && m.status !== 'Open') continue;
    const surname = number.split('-').slice(1).join('-').trim().toLowerCase();
    if (!surname || surname.length < 5) continue;
    if (/[\s,.]/.test(surname)) continue;
    if (NAME_STOPLIST.has(surname)) continue;
    const list = bySurname.get(surname) || [];
    list.push(number);
    bySurname.set(surname, list);
  }

  const index = new Map();
  for (const [surname, numbers] of bySurname) {
    if (numbers.length === 1) index.set(surname, numbers[0]);
  }
  return index;
}

let indexes = null;
let builtAt = 0;
const INDEX_TTL_MS = 10 * 60_000;

function getIndexes() {
  if (!indexes || Date.now() - builtAt > INDEX_TTL_MS) {
    indexes = { numbers: numberIndex(), names: nameIndex() };
    builtAt = Date.now();
  }
  return indexes;
}

/** Force the next detection to rebuild — used when the label cache refreshes. */
export function invalidateIndexes() {
  indexes = null;
}

/**
 * What label, if any, this text is about.
 *
 * Returns { label, source, apply } or null. `apply` is the whole point of the
 * split: true means the evidence is strong enough to label the card outright,
 * false means it becomes a question for you to answer.
 */
export function detectLabel(turns) {
  const list = (Array.isArray(turns) ? turns : [turns]).filter(Boolean);
  if (!list.length) return null;
  const { numbers, names } = getIndexes();

  /** Every label named by number in one turn, and how often. */
  const numbersIn = (text) => {
    const found = new Map();
    const bump = (label) => found.set(label, (found.get(label) || 0) + 1);

    // A path to a label folder is as good as its number — you typed the folder.
    const path = labelFromPath(text);
    if (path && numbers.has(path.label.split('-')[0])) bump(numbers.get(path.label.split('-')[0]));

    for (const m of text.matchAll(/\b(\d{4,6})\b/g)) {
      const hit = numbers.get(m[1]);
      if (hit) bump(hit);
    }
    return found;
  };

  /*
   * The opening turn decides, when it names exactly one label.
   *
   * It is where you say what you are sitting down to do — "working in
   * 01994-Acme", "/strategy 02123-Baker" — and nothing later in the session
   * is better evidence of the subject than that sentence. Counting instead lets
   * an hour of downstream discussion about a scheduling conflict outvote the
   * only line that was actually about the assignment.
   */
  const opening = numbersIn(list[0]);
  if (opening.size === 1) return { label: [...opening.keys()][0], source: 'number', apply: true };

  /*
   * Failing that, count every file number mentioned rather than taking the first.
   *
   * A session about one label that mentions a second in passing ("the Dunn
   * schedule conflicts with this") should not be labelled with the aside, and
   * how often you refer to a label is a fair proxy for whose work it is. A tie
   * is a genuinely ambiguous session, so it drops to a suggestion instead of
   * picking one.
   */
  const counts = new Map();
  for (const turn of list) {
    for (const [label, n] of numbersIn(turn)) counts.set(label, (counts.get(label) || 0) + n);
  }

  if (counts.size) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const clear = ranked.length === 1 || ranked[0][1] > ranked[1][1];
    return { label: ranked[0][0], source: 'number', apply: clear };
  }

  const text = list.join('\n');

  // Names are a guess, and two candidates in one conversation is no guess at all
  // — "compare the Acme and Cole settlements" names neither as the subject.
  const found = new Set();
  for (const [surname, number] of names) {
    if (new RegExp(`\\b${surname}\\b`, 'i').test(text)) found.add(number);
    if (found.size > 1) return null;
  }
  const [only] = found;
  return only ? { label: only, source: 'name', apply: false } : null;
}

/**
 * Look at every card that has no label yet and see whether its session says
 * which one it is. Cards whose session already runs inside a label folder are
 * left alone — the folder is better evidence than anything in the text.
 */
export function sweepLabels() {
  const sessions = new Map(
    scanSessions({ sinceDays: 14, interactiveOnly: true }).map((s) => [s.sessionId, s])
  );

  const applied = [];
  for (const card of listCards()) {
    if (card.archived || card.manual) continue;
    if (card.label) continue; // already settled, by detection or by hand

    const session = sessions.get(card.session_id);
    if (!session?.path) continue;
    if (session.labelSource === 'cwd') continue; // the folder already answered

    const hit = detectLabel(userTurns(session.path));
    if (!hit) continue;

    /*
     * Where the prompt disagrees with what the session did, the session wins.
     *
     * A document saved into a label folder was saved there deliberately; a number
     * appearing in a sentence may be an aside, a comparison, or a quotation. So
     * a contradicted guess is demoted to a question rather than applied over the
     * top of the file evidence.
     */
    if (hit.apply && session.label && session.label !== hit.label) hit.apply = false;

    if (hit.apply) {
      setCardLabel(card.session_id, hit.label, 'prompt');
      applied.push({ sessionId: card.session_id, label: hit.label, source: hit.source });
      continue;
    }

    // A guess you have already turned down, or one already on offer.
    if (card.label_dismissed === hit.label) continue;
    if (card.label_suggested === hit.label) continue;

    suggestCardLabel(card.session_id, hit.label);
    applied.push({ sessionId: card.session_id, label: hit.label, source: hit.source, suggested: true });
  }
  return applied;
}

/**
 * Detect on demand for one session — called the moment a session is started from
 * the board, and again shortly after, so a card that opens with "let's work on
 * 02123-Baker" is labelled before the next sweep comes round.
 */
export function detectForSession(sessionId) {
  const card = getCard(sessionId);
  if (!card || card.label) return null;
  // The working directory answers first when it can, and costs nothing to check.
  if (labelFromPath(card.cwd)) return null;

  const path = transcriptPath(sessionId);
  if (!path) return null;

  const hit = detectLabel(userTurns(path));
  if (!hit) return null;
  if (hit.apply) {
    setCardLabel(sessionId, hit.label, 'prompt');
  } else if (card.label_dismissed !== hit.label) {
    suggestCardLabel(sessionId, hit.label);
  }
  return hit;
}

export function startLabelWatcher({ intervalMs = 30_000 } = {}) {
  const tick = () => {
    try {
      for (const hit of sweepLabels()) {
        console.log(
          `label: ${hit.sessionId.slice(0, 8)} → ${hit.label}` +
            (hit.suggested ? ` (suggested, from a ${hit.source})` : '')
        );
      }
    } catch (err) {
      console.error('label sweep failed:', err.message);
    }
  };
  const id = setInterval(tick, intervalMs);
  id.unref?.();
  return () => clearInterval(id);
}
