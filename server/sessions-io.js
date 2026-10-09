/**
 * The three primitives every transcript reader needs, in a file neither reader
 * imports the other to get at.
 *
 * These lived in sessions.js when there was one transcript format. codex.js
 * needs all three and sessions.js needs codex.js, so leaving them where they
 * were would have made the two files import each other. Nothing here knows
 * anything about either format — it reads bytes, parses lines, and answers the
 * one question about a path that both readers ask.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { config } from './config.js';

/** A byte range of a file, as text. Transcripts are far too large to slurp. */
export function readChunk(path, start, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function* jsonLines(text, { dropFirst = false } = {}) {
  const lines = text.split('\n');
  // A tail chunk almost always starts mid-line; that fragment is unparseable.
  const start = dropFirst ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* truncated or partially-written line — skip */
    }
  }
}

/**
 * Which label, if any, a path sits inside — read from the configured folder
 * layout rather than a fixed convention.
 *
 * A path counts only if it is under `labels.root`, and the label is the segment
 * exactly `labels.depth` levels below it. Anything shallower is the tree above
 * the labels; anything deeper is a file *within* one, and its label is still the
 * segment at that depth. With no root configured this returns null, which is
 * what switches folder inference off for an install that has no such layout.
 *
 * Shared by the cwd check, the file-write inference, and the time log.
 */
export function labelFromPath(p) {
  if (!p) return null;

  const root = config.labels.root;
  if (!root || !p.startsWith(`${root}/`)) return null;

  const depth = Math.max(1, Number(config.labels.depth) || 1);
  // Segment names carry spaces ("01977-Northwind Trading"), so split on the
  // separator rather than trying to match the name itself.
  const parts = p.slice(root.length + 1).split('/').filter(Boolean);
  if (parts.length < depth) return null;

  const label = parts[depth - 1].trim();
  if (!label) return null;

  const pattern = config.labels.pattern;
  if (pattern) {
    try {
      if (!new RegExp(pattern).test(label)) return null;
    } catch {
      /* a broken pattern should not silently reject every path */
    }
  }

  // The folder the label is grouped under, when the layout has one. Displayed
  // beside the label in the time log, where knowing whose work it is helps.
  const client = depth > 1 ? parts[depth - 2].trim() : null;
  return { label, client };
}
