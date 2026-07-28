/**
 * Turning what a person typed into a folder that exists.
 *
 * "Working directory" is jargon, and the honest answer to "what do I put here?"
 * is usually "click Browse". But people do type, and what they type is rarely a
 * canonical path — it's `downloads`, or `~/Desktop`, or a path dragged out of
 * Finder as a file:// URL, or a label number. All of those are unambiguous
 * enough to honour, so we honour them rather than failing with "no such
 * directory".
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, basename, dirname } from 'node:path';
import { labelFolder, labelFolders } from './providers/index.js';
import { config } from './config.js';

const HOME = homedir();

const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Strip the decorations Finder, Terminal and copy-paste add to a path. */
function clean(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';

  // Dragging a folder onto a text field yields a file:// URL.
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* a literal % in a folder name — leave it alone */
    }
  }

  // "Copy as Pathname" on a name with spaces, and shell-style escaping.
  s = s.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');

  // A trailing slash is harmless everywhere except the root itself.
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
  return s;
}

/**
 * The path as the disk actually spells it. The boot volume is case-insensitive,
 * so `~/downloads` opens fine but would then be *displayed* that way — and would
 * not match a label folder path anywhere else in the app.
 */
function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk a path one segment at a time, accepting a case-insensitive match when the
 * exact name isn't there. This is what makes `downloads` find `Downloads` —
 * macOS filesystems are usually case-insensitive anyway, but synced and
 * network mounts here are not, so we can't rely on the OS to do it.
 */
function resolveLoosely(base, segments) {
  let current = base;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const exact = join(current, segment);
    if (isDir(exact)) {
      current = exact;
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    const lower = segment.toLowerCase();
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === lower);
    if (!hit) return null;
    current = join(current, hit.name);
  }
  return current;
}

/**
 * Best-effort absolute folder for whatever was typed, or null.
 * Order matters: an exact path always beats a fuzzy interpretation of it.
 */
export function findDir(input) {
  const s = clean(input);
  if (!s) return HOME;

  if (s === '~') return HOME;

  const expanded = s.startsWith('~/') ? join(HOME, s.slice(2)) : s;

  // 1. Exactly what was asked for.
  if (isAbsolute(expanded) && isDir(expanded)) return expanded;

  // 2. A bare label key, which is the shortest thing anyone actually types.
  //    Tried before the loose path walk so a label always beats a folder that
  //    merely happens to share its name.
  const folder = labelFolder(s);
  if (folder && isDir(folder)) return folder;

  // 3. Absolute, but a segment is cased differently than on disk.
  if (isAbsolute(expanded)) {
    const loose = resolveLoosely('/', expanded.split('/'));
    if (loose && isDir(loose)) return loose;
    return null;
  }

  // 4. Relative: read it against home, which is what someone typing `downloads`
  //    or `code/foo` means. The server's own cwd is never what they meant.
  const fromHome = resolveLoosely(HOME, expanded.split('/'));
  if (fromHome && isDir(fromHome)) return fromHome;

  return null;
}

/** findDir, but it explains itself when it fails. */
export function resolveDir(input) {
  const found = findDir(input);
  if (found) return canonical(found);
  const shown = clean(input);
  throw new Error(
    `Can't find a folder called “${shown}”. Use Browse… to pick one, ` +
      `or paste a full path such as ${join(HOME, 'Downloads')}.`
  );
}

/** ~/Library/… → ~/Library/…, purely for display. */
export function prettyPath(p) {
  if (!p) return '';
  return p === HOME ? '~' : p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

/** The shortcuts a Finder sidebar would show, minus the ones that don't exist. */
export function places() {
  const candidates = [
    { label: 'Home', path: HOME },
    { label: 'Desktop', path: join(HOME, 'Desktop') },
    { label: 'Documents', path: join(HOME, 'Documents') },
    { label: 'Downloads', path: join(HOME, 'Downloads') },
    { label: 'Code', path: join(HOME, 'code') },
  ];

  // Wherever the labels live is the shortcut most worth having, and it is the
  // one place this list cannot guess at.
  if (config.labels.root) {
    candidates.push({ label: capitalise(config.labels.noun) + 's', path: config.labels.root });
  }

  return candidates.filter((c) => isDir(c.path));
}

/** One level of subfolders, for the built-in browser. */
export function listDirs(input) {
  const path = resolveDir(input);
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch (err) {
    throw new Error(`Can't read ${prettyPath(path)}: ${err.code === 'EPERM' ? 'macOS is blocking access to this folder' : err.message}`);
  }

  const parent = path === '/' ? null : dirname(path);
  return {
    path,
    display: prettyPath(path),
    name: path === HOME ? 'Home' : basename(path) || '/',
    parent,
    parentDisplay: parent ? prettyPath(parent) : null,
    dirs: entries,
  };
}

/** Every label folder on disk, for the picker's label search. */
export function labelChoices() {
  return [...labelFolders().entries()]
    .map(([label, path]) => ({ label, client: basename(dirname(path)), path }))
    .sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
}
