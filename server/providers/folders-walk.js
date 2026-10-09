/**
 * The folder walk, as a child process — see folders.js for why.
 *
 *   node folders-walk.js <root> <depth> [pattern]
 *
 * Prints one `<label>\t<path>` line per leaf, written synchronously so that
 * everything found so far has reached the parent before any directory that
 * never answers takes this process down with it.
 */
import { readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const [root, depthArg, patternArg] = process.argv.slice(2);
const depth = Math.max(1, Number(depthArg) || 1);
let pattern = null;
if (patternArg) {
  try {
    pattern = new RegExp(patternArg);
  } catch {
    pattern = null; // a broken pattern should not silently hide every label
  }
}

function walk(dir, remaining) {
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
      if (!pattern || pattern.test(entry.name)) writeSync(1, `${entry.name}\t${path}\n`);
    } else {
      walk(path, remaining - 1);
    }
  }
}

if (root) walk(root, depth);
