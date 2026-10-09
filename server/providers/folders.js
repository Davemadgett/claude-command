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
 * files are are separate questions: someone whose list arrives from an API still
 * has a local mirror of folders whose names came from a server it never saw.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/*
 * The walk runs in a child process, never on the event loop. A folder under a
 * cloud mount (Dropbox, iCloud, OneDrive via the file provider) can be a
 * placeholder whose `open()` blocks in the kernel until the provider fetches it
 * — and on a machine where that fetch never completes, a readdirSync on the
 * server's thread stopped the whole board: every request timed out, SIGTERM was
 * ignored, and only kill -9 worked. (srv1, 2026-10-09: the label watcher's
 * 30-second tick walked the Clio root and hit one such matter folder.)
 *
 * So: the child streams leaves as it finds them; the parent keeps whatever has
 * arrived when the clock runs out, merges it over the previous index, and tries
 * again at the next refresh. Callers still get a Map synchronously — the last
 * good one — which is the right answer for an index that changes a few times a
 * week.
 */
const WALK = fileURLToPath(new URL('./folders-walk.js', import.meta.url));
const WALK_TIMEOUT_MS = 20_000;

let folders = new Map();
let builtAt = 0;
let refreshing = null;
let warned = false;
const MAX_AGE_MS = 10 * 60_000;

function refresh() {
  if (refreshing) return;
  const root = config.labels.root;
  if (!root) {
    folders = new Map();
    builtAt = Date.now();
    return;
  }
  const depth = Math.max(1, Number(config.labels.depth) || 1);
  const next = new Map();
  let buf = '';
  let done = false;

  const child = spawn(process.execPath, [WALK, root, String(depth), config.labels.pattern || ''], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  refreshing = child;

  const finish = (complete) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (!complete) {
      child.kill('SIGKILL');
      if (!warned) {
        console.error(
          `label folders: walking ${root} did not finish in ${WALK_TIMEOUT_MS / 1000}s — ` +
            `a cloud-only folder that never materializes? Keeping the ${next.size} found so far` +
            (folders.size ? ' over the previous index.' : '.')
        );
        warned = true;
      }
      for (const [key, path] of folders) if (!next.has(key)) next.set(key, path);
    }
    folders = next;
    builtAt = Date.now();
    refreshing = null;
  };

  const timer = setTimeout(() => finish(false), WALK_TIMEOUT_MS);
  timer.unref?.();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const tab = line.indexOf('\t');
      if (tab > 0) next.set(line.slice(0, tab), line.slice(tab + 1));
    }
  });
  child.on('error', () => finish(false));
  child.on('close', (code) => finish(code === 0));
}

function fresh() {
  if (!builtAt || Date.now() - builtAt > MAX_AGE_MS) refresh();
  return folders;
}

// Start the first walk now, so the index is usually ready before the first
// request rather than empty for it.
refresh();

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
