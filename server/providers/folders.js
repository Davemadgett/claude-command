/**
 * Labels read from the filesystem — the default, because it needs no account,
 * no key and no network, and most people already keep one folder per client or
 * per project somewhere.
 *
 * `depth` is what makes it fit different filing habits. A flat `~/Projects`
 * with one folder per project is depth 1. A two-level scheme — a folder per
 * client, and inside it a folder per engagement — is depth 2, and only the leaf
 * is the label. `pattern` then filters the leaves, so a folder that is merely
 * sitting in the tree ("Admin", "Old") does not become a label by accident.
 *
 * This module also answers "where does label X live on disk" for every index,
 * including the command one. Where the list of labels comes from and where the
 * files are are separate questions, and a Clio user has a local mirror of
 * folders whose names came from a server they will never see.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

let folders = new Map();
let builtAt = 0;
const MAX_AGE_MS = 10 * 60_000;

function leafAccepted(name) {
  const pattern = config.labels.pattern;
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return true; // a broken pattern should not silently hide every label
  }
}

function walk(dir, remaining, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable, unmounted, or permission-denied — not fatal
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (remaining === 1) {
      if (leafAccepted(entry.name)) out.set(entry.name, path);
    } else {
      walk(path, remaining - 1, out);
    }
  }
}

function build() {
  const next = new Map();
  const root = config.labels.root;
  if (root) walk(root, Math.max(1, Number(config.labels.depth) || 1), next);
  folders = next;
  builtAt = Date.now();
}

function fresh() {
  if (!builtAt || Date.now() - builtAt > MAX_AGE_MS) build();
  return folders;
}

/** Label key -> absolute folder path. */
export function labelFolders() {
  return fresh();
}

export function labelFolder(key) {
  if (!key) return null;
  const index = fresh();

  const exact = index.get(key);
  if (exact) return exact;

  /*
   * A key from an external index can carry a suffix the folder omits, or the
   * reverse — "01994-Acme" against a folder called "01994". Match on the
   * part before the dash, but only for keys that have one: without that guard,
   * a project called "acme" would happily resolve to "acme-archived".
   */
  if (!key.includes('-')) return null;
  const prefix = key.split('-')[0];
  for (const [name, path] of index) {
    if (name.split('-')[0] === prefix) return path;
  }
  return null;
}

/** The folder tree as an index, for when folders are themselves the label list. */
export function folderIndex() {
  const out = {};
  for (const [key, path] of fresh()) out[key] = { name: key, folder: path, url: null };
  return out;
}

export function foldersStatus() {
  const index = fresh();
  return {
    root: config.labels.root,
    depth: config.labels.depth,
    count: index.size,
    builtAt: builtAt ? new Date(builtAt).toISOString() : null,
  };
}
