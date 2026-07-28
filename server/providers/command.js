/**
 * Labels from any program that can print JSON.
 *
 * The alternative was an adapter per system — one for Clio, one for Jira, one
 * for Harvest — each carrying somebody's API client into this repo and going
 * stale the moment that vendor changed a field. A command is the smaller
 * contract: you already have a way to talk to your system, and this only needs
 * the answer.
 *
 * Your command prints, on stdout:
 *
 *   { "labels": { "<key>": { "name": "...", "url": "...", "status": "..." } } }
 *
 * `name`, `url` and `status` are all optional. Anything else is ignored, and
 * `{ "error": "..." }` is reported in the UI rather than thrown. There is a
 * worked example in examples/clio-labels.py.
 *
 * The result is cached to disk and refreshed in the background, because the
 * board must never wait on somebody's network: a label list a few hours stale
 * is not a problem, and a board that hangs on startup is.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CACHE_FILE = join(DATA_DIR, 'labels.json');

const MAX_AGE_MS = 12 * 60 * 60_000;
const TIMEOUT_MS = 60_000;

let labels = {};
let fetchedAt = 0;
let inFlight = false;
let lastError = null;

function loadFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    labels = raw.labels || {};
    fetchedAt = raw.fetchedAt || 0;
  } catch {
    /* first run, or the cache was cleared */
  }
}

loadFromDisk();

export function refreshLabels({ force = false } = {}) {
  const command = config.labels.command;
  if (!Array.isArray(command) || !command.length) return;
  if (inFlight) return;
  if (!force && Date.now() - fetchedAt < MAX_AGE_MS && Object.keys(labels).length) return;

  inFlight = true;
  const [bin, ...args] = command;
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    // config.json is gitignored, which makes it the right place for the key or
    // account id your command needs — better than asking people to arrange a
    // shell environment that a GUI app launched from Finder would not inherit.
    env: { ...process.env, ...(config.labels.env || {}) },
  });

  const kill = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });

  child.on('error', (err) => {
    clearTimeout(kill);
    inFlight = false;
    lastError = err.message;
  });

  child.on('close', () => {
    clearTimeout(kill);
    inFlight = false;
    try {
      const parsed = JSON.parse(out);
      if (parsed.error) {
        lastError = String(parsed.error);
        return;
      }
      labels = parsed.labels || {};
      fetchedAt = Date.now();
      lastError = null;
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt, labels }));
      console.log(`labels: cached ${Object.keys(labels).length} from ${bin}`);
    } catch (err) {
      lastError = `could not parse label list: ${err.message}`;
    }
  });
}

export function commandIndex() {
  return labels;
}

export function commandStatus() {
  return {
    command: config.labels.command || null,
    count: Object.keys(labels).length,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    error: lastError,
    refreshing: inFlight,
  };
}
